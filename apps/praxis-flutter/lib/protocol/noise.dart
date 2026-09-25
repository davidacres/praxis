import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';

/// Noise Protocol Framework — the `*_25519_ChaChaPoly_SHA256` suite, patterns
/// IK / NK / XX. A port of `@praxis/mobile-protocol`'s `noise.ts`, checked
/// against the same `snow` vectors. The product uses IK: the phone already
/// holds the desktop's static key from pairing.

const int dhLen = 32;
const int hashLen = 32;
const int tagLen = 16;
// 2^64 - 1 does not fit a Dart int; the counter never gets near 2^63.
const int _maxNonce = 0x7fffffffffffffff;

const _x25519 = DartX25519();
const _aead = DartChacha20.poly1305Aead();
const _sha256 = DartSha256();
const _hmac = DartHmac(DartSha256());

enum NoisePattern { ik, nk, xx }

class NoiseKeyPair {
  NoiseKeyPair(this.privateKey, this.publicKey);

  final Uint8List privateKey;
  final Uint8List publicKey;

  /// A keypair from 32 seed bytes, or a fresh random one.
  factory NoiseKeyPair.generate([List<int>? seed]) {
    final private = Uint8List.fromList(seed?.sublist(0, dhLen) ?? _randomBytes(dhLen));
    return NoiseKeyPair(private, _publicKeyOf(private));
  }
}

final _random = Random.secure();
Uint8List _randomBytes(int length) => Uint8List.fromList(List<int>.generate(length, (_) => _random.nextInt(256)));

final Uint8List _basePoint = Uint8List(32)..[0] = 9;

Uint8List _dh(Uint8List privateKey, Uint8List publicKey) {
  final pair = SimpleKeyPairData(
    privateKey,
    publicKey: SimplePublicKey(_basePoint, type: KeyPairType.x25519),
    type: KeyPairType.x25519,
  );
  final secret = _x25519.sharedSecretSync(
    keyPairData: pair,
    remotePublicKey: SimplePublicKey(publicKey, type: KeyPairType.x25519),
  );
  return Uint8List.fromList((secret as SecretKeyData).bytes);
}

/// X25519(k, 9) is the public key for private key k.
Uint8List _publicKeyOf(Uint8List privateKey) => _dh(privateKey, _basePoint);

Uint8List concat(List<List<int>> parts) {
  final out = BytesBuilder(copy: false);
  for (final part in parts) {
    out.add(part);
  }
  return out.toBytes();
}

Uint8List sha256(List<int> data) => Uint8List.fromList(_sha256.hashSync(data).bytes);

Uint8List _hmacSha256(List<int> key, List<int> data) =>
    Uint8List.fromList(_hmac.calculateMacSync(data, secretKeyData: SecretKeyData(key), nonce: const []).bytes);

/// Noise HKDF: an HMAC-SHA256 chain producing 2 or 3 HASHLEN outputs.
List<Uint8List> _hkdf(Uint8List chainingKey, List<int> inputKeyMaterial, int outputs) {
  final tempKey = _hmacSha256(chainingKey, inputKeyMaterial);
  final o1 = _hmacSha256(tempKey, [1]);
  final o2 = _hmacSha256(
    tempKey,
    concat([
      o1,
      [2],
    ]),
  );
  if (outputs == 2) return [o1, o2];
  final o3 = _hmacSha256(
    tempKey,
    concat([
      o2,
      [3],
    ]),
  );
  return [o1, o2, o3];
}

/// 32 zero bits followed by the 64-bit little-endian counter.
Uint8List _nonceBytes(int n) {
  final out = Uint8List(12);
  ByteData.sublistView(out).setUint64(4, n, Endian.little);
  return out;
}

class NoiseDecryptError implements Exception {
  NoiseDecryptError(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Noise CipherState — an AEAD key plus a monotonic nonce.
class CipherState {
  CipherState([this._key]);

  final Uint8List? _key;
  int _nonce = 0;

  bool get hasKey => _key != null;
  int get nonce => _nonce;

  Uint8List encryptWithAd(List<int> ad, List<int> plaintext) {
    final key = _key;
    if (key == null) return Uint8List.fromList(plaintext);
    if (_nonce >= _maxNonce) throw StateError('Noise nonce exhausted; rekey required.');
    final box = _aead.encryptSync(plaintext, secretKey: SecretKeyData(key), nonce: _nonceBytes(_nonce), aad: ad);
    _nonce += 1;
    return concat([box.cipherText, box.mac.bytes]);
  }

  Uint8List decryptWithAd(List<int> ad, List<int> ciphertext) {
    final key = _key;
    if (key == null) return Uint8List.fromList(ciphertext);
    if (_nonce >= _maxNonce) throw StateError('Noise nonce exhausted; rekey required.');
    if (ciphertext.length < tagLen) throw NoiseDecryptError('Ciphertext is shorter than its tag.');
    final box = SecretBox(
      ciphertext.sublist(0, ciphertext.length - tagLen),
      nonce: _nonceBytes(_nonce),
      mac: Mac(ciphertext.sublist(ciphertext.length - tagLen)),
    );
    try {
      final plain = _aead.decryptSync(box, secretKey: SecretKeyData(key), aad: ad);
      _nonce += 1;
      return Uint8List.fromList(plain);
    } on SecretBoxAuthenticationError {
      throw NoiseDecryptError('The message did not authenticate.');
    }
  }
}

class _SymmetricState {
  _SymmetricState(String protocolName) {
    final name = utf8.encode(protocolName);
    h = name.length <= hashLen ? concat([name, Uint8List(hashLen - name.length)]) : sha256(name);
    ck = Uint8List.fromList(h);
  }

  late Uint8List ck;
  late Uint8List h;
  CipherState cipher = CipherState();

  void mixKey(List<int> input) {
    final out = _hkdf(ck, input, 2);
    ck = out[0];
    cipher = CipherState(out[1].sublist(0, hashLen));
  }

  void mixHash(List<int> data) => h = sha256(concat([h, data]));

  Uint8List encryptAndHash(List<int> plaintext) {
    final ciphertext = cipher.encryptWithAd(h, plaintext);
    mixHash(ciphertext);
    return ciphertext;
  }

  Uint8List decryptAndHash(List<int> ciphertext) {
    final plaintext = cipher.decryptWithAd(h, ciphertext);
    mixHash(ciphertext);
    return plaintext;
  }

  List<CipherState> split() {
    final out = _hkdf(ck, const [], 2);
    return [CipherState(out[0].sublist(0, hashLen)), CipherState(out[1].sublist(0, hashLen))];
  }
}

enum _Token { e, s, ee, es, se, ss }

class _PatternSpec {
  const _PatternSpec(this.preResponder, this.messages);
  final List<_Token> preResponder;
  final List<List<_Token>> messages;
}

const Map<NoisePattern, _PatternSpec> _patterns = {
  NoisePattern.ik: _PatternSpec(
    [_Token.s],
    [
      [_Token.e, _Token.es, _Token.s, _Token.ss],
      [_Token.e, _Token.ee, _Token.se],
    ],
  ),
  NoisePattern.nk: _PatternSpec(
    [_Token.s],
    [
      [_Token.e, _Token.es],
      [_Token.e, _Token.ee],
    ],
  ),
  NoisePattern.xx: _PatternSpec([], [
    [_Token.e],
    [_Token.e, _Token.ee, _Token.s, _Token.es],
    [_Token.s, _Token.se],
  ]),
};

const Map<NoisePattern, String> _patternNames = {NoisePattern.ik: 'IK', NoisePattern.nk: 'NK', NoisePattern.xx: 'XX'};

class HandshakeResult {
  HandshakeResult(this.send, this.receive, this.handshakeHash, this.remoteStaticPublicKey);
  final CipherState send;
  final CipherState receive;
  final Uint8List handshakeHash;
  final Uint8List? remoteStaticPublicKey;
}

/// A Noise handshake in progress. Alternate [writeMessage] / [readMessage] per the pattern.
class Handshake {
  Handshake({
    required NoisePattern pattern,
    required this.initiator,
    List<int>? prologue,
    this.staticKeyPair,
    Uint8List? remoteStaticPublicKey,
    NoiseKeyPair? ephemeralKeyPair,
  }) : _rs = remoteStaticPublicKey,
       _forcedEphemeral = ephemeralKeyPair,
       _queue = _patterns[pattern]!.messages.map((tokens) => [...tokens]).toList(),
       _sym = _SymmetricState('Noise_${_patternNames[pattern]}_25519_ChaChaPoly_SHA256') {
    _sym.mixHash(prologue ?? const []);
    for (final token in _patterns[pattern]!.preResponder) {
      if (token != _Token.s) continue;
      final pub = initiator ? _rs : staticKeyPair?.publicKey;
      if (pub == null) throw StateError('Missing key for pre-message token "s".');
      _sym.mixHash(pub);
    }
  }

  final bool initiator;
  final NoiseKeyPair? staticKeyPair;
  final _SymmetricState _sym;
  final List<List<_Token>> _queue;
  NoiseKeyPair? _e;
  Uint8List? _rs;
  Uint8List? _re;
  NoiseKeyPair? _forcedEphemeral;
  HandshakeResult? _result;

  bool get done => _queue.isEmpty;
  HandshakeResult? get finished => _result;

  Uint8List writeMessage([List<int> payload = const []]) {
    if (_queue.isEmpty) throw StateError('The handshake has no more messages to write.');
    final tokens = _queue.removeAt(0);
    final message = BytesBuilder(copy: false);
    for (final token in tokens) {
      switch (token) {
        case _Token.e:
          _e = _forcedEphemeral ?? NoiseKeyPair.generate();
          _forcedEphemeral = null;
          message.add(_e!.publicKey);
          _sym.mixHash(_e!.publicKey);
        case _Token.s:
          final s = staticKeyPair;
          if (s == null) throw StateError('This handshake has no static key to send.');
          message.add(_sym.encryptAndHash(s.publicKey));
        default:
          _mixDh(token);
      }
    }
    message.add(_sym.encryptAndHash(payload));
    if (done) _finish();
    return message.toBytes();
  }

  Uint8List readMessage(List<int> message) {
    if (_queue.isEmpty) throw StateError('The handshake has no more messages to read.');
    final tokens = _queue.removeAt(0);
    var offset = 0;
    for (final token in tokens) {
      switch (token) {
        case _Token.e:
          if (message.length < offset + dhLen) throw NoiseDecryptError('Handshake message is too short.');
          _re = Uint8List.fromList(message.sublist(offset, offset + dhLen));
          offset += dhLen;
          _sym.mixHash(_re!);
        case _Token.s:
          final length = _sym.cipher.hasKey ? dhLen + tagLen : dhLen;
          if (message.length < offset + length) throw NoiseDecryptError('Handshake message is too short.');
          _rs = _sym.decryptAndHash(message.sublist(offset, offset + length));
          offset += length;
        default:
          _mixDh(token);
      }
    }
    final payload = _sym.decryptAndHash(message.sublist(offset));
    if (done) _finish();
    return payload;
  }

  void _mixDh(_Token token) {
    final e = _e;
    final s = staticKeyPair;
    Uint8List secret;
    switch (token) {
      case _Token.ee:
        secret = _dh(e!.privateKey, _re!);
      case _Token.es:
        secret = initiator ? _dh(e!.privateKey, _rs!) : _dh(s!.privateKey, _re!);
      case _Token.se:
        secret = initiator ? _dh(s!.privateKey, _re!) : _dh(e!.privateKey, _rs!);
      case _Token.ss:
        secret = _dh(s!.privateKey, _rs!);
      default:
        throw StateError('Not a DH token: $token');
    }
    _sym.mixKey(secret);
  }

  void _finish() {
    final pair = _sym.split();
    _result = HandshakeResult(
      initiator ? pair[0] : pair[1],
      initiator ? pair[1] : pair[0],
      Uint8List.fromList(_sym.h),
      _rs == null ? null : Uint8List.fromList(_rs!),
    );
  }
}
