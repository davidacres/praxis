import 'dart:async';
import 'dart:convert';
import 'dart:math';

import '../core/palette.dart';
import 'host_configuration.dart';

const desktopRegistryKey = 'praxis.mobile.desktops.v1';
const legacyHostKey = 'praxis.mobile.hostConfiguration.v1';
const legacyAppearanceKey = 'praxis.mobile.desktopAppearance.v1';

/// The repository owns serialization. Adapters must surface I/O failures.
abstract interface class DesktopStorage {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

String _text(Object? value, String field) {
  if (value is! String || value.trim().isEmpty) throw FormatException('Invalid $field');
  return value.trim();
}

HostConfiguration _configuration(Object? raw) {
  final json = Map<String, dynamic>.from(raw as Map);
  _text(json['hostId'], 'host ID');
  _text(json['address'], 'address');
  final key = _text(json['hostPublicKeyHex'], 'host key');
  if (!RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(key)) throw const FormatException('Invalid host key');
  final port = json['port'];
  if (port is! int || port < 1 || port > 65535) throw const FormatException('Invalid port');
  final relay = json['relayUrl'];
  final channel = json['relayChannel'];
  if ((relay == null) != (channel == null)) throw const FormatException('Incomplete relay route');
  if (relay != null) {
    final uri = Uri.tryParse(_text(relay, 'relay URL'));
    if (uri == null || !['ws', 'wss'].contains(uri.scheme) || uri.host.isEmpty || uri.userInfo.isNotEmpty) {
      throw const FormatException('Invalid relay URL');
    }
    _text(channel, 'relay channel');
  }
  return HostConfiguration.fromJson({...json, 'hostPublicKeyHex': key.toLowerCase()});
}

/// Unsent composer state, never an executable command. Expired entries are
/// ignored on read and removed on the next registry write (30 days).
class DesktopDraft {
  DesktopDraft({
    required this.text,
    required this.updatedAt,
    this.newChat = false,
    this.projectId,
    this.provider,
    this.model,
    this.mode = 'chat',
  });
  final String text;
  final String updatedAt;
  final bool newChat;
  final String? projectId;
  final String? provider;
  final String? model;
  final String mode;
  bool get expired => DateTime.now().toUtc().difference(DateTime.parse(updatedAt)) > const Duration(days: 30);
  factory DesktopDraft.fromJson(Object? raw) {
    final json = Map<String, dynamic>.from(raw as Map);
    final at = _text(json['updatedAt'], 'draft time');
    if (DateTime.tryParse(at) == null) throw const FormatException('Invalid draft time');
    final mode = json['mode'] as String? ?? 'chat';
    if (!['chat', 'analysis', 'review'].contains(mode)) throw const FormatException('Invalid draft mode');
    return DesktopDraft(
      text: json['text'] as String,
      updatedAt: at,
      newChat: json['newChat'] == true,
      projectId: json['projectId'] as String?,
      provider: json['provider'] as String?,
      model: json['model'] as String?,
      mode: mode,
    );
  }
  Map<String, Object?> toJson() => {
    'text': text,
    'updatedAt': updatedAt,
    'newChat': newChat,
    'projectId': projectId,
    'provider': provider,
    'model': model,
    'mode': mode,
  };
}

class SavedDesktop {
  SavedDesktop({
    required this.entryId,
    required this.configuration,
    this.nickname,
    this.appearance,
    this.lastUsedAt,
    Map<String, DesktopDraft> drafts = const {},
  }) : drafts = Map.unmodifiable(drafts);
  final String entryId;
  final HostConfiguration configuration;
  final String? nickname;
  final Appearance? appearance;
  final String? lastUsedAt;
  final Map<String, DesktopDraft> drafts;

  String get name =>
      [nickname, configuration.hostName, configuration.address].whereType<String>().firstWhere((s) => s.trim().isNotEmpty).trim();
  bool sameIdentity(HostConfiguration config) =>
      configuration.hostId == config.hostId && configuration.hostPublicKeyHex.toLowerCase() == config.hostPublicKeyHex.toLowerCase();

  factory SavedDesktop.fromJson(Object? raw) {
    final json = Map<String, dynamic>.from(raw as Map);
    final config = _configuration(json['configuration']);
    if (config.pairingTokenId != null || config.pairingExpiresAt != null) throw const FormatException('Saved invitations are not allowed');
    final nickname = json['nickname'] as String?;
    if (nickname != null && (nickname.trim().isEmpty || nickname.length > 100)) throw const FormatException('Invalid nickname');
    final at = json['lastUsedAt'] as String?;
    if (at != null && DateTime.tryParse(at) == null) throw const FormatException('Invalid last-used time');
    final drafts = <String, DesktopDraft>{};
    final storedDrafts = json['drafts'];
    if (storedDrafts is Map) {
      for (final item in storedDrafts.entries) {
        try {
          final draft = DesktopDraft.fromJson(item.value);
          if (item.key is String && !draft.expired) drafts[item.key as String] = draft;
        } catch (_) {
          /* A damaged draft does not discard desktop trust. */
        }
      }
    }
    return SavedDesktop(
      drafts: drafts,
      entryId: _text(json['entryId'], 'entry ID'),
      configuration: config,
      nickname: nickname,
      appearance: readMobileAppearance(json['appearance']),
      lastUsedAt: at,
    );
  }

  Map<String, Object?> toJson() => {
    'entryId': entryId,
    'configuration': configuration.toJson(),
    if (nickname != null) 'nickname': nickname,
    if (appearance != null) 'appearance': appearance!.raw,
    if (lastUsedAt != null) 'lastUsedAt': lastUsedAt,
    'drafts': {
      for (final item in drafts.entries)
        if (!item.value.expired) item.key: item.value.toJson(),
    },
  };
}

class DesktopRegistry {
  DesktopRegistry({List<SavedDesktop> entries = const [], this.activeEntryId, List<String> warnings = const []})
    : entries = List.unmodifiable(entries),
      warnings = List.unmodifiable(warnings);
  final List<SavedDesktop> entries;
  final String? activeEntryId;
  final List<String> warnings;
  SavedDesktop? find(String? id) => entries.where((entry) => entry.entryId == id).firstOrNull;
  SavedDesktop? get active => find(activeEntryId);

  factory DesktopRegistry.decode(String raw) {
    final json = jsonDecode(raw) as Map<String, dynamic>;
    if (json['version'] != 1) throw StateError('Unsupported saved desktop schema. Update Praxis before changing desktops.');
    if (json['entries'] is! List) throw const FormatException('Invalid saved desktop list');
    final entries = <SavedDesktop>[];
    final warnings = <String>[];
    for (final raw in json['entries'] as List) {
      try {
        final entry = SavedDesktop.fromJson(raw);
        if (entries.any((e) => e.entryId == entry.entryId || e.configuration.hostId == entry.configuration.hostId)) {
          throw const FormatException('Duplicate saved identity');
        }
        entries.add(entry);
      } catch (_) {
        warnings.add('A damaged or duplicate desktop record was skipped. Pair that desktop again.');
      }
    }
    final activeId = json['activeEntryId'];
    final active = activeId is String && entries.any((e) => e.entryId == activeId) ? activeId : null;
    if (activeId != null && active == null) warnings.add('The selected desktop is unavailable. Select a saved desktop.');
    return DesktopRegistry(entries: entries, activeEntryId: active, warnings: warnings);
  }

  String encode() => jsonEncode({'version': 1, 'activeEntryId': activeEntryId, 'entries': entries.map((entry) => entry.toJson()).toList()});
}

/// Read-modify-write operations are serialized, including migration and reads.
/// A failed operation does not poison the queue; callers still receive its error.
class DesktopRepository {
  DesktopRepository(this.storage);
  final DesktopStorage storage;
  Future<void> _tail = Future.value();

  Future<T> _serial<T>(Future<T> Function() operation) {
    final next = _tail.then((_) => operation());
    _tail = next.then<void>((_) {}, onError: (Object error, StackTrace stack) {});
    return next;
  }

  Future<void> _commit(DesktopRegistry registry) async {
    final encoded = registry.encode();
    await storage.write(desktopRegistryKey, encoded);
    if (await storage.read(desktopRegistryKey) != encoded) {
      throw StateError('Saved desktops could not be verified. Try again before leaving this screen.');
    }
  }

  Future<DesktopRegistry> _load() async {
    final stored = await storage.read(desktopRegistryKey);
    if (stored != null) {
      final registry = DesktopRegistry.decode(stored);
      // Cleanup is resumable, but only when the legacy identity made it across.
      final legacy = await storage.read(legacyHostKey);
      if (legacy != null) {
        HostConfiguration? config;
        try {
          config = _configuration(jsonDecode(legacy));
        } catch (_) {
          /* Retain malformed legacy data for recovery. */
        }
        if (config != null && registry.entries.any((entry) => entry.sameIdentity(config!))) {
          await storage.delete(legacyAppearanceKey);
          await storage.delete(legacyHostKey);
        }
      }
      return registry;
    }
    final legacy = await storage.read(legacyHostKey);
    if (legacy == null) return DesktopRegistry();
    final config = _configuration(jsonDecode(legacy)).withoutInvitation();
    final appearance = await storage.read(legacyAppearanceKey);
    Appearance? theme;
    final warnings = <String>[];
    if (appearance != null) {
      try {
        theme = readMobileAppearance(jsonDecode(appearance));
      } catch (_) {
        warnings.add('The old desktop theme could not be recovered.');
      }
    }
    final entry = SavedDesktop(entryId: _newId(), configuration: config, appearance: theme);
    final registry = DesktopRegistry(entries: [entry], activeEntryId: entry.entryId, warnings: warnings);
    await _commit(registry);
    await storage.delete(legacyAppearanceKey);
    await storage.delete(legacyHostKey);
    return registry;
  }

  Future<DesktopRegistry> load() => _serial(_load);

  Future<DesktopRegistry> _update(DesktopRegistry Function(DesktopRegistry) update, {bool Function()? isCurrent}) => _serial(() async {
    final current = await _load();
    if (isCurrent != null && !isCurrent()) throw StateError('The desktop selection changed.');
    final next = update(current);
    await _commit(next);
    return next;
  });

  Future<DesktopRegistry> select(String? id) => _update((registry) {
    if (id != null && registry.find(id) == null) throw StateError('That desktop is no longer saved.');
    return DesktopRegistry(entries: registry.entries, activeEntryId: id);
  });

  /// Call only after the pinned encrypted connection has authenticated.
  Future<DesktopRegistry> saveAuthenticated(HostConfiguration configuration, {bool replaceKey = false, bool Function()? isCurrent}) =>
      _update((registry) {
        final config = _configuration(configuration.toJson()).withoutInvitation();
        final old = registry.entries.where((entry) => entry.configuration.hostId == config.hostId).firstOrNull;
        final matches = old?.sameIdentity(config) ?? false;
        if (old != null && !matches && !replaceKey) throw StateError('This desktop’s key changed. Confirm a new pairing first.');
        final entry = SavedDesktop(
          entryId: matches ? old!.entryId : _newId(),
          configuration: config,
          nickname: old?.nickname,
          appearance: matches ? old?.appearance : null,
          drafts: matches ? old!.drafts : {},
          lastUsedAt: DateTime.now().toUtc().toIso8601String(),
        );
        return DesktopRegistry(entries: [...registry.entries.where((e) => e != old), entry], activeEntryId: entry.entryId);
      }, isCurrent: isCurrent);

  Future<DesktopRegistry> rename(String id, String? nickname) => _update((registry) {
    final old = registry.find(id);
    if (old == null) throw StateError('That desktop is no longer saved.');
    final name = nickname?.trim();
    if (name != null && name.length > 100) throw StateError('Use at most 100 characters for the nickname.');
    final entry = SavedDesktop(
      entryId: id,
      configuration: old.configuration,
      nickname: name == null || name.isEmpty ? null : name,
      appearance: old.appearance,
      lastUsedAt: old.lastUsedAt,
      drafts: old.drafts,
    );
    return DesktopRegistry(
      entries: registry.entries.map((e) => e.entryId == id ? entry : e).toList(),
      activeEntryId: registry.activeEntryId,
    );
  });

  Future<DesktopRegistry> cacheAppearance(String id, Appearance appearance, {bool Function()? isCurrent}) => _update((registry) {
    if (registry.find(id) == null) throw StateError('That desktop is no longer saved.');
    return DesktopRegistry(
      entries: registry.entries
          .map(
            (e) => e.entryId == id
                ? SavedDesktop(
                    entryId: id,
                    configuration: e.configuration,
                    nickname: e.nickname,
                    appearance: appearance,
                    lastUsedAt: e.lastUsedAt,
                    drafts: e.drafts,
                  )
                : e,
          )
          .toList(),
      activeEntryId: registry.activeEntryId,
    );
  }, isCurrent: isCurrent);

  Future<DesktopRegistry> saveDraft(String id, String context, DesktopDraft? draft) => _update((registry) {
    final old = registry.find(id);
    if (old == null) throw StateError('That desktop is no longer saved.');
    final drafts = {...old.drafts};
    if (draft == null) {
      drafts.remove(context);
    } else {
      drafts[context] = draft;
    }
    final entry = SavedDesktop(
      entryId: id,
      configuration: old.configuration,
      nickname: old.nickname,
      appearance: old.appearance,
      lastUsedAt: old.lastUsedAt,
      drafts: drafts,
    );
    return DesktopRegistry(
      entries: registry.entries.map((e) => e.entryId == id ? entry : e).toList(),
      activeEntryId: registry.activeEntryId,
    );
  });

  Future<DesktopRegistry> forget(String id) => _update(
    (registry) => DesktopRegistry(
      entries: registry.entries.where((e) => e.entryId != id).toList(),
      activeEntryId: registry.activeEntryId == id ? null : registry.activeEntryId,
    ),
  );

  static String _newId() {
    final random = Random.secure();
    return List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  }
}
