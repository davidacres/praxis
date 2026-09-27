import 'dart:typed_data';

import 'noise.dart';

/// A Noise IK channel with length-prefixed framing: every record is a 4-byte
/// big-endian length followed by that many bytes. Port of `secureChannel.ts`.

const int maxRecord = 1 << 20;

Uint8List frame(List<int> payload) {
  if (payload.length > maxRecord) {
    throw StateError('Record of ${payload.length} bytes exceeds the $maxRecord limit.');
  }
  final out = Uint8List(4 + payload.length);
  ByteData.sublistView(out).setUint32(0, payload.length, Endian.big);
  out.setRange(4, out.length, payload);
  return out;
}

/// Buffers stream bytes and emits whole records as they complete.
class RecordAssembler {
  Uint8List _buffer = Uint8List(0);

  List<Uint8List> push(List<int> chunk) {
    final merged = Uint8List(_buffer.length + chunk.length)
      ..setRange(0, _buffer.length, _buffer)
      ..setRange(_buffer.length, _buffer.length + chunk.length, chunk);
    _buffer = merged;
    final records = <Uint8List>[];
    while (_buffer.length >= 4) {
      final length = ByteData.sublistView(_buffer, 0, 4).getUint32(0, Endian.big);
      if (length > maxRecord) throw StateError('Framed record claims $length bytes, over the $maxRecord limit.');
      if (_buffer.length < 4 + length) break;
      records.add(Uint8List.fromList(_buffer.sublist(4, 4 + length)));
      _buffer = Uint8List.fromList(_buffer.sublist(4 + length));
    }
    return records;
  }
}

/// One end of a Noise IK channel.
class SecureChannel {
  SecureChannel._(this.initiator, {required NoiseKeyPair staticKeyPair, Uint8List? remoteStaticPublicKey, List<int>? prologue, NoiseKeyPair? ephemeralKeyPair})
    : _handshake = Handshake(
        pattern: NoisePattern.ik,
        initiator: initiator,
        staticKeyPair: staticKeyPair,
        remoteStaticPublicKey: remoteStaticPublicKey,
        prologue: prologue,
        ephemeralKeyPair: ephemeralKeyPair,
      );

  factory SecureChannel.initiator({required NoiseKeyPair staticKeyPair, required Uint8List remoteStaticPublicKey, List<int>? prologue}) =>
      SecureChannel._(true, staticKeyPair: staticKeyPair, remoteStaticPublicKey: remoteStaticPublicKey, prologue: prologue);

  factory SecureChannel.responder({required NoiseKeyPair staticKeyPair, List<int>? prologue}) =>
      SecureChannel._(false, staticKeyPair: staticKeyPair, prologue: prologue);

  final bool initiator;
  final Handshake _handshake;
  CipherState? _send;
  CipherState? _receive;
  Uint8List? _remoteStatic;

  bool get open => _send != null && _receive != null;
  Uint8List? get peerStaticPublicKey => _remoteStatic;

  /// The next handshake record to send, framed.
  Uint8List nextHandshakeMessage([List<int> payload = const []]) {
    if (open) throw StateError('The handshake is already complete.');
    final record = frame(_handshake.writeMessage(payload));
    _capture();
    return record;
  }

  /// Consumes a (de-framed) handshake record from the peer.
  Uint8List readHandshakeMessage(List<int> record) {
    if (open) throw StateError('The handshake is already complete.');
    final payload = _handshake.readMessage(record);
    _capture();
    return payload;
  }

  void _capture() {
    final result = _handshake.finished;
    if (result == null) return;
    _send = result.send;
    _receive = result.receive;
    _remoteStatic = result.remoteStaticPublicKey;
  }

  Uint8List encrypt(List<int> plaintext) {
    final send = _send;
    if (send == null) throw StateError('The channel is not open.');
    return frame(send.encryptWithAd(const [], plaintext));
  }

  Uint8List decrypt(List<int> record) {
    final receive = _receive;
    if (receive == null) throw StateError('The channel is not open.');
    return receive.decryptWithAd(const [], record);
  }
}

/// Runs the IK handshake between two in-process channels (tests).
void completeHandshake(SecureChannel initiator, SecureChannel responder) {
  for (final record in RecordAssembler().push(initiator.nextHandshakeMessage())) {
    responder.readHandshakeMessage(record);
  }
  for (final record in RecordAssembler().push(responder.nextHandshakeMessage())) {
    initiator.readHandshakeMessage(record);
  }
  if (!initiator.open || !responder.open) throw StateError('The handshake did not complete.');
}
