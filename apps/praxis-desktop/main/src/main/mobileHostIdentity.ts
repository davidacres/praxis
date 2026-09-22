/**
 * The desktop's long-term mobile identity: an X25519 static keypair whose
 * public half a phone pins at pairing and whose private half stays in the
 * safeStorage-backed secret store. Generated once, reused for the life of the
 * profile; a `PRAXIS_MOBILE_HOST_KEY` hex override and an ephemeral fallback
 * cover headless / e2e machines where safeStorage is unavailable.
 */
import { generateKeyPair, type KeyPair } from '@praxis/mobile-protocol';
import { randomBytes } from 'node:crypto';
import { getSecretsStore } from './connectionStoreInstance';

const SECRET_KEY = 'mobile:hostStaticKey';
const PAIRING_CODE_KEY = 'mobile:pairingCode';
const HOST_ID_KEY = 'mobile:hostId';

function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('A mobile host key must be 32 bytes of hex.');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

let cached: KeyPair | undefined;
let cachedPairingCode: string | undefined;
let cachedHostId: string | undefined;

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

export async function getMobilePairingCode(): Promise<string> {
  if (cachedPairingCode) return cachedPairingCode;
  const override = process.env.PRAXIS_MOBILE_PAIRING_CODE?.trim();
  if (override) {
    cachedPairingCode = override;
    return override;
  }
  const secrets = getSecretsStore();
  const stored = await secrets.get(PAIRING_CODE_KEY).catch(() => undefined);
  if (stored?.trim()) {
    cachedPairingCode = stored.trim();
    return cachedPairingCode;
  }
  const fresh = randomBytes(24).toString('base64url');
  await secrets.store(PAIRING_CODE_KEY, fresh).catch(() => undefined);
  cachedPairingCode = fresh;
  return fresh;
}

export async function getMobileHostId(): Promise<string> {
  if (cachedHostId) return cachedHostId;
  const secrets = getSecretsStore();
  const stored = await secrets.get(HOST_ID_KEY).catch(() => undefined);
  if (stored?.trim()) {
    cachedHostId = stored.trim();
    return cachedHostId;
  }
  const fresh = randomBytes(16).toString('hex');
  await secrets.store(HOST_ID_KEY, fresh).catch(() => undefined);
  cachedHostId = fresh;
  return fresh;
}

/** Regenerates the static key. Paired phones must distrust the new public key. Host id is unchanged. */
export async function rotateMobileHostIdentity(): Promise<KeyPair> {
  cached = undefined;
  cachedPairingCode = undefined;
  const secrets = getSecretsStore();
  await secrets.delete(SECRET_KEY).catch(() => undefined);
  await secrets.delete(PAIRING_CODE_KEY).catch(() => undefined);
  return getMobileHostIdentity();
}

export function resetMobileHostIdentity(): void {
  cached = undefined;
  cachedPairingCode = undefined;
  cachedHostId = undefined;
}
