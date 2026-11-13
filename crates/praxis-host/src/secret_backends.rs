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
    // Created 0600 rather than chmod-ed after the write, so the secrets are never readable by
    // others, not even for the moment between the two. A stale temp file (perhaps left with wider
    // permissions by an older build) is removed first so the mode applies to a new file.
    let _ = fs::remove_file(&tmp);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    {
        use std::io::Write;
        let mut file = options.open(&tmp).map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
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

/// The single keychain item that holds every secret, as one JSON object.
///
/// One item means one access check, so startup asks the OS for permission once rather than once per
/// secret. Entries used to be stored one per key (`account = <secret key>`); the first load folds
/// those into this item and removes them, see [`KeychainSecretBackend::migrate_legacy`].
const VAULT_ACCOUNT: &str = "praxis.secrets.v1";

/// Keys that only live for the length of a sign-in and are never worth carrying over.
const TRANSIENT_PREFIXES: &[&str] = &["ticketManager.mcp.oauth.verifier."];

/// The keychain operations the backend needs, so the migration can be tested without the OS store.
pub(crate) trait KeychainItems: std::fmt::Debug + Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The real OS credential store: `service = "Praxis"`, one entry per account.
#[derive(Debug)]
struct OsKeychainItems;

impl OsKeychainItems {
    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, account).map_err(|error| error.to_string())
    }
}

impl KeychainItems for OsKeychainItems {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        Self::entry(account)?
            .set_password(value)
            .map_err(|error| error.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[derive(Debug, Default)]
struct VaultState {
    /// The secrets, once the vault has been read. `None` until then.
    secrets: Option<BTreeMap<String, String>>,
    /// Set when a legacy item could not be read, so writing a vault now would drop it.
    migration_incomplete: bool,
}

/// OS credential store holding every secret in one item.
#[derive(Debug)]
pub struct KeychainSecretBackend {
    /// Names of the legacy per-key items, from before everything moved into one item.
    index_path: PathBuf,
    items: Box<dyn KeychainItems>,
    state: Mutex<VaultState>,
}

impl KeychainSecretBackend {
    /// `profile_dir` holds only the legacy key-name index, which is removed after migration.
    #[must_use]
    pub fn new(profile_dir: &Path) -> Self {
        Self::with_items(profile_dir, Box::new(OsKeychainItems))
    }

    pub(crate) fn with_items(profile_dir: &Path, items: Box<dyn KeychainItems>) -> Self {
        Self {
            index_path: profile_dir.join("secrets.index.json"),
            items,
            state: Mutex::new(VaultState::default()),
        }
    }

    fn read_index(&self) -> BTreeSet<String> {
        fs::read_to_string(&self.index_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, VaultState>, String> {
        self.state
            .lock()
            .map_err(|_| "secret vault lock poisoned".to_string())
    }

    fn write_vault(&self, secrets: &BTreeMap<String, String>) -> Result<(), String> {
        self.items.set(
            VAULT_ACCOUNT,
            &serde_json::to_string(secrets).map_err(|error| error.to_string())?,
        )
    }

    /// Reads the vault once and keeps it in memory. A vault that is missing is created from the
    /// legacy per-key items; one that cannot be read is an error, never an empty vault, so a later
    /// write can't overwrite secrets the OS merely refused to hand over.
    fn ensure_loaded(&self, state: &mut VaultState) -> Result<(), String> {
        if state.secrets.is_some() {
            return Ok(());
        }
        match self.items.get(VAULT_ACCOUNT)? {
            Some(raw) => {
                let parsed = serde_json::from_str(&raw)
                    .map_err(|error| format!("the secret vault is unreadable: {error}"))?;
                state.secrets = Some(parsed);
            }
            None => self.migrate_legacy(state),
        }
        Ok(())
    }

    /// Folds the old one-item-per-key entries into the vault, then removes them. If any of them
    /// can't be read (access refused) nothing is written or removed, and writes stay blocked until
    /// a later launch can read them all.
    fn migrate_legacy(&self, state: &mut VaultState) {
        let mut gathered = BTreeMap::new();
        let mut complete = true;
        let legacy = self.read_index();
        for key in &legacy {
            if TRANSIENT_PREFIXES
                .iter()
                .any(|prefix| key.starts_with(prefix))
            {
                continue;
            }
            match self.items.get(key) {
                Ok(Some(value)) if !value.is_empty() => {
                    gathered.insert(key.clone(), value);
                }
                Ok(_) => {}
                Err(error) => {
                    complete = false;
                    eprintln!(
                        "[secrets] could not read '{key}' from the OS credential store: {error}"
                    );
                }
            }
        }
        if complete && !legacy.is_empty() {
            match self.write_vault(&gathered) {
                Ok(()) => {
                    for key in &legacy {
                        let _ = self.items.delete(key);
                    }
                    let _ = fs::remove_file(&self.index_path);
                    eprintln!(
                        "[secrets] moved {} secrets into one keychain item",
                        gathered.len()
                    );
                }
                Err(error) => {
                    complete = false;
                    eprintln!("[secrets] could not create the keychain vault: {error}");
                }
            }
        }
        state.migration_incomplete = !complete;
        state.secrets = Some(gathered);
    }

    fn mutate(
        &self,
        change: impl FnOnce(&mut BTreeMap<String, String>) -> bool,
    ) -> Result<(), String> {
        let mut state = self.lock_state()?;
        self.ensure_loaded(&mut state)?;
        if state.migration_incomplete {
            return Err(
                "Some saved secrets could not be read from the keychain, so changes are paused. \
                 Allow access when prompted and relaunch Praxis."
                    .into(),
            );
        }
        let mut next = state.secrets.clone().unwrap_or_default();
        if change(&mut next) {
            self.write_vault(&next)?;
            state.secrets = Some(next);
        }
        Ok(())
    }
}

impl SecretBackend for KeychainSecretBackend {
    fn load(&self) -> BTreeMap<String, String> {
        let Ok(mut state) = self.lock_state() else {
            return BTreeMap::new();
        };
        match self.ensure_loaded(&mut state) {
            Ok(()) => state.secrets.clone().unwrap_or_default(),
            Err(error) => {
                eprintln!("[secrets] could not read the OS credential store: {error}");
                BTreeMap::new()
            }
        }
    }

    fn store(&self, key: &str, value: &str) -> Result<(), String> {
        self.mutate(|all| {
            if all.get(key).map(String::as_str) == Some(value) {
                return false;
            }
            all.insert(key.to_owned(), value.to_owned());
            true
        })
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        self.mutate(|all| all.remove(key).is_some())
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

    #[cfg(unix)]
    #[test]
    fn a_stale_permissive_temp_file_does_not_widen_the_written_secrets() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("praxis-secrets-tmp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("secrets.json");
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, "{}").expect("stale tmp");
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644)).expect("chmod");
        write_private(&path, br#"{"k":"v"}"#).expect("write");
        assert_eq!(
            fs::metadata(&path).expect("meta").permissions().mode() & 0o777,
            0o600
        );
        assert!(!tmp.exists());
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

    /// An in-memory stand-in for the OS keychain that counts reads.
    #[derive(Debug, Default)]
    struct FakeKeychain {
        items: Mutex<BTreeMap<String, String>>,
        gets: Mutex<Vec<String>>,
        unreadable: Mutex<BTreeSet<String>>,
    }

    impl KeychainItems for std::sync::Arc<FakeKeychain> {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.gets.lock().expect("gets").push(account.to_owned());
            if self
                .unreadable
                .lock()
                .expect("unreadable")
                .contains(account)
            {
                return Err("User canceled the operation".into());
            }
            Ok(self.items.lock().expect("items").get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Result<(), String> {
            self.items
                .lock()
                .expect("items")
                .insert(account.to_owned(), value.to_owned());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.items.lock().expect("items").remove(account);
            Ok(())
        }
    }

    fn legacy_profile(
        name: &str,
        entries: &[(&str, &str)],
    ) -> (PathBuf, std::sync::Arc<FakeKeychain>) {
        let dir = std::env::temp_dir().join(format!("praxis-vault-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        let keychain = std::sync::Arc::new(FakeKeychain::default());
        let names: BTreeSet<&str> = entries.iter().map(|(key, _)| *key).collect();
        fs::write(
            dir.join("secrets.index.json"),
            serde_json::to_string(&names).expect("index"),
        )
        .expect("write index");
        for (key, value) in entries {
            keychain.set(key, value).expect("seed");
        }
        (dir, keychain)
    }

    fn backend(dir: &Path, keychain: &std::sync::Arc<FakeKeychain>) -> KeychainSecretBackend {
        KeychainSecretBackend::with_items(dir, Box::new(std::sync::Arc::clone(keychain)))
    }

    #[test]
    fn legacy_items_are_folded_into_one_item_and_removed() {
        let (dir, keychain) = legacy_profile(
            "migrate",
            &[
                ("praxis.geminiApiKey", "g-1"),
                ("mobile:hostId", "host-1"),
                ("ticketManager.mcp.oauth.verifier.abc", "stale"),
            ],
        );
        let first = backend(&dir, &keychain).load();
        assert_eq!(
            first,
            BTreeMap::from([
                ("mobile:hostId".to_string(), "host-1".to_string()),
                ("praxis.geminiApiKey".to_string(), "g-1".to_string()),
            ])
        );
        let accounts: Vec<String> = keychain
            .items
            .lock()
            .expect("items")
            .keys()
            .cloned()
            .collect();
        assert_eq!(
            accounts,
            vec![VAULT_ACCOUNT.to_string()],
            "only the vault is left"
        );
        assert!(
            !dir.join("secrets.index.json").exists(),
            "the legacy index is removed"
        );

        // A later launch reads the single item and nothing else.
        keychain.gets.lock().expect("gets").clear();
        assert_eq!(backend(&dir, &keychain).load(), first);
        assert_eq!(
            *keychain.gets.lock().expect("gets"),
            vec![VAULT_ACCOUNT.to_string()]
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn storing_and_removing_rewrite_the_one_item() {
        let (dir, keychain) = legacy_profile("rewrite", &[("a", "1"), ("b", "2")]);
        let vault = backend(&dir, &keychain);
        vault.load();
        vault.store("c", "3").expect("store");
        vault.remove("a").expect("remove");
        vault.remove("never-there").expect("absent key is fine");
        let reopened = backend(&dir, &keychain).load();
        assert_eq!(
            reopened,
            BTreeMap::from([
                ("b".to_string(), "2".to_string()),
                ("c".to_string(), "3".to_string()),
            ])
        );
        assert_eq!(keychain.items.lock().expect("items").len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_fresh_install_starts_empty_and_creates_the_item_on_first_write() {
        let dir = std::env::temp_dir().join(format!("praxis-vault-fresh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        let keychain = std::sync::Arc::new(FakeKeychain::default());
        let vault = backend(&dir, &keychain);
        assert!(vault.load().is_empty());
        assert!(keychain.items.lock().expect("items").is_empty());
        vault.store("k", "v").expect("store");
        assert_eq!(
            backend(&dir, &keychain).load().get("k").map(String::as_str),
            Some("v")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_refused_legacy_read_keeps_every_legacy_item_and_pauses_writes() {
        let (dir, keychain) = legacy_profile("refused", &[("a", "1"), ("b", "2")]);
        keychain
            .unreadable
            .lock()
            .expect("unreadable")
            .insert("b".into());
        let vault = backend(&dir, &keychain);
        assert_eq!(
            vault.load(),
            BTreeMap::from([("a".to_string(), "1".to_string())])
        );
        assert!(vault.store("c", "3").is_err(), "writing now would drop 'b'");
        let accounts: Vec<String> = keychain
            .items
            .lock()
            .expect("items")
            .keys()
            .cloned()
            .collect();
        assert_eq!(
            accounts,
            vec!["a".to_string(), "b".to_string()],
            "nothing was created or removed"
        );
        assert!(dir.join("secrets.index.json").exists());

        // Once access is allowed, the next launch migrates everything.
        keychain.unreadable.lock().expect("unreadable").clear();
        assert_eq!(
            backend(&dir, &keychain).load(),
            BTreeMap::from([
                ("a".to_string(), "1".to_string()),
                ("b".to_string(), "2".to_string())
            ])
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unreadable_vault_is_an_error_and_is_never_overwritten() {
        let (dir, keychain) = legacy_profile("corrupt", &[]);
        keychain.set(VAULT_ACCOUNT, "not json").expect("seed");
        let vault = backend(&dir, &keychain);
        assert!(vault.load().is_empty());
        assert!(vault.store("k", "v").is_err());
        assert_eq!(
            keychain
                .items
                .lock()
                .expect("items")
                .get(VAULT_ACCOUNT)
                .map(String::as_str),
            Some("not json")
        );
        let _ = fs::remove_dir_all(dir);
    }
}
