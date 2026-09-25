@Tags(['stage-host'])
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/protocol/client.dart';
import 'package:praxis_mobile/protocol/noise.dart';
import 'package:praxis_mobile/protocol/wire.dart';

import '../hex.dart';

// Runs against `node tool/stage_host.cjs`: the desktop's real LAN listener.
final _invitationFile = File('tool/.stage-host/invitation.txt');

Map<String, Object?> _read(String operation, [Map<String, String> target = const {}, Map<String, Object?>? params]) => {
      'protocolVersion': 1,
      'requestId': 'read:${DateTime.now().microsecondsSinceEpoch}',
      'caller': {'deviceId': 'praxis-mobile', 'capabilities': ['view', 'execute', 'approve']},
      'target': {'hostId': 'stage-host', 'projectId': 'praxis', ...target},
      'operation': operation,
      if (params != null) 'params': params,
    };

void main() {
  final skip = _invitationFile.existsSync() ? null : 'Start tool/stage_host.cjs first';

  test('a new phone pairs with an invitation, then reads over the encrypted channel', () async {
    final parts = _invitationFile.readAsStringSync().split('|');
    final endpoint = parts[3].split(':');
    final client = MobileSecureClient(
      host: endpoint[0],
      port: int.parse(endpoint[1]),
      staticKeyPair: NoiseKeyPair.generate(),
      remoteStaticPublicKey: fromHex(parts[2]),
      pairingTokenId: parts[4],
    );
    final statuses = <String>[];
    client.onStatus((status) => statuses.add(status.code));
    await client.connect();
    expect(statuses, ['pairing-required', 'pairing-pending', 'ready']);

    final info = await client.read(_read('host.info')) as Map<String, dynamic>;
    expect(info['surfaceRevision'], 5);
    final sessions = await client.read(_read('sessions.list')) as List<dynamic>;
    expect(sessions, isNotEmpty);
    final diff = await client.read(_read('changes.get', {'sessionId': 'sess-pairing'}, {'path': 'package-lock.json'})) as Map<String, dynamic>;
    expect(diff['hunks'], isNotEmpty);
    final replay = await client.replay(info['latestSequence'] as int) as Map<String, dynamic>;
    expect(replay['replaying'], true);
    client.close();
  }, skip: skip);

  test('a wrong pinned key is reported as a handshake failure, not a bare close', () async {
    final parts = _invitationFile.readAsStringSync().split('|');
    final endpoint = parts[3].split(':');
    final client = MobileSecureClient(
      host: endpoint[0],
      port: int.parse(endpoint[1]),
      staticKeyPair: NoiseKeyPair.generate(),
      remoteStaticPublicKey: NoiseKeyPair.generate().publicKey,
      connectTimeout: const Duration(seconds: 4),
    );
    await expectLater(client.connect(), throwsA(isA<MobileConnectionError>().having((e) => e.code, 'code', 'handshake-rejected')));
  }, skip: skip);

  test('nothing listening is reported as unreachable', () async {
    final client = MobileSecureClient(
      host: '127.0.0.1',
      port: 9,
      staticKeyPair: NoiseKeyPair.generate(),
      remoteStaticPublicKey: NoiseKeyPair.generate().publicKey,
    );
    await expectLater(client.connect(), throwsA(isA<MobileConnectionError>().having((e) => e.code, 'code', 'unreachable')));
  });
}
