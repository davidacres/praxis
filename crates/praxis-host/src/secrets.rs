//! In-memory secret store unlocked by Electron `safeStorage` or seeded by isolated tests.
//!
//! Keeping secret decryption at the Electron shell boundary (`safeStorage`) while holding the
//! unlocked key-value map inside [`HostSecretStore`] lets Rust services (`praxis-trackers`,
//! `praxis-ai`, `praxis-mobile`, `praxis-core`) read and update credentials without depending
//! on Electron's C++ keychain APIs.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

/// Thread-safe credential store shared across services inside [`crate::HostContext`].
#[derive(Debug, Clone, Default)]
pub struct HostSecretStore {
    inner: Arc<RwLock<BTreeMap<String, String>>>,
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

    /// Stores or updates a secret value. Passing an empty string removes the key.
    pub fn set(&self, key: impl Into<String>, value: impl Into<String>) -> bool {
        let key = key.into();
        let value = value.into();
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
