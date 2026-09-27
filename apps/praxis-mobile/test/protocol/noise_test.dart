import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/protocol/noise.dart';
import 'package:praxis_mobile/protocol/secure_channel.dart';

import '../hex.dart';

// The same canonical `snow` vectors `@praxis/mobile-protocol` is checked against.
final _vectors = (jsonDecode(File('../../packages/mobile-protocol/src/noiseVectors.fixture.json').readAsStringSync())
    as Map<String, dynamic>)['vectors'] as List<dynamic>;

NoisePattern _patternOf(String name) => switch (name.split('_')[1]) {
      'IK' => NoisePattern.ik,
      'NK' => NoisePattern.nk,
      _ => NoisePattern.xx,
    };

void main() {
  for (final raw in _vectors) {
    final vector = raw as Map<String, dynamic>;
    final name = vector['protocol_name'] as String;
    test('$name matches the snow test vector', () {
      final pattern = _patternOf(name);
      final prologue = fromHex(vector['init_prologue'] as String);
      final initStatic = vector['init_static'] as String?;
      final initRemote = vector['init_remote_static'] as String?;
      final respStatic = vector['resp_static'] as String?;
      final initiator = Handshake(
        pattern: pattern,
        initiator: true,
        prologue: prologue,
        staticKeyPair: initStatic == null ? null : NoiseKeyPair.generate(fromHex(initStatic)),
        remoteStaticPublicKey: initRemote == null ? null : fromHex(initRemote),
        ephemeralKeyPair: NoiseKeyPair.generate(fromHex(vector['init_ephemeral'] as String)),
      );
      final responder = Handshake(
        pattern: pattern,
        initiator: false,
        prologue: prologue,
        staticKeyPair: respStatic == null ? null : NoiseKeyPair.generate(fromHex(respStatic)),
        ephemeralKeyPair: NoiseKeyPair.generate(fromHex(vector['resp_ephemeral'] as String)),
      );
      final handshakeMessages = pattern == NoisePattern.xx ? 3 : 2;
      final messages = (vector['messages'] as List<dynamic>).cast<Map<String, dynamic>>();
      for (var i = 0; i < messages.length; i += 1) {
        final payload = messages[i]['payload'] as String;
        final ciphertext = messages[i]['ciphertext'] as String;
        final initiatorSends = i.isEven;
        final writer = initiatorSends ? initiator : responder;
        final reader = initiatorSends ? responder : initiator;
        if (i < handshakeMessages) {
          final produced = writer.writeMessage(fromHex(payload));
          expect(toHex(produced), ciphertext, reason: 'message $i ciphertext');
          expect(toHex(reader.readMessage(produced)), payload, reason: 'message $i payload');
        } else {
          final produced = writer.finished!.send.encryptWithAd(const [], fromHex(payload));
          expect(toHex(produced), ciphertext, reason: 'transport message $i ciphertext');
          expect(toHex(reader.finished!.receive.decryptWithAd(const [], produced)), payload, reason: 'transport message $i payload');
        }
      }
      expect(toHex(initiator.finished!.handshakeHash), toHex(responder.finished!.handshakeHash));
      if (pattern != NoisePattern.nk) {
        expect(toHex(initiator.finished!.remoteStaticPublicKey!), toHex(NoiseKeyPair.generate(fromHex(respStatic!)).publicKey));
        expect(toHex(responder.finished!.remoteStaticPublicKey!), toHex(NoiseKeyPair.generate(fromHex(initStatic!)).publicKey));
      }
    });
  }

  test('IK: a live handshake with random keys yields a working two-way channel', () {
    final phone = NoiseKeyPair.generate();
    final desktop = NoiseKeyPair.generate();
    final initiator = SecureChannel.initiator(staticKeyPair: phone, remoteStaticPublicKey: desktop.publicKey);
    final responder = SecureChannel.responder(staticKeyPair: desktop);
    completeHandshake(initiator, responder);
    expect(toHex(responder.peerStaticPublicKey!), toHex(phone.publicKey));
    final assembler = RecordAssembler();
    final record = assembler.push(initiator.encrypt(utf8.encode('hello desktop'))).single;
    expect(utf8.decode(responder.decrypt(record)), 'hello desktop');
    final back = assembler.push(responder.encrypt(utf8.encode('hello phone'))).single;
    expect(utf8.decode(initiator.decrypt(back)), 'hello phone');
  });

  test('IK: pinning the wrong desktop key fails the handshake', () {
    final phone = NoiseKeyPair.generate();
    final desktop = NoiseKeyPair.generate();
    final attacker = NoiseKeyPair.generate();
    final initiator = SecureChannel.initiator(staticKeyPair: phone, remoteStaticPublicKey: attacker.publicKey);
    final responder = SecureChannel.responder(staticKeyPair: desktop);
    final first = RecordAssembler().push(initiator.nextHandshakeMessage()).single;
    expect(() => responder.readHandshakeMessage(first), throwsA(isA<NoiseDecryptError>()));
  });

  test('records reassemble across arbitrary chunk boundaries', () {
    final assembler = RecordAssembler();
    final a = frame(Uint8List.fromList([1, 2, 3]));
    final b = frame(Uint8List.fromList(List<int>.generate(300, (i) => i % 256)));
    final stream = [...a, ...b];
    final out = <Uint8List>[];
    for (var i = 0; i < stream.length; i += 7) {
      out.addAll(assembler.push(stream.sublist(i, i + 7 > stream.length ? stream.length : i + 7)));
    }
    expect(out.length, 2);
    expect(out[0], [1, 2, 3]);
    expect(out[1].length, 300);
  });
}
