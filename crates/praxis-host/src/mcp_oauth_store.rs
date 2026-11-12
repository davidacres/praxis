//! Durable MCP OAuth credentials (`DesktopMcpOAuthProvider` in the retired Electron host).
//!
//! The sign-in tokens, the dynamically registered client and the discovered endpoints are kept in
//! the shared [`HostSecretStore`], so they reach the OS keychain through whichever
//! [`crate::secrets::SecretBackend`] the host attached (and the profile's 0600 secrets file only
//! when the keychain is not in use). Nothing here ever writes a token to a plain file. Key names
//! match the TS provider: `praxis.mcp.oauth.<kind>.<sha256(server url [#client id])>`.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::secrets::HostSecretStore;

/// Refresh this long before the access token expires.
pub const REFRESH_SKEW_MS: u64 = 60_000;

/// The OAuth token set, shaped like the MCP SDK's `OAuthTokens` plus an absolute expiry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthTokens {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub token_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Milliseconds since the Unix epoch at which the access token stops working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
}

impl OAuthTokens {
    /// Builds a token set from a token-endpoint response, keeping `previous_refresh` when the
    /// server does not rotate the refresh token.
    #[must_use]
    pub fn from_response(
        response: &serde_json::Value,
        previous_refresh: Option<&str>,
        now_ms: u64,
    ) -> Option<Self> {
        let access_token = response["access_token"].as_str()?.to_owned();
        Some(Self {
            access_token,
            refresh_token: response["refresh_token"]
                .as_str()
                .or(previous_refresh)
                .filter(|t| !t.is_empty())
                .map(str::to_owned),
            token_type: response["token_type"]
                .as_str()
                .unwrap_or("Bearer")
                .to_owned(),
            scope: response["scope"].as_str().map(str::to_owned),
            expires_at_ms: response["expires_in"]
                .as_u64()
                .or_else(|| response["expires_in"].as_str().and_then(|s| s.parse().ok()))
                .map(|seconds| now_ms + seconds * 1000),
        })
    }

    /// The access token is expired, or about to be, and a refresh should be tried first.
    #[must_use]
    pub fn needs_refresh(&self, now_ms: u64) -> bool {
        self.expires_at_ms
            .is_some_and(|at| now_ms + REFRESH_SKEW_MS >= at)
    }
}

/// A registered (or configured) OAuth client, as far as refreshing needs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredClient {
    pub client_id: String,
}

/// Discovered endpoints, so a refresh after a restart needs no new discovery round trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredEndpoints {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
}

#[must_use]
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Token storage: a read-through cache over the host secret store.
#[derive(Debug, Default)]
pub struct TokenVault {
    store: RwLock<Option<HostSecretStore>>,
    memory: Mutex<BTreeMap<String, String>>,
}

impl TokenVault {
    #[must_use]
    pub fn with_store(store: HostSecretStore) -> Self {
        Self {
            store: RwLock::new(Some(store)),
            memory: Mutex::default(),
        }
    }

    /// The process-wide vault the Jira services share.
    #[must_use]
    pub fn global() -> &'static TokenVault {
        static VAULT: OnceLock<TokenVault> = OnceLock::new();
        VAULT.get_or_init(TokenVault::default)
    }

    /// Points the vault at the host's secret store (and so at the keychain). Entries already held
    /// in memory are flushed into it so a sign-in made first is not lost.
    pub fn install_store(&self, store: HostSecretStore) {
        if let Ok(memory) = self.memory.lock() {
            for (key, value) in memory.iter() {
                if !store.has(key) {
                    store.set(key.clone(), value.clone());
                }
            }
        }
        if let Ok(mut slot) = self.store.write() {
            *slot = Some(store);
        }
    }

    fn store(&self) -> Option<HostSecretStore> {
        self.store.read().ok().and_then(|slot| slot.clone())
    }

    /// The secret key for one kind of credential of one server (and pre-registered client).
    #[must_use]
    pub fn secret_key(kind: &str, identity: &str) -> String {
        let digest = Sha256::digest(identity.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        format!("praxis.mcp.oauth.{kind}.{hex}")
    }

    fn read(&self, kind: &str, identity: &str) -> Option<String> {
        let key = Self::secret_key(kind, identity);
        if let Some(value) = self.memory.lock().ok().and_then(|m| m.get(&key).cloned()) {
            return Some(value);
        }
        let value = self.store()?.get(&key)?;
        if let Ok(mut memory) = self.memory.lock() {
            memory.insert(key, value.clone());
        }
        Some(value)
    }

    fn write(&self, kind: &str, identity: &str, value: &str) {
        let key = Self::secret_key(kind, identity);
        if let Ok(mut memory) = self.memory.lock() {
            memory.insert(key.clone(), value.to_owned());
        }
        if let Some(store) = self.store() {
            // A failed persist leaves the in-memory copy so this run still works; the store logs
            // the key name (never the value).
            store.set(key, value);
        }
    }

    fn remove(&self, kind: &str, identity: &str) {
        let key = Self::secret_key(kind, identity);
        if let Ok(mut memory) = self.memory.lock() {
            memory.remove(&key);
        }
        if let Some(store) = self.store() {
            store.delete(&key);
        }
    }

    #[must_use]
    pub fn tokens(&self, identity: &str) -> Option<OAuthTokens> {
        serde_json::from_str(&self.read("tokens", identity)?).ok()
    }

    pub fn save_tokens(&self, identity: &str, tokens: &OAuthTokens) {
        if let Ok(json) = serde_json::to_string(tokens) {
            self.write("tokens", identity, &json);
        }
    }

    pub fn clear_tokens(&self, identity: &str) {
        self.remove("tokens", identity);
    }

    #[must_use]
    pub fn client(&self, identity: &str) -> Option<StoredClient> {
        serde_json::from_str(&self.read("client", identity)?).ok()
    }

    pub fn save_client(&self, identity: &str, client: &StoredClient) {
        if let Ok(json) = serde_json::to_string(client) {
            self.write("client", identity, &json);
        }
    }

    #[must_use]
    pub fn endpoints(&self, identity: &str) -> Option<StoredEndpoints> {
        serde_json::from_str(&self.read("discovery", identity)?).ok()
    }

    pub fn save_endpoints(&self, identity: &str, endpoints: &StoredEndpoints) {
        if let Ok(json) = serde_json::to_string(endpoints) {
            self.write("discovery", identity, &json);
        }
    }

    /// Forgets every credential of one server (`invalidateCredentials('all')`).
    pub fn clear_all(&self, identity: &str) {
        for kind in ["client", "tokens", "verifier", "discovery"] {
            self.remove(kind, identity);
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::secret_backends::FileSecretBackend;
    use std::sync::Arc;

    fn tokens() -> OAuthTokens {
        OAuthTokens {
            access_token: "access-fixture".into(),
            refresh_token: Some("refresh-fixture".into()),
            token_type: "Bearer".into(),
            scope: None,
            expires_at_ms: Some(10_000_000),
        }
    }

    fn file_store(path: &std::path::Path) -> HostSecretStore {
        let store = HostSecretStore::new();
        store.attach_backend(Arc::new(FileSecretBackend::new(path.to_path_buf())));
        store
    }

    #[test]
    fn tokens_survive_a_restart_through_the_secret_store() {
        let dir = std::env::temp_dir().join(format!("praxis-oauth-vault-{}", std::process::id()));
        let path = dir.join("secrets.json");
        let server = "https://mcp.example/mcp";
        let first = TokenVault::with_store(file_store(&path));
        first.save_tokens(server, &tokens());
        first.save_client(
            server,
            &StoredClient {
                client_id: "cid".into(),
            },
        );
        // A brand new vault over a brand new store reading the same backend: a restart.
        let second = TokenVault::with_store(file_store(&path));
        assert_eq!(second.tokens(server), Some(tokens()));
        assert_eq!(second.client(server).unwrap().client_id, "cid");
        // Another client identity for the same server sees nothing.
        assert!(
            second
                .tokens("https://mcp.example/mcp#byo-client")
                .is_none()
        );
        second.clear_all(server);
        assert!(
            TokenVault::with_store(file_store(&path))
                .tokens(server)
                .is_none()
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_sign_in_made_before_the_store_exists_is_flushed_into_it() {
        let dir = std::env::temp_dir().join(format!("praxis-oauth-flush-{}", std::process::id()));
        let path = dir.join("secrets.json");
        let vault = TokenVault::default();
        vault.save_tokens("srv", &tokens());
        vault.install_store(file_store(&path));
        assert_eq!(
            TokenVault::with_store(file_store(&path)).tokens("srv"),
            Some(tokens())
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keys_use_the_ts_scheme_and_never_the_plain_url() {
        let key = TokenVault::secret_key("tokens", "https://mcp.example/mcp");
        assert!(key.starts_with("praxis.mcp.oauth.tokens."));
        assert_eq!(key.len(), "praxis.mcp.oauth.tokens.".len() + 64);
        assert!(!key.contains("example"));
    }

    #[test]
    fn expiry_and_rotation_are_derived_from_the_token_response() {
        let response = serde_json::json!({"access_token": "a2", "expires_in": 3600});
        let next = OAuthTokens::from_response(&response, Some("kept-refresh"), 1_000).unwrap();
        assert_eq!(next.refresh_token.as_deref(), Some("kept-refresh"));
        assert_eq!(next.expires_at_ms, Some(1_000 + 3_600_000));
        assert!(!next.needs_refresh(1_000));
        assert!(next.needs_refresh(1_000 + 3_600_000 - REFRESH_SKEW_MS));
        let rotated = serde_json::json!({"access_token": "a3", "refresh_token": "r3"});
        let next = OAuthTokens::from_response(&rotated, Some("old"), 0).unwrap();
        assert_eq!(next.refresh_token.as_deref(), Some("r3"));
        assert!(!next.needs_refresh(u64::MAX / 2));
    }
}
