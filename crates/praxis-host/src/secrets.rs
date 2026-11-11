//! In-memory secret store unlocked by Electron `safeStorage` or seeded by isolated tests.
//!
//! Keeping secret decryption at the Electron shell boundary (`safeStorage`) while holding the
//! unlocked key-value map inside [`HostSecretStore`] lets Rust services (`praxis-trackers`,
//! `praxis-ai`, `praxis-mobile`, `praxis-core`) read and update credentials without depending
//! on Electron's C++ keychain APIs.

use std::collections::BTreeMap;
use std::fmt::Debug;
use std::sync::{Arc, RwLock};

/// Durable storage behind a [`HostSecretStore`]. The store keeps the unlocked map in memory;
/// a backend makes writes survive a restart. Implementations must never log values.
pub trait SecretBackend: Debug + Send + Sync {
    /// Reads every persisted secret. Entries that cannot be read are skipped, never fatal.
    fn load(&self) -> BTreeMap<String, String>;
    /// Persists one secret.
    fn store(&self, key: &str, value: &str) -> Result<(), String>;
    /// Removes one secret. Removing an absent key is not an error.
    fn remove(&self, key: &str) -> Result<(), String>;
}

/// Thread-safe credential store shared across services inside [`crate::HostContext`].
#[derive(Debug, Clone, Default)]
pub struct HostSecretStore {
    inner: Arc<RwLock<BTreeMap<String, String>>>,
    backend: Arc<RwLock<Option<Arc<dyn SecretBackend>>>>,
}

impl HostSecretStore {
    /// Creates an empty [`HostSecretStore`].
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a [`HostSecretStore`] pre-populated with unlocked secrets.
    #[must_use]
    pub fn with_entries(entries: BTreeMap<String, String>) -> Self {
        let store = Self::new();
        store.seed(entries);
        store
    }

    /// Reads a secret by key, returning `None` if absent or blank.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<String> {
        let guard = self.inner.read().ok()?;
        guard.get(key).cloned()
    }

    /// Returns `true` if a non-empty secret exists for `key`.
    #[must_use]
    pub fn has(&self, key: &str) -> bool {
        self.inner
            .read()
            .ok()
            .is_some_and(|guard| guard.get(key).is_some_and(|v| !v.is_empty()))
    }

    /// Attaches durable storage and loads what it already holds into memory. Values already
    /// in memory (for example seeded by a test) win over persisted ones.
    pub fn attach_backend(&self, backend: Arc<dyn SecretBackend>) {
        let persisted = backend.load();
        if let Ok(mut guard) = self.inner.write() {
            for (key, value) in persisted {
                guard.entry(key).or_insert(value);
            }
        }
        if let Ok(mut slot) = self.backend.write() {
            *slot = Some(backend);
        }
    }

    fn backend(&self) -> Option<Arc<dyn SecretBackend>> {
        self.backend.read().ok().and_then(|slot| slot.clone())
    }

    /// Stores or updates a secret value. Passing an empty string removes the key.
    ///
    /// With a backend attached the value is persisted first; if that fails nothing changes and
    /// `false` is returned, so a secret is never reported stored that would vanish on restart.
    pub fn set(&self, key: impl Into<String>, value: impl Into<String>) -> bool {
        let key = key.into();
        let value = value.into();
        if let Some(backend) = self.backend() {
            let persisted = if value.is_empty() {
                backend.remove(&key)
            } else {
                backend.store(&key, &value)
            };
            if let Err(error) = persisted {
                eprintln!("[secrets] could not persist '{key}': {error}");
                return false;
            }
        }
        let Ok(mut guard) = self.inner.write() else {
            return false;
        };
        if value.is_empty() {
            guard.remove(&key).is_some()
        } else {
            guard.insert(key, value);
            true
        }
    }

    /// Deletes a secret by key, returning `true` if it was present.
    pub fn delete(&self, key: &str) -> bool {
        if let Some(backend) = self.backend()
            && let Err(error) = backend.remove(key)
        {
            eprintln!("[secrets] could not remove '{key}': {error}");
            return false;
        }
        self.inner
            .write()
            .ok()
            .is_some_and(|mut guard| guard.remove(key).is_some())
    }

    /// Merges a batch of unlocked secrets into the store and returns the total key count.
    pub fn seed(&self, entries: BTreeMap<String, String>) -> usize {
        let Ok(mut guard) = self.inner.write() else {
            return 0;
        };
        for (key, value) in entries {
            if value.is_empty() {
                guard.remove(&key);
            } else {
                guard.insert(key, value);
            }
        }
        guard.len()
    }

    /// Returns the sorted list of stored secret keys (never values).
    #[must_use]
    pub fn keys(&self) -> Vec<String> {
        self.inner
            .read()
            .map(|guard| guard.keys().cloned().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_store_crud_and_empty_removal() {
        let store = HostSecretStore::new();
        assert!(!store.has("github:conn-1:pat"));
        assert!(store.set("github:conn-1:pat", "ghp_test_token"));
        assert!(store.has("github:conn-1:pat"));
        assert_eq!(
            store.get("github:conn-1:pat").as_deref(),
            Some("ghp_test_token")
        );
        assert_eq!(store.keys(), vec!["github:conn-1:pat".to_string()]);

        // Empty value removes the secret.
        store.set("github:conn-1:pat", "");
        assert!(!store.has("github:conn-1:pat"));
        assert_eq!(store.get("github:conn-1:pat"), None);
    }
}
