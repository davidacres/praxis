import 'dart:convert';
import 'dart:io';

/// Desktops announcing themselves on the local network (the desktop's
/// discovery advertiser). Discovery identifies a host only; pairing still
/// needs its invitation. Port of `app/mobileDiscovery.ts` +
/// `renderer/mobileHostDiscovery.ts`.

const _multicastAddress = '239.255.90.90';
const _discoveryPort = 43199;

class DiscoveredHost {
  const DiscoveredHost({required this.hostId, required this.displayName, required this.fingerprint, required this.port, required this.addresses});
  final String hostId;
  final String displayName;
  final String fingerprint;
  final int port;
  final List<String> addresses;
}

DiscoveredHost? parseDiscoveryHint(String raw) {
  try {
    final value = jsonDecode(raw);
    if (value is! Map<String, dynamic>) return null;
    if (value['v'] != 1 || value['hostId'] is! String || value['displayName'] is! String) return null;
    final fingerprint = value['fingerprint'];
    if (fingerprint is! String || !RegExp(r'^[0-9a-f]{16}$', caseSensitive: false).hasMatch(fingerprint)) return null;
    final port = value['port'];
    if (port is! num || port < 1024 || port > 65535) return null;
    final addresses = value['addresses'];
    if (addresses is! List || !addresses.every((address) => address is String)) return null;
    if (value.containsKey('tokenId') || value.containsKey('publicKeyHex') || value.containsKey('privateKey')) return null;
    return DiscoveredHost(
      hostId: value['hostId'] as String,
      displayName: value['displayName'] as String,
      fingerprint: fingerprint.toLowerCase(),
      port: port.toInt(),
      addresses: addresses.cast<String>().where((address) => address.isNotEmpty).toList(),
    );
  } catch (_) {
    return null;
  }
}

/// Listens for announcements; returns a function that stops listening.
Future<void Function()> listenForHosts(void Function(DiscoveredHost host) onHost) async {
  RawDatagramSocket? socket;
  try {
    socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, _discoveryPort, reuseAddress: true, reusePort: true);
    try {
      socket.joinMulticast(InternetAddress(_multicastAddress));
    } catch (_) {
      // Manual invitation paste remains available when multicast is blocked.
    }
    socket.listen((event) {
      if (event != RawSocketEvent.read) return;
      final datagram = socket?.receive();
      if (datagram == null) return;
      final hint = parseDiscoveryHint(utf8.decode(datagram.data, allowMalformed: true));
      if (hint != null) onHost(hint);
    });
  } catch (_) {
    // The port may be taken or the platform may refuse; discovery is optional.
  }
  return () => socket?.close();
}
