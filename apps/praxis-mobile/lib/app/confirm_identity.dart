import 'package:flutter/material.dart';
import 'package:local_auth/local_auth.dart';

/// Proves the person holding the phone is its owner before an approval, an
/// agent permission, or any other answer that acts. Face ID / Touch ID with the
/// device passcode as fallback; a phone with no lock gets an explicit
/// confirmation instead, never a silent pass. Port of `app/confirmIdentity.ts`.

/// How long one successful check covers further approvals.
const _grace = Duration(seconds: 60);
DateTime _confirmedUntil = DateTime.fromMillisecondsSinceEpoch(0);

final GlobalKey<NavigatorState> rootNavigatorKey = GlobalKey<NavigatorState>();

Future<bool> _askPlainConfirmation(String reason) async {
  final context = rootNavigatorKey.currentContext;
  if (context == null) return false;
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog.adaptive(
      title: const Text('Confirm on this phone'),
      content: Text(
        "$reason\n\nThis phone has no Face ID, Touch ID or passcode set up, so Praxis cannot check it is you. Set one up in the phone's Settings to protect approvals.",
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
        TextButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('Continue', style: TextStyle(color: Colors.red)),
        ),
      ],
    ),
  );
  return result ?? false;
}

Future<bool> confirmIdentity(String reason) async {
  if (DateTime.now().isBefore(_confirmedUntil)) return true;
  final auth = LocalAuthentication();
  var secured = false;
  try {
    secured = await auth.isDeviceSupported();
  } catch (_) {
    secured = false;
  }
  if (!secured) return _askPlainConfirmation(reason);
  try {
    final ok = await auth.authenticate(localizedReason: reason);
    if (ok) _confirmedUntil = DateTime.now().add(_grace);
    return ok;
  } catch (_) {
    return false;
  }
}

/// Forgets a recent check — on disconnect, so a new pairing never inherits it.
void forgetIdentityCheck() => _confirmedUntil = DateTime.fromMillisecondsSinceEpoch(0);
