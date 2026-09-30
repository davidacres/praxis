import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'noise.dart';
import 'secure_channel.dart';
import 'wire.dart';

/// The phone side of the desktop LAN transport over a `dart:io` socket: runs
/// the Noise IK handshake (pinning the desktop key), follows the listener's
/// status frames through pairing, correlates request ids with replies, and
/// turns every failure into a [MobileConnectionError] that says what went
/// wrong. Port of `@praxis/mobile-protocol`'s `MobileSecureClient`.
class MobileSecureClient {
  MobileSecureClient({
    required this.host,
    required this.port,
    required this.staticKeyPair,
    required this.remoteStaticPublicKey,
    this.pairingTokenId,
    this.prologue,
    this.connectTimeout = const Duration(seconds: 15),
    this.requestTimeout = const Duration(seconds: 30),
    this.legacyReadyAfter = const Duration(seconds: 3),
    this.relayUrl,
    this.relayChannel,
  });

  final String host;
  final int port;
  final NoiseKeyPair staticKeyPair;
  final Uint8List remoteStaticPublicKey;
  final String? pairingTokenId;
  final List<int>? prologue;
  final Duration connectTimeout;
  final Duration requestTimeout;

  /// A desktop from before status frames never sends one: silence this long after the handshake means ready.
  final Duration legacyReadyAfter;

  /// When both are set the client reaches the desktop through the relay (`ws(s)://` URL and channel id
  /// from the invitation) instead of dialling [host]:[port]. The Noise IK channel runs end to end above
  /// the relay, so it forwards bytes it cannot read.
  final String? relayUrl;
  final String? relayChannel;

  bool get viaRelay => relayUrl != null && relayChannel != null;

  String get endpoint => viaRelay ? 'the relay' : '$host:$port';

  _Link? _link;
  SecureChannel? _channel;
  ConnectionStage _stage = ConnectionStage.connect;
  bool _ready = false;
  bool _closed = false;
  bool _settled = false;
  MobileConnectionStatus? _lastStatus;
  Completer<void>? _connecting;
  Timer? _connectTimer;
  Timer? _legacyTimer;
  int _requestSequence = 0;
  final Map<String, _Pending> _pending = {};
  final List<void Function(Map<String, dynamic>)> _eventListeners = [];
  final List<void Function(MobileConnectionStatus)> _statusListeners = [];
  final List<void Function(MobileConnectionError)> _closeListeners = [];

  bool get isReady => _ready && !_closed;
  MobileConnectionStatus? get status => _lastStatus;

  void Function() onEvent(void Function(Map<String, dynamic> envelope) listener) {
    _eventListeners.add(listener);
    return () => _eventListeners.remove(listener);
  }

  /// Every status frame, including `pairing-pending` while the desktop has not confirmed yet.
  void Function() onStatus(void Function(MobileConnectionStatus status) listener) {
    _statusListeners.add(listener);
    return () => _statusListeners.remove(listener);
  }

  /// Fires once when an established or pending connection ends, with the reason.
  void Function() onClose(void Function(MobileConnectionError error) listener) {
    _closeListeners.add(listener);
    return () => _closeListeners.remove(listener);
  }

  /// Completes once the desktop reports `ready`; throws a [MobileConnectionError].
  Future<void> connect() {
    if (_connecting != null) return Future.error(StateError('connect() may only be called once.'));
    final completer = _connecting = Completer<void>();
    final channel = _channel = SecureChannel.initiator(staticKeyPair: staticKeyPair, remoteStaticPublicKey: remoteStaticPublicKey, prologue: prologue);
    final assembler = RecordAssembler();
    _armTimeout();

    if (viaRelay) {
      _connectViaRelay(channel, assembler);
      return completer.future;
    }

    Socket.connect(host, port, timeout: const Duration(seconds: 10)).then(
      (socket) {
        if (_closed) {
          socket.destroy();
          return;
        }
        _link = _SocketLink(socket);
        socket.setOption(SocketOption.tcpNoDelay, true);
        _stage = ConnectionStage.handshake;
        socket.listen(
          (bytes) => _onData(bytes, assembler, channel),
          onError: (Object error) => _fail(_classifyEnd(error)),
          onDone: () => _fail(_classifyEnd(null)),
          cancelOnError: true,
        );
        socket.add(channel.nextHandshakeMessage());
      },
      onError: (Object error) {
        _fail(classifyMobileTransportFailure(stage: ConnectionStage.connect, endpoint: endpoint, cause: error));
      },
    );
    return completer.future;
  }

  void _connectViaRelay(SecureChannel channel, RecordAssembler assembler) {
    final base = relayUrl!.replaceAll(RegExp(r'/+$'), '');
    WebSocket.connect('$base/v1/connect?channel=$relayChannel').timeout(const Duration(seconds: 10)).then(
      (ws) {
        if (_closed) {
          unawaited(ws.close());
          return;
        }
        _link = _WebSocketLink(ws);
        _stage = ConnectionStage.handshake;
        ws.listen(
          (Object? data) {
            if (data is List<int>) _onData(data, assembler, channel);
          },
          onError: (Object error) => _fail(_classifyEnd(error)),
          onDone: () => _fail(_relayClosed(ws.closeCode)),
          cancelOnError: true,
        );
        ws.add(channel.nextHandshakeMessage());
      },
      onError: (Object error) {
        _fail(classifyMobileTransportFailure(stage: ConnectionStage.connect, endpoint: endpoint, cause: error));
      },
    );
  }

  /// The relay closes with an application code when the desktop is offline (4404), never answered (4408), or it is limiting this connection.
  MobileConnectionError _relayClosed(int? code) {
    final last = _lastStatus;
    if (last != null && isTerminalMobileStatus(last.code)) return MobileConnectionError.fromStatus(last);
    if (code == 4404 || code == 4408) {
      return MobileConnectionError('unreachable', 'The Praxis desktop is not connected to the relay. Check that Praxis is running on the desktop and that Mobile access includes the internet.', true);
    }
    if (code == 4429 || code == 4430 || code == 4503) {
      return MobileConnectionError('unreachable', 'The relay is busy or limiting this connection. Try again shortly.', true);
    }
    return _classifyEnd(null);
  }

  MobileConnectionError _classifyEnd(Object? cause) {
    final last = _lastStatus;
    if (last != null && isTerminalMobileStatus(last.code)) return MobileConnectionError.fromStatus(last);
    return classifyMobileTransportFailure(stage: _stage, endpoint: endpoint, cause: cause);
  }

  void _armTimeout() {
    _connectTimer?.cancel();
    _connectTimer = Timer(connectTimeout, () {
      _fail(classifyMobileTransportFailure(stage: _stage, endpoint: endpoint, timedOut: true));
    });
  }

  void _disarmTimeout() {
    _connectTimer?.cancel();
    _connectTimer = null;
  }

  void _resolve() {
    _ready = true;
    _disarmTimeout();
    if (!_settled) {
      _settled = true;
      _connecting?.complete();
    }
  }

  void _fail(MobileConnectionError error, {bool notify = true}) {
    _disarmTimeout();
    _legacyTimer?.cancel();
    if (_closed) return;
    _closed = true;
    _link?.destroy();
    for (final waiting in _pending.values) {
      waiting.timer.cancel();
      waiting.completer.completeError(error);
    }
    _pending.clear();
    if (!_settled) {
      _settled = true;
      _connecting?.completeError(error);
    } else if (notify) {
      for (final listener in [..._closeListeners]) {
        listener(error);
      }
    }
  }

  void _onStatus(MobileConnectionStatus status) {
    _legacyTimer?.cancel();
    _lastStatus = status;
    for (final listener in [..._statusListeners]) {
      listener(status);
    }
    if (isTerminalMobileStatus(status.code)) {
      _fail(MobileConnectionError.fromStatus(status));
      return;
    }
    if (status.code == 'ready') {
      _resolve();
      return;
    }
    if (status.code == 'pairing-required') {
      final token = pairingTokenId?.trim() ?? '';
      if (token.isEmpty) {
        _fail(MobileConnectionError.fromStatus(status));
        return;
      }
      _send({
        'id': 'pair',
        'kind': 'pair',
        'payload': {'tokenId': token},
      });
      return;
    }
    // pairing-pending: someone has to act on the desktop, so no deadline applies.
    _disarmTimeout();
  }

  void _onData(List<int> bytes, RecordAssembler assembler, SecureChannel channel) {
    if (_closed) return;
    List<Uint8List> records;
    try {
      records = assembler.push(bytes);
    } catch (error) {
      _fail(MobileConnectionError('protocol-error', 'The desktop sent a malformed record.', true, '$error'));
      return;
    }
    for (final record in records) {
      if (_closed) return;
      if (!channel.open) {
        try {
          channel.readHandshakeMessage(record);
        } catch (error) {
          _fail(
            MobileConnectionError(
              'handshake-failed',
              'The desktop’s identity did not match the host key this phone pinned. If the desktop reset its key, scan a new pairing invitation.',
              false,
              '$error',
            ),
          );
          return;
        }
        if (channel.open) {
          _stage = ConnectionStage.session;
          if (legacyReadyAfter > Duration.zero) {
            _legacyTimer = Timer(legacyReadyAfter, () {
              if (_closed || _settled) return;
              _resolve();
            });
          }
        }
        continue;
      }
      Map<String, dynamic> frame;
      try {
        frame = jsonDecode(utf8.decode(channel.decrypt(record))) as Map<String, dynamic>;
      } catch (error) {
        _fail(MobileConnectionError('protocol-error', 'A message from the desktop could not be decrypted.', true, '$error'));
        return;
      }
      switch (frame['kind']) {
        case 'status':
          final status = frame['status'] as Map<String, dynamic>? ?? const {};
          final code = status['code'];
          if (isMobileConnectionStatusCode(code)) _onStatus(mobileConnectionStatus(code as String, status['message'] as String?));
        case 'event':
          final envelope = frame['envelope'];
          if (envelope is Map<String, dynamic>) {
            for (final listener in [..._eventListeners]) {
              listener(envelope);
            }
          }
        case 'reply':
          final id = frame['id'];
          if (id == 'pair') {
            if (frame['ok'] != true) {
              _fail(MobileConnectionError('invitation-invalid', (frame['error'] as String?) ?? 'The desktop refused the pairing invitation.', false));
            }
            continue;
          }
          final waiting = _pending.remove(id);
          if (waiting == null) continue;
          waiting.timer.cancel();
          if (frame['ok'] == true) {
            waiting.completer.complete(frame['value']);
          } else {
            waiting.completer.completeError(MobileRequestError((frame['error'] as String?) ?? 'The desktop rejected the request.', frame['code'] as String?));
          }
      }
    }
  }

  void _send(Map<String, dynamic> frame) {
    final link = _link;
    final channel = _channel;
    if (link == null || channel == null || !channel.open || _closed) {
      throw MobileConnectionError('connection-lost', 'The Praxis desktop is not connected.', true);
    }
    link.add(channel.encrypt(utf8.encode(jsonEncode(frame))));
  }

  Future<Object?> request(String kind, Object? payload) {
    if (!isReady) {
      return Future.error(MobileConnectionError('connection-lost', 'The Praxis desktop is not connected.', true));
    }
    _requestSequence += 1;
    final id = 'm-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}-${_requestSequence.toRadixString(36)}';
    final completer = Completer<Object?>();
    final timer = Timer(requestTimeout, () {
      if (_pending.remove(id) != null) {
        completer.completeError(MobileConnectionError('timed-out', 'The Praxis desktop did not answer in time.', true));
      }
    });
    _pending[id] = _Pending(completer, timer);
    try {
      _send({'id': id, 'kind': kind, 'payload': payload});
    } catch (error) {
      timer.cancel();
      _pending.remove(id);
      return Future.error(error);
    }
    return completer.future;
  }

  Future<Object?> read(Object request) => this.request('read', request);
  Future<Object?> command(Object command) => request('command', command);

  /// Asks the desktop to stream every retained event after [afterSequence].
  Future<Object?> replay(int afterSequence) => request('replay', {'afterSequence': afterSequence});

  /// Closes without notifying close listeners (the caller chose to close).
  void close() {
    if (_connecting == null) {
      _closed = true;
      return;
    }
    _fail(MobileConnectionError('connection-lost', 'The connection was closed on this phone.', true), notify: false);
  }
}

class _Pending {
  _Pending(this.completer, this.timer);
  final Completer<Object?> completer;
  final Timer timer;
}

/// The byte pipe under the secure channel: a TCP socket on the LAN, or a WebSocket to the relay.
abstract class _Link {
  void add(List<int> bytes);
  void destroy();
}

class _SocketLink implements _Link {
  _SocketLink(this._socket);
  final Socket _socket;

  @override
  void add(List<int> bytes) => _socket.add(bytes);

  @override
  void destroy() => _socket.destroy();
}

class _WebSocketLink implements _Link {
  _WebSocketLink(this._socket);
  final WebSocket _socket;

  @override
  void add(List<int> bytes) => _socket.add(bytes);

  @override
  void destroy() => unawaited(_socket.close());
}
