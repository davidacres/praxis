import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/connection.dart';
import 'package:praxis_mobile/app/desktop_registry.dart';
import 'package:praxis_mobile/app/store.dart';
import 'package:praxis_mobile/app/theme.dart';

import '../app/desktop_registry_test.dart' show MemoryDesktopStorage;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('one phone pairs with two isolated real-protocol hosts and commands only its selection', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final root = await Directory.systemTemp.createTemp('PXMOB-F108-hosts-');
    final processes = <Process>[];
    final sockets = <ServerSocket>[];
    AppStore? store;
    try {
      for (var i = 0; i < 4; i++) {
        sockets.add(await ServerSocket.bind(InternetAddress.loopbackIPv4, 0));
      }
      final ports = sockets.map((socket) => socket.port).toList();
      for (final socket in sockets) {
        await socket.close();
      }
      final configs = <HostConfiguration>[];
      for (var i = 0; i < 2; i++) {
        final state = Directory('${root.path}/host-$i')..createSync();
        final process = await Process.start('node', [
          'tool/stage_host.cjs',
          '--host-id',
          'test-host-$i',
          '--name',
          'Duplicate desktop',
          '--state-dir',
          state.path,
          '--port',
          '${ports[i * 2]}',
          '--control',
          '${ports[i * 2 + 1]}',
        ]);
        processes.add(process);
        // Consume logs without publishing secret invitation/key material.
        process.stdout.drain<void>();
        final errors = StringBuffer();
        process.stderr.transform(utf8.decoder).listen(errors.write);
        final invitation = File('${state.path}/invitation.txt');
        for (var attempt = 0; attempt < 100 && !invitation.existsSync(); attempt++) {
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        expect(invitation.existsSync(), isTrue, reason: 'Isolated host did not start: $errors');
        final parts = invitation.readAsStringSync().split('|');
        configs.add(
          HostConfiguration(
            hostId: parts[1],
            hostName: 'Duplicate desktop',
            address: '127.0.0.1',
            port: ports[i * 2],
            hostPublicKeyHex: parts[2],
            pairingTokenId: parts[4],
          ),
        );
      }
      final repository = DesktopRepository(MemoryDesktopStorage());
      store = AppStore(theme: ThemeController(), repository: repository, initialize: false, identityCheck: (_) async => true);
      await store.connect(configs[0]);
      expect(store.connection, ShellConnection.ready);
      final a = store.selectedDesktop!;
      await store.connect(configs[1]);
      expect(store.connection, ShellConnection.ready);
      expect(store.desktops.entries, hasLength(2));
      final b = store.selectedDesktop!;
      expect(a.configuration.hostPublicKeyHex, isNot(b.configuration.hostPublicKeyHex));
      final pairedA = jsonDecode(File('${root.path}/host-0/paired.json').readAsStringSync()) as List;
      final pairedB = jsonDecode(File('${root.path}/host-1/paired.json').readAsStringSync()) as List;
      expect(pairedA.single[0], pairedB.single[0], reason: 'The phone must reuse its global identity.');
      await store.sendFollowUp(store.work.firstWhere((item) => item.sessionId == 'sess-pairing'), 'Only desktop B');
      expect(
        store.transcriptFor('sess-pairing').any((message) => message.text == 'Only desktop B'),
        isTrue,
        reason: store.followUps.map((item) => item.result).join('; '),
      );
      await store.selectDesktop(a.entryId);
      expect(store.connection, ShellConnection.ready);
      expect(store.transcriptFor('sess-pairing').any((message) => message.text == 'Only desktop B'), isFalse);
      await store.sendFollowUp(store.work.firstWhere((item) => item.sessionId == 'sess-pairing'), 'Only desktop A');
      await store.selectDesktop(b.entryId);
      expect(store.transcriptFor('sess-pairing').any((message) => message.text == 'Only desktop A'), isFalse);
      await store.forgetDesktop(a.entryId);
      expect(store.selectedDesktop!.entryId, b.entryId);
      expect(store.connection, ShellConnection.ready);
    } finally {
      store?.dispose();
      for (final process in processes) {
        process.kill();
        await process.exitCode;
      }
      await root.delete(recursive: true);
    }
  }, timeout: const Timeout(Duration(seconds: 45)));
}
