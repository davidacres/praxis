//! One-time import of secrets written by the retired Electron app.
//!
//! Electron's `safeStorage` wrote `<profile>/secrets.json`: a JSON object of base64 blobs.
//! On macOS each blob is Chromium's `v10` format — the ASCII prefix `v10` followed by
//! AES-128-CBC ciphertext, keyed from the `"<App> Safe Storage"` Keychain password:
//! PBKDF2-HMAC-SHA1(password, salt `saltysalt`, 1003 iterations, 16 bytes), IV = 16 spaces.
//!
//! The import is read-only with respect to the legacy file: it is never modified or deleted,
//! so a downgrade or a failed import loses nothing.

use std::collections::BTreeMap;
use std::path::Path;

use crate::secrets::HostSecretStore;

use aes::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

const PREFIX: &[u8] = b"v10";

/// Whether a stored value is an Electron `safeStorage` blob rather than plaintext.
#[must_use]
pub fn is_safe_storage_blob(value: &str) -> bool {
    STANDARD
        .decode(value)
        .is_ok_and(|bytes| bytes.starts_with(PREFIX))
}

/// Derives the Chromium `v10` AES key from the Keychain "Safe Storage" password.
#[must_use]
pub fn derive_key(keychain_password: &str) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(keychain_password.as_bytes(), b"saltysalt", 1003, &mut key);
    key
}

/// Decrypts one blob. `None` for anything that is not a well-formed `v10` blob for this key,
/// matching Electron's own behavior of treating an undecryptable blob as unavailable.
#[must_use]
pub fn decrypt_blob(key: &[u8; 16], value: &str) -> Option<String> {
    let bytes = STANDARD.decode(value).ok()?;
    let ciphertext = bytes.strip_prefix(PREFIX)?;
    let iv = [b' '; 16];
    let plain = Aes128CbcDec::new(key.into(), &iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
        .ok()?;
    String::from_utf8(plain).ok()
}

/// Splits the legacy file into plaintext entries and encrypted blobs.
#[must_use]
pub fn partition_legacy(
    entries: BTreeMap<String, serde_json::Value>,
) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
    let (mut plain, mut blobs) = (BTreeMap::new(), BTreeMap::new());
    for (key, value) in entries {
        let Some(text) = value.as_str() else { continue };
        if text.is_empty() {
            continue;
        }
        if is_safe_storage_blob(text) {
            blobs.insert(key, text.to_owned());
        } else {
            plain.insert(key, text.to_owned());
        }
    }
    (plain, blobs)
}

/// What an import run did. Counts only — never names or values.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ImportReport {
    pub imported: usize,
    pub already_present: usize,
    pub undecryptable: usize,
    /// Encrypted entries left because no decryption key was available (not macOS, or access denied).
    pub locked: usize,
    pub complete: bool,
}

const MARKER: &str = "secrets.electron-import.done";

/// Imports `<profile_dir>/secrets.json` into `store` (which should already have its durable
/// backend attached, so each `set` is persisted). Existing values always win. `blob_key` is
/// called at most once, and only if there are encrypted entries still to import — it is where
/// the OS keychain prompt happens. The legacy file is never modified. A marker is written only
/// when nothing was left locked, so a denied prompt is retried on a later launch.
pub fn import_legacy(
    profile_dir: &Path,
    store: &HostSecretStore,
    blob_key: impl FnOnce() -> Option<[u8; 16]>,
) -> ImportReport {
    let mut report = ImportReport::default();
    let marker = profile_dir.join(MARKER);
    if marker.exists() {
        report.complete = true;
        return report;
    }
    let Ok(raw) = std::fs::read_to_string(profile_dir.join("secrets.json")) else {
        return report;
    };
    let Ok(entries) = serde_json::from_str::<BTreeMap<String, serde_json::Value>>(&raw) else {
        return report;
    };
    let (plain, blobs) = partition_legacy(entries);
    for (key, value) in plain {
        if store.has(&key) {
            report.already_present += 1;
        } else if store.set(key, value) {
            report.imported += 1;
        }
    }
    let pending: Vec<_> = blobs
        .into_iter()
        .filter(|(key, _)| !store.has(key))
        .collect();
    if !pending.is_empty() {
        match blob_key() {
            Some(key) => {
                for (name, blob) in pending {
                    match decrypt_blob(&key, &blob) {
                        Some(value) => {
                            if store.set(name, value) {
                                report.imported += 1;
                            } else {
                                report.locked += 1;
                            }
                        }
                        None => report.undecryptable += 1,
                    }
                }
            }
            None => report.locked = pending.len(),
        }
    }
    report.complete = report.locked == 0;
    if report.complete {
        let _ = std::fs::write(marker, b"done\n");
    }
    report
}

/// Reads the Safe Storage password from the macOS Keychain (this triggers the OS access
/// prompt the first time). `None` when the item is absent or access is denied.
#[cfg(target_os = "macos")]
#[must_use]
pub fn macos_safe_storage_password(service: &str, account: &str) -> Option<String> {
    let output = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-w", "-s", service, "-a", account])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let password = String::from_utf8(output.stdout).ok()?;
    let password = password.trim_end_matches('\n').to_owned();
    (!password.is_empty()).then_some(password)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncryptMut;

    type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

    fn encrypt(key: &[u8; 16], plain: &str) -> String {
        let iv = [b' '; 16];
        let cipher = Aes128CbcEnc::new(key.into(), &iv.into())
            .encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());
        STANDARD.encode([PREFIX, &cipher].concat())
    }

    #[test]
    fn decrypts_what_the_chromium_scheme_produces() {
        let key = derive_key("a-keychain-password");
        let blob = encrypt(&key, "sk-live-123");
        assert!(
            blob.starts_with("djEw"),
            "v10 base64 prefix, the shape seen in real profiles"
        );
        assert!(is_safe_storage_blob(&blob));
        assert_eq!(decrypt_blob(&key, &blob).as_deref(), Some("sk-live-123"));
    }

    #[test]
    fn wrong_key_or_garbage_is_unavailable_not_a_panic() {
        let blob = encrypt(&derive_key("right"), "secret");
        assert_eq!(decrypt_blob(&derive_key("wrong"), &blob), None);
        assert_eq!(decrypt_blob(&derive_key("right"), "not base64!!"), None);
        assert_eq!(
            decrypt_blob(&derive_key("right"), &STANDARD.encode(b"v10short")),
            None
        );
        assert!(!is_safe_storage_blob("plain-token"));
    }

    #[test]
    fn import_is_additive_read_only_and_retries_when_locked() {
        use crate::secret_backends::FileSecretBackend;
        use std::sync::Arc;
        let dir = std::env::temp_dir().join(format!("praxis-import-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let key = derive_key("pw");
        let legacy = serde_json::json!({ "enc": encrypt(&key, "from-electron"), "keep": encrypt(&key, "old"), "plain": "p" });
        std::fs::write(dir.join("secrets.json"), legacy.to_string()).expect("legacy");
        let before = std::fs::read(dir.join("secrets.json")).expect("read");

        let store = HostSecretStore::new();
        store.attach_backend(Arc::new(FileSecretBackend::new(
            dir.join("new-secrets.json"),
        )));
        store.set("keep", "newer");

        let locked = import_legacy(&dir, &store, || None);
        assert_eq!(
            (locked.imported, locked.locked, locked.complete),
            (1, 1, false),
            "plain imported; the one missing blob waits"
        );
        assert!(!dir.join(MARKER).exists());

        let done = import_legacy(&dir, &store, || Some(key));
        assert_eq!((done.imported, done.locked, done.complete), (1, 0, true));
        assert_eq!(store.get("enc").as_deref(), Some("from-electron"));
        assert_eq!(
            store.get("keep").as_deref(),
            Some("newer"),
            "existing values win"
        );
        assert_eq!(
            std::fs::read(dir.join("secrets.json")).expect("read"),
            before,
            "legacy file untouched"
        );

        let again = import_legacy(&dir, &store, || {
            panic!("must not prompt again after completion")
        });
        assert!(again.complete);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn partition_separates_plaintext_from_blobs_and_skips_non_strings() {
        let key = derive_key("k");
        let entries = BTreeMap::from([
            ("a".to_string(), serde_json::json!(encrypt(&key, "x"))),
            ("b".to_string(), serde_json::json!("plain")),
            ("c".to_string(), serde_json::json!(5)),
            ("d".to_string(), serde_json::json!("")),
        ]);
        let (plain, blobs) = partition_legacy(entries);
        assert_eq!(plain.keys().collect::<Vec<_>>(), vec!["b"]);
        assert_eq!(blobs.keys().collect::<Vec<_>>(), vec!["a"]);
    }
}
