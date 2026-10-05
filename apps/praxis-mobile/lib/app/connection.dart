import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../core/palette.dart';
import 'desktop_registry.dart';
import 'host_configuration.dart';
export 'host_configuration.dart';
import '../protocol/client.dart';
import '../protocol/noise.dart';
import '../protocol/wire.dart';

const _deviceKey = 'praxis.mobile.devicePrivateKey.v1';
const _displayModeKey = 'praxis.mobile.displayMode.v1';

const _storage = FlutterSecureStorage(iOptions: IOSOptions(accessibility: KeychainAccessibility.unlocked_this_device));

final _hex64 = RegExp(r'^[0-9a-fA-F]{64}$');

Uint8List hexToBytes(String value) {
  final clean = value.trim();
  if (!_hex64.hasMatch(clean)) throw StateError('The desktop host key must be 32 bytes of hexadecimal text.');
  return Uint8List.fromList(List<int>.generate(32, (i) => int.parse(clean.substring(i * 2, i * 2 + 2), radix: 16)));
}

String bytesToHex(List<int> bytes) => bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();

NoiseKeyPair? _identity;

Future<NoiseKeyPair>? _identityLoading;

Future<NoiseKeyPair> deviceIdentity() {
  final cached = _identity;
  if (cached != null) return Future.value(cached);
  return _identityLoading ??= _loadDeviceIdentity().whenComplete(() => _identityLoading = null);
}

Future<NoiseKeyPair> _loadDeviceIdentity() async {
  final stored = await _storage.read(key: _deviceKey);
  if (stored != null) {
    if (!_hex64.hasMatch(stored)) throw StateError('The phone’s saved identity is damaged. It was retained for recovery.');
    return _identity = NoiseKeyPair.generate(hexToBytes(stored));
  }
  final identity = NoiseKeyPair.generate();
  await _storage.write(key: _deviceKey, value: bytesToHex(identity.privateKey));
  return _identity = identity;
}

/// Hex prefix of this phone's public key — the desktop lists a pending phone as `Phone <prefix>`.
Future<String> deviceKeyPrefix() async => bytesToHex((await deviceIdentity()).publicKey).substring(0, 6);

class SecureDesktopStorage implements DesktopStorage {
  @override
  Future<String?> read(String key) => _storage.read(key: key);
  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);
  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

final desktopRepository = DesktopRepository(SecureDesktopStorage());

// Compatibility entry points for the single active transport. New callers
// select an explicit registry entry; forgetting never removes other desktops.
Future<HostConfiguration?> loadHostConfiguration() async => (await desktopRepository.load()).active?.configuration;
Future<void> saveHostConfiguration(HostConfiguration value) async {
  await desktopRepository.saveAuthenticated(value);
}

Future<void> forgetHostConfiguration() async {
  final id = (await desktopRepository.load()).activeEntryId;
  if (id != null) await desktopRepository.forget(id);
}

Future<Appearance?> loadDesktopAppearance() async => (await desktopRepository.load()).active?.appearance;
Future<void> saveDesktopAppearance(Appearance value) async {
  final id = (await desktopRepository.load()).activeEntryId;
  if (id != null) await desktopRepository.cacheAppearance(id, value);
}

Future<String?> loadDisplayMode() async {
  try {
    final stored = await _storage.read(key: _displayModeKey);
    return stored == 'large' || stored == 'compact' ? stored : null;
  } catch (_) {
    return null;
  }
}

Future<void> saveDisplayMode(String value) => _storage.write(key: _displayModeKey, value: value);

/// One encrypted session with the desktop. The protocol work is [MobileSecureClient]'s.
class NativeMobileConnection {
  NativeMobileConnection(this.config);

  final HostConfiguration config;
  MobileSecureClient? _client;
  bool _closed = false;
  final List<void Function(Map<String, dynamic>)> _listeners = [];
  final List<void Function(MobileConnectionStatus)> _statusListeners = [];
  final List<void Function(MobileConnectionError)> _closeListeners = [];

  /// True while a LAN attempt that may fall back to the relay is running: its failure is reported by
  /// the rejected future, not as a close event, so the store does not see a phantom disconnect.
  bool _tryingLan = false;

  /// Direct first — the LAN is faster and needs no relay — and through the relay only when the desktop
  /// could not be reached. Any other failure (revoked, wrong key, access refused) is final: falling back
  /// would only hide the real reason.
  Future<void> connect() async {
    if (_closed) throw StateError('This desktop connection was cancelled.');
    if (_client != null) throw StateError('This connection was already opened; create a new one to reconnect.');
    if (!config.hasRelay) return _open(relay: false);
    _tryingLan = true;
    try {
      await _open(relay: false, connectTimeout: const Duration(seconds: 4));
    } on MobileConnectionError catch (error) {
      if (_closed) rethrow;
      if (error.code != 'unreachable' && error.code != 'timed-out') rethrow;
      _client = null;
      _tryingLan = false;
      await _open(relay: true);
    } finally {
      _tryingLan = false;
    }
  }

  Future<void> _open({required bool relay, Duration? connectTimeout}) async {
    final identity = await deviceIdentity();
    if (_closed) throw StateError('This desktop connection was cancelled.');
    final client = _client = MobileSecureClient(
      host: config.address,
      port: config.port,
      staticKeyPair: identity,
      remoteStaticPublicKey: hexToBytes(config.hostPublicKeyHex),
      pairingTokenId: config.pairingTokenId,
      relayUrl: relay ? config.relayUrl : null,
      relayChannel: relay ? config.relayChannel : null,
      connectTimeout: connectTimeout ?? const Duration(seconds: 15),
    );
    client.onEvent((envelope) {
      for (final listener in [..._listeners]) {
        listener(envelope);
      }
    });
    client.onStatus((status) {
      for (final listener in [..._statusListeners]) {
        listener(status);
      }
    });
    client.onClose((error) {
      if (_tryingLan) return;
      for (final listener in [..._closeListeners]) {
        listener(error);
      }
    });
    await client.connect();
  }

  MobileSecureClient get _ready {
    final client = _client;
    if (client == null) throw StateError('The Praxis desktop is not connected.');
    return client;
  }

  Future<Object?> read(Map<String, Object?> request) => _ready.read(request);
  Future<Object?> command(Map<String, Object?> command) => _ready.command(command);
  Future<Object?> replay(int afterSequence) => _ready.replay(afterSequence);

  void Function() subscribe(void Function(Map<String, dynamic>) listener) {
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }

  void Function() subscribeStatus(void Function(MobileConnectionStatus) listener) {
    _statusListeners.add(listener);
    return () => _statusListeners.remove(listener);
  }

  void Function() subscribeClose(void Function(MobileConnectionError) listener) {
    _closeListeners.add(listener);
    return () => _closeListeners.remove(listener);
  }

  void close() {
    _closed = true;
    _client?.close();
  }
}
