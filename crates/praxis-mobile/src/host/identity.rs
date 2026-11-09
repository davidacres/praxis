//! The desktop's long-term mobile identity (`apps/praxis-desktop/main/src/main/mobileHostIdentity.ts`
//! port).
//!
//! * the X25519 static keypair a phone pins at pairing (`mobile:hostStaticKey`, 64 hex);
//! * the out-of-band pairing code used as the Noise prologue (`mobile:pairingCode`, 24 random
//!   bytes base64url);
//! * the stable host id (`mobile:hostId`, 16 random bytes hex);
//! * the Ed25519 key the desktop signs the relay's challenge with (`mobile:relayKey`, PKCS#8 DER
//!   hex — the exact bytes Node's `privateKey.export({ format: 'der', type: 'pkcs8' })` writes).
//!
//! Secrets live in the host's secret store, reached through [`MobileSecretStore`]; a store that
//! cannot persist (headless / e2e) leaves the value for the life of this identity only. The
//! `PRAXIS_MOBILE_HOST_KEY` / `PRAXIS_MOBILE_PAIRING_CODE` overrides arrive through
//! [`MobileIdentityOverrides`] so tests never touch the process environment. Secret strings
//! read from the store are zeroized after use and never logged.

use async_trait::async_trait;
use base64::Engine as _;
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::DecodePrivateKey;
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use crate::noise::{DHLEN, KeyPair};
use crate::relay::{decode_hex, hex};

pub const HOST_STATIC_KEY_SECRET: &str = "mobile:hostStaticKey";
pub const PAIRING_CODE_SECRET: &str = "mobile:pairingCode";
pub const HOST_ID_SECRET: &str = "mobile:hostId";
pub const RELAY_KEY_SECRET: &str = "mobile:relayKey";

/// The host's secret store (`getSecretsStore()` in the TS). Errors are strings because every
/// caller here treats a failure as "not stored".
#[async_trait]
pub trait MobileSecretStore: Send + Sync {
    async fn get(&self, key: &str) -> Result<Option<String>, String>;
    async fn store(&self, key: &str, value: &str) -> Result<(), String>;
    async fn delete(&self, key: &str) -> Result<(), String>;
}

/// `PRAXIS_MOBILE_HOST_KEY` and `PRAXIS_MOBILE_PAIRING_CODE`.
#[derive(Default, Clone)]
pub struct MobileIdentityOverrides {
    pub host_key_hex: Option<Zeroizing<String>>,
    pub pairing_code: Option<Zeroizing<String>>,
}

impl MobileIdentityOverrides {
    pub fn from_env() -> Self {
        let read = |name: &str| std::env::var(name).ok().map(Zeroizing::new);
        Self {
            host_key_hex: read("PRAXIS_MOBILE_HOST_KEY"),
            pairing_code: read("PRAXIS_MOBILE_PAIRING_CODE"),
        }
    }
}

/// The Ed25519 key the relay verifies; the phone never sees it.
#[derive(Clone)]
pub struct MobileRelayIdentity {
    /// Raw Ed25519 public key, 64 hex characters.
    pub public_key_hex: String,
    pub signing_key: SigningKey,
}

impl MobileRelayIdentity {
    pub fn from_signing_key(signing_key: SigningKey) -> Self {
        Self {
            public_key_hex: hex(signing_key.verifying_key().as_bytes()),
            signing_key,
        }
    }

    pub fn generate() -> Self {
        let mut seed = Zeroizing::new([0u8; 32]);
        getrandom::getrandom(seed.as_mut()).expect("the OS random source is available");
        Self::from_signing_key(SigningKey::from_bytes(&seed))
    }
}

impl std::fmt::Debug for MobileRelayIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MobileRelayIdentity")
            .field("public_key_hex", &self.public_key_hex)
            .finish_non_exhaustive()
    }
}

/// Node's PKCS#8 v1 prefix for an Ed25519 private key; the 32-byte seed follows.
const ED25519_PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// The DER Node writes for this key.
pub fn ed25519_pkcs8_der(signing_key: &SigningKey) -> Zeroizing<Vec<u8>> {
    let mut der = Zeroizing::new(Vec::with_capacity(48));
    der.extend_from_slice(&ED25519_PKCS8_PREFIX);
    der.extend_from_slice(signing_key.as_bytes());
    der
}

/// Reads a PKCS#8 Ed25519 key (v1 as Node writes it, or v2 with the public key).
pub fn ed25519_from_pkcs8_der(der: &[u8]) -> Option<SigningKey> {
    SigningKey::from_pkcs8_der(der).ok()
}

fn key_from_hex(text: &str) -> Option<KeyPair> {
    let clean = text.trim();
    if clean.len() != DHLEN * 2 {
        return None;
    }
    let bytes = Zeroizing::new(decode_hex(clean)?);
    let mut private_key = Zeroizing::new([0u8; DHLEN]);
    private_key.copy_from_slice(&bytes);
    Some(KeyPair::from_private_key(*private_key))
}

#[derive(Default)]
struct Cache {
    static_key: Option<KeyPair>,
    pairing_code: Option<Zeroizing<String>>,
    host_id: Option<String>,
    relay: Option<MobileRelayIdentity>,
}

/// Lazily loads (or mints and stores) each identity part once, then serves it from memory.
pub struct MobileHostIdentity<S: MobileSecretStore> {
    secrets: S,
    overrides: MobileIdentityOverrides,
    cache: Mutex<Cache>,
}

impl<S: MobileSecretStore> MobileHostIdentity<S> {
    pub fn new(secrets: S, overrides: MobileIdentityOverrides) -> Self {
        Self {
            secrets,
            overrides,
            cache: Mutex::new(Cache::default()),
        }
    }

    async fn stored(&self, key: &str) -> Option<Zeroizing<String>> {
        self.secrets
            .get(key)
            .await
            .ok()
            .flatten()
            .map(Zeroizing::new)
    }

    /// The X25519 static keypair. An invalid `PRAXIS_MOBILE_HOST_KEY` is an error, as in the TS.
    pub async fn static_key(&self) -> Result<KeyPair, String> {
        let mut cache = self.cache.lock().await;
        if let Some(key) = &cache.static_key {
            return Ok(key.clone());
        }
        if let Some(override_hex) = &self.overrides.host_key_hex {
            let key = key_from_hex(override_hex)
                .ok_or_else(|| "A mobile host key must be 32 bytes of hex.".to_owned())?;
            cache.static_key = Some(key.clone());
            return Ok(key);
        }
        if let Some(key) = self
            .stored(HOST_STATIC_KEY_SECRET)
            .await
            .and_then(|stored| key_from_hex(&stored))
        {
            cache.static_key = Some(key.clone());
            return Ok(key);
        }
        let fresh = KeyPair::generate();
        let private_hex = Zeroizing::new(hex(fresh.private_key().as_ref()));
        // Unpersisted (no safe storage) is fine: the listener defaults to `off`.
        let _ = self
            .secrets
            .store(HOST_STATIC_KEY_SECRET, &private_hex)
            .await;
        cache.static_key = Some(fresh.clone());
        Ok(fresh)
    }

    /// The Noise prologue both ends must share.
    pub async fn pairing_code(&self) -> Zeroizing<String> {
        let mut cache = self.cache.lock().await;
        if let Some(code) = &cache.pairing_code {
            return code.clone();
        }
        let override_code = self
            .overrides
            .pairing_code
            .as_ref()
            .map(|code| Zeroizing::new(code.trim().to_owned()))
            .filter(|code| !code.is_empty());
        let stored = || async {
            self.stored(PAIRING_CODE_SECRET)
                .await
                .map(|code| Zeroizing::new(code.trim().to_owned()))
                .filter(|code| !code.is_empty())
        };
        let code = match override_code {
            Some(code) => code,
            None => match stored().await {
                Some(code) => code,
                None => {
                    let mut bytes = Zeroizing::new([0u8; 24]);
                    getrandom::getrandom(bytes.as_mut())
                        .expect("the OS random source is available");
                    let fresh = Zeroizing::new(
                        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes.as_ref()),
                    );
                    let _ = self.secrets.store(PAIRING_CODE_SECRET, &fresh).await;
                    fresh
                }
            },
        };
        cache.pairing_code = Some(code.clone());
        code
    }

    pub async fn host_id(&self) -> String {
        let mut cache = self.cache.lock().await;
        if let Some(id) = &cache.host_id {
            return id.clone();
        }
        let id = match self
            .secrets
            .get(HOST_ID_SECRET)
            .await
            .ok()
            .flatten()
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty())
        {
            Some(id) => id,
            None => {
                let mut bytes = [0u8; 16];
                getrandom::getrandom(&mut bytes).expect("the OS random source is available");
                let fresh = hex(&bytes);
                let _ = self.secrets.store(HOST_ID_SECRET, &fresh).await;
                fresh
            }
        };
        cache.host_id = Some(id.clone());
        id
    }

    /// Regenerates the static key (and the pairing code). Paired phones must distrust the new
    /// public key; the host id is unchanged.
    pub async fn rotate(&self) -> Result<KeyPair, String> {
        {
            let mut cache = self.cache.lock().await;
            cache.static_key = None;
            cache.pairing_code = None;
        }
        let _ = self.secrets.delete(HOST_STATIC_KEY_SECRET).await;
        let _ = self.secrets.delete(PAIRING_CODE_SECRET).await;
        self.static_key().await
    }

    /// Forgets every cached part (the next read reloads from the store).
    pub async fn reset(&self) {
        let mut cache = self.cache.lock().await;
        cache.static_key = None;
        cache.pairing_code = None;
        cache.host_id = None;
    }

    /// The relay signing key: loaded from the store, else minted and stored. An unreadable
    /// stored key is replaced, as in the TS.
    pub async fn relay_identity(&self) -> MobileRelayIdentity {
        let mut cache = self.cache.lock().await;
        if let Some(identity) = &cache.relay {
            return identity.clone();
        }
        let loaded = self
            .stored(RELAY_KEY_SECRET)
            .await
            .and_then(|stored| decode_hex(stored.trim()).map(Zeroizing::new))
            .and_then(|der| ed25519_from_pkcs8_der(&der));
        let identity = match loaded {
            Some(key) => MobileRelayIdentity::from_signing_key(key),
            None => {
                let fresh = MobileRelayIdentity::generate();
                let der_hex = Zeroizing::new(hex(&ed25519_pkcs8_der(&fresh.signing_key)));
                let _ = self.secrets.store(RELAY_KEY_SECRET, &der_hex).await;
                fresh
            }
        };
        cache.relay = Some(identity.clone());
        identity
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex as StdMutex};

    #[derive(Clone, Default)]
    struct MemorySecrets {
        values: Arc<StdMutex<HashMap<String, String>>>,
        refuse_writes: bool,
    }

    #[async_trait]
    impl MobileSecretStore for MemorySecrets {
        async fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().expect("secrets").get(key).cloned())
        }
        async fn store(&self, key: &str, value: &str) -> Result<(), String> {
            if self.refuse_writes {
                return Err("safeStorage unavailable".into());
            }
            self.values
                .lock()
                .expect("secrets")
                .insert(key.into(), value.into());
            Ok(())
        }
        async fn delete(&self, key: &str) -> Result<(), String> {
            self.values.lock().expect("secrets").remove(key);
            Ok(())
        }
    }

    #[tokio::test]
    async fn mints_once_persists_and_reloads_the_same_identity() {
        let secrets = MemorySecrets::default();
        let first = MobileHostIdentity::new(secrets.clone(), MobileIdentityOverrides::default());
        let key = first.static_key().await.expect("key");
        let code = first.pairing_code().await;
        let id = first.host_id().await;
        let relay = first.relay_identity().await;
        assert_eq!(code.len(), 32, "24 bytes of base64url");
        assert_eq!(id.len(), 32);
        assert_eq!(
            first.static_key().await.expect("cached").public_key(),
            key.public_key()
        );

        let again = MobileHostIdentity::new(secrets.clone(), MobileIdentityOverrides::default());
        assert_eq!(
            again.static_key().await.expect("key").public_key(),
            key.public_key()
        );
        assert_eq!(*again.pairing_code().await, *code);
        assert_eq!(again.host_id().await, id);
        assert_eq!(
            again.relay_identity().await.public_key_hex,
            relay.public_key_hex
        );

        let stored = secrets.values.lock().expect("secrets").clone();
        assert_eq!(stored[HOST_STATIC_KEY_SECRET].len(), 64);
        assert!(stored[RELAY_KEY_SECRET].starts_with("302e020100300506032b657004220420"));
        assert_eq!(stored[RELAY_KEY_SECRET].len(), 96);
    }

    #[tokio::test]
    async fn rotation_replaces_the_key_and_code_but_keeps_the_host_id() {
        let identity =
            MobileHostIdentity::new(MemorySecrets::default(), MobileIdentityOverrides::default());
        let before = identity.static_key().await.expect("key").public_key();
        let code = identity.pairing_code().await;
        let id = identity.host_id().await;
        let after = identity.rotate().await.expect("rotated").public_key();
        assert_ne!(before, after);
        assert_ne!(*identity.pairing_code().await, *code);
        assert_eq!(identity.host_id().await, id);
    }

    #[tokio::test]
    async fn overrides_win_and_a_bad_override_is_refused() {
        let overrides = MobileIdentityOverrides {
            host_key_hex: Some(Zeroizing::new("11".repeat(32))),
            pairing_code: Some(Zeroizing::new("  pair-me \n".into())),
        };
        let identity = MobileHostIdentity::new(MemorySecrets::default(), overrides);
        let key = identity.static_key().await.expect("key");
        assert_eq!(
            key.public_key(),
            KeyPair::from_private_key([0x11; 32]).public_key()
        );
        assert_eq!(identity.pairing_code().await.as_str(), "pair-me");
        let bad = MobileIdentityOverrides {
            host_key_hex: Some(Zeroizing::new("xyz".into())),
            pairing_code: None,
        };
        let refused = MobileHostIdentity::new(MemorySecrets::default(), bad);
        assert_eq!(
            refused.static_key().await.map(|k| k.public_key()),
            Err("A mobile host key must be 32 bytes of hex.".to_owned())
        );
    }

    #[tokio::test]
    async fn without_safe_storage_the_identity_lasts_for_the_process() {
        let secrets = MemorySecrets {
            refuse_writes: true,
            ..MemorySecrets::default()
        };
        let identity = MobileHostIdentity::new(secrets.clone(), MobileIdentityOverrides::default());
        let key = identity.static_key().await.expect("key").public_key();
        assert_eq!(identity.static_key().await.expect("key").public_key(), key);
        assert!(secrets.values.lock().expect("secrets").is_empty());
    }

    #[test]
    fn the_relay_key_der_round_trips_and_matches_node() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let der = ed25519_pkcs8_der(&signing);
        assert_eq!(der.len(), 48);
        let back = ed25519_from_pkcs8_der(&der).expect("decodes");
        assert_eq!(back.to_bytes(), signing.to_bytes());
        assert!(ed25519_from_pkcs8_der(b"garbage").is_none());
    }
}
