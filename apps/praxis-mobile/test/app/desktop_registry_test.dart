import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/desktop_registry.dart';
import 'package:praxis_mobile/app/host_configuration.dart';
import 'package:praxis_mobile/core/palette.dart';

class MemoryDesktopStorage implements DesktopStorage {
  final values = <String, String>{};
  final operations = <String>[];
  String? failOperation;
  bool corruptWrite = false;
  void record(String operation) {
    operations.add(operation);
    if (failOperation == operation) throw StateError('Storage unavailable');
  }

  @override
  Future<String?> read(String key) async {
    record('read:$key');
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    record('write:$key');
    values[key] = corruptWrite ? '{}' : value;
  }

  @override
  Future<void> delete(String key) async {
    record('delete:$key');
    values.remove(key);
  }
}

HostConfiguration hostConfig(String id, {String? key, String address = '127.0.0.1', String? invitation}) => HostConfiguration(
  hostId: id,
  hostName: 'Desktop',
  address: address,
  port: 43100,
  hostPublicKeyHex: key ?? (id == 'A' ? 'a' : 'b') * 64,
  pairingTokenId: invitation,
);

final lightAppearance = readMobileAppearance({
  'themeId': 'praxis-light',
  'themeName': 'Praxis Light',
  'mode': 'light',
  'colors': {
    'bg': '#f5f2eb',
    'bgElevated': '#fffdf8',
    'bgSunken': '#ebe7de',
    'bgInput': '#fffdf8',
    'border': '#d5c8b8',
    'borderStrong': '#ad9a85',
    'text': '#2c2620',
    'textSecondary': '#74695e',
    'textTertiary': '#958878',
    'accent': '#c6431f',
    'accentContrast': '#fffdf8',
    'success': '#467a5b',
    'warning': '#9b6b22',
    'danger': '#b94a48',
  },
})!;

void main() {
  late MemoryDesktopStorage storage;
  late DesktopRepository repository;
  setUp(() {
    storage = MemoryDesktopStorage();
    repository = DesktopRepository(storage);
  });

  void legacy() {
    storage.values[legacyHostKey] = jsonEncode(hostConfig('A', invitation: 'spent').toJson());
    storage.values[legacyAppearanceKey] = jsonEncode(lightAppearance.raw);
    storage.values['praxis.mobile.devicePrivateKey.v1'] = 'unchanged-phone-key';
  }

  test('legacy migration verifies before removing values and never touches phone identity', () async {
    legacy();
    final first = await repository.load();
    expect(first.active!.configuration.hostId, 'A');
    expect(first.active!.configuration.pairingTokenId, isNull);
    expect(first.active!.appearance!.themeName, 'Praxis Light');
    expect(storage.values.containsKey(legacyHostKey), isFalse);
    final verification = storage.operations.lastIndexOf('read:$desktopRegistryKey');
    expect(verification, lessThan(storage.operations.indexOf('delete:$legacyHostKey')));
    expect((await repository.load()).activeEntryId, first.activeEntryId);
    expect(storage.values['praxis.mobile.devicePrivateKey.v1'], 'unchanged-phone-key');
    expect(storage.operations.any((operation) => operation.contains('devicePrivateKey')), isFalse);
  });

  test('failed migration write retains legacy data and queue recovers', () async {
    legacy();
    storage.failOperation = 'write:$desktopRegistryKey';
    await expectLater(repository.load(), throwsStateError);
    expect(storage.values[legacyHostKey], isNotNull);
    storage.failOperation = null;
    expect((await repository.load()).entries, hasLength(1));
  });

  test('failed readback retains both legacy values', () async {
    legacy();
    storage.corruptWrite = true;
    await expectLater(repository.load(), throwsStateError);
    expect(storage.values[legacyHostKey], isNotNull);
    expect(storage.values[legacyAppearanceKey], isNotNull);
  });

  test('interrupted cleanup resumes without duplicating migrated identity', () async {
    legacy();
    storage.failOperation = 'delete:$legacyHostKey';
    await expectLater(repository.load(), throwsStateError);
    final written = DesktopRegistry.decode(storage.values[desktopRegistryKey]!);
    storage.failOperation = null;
    final restored = await repository.load();
    expect(restored.entries, hasLength(1));
    expect(restored.activeEntryId, written.activeEntryId);
    expect(storage.values.containsKey(legacyHostKey), isFalse);
  });

  test('newer schemas and unreadable documents are never overwritten', () async {
    for (final raw in ['{"version":2,"entries":[]}', 'broken-json']) {
      storage.values[desktopRegistryKey] = raw;
      await expectLater(repository.saveAuthenticated(hostConfig('A')), throwsA(anything));
      expect(storage.values[desktopRegistryKey], raw);
    }
  });

  test('independent record recovery does not silently select another host', () async {
    final good = SavedDesktop(entryId: 'good', configuration: hostConfig('A'));
    storage.values[desktopRegistryKey] = jsonEncode({
      'version': 1,
      'activeEntryId': 'bad',
      'entries': [
        {'entryId': 'bad', 'configuration': <String, Object?>{}},
        good.toJson(),
        good.toJson(),
      ],
    });
    final result = await repository.load();
    expect(result.entries, hasLength(1));
    expect(result.active, isNull);
    expect(result.warnings, hasLength(3));
  });

  test('parallel saves serialize and same identity preserves nickname and preferences', () async {
    await Future.wait([repository.saveAuthenticated(hostConfig('A')), repository.saveAuthenticated(hostConfig('B'))]);
    var registry = await repository.load();
    final a = registry.entries.firstWhere((e) => e.configuration.hostId == 'A');
    await repository.rename(a.entryId, 'My desktop');
    await repository.cacheAppearance(a.entryId, lightAppearance);
    registry = await repository.saveAuthenticated(hostConfig('A', address: '192.168.1.12'));
    expect(registry.entries, hasLength(2));
    expect(registry.active!.entryId, a.entryId);
    expect(registry.active!.name, 'My desktop');
    expect(registry.active!.configuration.hostName, 'Desktop');
    expect(registry.active!.appearance!.themeName, 'Praxis Light');
    expect((await repository.rename(a.entryId, '')).active!.name, 'Desktop');
  });

  test('changed pinned key requires explicit replacement and drops old host data', () async {
    final old = (await repository.saveAuthenticated(hostConfig('A'))).active!;
    await repository.rename(old.entryId, 'Home');
    await repository.cacheAppearance(old.entryId, lightAppearance);
    await expectLater(repository.saveAuthenticated(hostConfig('A', key: 'c' * 64)), throwsStateError);
    final newEntry = (await repository.saveAuthenticated(hostConfig('A', key: 'c' * 64), replaceKey: true)).active!;
    expect(newEntry.entryId, isNot(old.entryId));
    expect(newEntry.name, 'Home');
    expect(newEntry.appearance, isNull);
  });

  test('late guarded writes do not commit after a switch', () async {
    await repository.saveAuthenticated(hostConfig('A'));
    final raw = storage.values[desktopRegistryKey];
    await expectLater(repository.saveAuthenticated(hostConfig('B'), isCurrent: () => false), throwsStateError);
    expect(storage.values[desktopRegistryKey], raw);
  });

  test('drafts with colliding context IDs stay scoped; forget preserves other entry and selection', () async {
    final a = (await repository.saveAuthenticated(hostConfig('A'))).active!;
    final b = (await repository.saveAuthenticated(hostConfig('B'))).active!;
    await repository.saveDraft(a.entryId, 'same-session', DesktopDraft(text: 'For A', updatedAt: DateTime.now().toUtc().toIso8601String()));
    await repository.saveDraft(b.entryId, 'same-session', DesktopDraft(text: 'For B', updatedAt: DateTime.now().toUtc().toIso8601String()));
    final registry = await repository.load();
    expect(registry.find(a.entryId)!.drafts['same-session']!.text, 'For A');
    expect(registry.find(b.entryId)!.drafts['same-session']!.text, 'For B');
    final forgotten = await repository.forget(a.entryId);
    expect(forgotten.activeEntryId, b.entryId);
    expect(forgotten.entries, hasLength(1));
    expect((await repository.forget(b.entryId)).active, isNull);
  });

  test('expired and damaged drafts do not discard the desktop', () async {
    final entry = SavedDesktop(entryId: 'a', configuration: hostConfig('A'));
    storage.values[desktopRegistryKey] = jsonEncode({
      'version': 1,
      'entries': [
        {
          ...entry.toJson(),
          'drafts': {
            'expired': {'text': 'old', 'updatedAt': '2020-01-01T00:00:00Z'},
            'damaged': <String, Object?>{},
          },
        },
      ],
    });
    final registry = await repository.load();
    expect(registry.entries, hasLength(1));
    expect(registry.entries.first.drafts, isEmpty);
  });
}
