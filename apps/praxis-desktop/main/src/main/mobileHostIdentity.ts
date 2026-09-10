/**
 * The desktop's long-term mobile identity: an X25519 static keypair whose
 * public half a phone pins at pairing and whose private half stays in the
 * safeStorage-backed secret store. Generated once, reused for the life of the
 * profile; a `PRAXIS_MOBILE_HOST_KEY` hex override and an ephemeral fallback
 * cover headless / e2e machines where safeStorage is unavailable.
 */
import { generateKeyPair, type KeyPair } from '@praxis/mobile-protocol';
import { getSecretsStore } from './connectionStoreInstance';

const SECRET_KEY = 'mobile:hostStaticKey';

function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('A mobile host key must be 32 bytes of hex.');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

let cached: KeyPair | undefined;

export async function getMobileHostIdentity(): Promise<KeyPair> {
  if (cached) return cached;

  const override = process.env.PRAXIS_MOBILE_HOST_KEY;
  if (override) {
    cached = generateKeyPair(fromHex(override));
    return cached;
  }

  const secrets = getSecretsStore();
  const stored = await secrets.get(SECRET_KEY).catch(() => undefined);
  if (stored && /^[0-9a-fA-F]{64}$/.test(stored)) {
    cached = generateKeyPair(fromHex(stored));
    return cached;
  }

  const fresh = generateKeyPair();
  try {
    await secrets.store(SECRET_KEY, toHex(fresh.privateKey));
  } catch {
    // safeStorage unavailable (headless / e2e). Keep the key for this process
    // only; the mobile listener defaults to `off`, so an unpersisted identity
    // never matters unless a test explicitly enables it.
  }
  cached = fresh;
  return cached;
}

export function resetMobileHostIdentity(): void {
  cached = undefined;
}
