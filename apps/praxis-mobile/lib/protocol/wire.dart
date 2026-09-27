// The connection-status vocabulary and failure classification both ends
// share. Port of `@praxis/mobile-protocol`'s `wire.ts`.

class MobileConnectionStatus {
  const MobileConnectionStatus(this.code, this.message, this.retryable);
  final String code;
  final String message;
  final bool retryable;
}

const Map<String, (String, bool)> _statusDefaults = {
  'ready': ('Connected.', true),
  'pairing-required': ('This phone is not paired with the desktop. Scan a current pairing invitation from Settings → Mobile access.', false),
  'pairing-pending': ('Waiting for this phone to be confirmed in Settings → Mobile access on the desktop.', true),
  'pairing-rejected': ('The desktop declined this pairing request.', false),
  'invitation-expired': ('The pairing invitation has expired. Create a new invitation in Settings → Mobile access and scan it again.', false),
  'invitation-invalid': (
    'The pairing invitation does not match the one the desktop is offering. Scan the invitation currently shown in Settings → Mobile access.',
    false,
  ),
  'invitation-used': ('That pairing invitation has already been used. Create a new invitation on the desktop to pair this phone.', false),
  'device-revoked': ('The desktop revoked this phone’s access. Pair it again with a new invitation from Settings → Mobile access.', false),
  'host-key-reset': ('The desktop reset its host key, so every phone must pair again. Scan a new invitation from Settings → Mobile access.', false),
  'access-disabled': ('Mobile access is turned off on the desktop. Turn it on in Settings → Mobile access.', false),
  'access-denied': ('The desktop’s mobile access policy does not allow connections from this network.', false),
  'host-shutdown': ('The Praxis desktop stopped its mobile listener.', true),
};

bool isMobileConnectionStatusCode(Object? value) => value is String && _statusDefaults.containsKey(value);

MobileConnectionStatus mobileConnectionStatus(String code, [String? message]) {
  final fallback = _statusDefaults[code] ?? ('Connected.', true);
  final trimmed = message?.trim() ?? '';
  return MobileConnectionStatus(code, trimmed.isNotEmpty ? trimmed : fallback.$1, fallback.$2);
}

/// A status that ends the connection (anything but ready / pairing in progress).
bool isTerminalMobileStatus(String code) => code != 'ready' && code != 'pairing-required' && code != 'pairing-pending';

/// A connection failure with a stable code the UI can act on and a message it can show.
class MobileConnectionError implements Exception {
  MobileConnectionError(this.code, this.message, this.retryable, [this.detail]);

  factory MobileConnectionError.fromStatus(MobileConnectionStatus status) => MobileConnectionError(status.code, status.message, status.retryable);

  final String code;
  final String message;
  final bool retryable;
  final String? detail;

  @override
  String toString() => message;
}

/// A request the desktop answered with an error.
class MobileRequestError implements Exception {
  MobileRequestError(this.message, [this.code]);
  final String message;
  final String? code;
  @override
  String toString() => message;
}

enum ConnectionStage { connect, handshake, session }

/// Classifies a socket that failed without a status frame.
MobileConnectionError classifyMobileTransportFailure({required ConnectionStage stage, required String endpoint, Object? cause, bool timedOut = false}) {
  final detail = cause == null ? null : _describeCause(cause);
  if (timedOut) {
    return stage == ConnectionStage.session
        ? MobileConnectionError('timed-out', 'The Praxis desktop stopped responding. Reconnecting…', true, detail)
        : MobileConnectionError(
            'timed-out',
            'No answer from the Praxis desktop at $endpoint. Check that the phone and desktop are on the same network and that Mobile access is on.',
            true,
            detail,
          );
  }
  switch (stage) {
    case ConnectionStage.connect:
      return MobileConnectionError(
        'unreachable',
        'Couldn’t reach the Praxis desktop at $endpoint${detail != null ? ' ($detail)' : ''}. Check that Praxis is running with Mobile access on, and that the phone is on the same network.',
        true,
        detail,
      );
    case ConnectionStage.handshake:
      return MobileConnectionError(
        'handshake-rejected',
        'The desktop closed the secure handshake. Its host key may have been reset, or this phone pinned a different desktop — scan a current pairing invitation from Settings → Mobile access.',
        false,
        detail,
      );
    case ConnectionStage.session:
      return MobileConnectionError('connection-lost', 'The connection to the Praxis desktop was lost. Reconnecting…', true, detail);
  }
}

String _describeCause(Object cause) {
  final text = cause.toString();
  // SocketException's text is "SocketException: Connection refused (OS Error: …)"; keep the reason.
  final match = RegExp(r'^\w+Exception: (.*?)(?: \(OS Error.*)?(?:, address.*)?$').firstMatch(text);
  return match?.group(1)?.trim() ?? text;
}
