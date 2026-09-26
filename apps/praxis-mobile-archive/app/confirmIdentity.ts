import { Alert } from 'react-native';

type LocalAuthModule = typeof import('expo-local-authentication');

function getLocalAuth(): LocalAuthModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-local-authentication') as LocalAuthModule;
    if (mod && typeof mod.getEnrolledLevelAsync === 'function') {
      return mod;
    }
  } catch {
    // Native module not linked in this binary
  }
  return null;
}

/**
 * How long one successful check covers further approvals. Long enough to work
 * through a short queue of decisions without re-scanning, short enough that a
 * phone left unlocked on a desk is not an open approval channel.
 */
const GRACE_MS = 60_000;
let confirmedUntil = 0;

function askPlainConfirmation(reason: string): Promise<boolean> {
  return new Promise(resolve => {
    Alert.alert(
      'Confirm on this phone',
      `${reason}\n\nThis phone has no Face ID, Touch ID or passcode set up, so Praxis cannot check it is you. Set one up in the phone's Settings to protect approvals.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/**
 * Proves the person holding the phone is its owner before an approval, an
 * agent permission, or any other answer that acts. Face ID / Touch ID with the
 * device passcode as fallback; a phone with no lock at all gets an explicit
 * confirmation instead, never a silent pass.
 */
export async function confirmIdentity(reason: string): Promise<boolean> {
  if (Date.now() < confirmedUntil) return true;
  const auth = getLocalAuth();
  if (!auth) return askPlainConfirmation(reason);
  let secured = false;
  try {
    secured = (await auth.getEnrolledLevelAsync()) !== auth.SecurityLevel.NONE;
  } catch {
    secured = false;
  }
  if (!secured) return askPlainConfirmation(reason);
  try {
    const result = await auth.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    if (result.success) confirmedUntil = Date.now() + GRACE_MS;
    return result.success;
  } catch {
    return false;
  }
}

/** Forgets a recent check — on disconnect, so a new pairing never inherits it. */
export function forgetIdentityCheck(): void {
  confirmedUntil = 0;
}
