//! Durable [`SecretBackend`]s.
//!
//! * [`KeychainSecretBackend`] — the shipping backend. Values live in the OS credential store
//!   (macOS Keychain, Windows Credential Manager, Secret Service), one entry per key under the
//!   service name `Praxis`. The OS stores can't enumerate entries, so the key *names* (never
//!   values) are kept in `secrets.index.json` next to the profile.
//! * [`FileSecretBackend`] — a 0600 JSON file inside an explicit profile directory. Used by the
//!   e2e server and tests so a developer's real keychain is never read or written.
//!
//! Neither touches Electron's legacy `secrets.json`; see [`crate::electron_secrets`].

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::secrets::SecretBackend;

const SERVICE: &str = "Praxis";

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

/// File-backed secrets for isolated profiles (tests, e2e).
#[derive(Debug)]
pub struct FileSecretBackend {
    path: PathBuf,
    lock: Mutex<()>,
}

impl FileSecretBackend {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> BTreeMap<String, String> {
        // A secrets file that was left group/world-readable (copied, restored from a backup,
        // created by an older build) is tightened every time it is read, not only on write.
        #[cfg(unix)]
        if self.path.exists() {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
        }
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }
}

impl SecretBackend for FileSecretBackend {
    fn load(&self) -> BTreeMap<String, String> {
        self.read()
    }

    fn store(&self, key: &str, value: &str) -> Result<(), String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "secret file lock poisoned".to_string())?;
        let mut all = self.read();
        all.insert(key.to_owned(), value.to_owned());
        write_private(
            &self.path,
            &serde_json::to_vec_pretty(&all).map_err(|e| e.to_string())?,
        )
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "secret file lock poisoned".to_string())?;
        let mut all = self.read();
        if all.remove(key).is_some() {
            write_private(
                &self.path,
                &serde_json::to_vec_pretty(&all).map_err(|e| e.to_string())?,
            )?;
        }
        Ok(())
    }
}

/// OS credential store. Entries are `service = "Praxis"`, `account = <secret key>`.
#[derive(Debug)]
pub struct KeychainSecretBackend {
    index_path: PathBuf,
    lock: Mutex<()>,
}

impl KeychainSecretBackend {
    /// `profile_dir` holds only the non-sensitive key-name index.
    #[must_use]
    pub fn new(profile_dir: &Path) -> Self {
        Self {
            index_path: profile_dir.join("secrets.index.json"),
            lock: Mutex::new(()),
        }
    }

    fn read_index(&self) -> BTreeSet<String> {
        fs::read_to_string(&self.index_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn write_index(&self, index: &BTreeSet<String>) -> Result<(), String> {
        write_private(
            &self.index_path,
            &serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?,
        )
    }

    fn entry(key: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, key).map_err(|error| error.to_string())
    }
}

impl SecretBackend for KeychainSecretBackend {
    fn load(&self) -> BTreeMap<String, String> {
        let mut loaded = BTreeMap::new();
        for key in self.read_index() {
            match Self::entry(&key)
                .and_then(|entry| entry.get_password().map_err(|e| e.to_string()))
            {
                Ok(value) if !value.is_empty() => {
                    loaded.insert(key, value);
                }
                Ok(_) => {}
                Err(error) => eprintln!(
                    "[secrets] could not read '{key}' from the OS credential store: {error}"
                ),
            }
        }
        loaded
    }

    fn store(&self, key: &str, value: &str) -> Result<(), String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "secret index lock poisoned".to_string())?;
        Self::entry(key)?
            .set_password(value)
            .map_err(|error| error.to_string())?;
        let mut index = self.read_index();
        if index.insert(key.to_owned()) {
            self.write_index(&index)?;
        }
        Ok(())
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "secret index lock poisoned".to_string())?;
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(error.to_string()),
        }
        let mut index = self.read_index();
        if index.remove(key) {
            self.write_index(&index)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_backend_round_trips_and_is_private() {
        let dir = std::env::temp_dir().join(format!("praxis-secrets-{}", std::process::id()));
        let path = dir.join("secrets.json");
        let backend = FileSecretBackend::new(path.clone());
        backend.store("a", "1").expect("store");
        backend.store("b", "2").expect("store");
        backend.remove("a").expect("remove");
        backend.remove("never-there").expect("absent key is fine");
        assert_eq!(
            backend.load(),
            BTreeMap::from([("b".to_string(), "2".to_string())])
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).expect("meta").permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn reading_repairs_a_permissive_secrets_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("praxis-secrets-repair-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("secrets.json");
        fs::write(&path, r#"{"k":"fixture-only-value"}"#).expect("write");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod");
        let backend = FileSecretBackend::new(path.clone());
        assert_eq!(
            backend.load().get("k").map(String::as_str),
            Some("fixture-only-value")
        );
        assert_eq!(
            fs::metadata(&path).expect("meta").permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn store_persists_before_memory_and_survives_a_new_instance() {
        use crate::secrets::HostSecretStore;
        use std::sync::Arc;
        let dir = std::env::temp_dir().join(format!("praxis-secrets-store-{}", std::process::id()));
        let path = dir.join("secrets.json");
        let first = HostSecretStore::new();
        first.attach_backend(Arc::new(FileSecretBackend::new(path.clone())));
        assert!(first.set("ai:apiKey", "k-123"));
        let second = HostSecretStore::new();
        second.attach_backend(Arc::new(FileSecretBackend::new(path.clone())));
        assert_eq!(second.get("ai:apiKey").as_deref(), Some("k-123"));
        assert!(second.delete("ai:apiKey"));
        let third = HostSecretStore::new();
        third.attach_backend(Arc::new(FileSecretBackend::new(path)));
        assert!(!third.has("ai:apiKey"));
        let _ = fs::remove_dir_all(dir);
    }
}
