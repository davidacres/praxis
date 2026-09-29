import 'dart:convert';
import 'dart:math';

import '../protocol/wire.dart';
import 'time.dart';

// Reads what the desktop's Settings → Mobile access offers for pairing — the
// compact QR text (`P1|hostId|key|address:port|tokenId|expiresAt`), the JSON
// invitation, or a bare 64-hex host key — and turns connection failures into
// something a person can act on. Port of `renderer/mobilePairingInvitation.ts`.

class InvitationDetails {
  const InvitationDetails({this.hostId, this.hostName, this.address, this.port, this.hostPublicKeyHex, this.tokenId, this.expiresAt, this.relayUrl, this.relayChannel});
  final String? hostId;
  final String? hostName;
  final String? address;
  final int? port;
  final String? hostPublicKeyHex;
  final String? tokenId;
  final String? expiresAt;

  /// Where the desktop can be reached off the LAN: a `ws(s)://` relay URL and the desktop's channel on it.
  final String? relayUrl;
  final String? relayChannel;
}

enum InvitationKind { invitation, key, unrecognised }

class InvitationParse {
  const InvitationParse(this.kind, [this.details = const InvitationDetails(), this.expired = false]);
  final InvitationKind kind;
  final InvitationDetails details;
  final bool expired;
}

final _hexKey = RegExp(r'^[0-9a-fA-F]{64}$');
final _relayChannel = RegExp(r'^[0-9a-f]{32}$');
final _relayScheme = RegExp(r'^wss?://[^\s|]+$', caseSensitive: false);

/// A relay route is only kept when both halves are well formed; a half-route would fail later and confusingly.
({String? url, String? channel}) _relayRoute(Object? url, Object? channel) {
  final u = url is String ? url.trim() : null;
  final c = channel is String ? channel.trim().toLowerCase() : null;
  return u != null && c != null && _relayScheme.hasMatch(u) && _relayChannel.hasMatch(c) ? (url: u, channel: c) : (url: null, channel: null);
}

({String? address, int? port}) _splitEndpoint(String? endpoint) {
  final separator = endpoint?.lastIndexOf(':') ?? -1;
  if (endpoint == null || separator <= 0) return (address: null, port: null);
  final port = int.tryParse(endpoint.substring(separator + 1));
  return (address: endpoint.substring(0, separator), port: port != null && port > 0 && port <= 65535 ? port : null);
}

InvitationParse parseMobileInvitation(String raw, [DateTime? now]) {
  final value = raw.trim();
  final at = (now ?? DateTime.now()).millisecondsSinceEpoch;
  bool expired(String? expiresAt) => (parseInstant(expiresAt) ?? 1 << 62) <= at;
  if (_hexKey.hasMatch(value)) return InvitationParse(InvitationKind.key, InvitationDetails(hostPublicKeyHex: value.toLowerCase()));
  if (RegExp(r'^P\d+\|').hasMatch(value)) {
    final parts = value.split('|');
    String? part(int index) => index < parts.length && parts[index].isNotEmpty ? parts[index] : null;
    final key = part(2);
    final endpoint = _splitEndpoint(part(3));
    final relay = _relayRoute(part(6), part(7));
    final details = InvitationDetails(
      hostId: part(1),
      hostPublicKeyHex: key != null && _hexKey.hasMatch(key) ? key.toLowerCase() : null,
      address: endpoint.address,
      port: endpoint.port,
      tokenId: part(4),
      expiresAt: part(5),
      relayUrl: relay.url,
      relayChannel: relay.channel,
    );
    return details.hostPublicKeyHex != null
        ? InvitationParse(InvitationKind.invitation, details, expired(part(5)))
        : const InvitationParse(InvitationKind.unrecognised);
  }
  try {
    final parsed = jsonDecode(value);
    if (parsed is! Map<String, dynamic>) return const InvitationParse(InvitationKind.unrecognised);
    final endpoints = parsed['endpoints'] is List ? parsed['endpoints'] as List : const <Object?>[];
    final addresses = parsed['addresses'] is List ? parsed['addresses'] as List : const <Object?>[];
    final first = endpoints.isNotEmpty && endpoints.first is Map ? endpoints.first as Map : null;
    final address = first?['address'] is String
        ? first!['address'] as String
        : addresses.isNotEmpty && addresses.first is String
        ? addresses.first as String
        : null;
    final port = first?['port'] is num
        ? (first!['port'] as num).toInt()
        : parsed['port'] is num
        ? (parsed['port'] as num).toInt()
        : null;
    final keyValue = parsed['publicKeyHex'];
    final key = keyValue is String && _hexKey.hasMatch(keyValue) ? keyValue.toLowerCase() : null;
    if (key == null) return const InvitationParse(InvitationKind.unrecognised);
    final hostName = parsed['displayName'] is String
        ? parsed['displayName'] as String
        : parsed['hostName'] is String
        ? parsed['hostName'] as String
        : null;
    final expiresAt = parsed['expiresAt'] is String ? parsed['expiresAt'] as String : null;
    final relayJson = parsed['relay'] is Map ? parsed['relay'] as Map : const <Object?, Object?>{};
    final relay = _relayRoute(relayJson['url'], relayJson['channel']);
    return InvitationParse(
      InvitationKind.invitation,
      InvitationDetails(
        hostId: parsed['hostId'] is String ? parsed['hostId'] as String : null,
        hostName: hostName,
        address: address,
        port: port,
        hostPublicKeyHex: key,
        tokenId: parsed['tokenId'] is String ? parsed['tokenId'] as String : null,
        expiresAt: expiresAt,
        relayUrl: relay.url,
        relayChannel: relay.channel,
      ),
      expired(expiresAt),
    );
  } on FormatException {
    return const InvitationParse(InvitationKind.unrecognised);
  }
}

enum IssueAction { rescan, retry, wait, checkDesktop }

class ConnectionIssue {
  const ConnectionIssue({required this.code, required this.title, required this.message, required this.action, required this.retryable});
  final String code;
  final String title;
  final String message;
  final IssueAction action;
  final bool retryable;
}

const Map<String, (String, IssueAction)> _issueTitles = {
  'pairing-required': ('This phone is not paired', IssueAction.rescan),
  'pairing-pending': ('Waiting for desktop confirmation', IssueAction.wait),
  'pairing-rejected': ('Pairing was declined', IssueAction.rescan),
  'invitation-expired': ('Invitation expired', IssueAction.rescan),
  'invitation-invalid': ('Invitation not recognised', IssueAction.rescan),
  'invitation-used': ('Invitation already used', IssueAction.rescan),
  'device-revoked': ('Access revoked', IssueAction.rescan),
  'host-key-reset': ('Desktop key was reset', IssueAction.rescan),
  'handshake-rejected': ('Secure handshake refused', IssueAction.rescan),
  'handshake-failed': ('Desktop identity mismatch', IssueAction.rescan),
  'access-disabled': ('Mobile access is off', IssueAction.checkDesktop),
  'access-denied': ('Network not allowed', IssueAction.checkDesktop),
  'unreachable': ('Desktop unreachable', IssueAction.retry),
  'timed-out': ('Desktop not responding', IssueAction.retry),
  'connection-lost': ('Connection lost', IssueAction.retry),
  'host-shutdown': ('Desktop stopped listening', IssueAction.retry),
  'protocol-error': ('Connection error', IssueAction.retry),
};

ConnectionIssue describeConnectionIssue(Object error) {
  final code = error is MobileConnectionError ? error.code : 'unknown';
  final retryable = error is MobileConnectionError && error.retryable;
  final message = error is MobileConnectionError
      ? error.message
      : error is MobileRequestError
      ? error.message
      : error is StateError
      ? error.message
      : error.toString().replaceFirst(RegExp(r'^(Exception|Bad state): '), '');
  final known = _issueTitles[code];
  return ConnectionIssue(
    code: code,
    title: known?.$1 ?? 'Couldn’t connect',
    message: message,
    action: known?.$2 ?? (retryable ? IssueAction.retry : IssueAction.checkDesktop),
    retryable: retryable,
  );
}

/// Delay before reconnect attempt [attempt] (0-based): 1s, 2s, 4s … capped at 30s.
Duration reconnectDelay(int attempt) => Duration(milliseconds: min(30000, 1000 * pow(2, max(0, attempt)).toInt()));
