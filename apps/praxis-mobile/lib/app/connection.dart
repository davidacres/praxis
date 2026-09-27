import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../core/palette.dart';
import '../protocol/client.dart';
import '../protocol/noise.dart';
import '../protocol/wire.dart';

/// The paired desktop, as the phone remembers it. Port of `app/mobileConnection.ts`.
class HostConfiguration {
  const HostConfiguration({
    required this.hostId,
    this.hostName,
    required this.address,
    required this.port,
    required this.hostPublicKeyHex,
    this.projectId,
    this.pairingTokenId,
    this.pairingExpiresAt,
  });

  factory HostConfiguration.fromJson(Map<String, dynamic> json) => HostConfiguration(
    hostId: json['hostId'] as String,
    hostName: json['hostName'] as String?,
    address: json['address'] as String,
    port: (json['port'] as num).toInt(),
    hostPublicKeyHex: json['hostPublicKeyHex'] as String,
    projectId: json['projectId'] as String?,
    pairingTokenId: json['pairingTokenId'] as String?,
    pairingExpiresAt: json['pairingExpiresAt'] as String?,
  );

  final String hostId;
  final String? hostName;
  final String address;
  final int port;
  final String hostPublicKeyHex;
  final String? projectId;

  /// Present only until the desktop has confirmed this phone; invitations are single-use.
  final String? pairingTokenId;
  final String? pairingExpiresAt;

  Map<String, dynamic> toJson() => {
    'hostId': hostId,
    if (hostName != null) 'hostName': hostName,
    'address': address,
    'port': port,
    'hostPublicKeyHex': hostPublicKeyHex,
    if (projectId != null) 'projectId': projectId,
    if (pairingTokenId != null) 'pairingTokenId': pairingTokenId,
    if (pairingExpiresAt != null) 'pairingExpiresAt': pairingExpiresAt,
  };

  HostConfiguration withProject(String? projectId) => HostConfiguration(
    hostId: hostId,
    hostName: hostName,
    address: address,
    port: port,
    hostPublicKeyHex: hostPublicKeyHex,
    projectId: projectId,
    pairingTokenId: pairingTokenId,
    pairingExpiresAt: pairingExpiresAt,
  );

  /// Confirmed: the invitation is spent, so it is not kept or re-presented.
  HostConfiguration withoutInvitation() =>
      HostConfiguration(hostId: hostId, hostName: hostName, address: address, port: port, hostPublicKeyHex: hostPublicKeyHex, projectId: projectId);
}

const _deviceKey = 'praxis.mobile.devicePrivateKey.v1';
const _hostConfigurationKey = 'praxis.mobile.hostConfiguration.v1';
const _appearanceKey = 'praxis.mobile.desktopAppearance.v1';
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

Future<NoiseKeyPair> deviceIdentity() async {
  final cached = _identity;
  if (cached != null) return cached;
  final stored = await _storage.read(key: _deviceKey);
  if (stored != null && _hex64.hasMatch(stored)) return _identity = NoiseKeyPair.generate(hexToBytes(stored));
  final identity = NoiseKeyPair.generate();
  await _storage.write(key: _deviceKey, value: bytesToHex(identity.privateKey));
  return _identity = identity;
}

/// Hex prefix of this phone's public key — the desktop lists a pending phone as `Phone <prefix>`.
Future<String> deviceKeyPrefix() async => bytesToHex((await deviceIdentity()).publicKey).substring(0, 6);

Future<HostConfiguration?> loadHostConfiguration() async {
  final stored = await _storage.read(key: _hostConfigurationKey);
  if (stored == null) return null;
  try {
    return HostConfiguration.fromJson(jsonDecode(stored) as Map<String, dynamic>);
  } catch (_) {
    return null;
  }
}

Future<void> saveHostConfiguration(HostConfiguration value) => _storage.write(key: _hostConfigurationKey, value: jsonEncode(value.toJson()));

Future<void> forgetHostConfiguration() async {
  await _storage.delete(key: _hostConfigurationKey);
  await _storage.delete(key: _appearanceKey);
}

/// The paired desktop's last theme, so the phone opens wearing it before it reconnects.
Future<Appearance?> loadDesktopAppearance() async {
  try {
    final stored = await _storage.read(key: _appearanceKey);
    return stored == null ? null : readMobileAppearance(jsonDecode(stored));
  } catch (_) {
    return null;
  }
}

Future<void> saveDesktopAppearance(Appearance value) => _storage.write(key: _appearanceKey, value: jsonEncode(value.raw));

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
  final List<void Function(Map<String, dynamic>)> _listeners = [];
  final List<void Function(MobileConnectionStatus)> _statusListeners = [];
  final List<void Function(MobileConnectionError)> _closeListeners = [];

  Future<void> connect() async {
    if (_client != null) throw StateError('This connection was already opened; create a new one to reconnect.');
    final client = _client = MobileSecureClient(
      host: config.address,
      port: config.port,
      staticKeyPair: await deviceIdentity(),
      remoteStaticPublicKey: hexToBytes(config.hostPublicKeyHex),
      pairingTokenId: config.pairingTokenId,
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

  void close() => _client?.close();
}
