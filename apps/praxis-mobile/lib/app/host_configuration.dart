/// The paired desktop, as the phone remembers it. Identity and routes shared by the transport and saved registry.
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
    this.relayUrl,
    this.relayChannel,
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
    relayUrl: json['relayUrl'] as String?,
    relayChannel: json['relayChannel'] as String?,
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

  /// Off-LAN route from the invitation (FX-BE-079); absent when the desktop offered none.
  final String? relayUrl;
  final String? relayChannel;

  bool get hasRelay => relayUrl != null && relayChannel != null;

  Map<String, dynamic> toJson() => {
    'hostId': hostId,
    if (hostName != null) 'hostName': hostName,
    'address': address,
    'port': port,
    'hostPublicKeyHex': hostPublicKeyHex,
    if (projectId != null) 'projectId': projectId,
    if (pairingTokenId != null) 'pairingTokenId': pairingTokenId,
    if (pairingExpiresAt != null) 'pairingExpiresAt': pairingExpiresAt,
    if (relayUrl != null) 'relayUrl': relayUrl,
    if (relayChannel != null) 'relayChannel': relayChannel,
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
    relayUrl: relayUrl,
    relayChannel: relayChannel,
  );

  /// Confirmed: the invitation is spent, so it is not kept or re-presented.
  HostConfiguration withoutInvitation() => HostConfiguration(
    hostId: hostId,
    hostName: hostName,
    address: address,
    port: port,
    hostPublicKeyHex: hostPublicKeyHex,
    projectId: projectId,
    relayUrl: relayUrl,
    relayChannel: relayChannel,
  );
}
