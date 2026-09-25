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

  String get endpoint => '$host:$port';

  Socket? _socket;
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

    Socket.connect(host, port, timeout: const Duration(seconds: 10)).then(
      (socket) {
        if (_closed) {
          socket.destroy();
          return;
        }
        _socket = socket;
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
    _socket?.destroy();
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
    final socket = _socket;
    final channel = _channel;
    if (socket == null || channel == null || !channel.open || _closed) {
      throw MobileConnectionError('connection-lost', 'The Praxis desktop is not connected.', true);
    }
    socket.add(channel.encrypt(utf8.encode(jsonEncode(frame))));
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
