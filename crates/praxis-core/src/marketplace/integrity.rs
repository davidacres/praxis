//! Tarball integrity verification against registry `dist` metadata (`integrity.ts` port).
//!
//! Prefers Subresource Integrity (`sha512-<base64>`, space-separated list, any
//! entry matching passes), falls back to a legacy hex SHA-1 `shasum`, and treats
//! a missing expectation as a hard failure: an add-on install downloads code and
//! content onto the machine, so "nothing to check" is never waved through.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};

/// Outcome of a single integrity check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrityResult {
    pub ok: bool,
    /// The algorithm that was checked (`sha512`, `sha1`, …), when one could be.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub algorithm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl IntegrityResult {
    fn pass(algorithm: &str) -> Self {
        Self {
            ok: true,
            algorithm: Some(algorithm.to_string()),
            reason: None,
        }
    }

    fn fail(algorithm: Option<&str>, reason: impl Into<String>) -> Self {
        Self {
            ok: false,
            algorithm: algorithm.map(str::to_string),
            reason: Some(reason.into()),
        }
    }
}

/// The `dist` hashes a registry advertises for one published version.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TarballDist {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shasum: Option<String>,
}

const SUPPORTED_SRI_ALGORITHMS: &[&str] = &["sha256", "sha384", "sha512"];

fn sri_digest_base64(bytes: &[u8], algorithm: &str) -> Option<String> {
    let digest = match algorithm {
        "sha256" => Sha256::digest(bytes).to_vec(),
        "sha384" => Sha384::digest(bytes).to_vec(),
        "sha512" => Sha512::digest(bytes).to_vec(),
        _ => return None,
    };
    Some(BASE64.encode(digest))
}

fn sha1_hex(bytes: &[u8]) -> String {
    Sha1::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Length-checked comparison whose running time does not depend on where the inputs differ.
fn constant_time_equals(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Checks `bytes` against an SRI string (`sha512-…`), possibly space-separated.
#[must_use]
pub fn verify_subresource_integrity(bytes: &[u8], sri: &str) -> IntegrityResult {
    let entries: Vec<(String, &str)> = sri
        .split_whitespace()
        .filter_map(|entry| {
            entry
                .split_once('-')
                .map(|(algorithm, expected)| (algorithm.to_lowercase(), expected))
        })
        .collect();

    if entries.is_empty() {
        return IntegrityResult::fail(
            None,
            "Integrity string was not in `<algorithm>-<hash>` form.",
        );
    }

    let checkable: Vec<&(String, &str)> = entries
        .iter()
        .filter(|(algorithm, _)| SUPPORTED_SRI_ALGORITHMS.contains(&algorithm.as_str()))
        .collect();
    if checkable.is_empty() {
        let seen: Vec<&str> = entries
            .iter()
            .map(|(algorithm, _)| algorithm.as_str())
            .collect();
        return IntegrityResult::fail(
            None,
            format!(
                "No supported hash algorithm in integrity string (saw {}).",
                seen.join(", ")
            ),
        );
    }

    for (algorithm, expected) in &checkable {
        if let Some(actual) = sri_digest_base64(bytes, algorithm)
            && constant_time_equals(&actual, expected)
        {
            return IntegrityResult::pass(algorithm);
        }
    }
    IntegrityResult::fail(
        Some(checkable[0].0.as_str()),
        "Downloaded tarball did not match the integrity hash the registry advertised.",
    )
}

/// Checks `bytes` against a hex SHA-1 `shasum`.
#[must_use]
pub fn verify_shasum(bytes: &[u8], shasum: &str) -> IntegrityResult {
    let expected = shasum.trim().to_lowercase();
    if expected.len() != 40 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return IntegrityResult::fail(None, "shasum was not a 40-character hex SHA-1.");
    }
    if constant_time_equals(&sha1_hex(bytes), &expected) {
        IntegrityResult::pass("sha1")
    } else {
        IntegrityResult::fail(
            Some("sha1"),
            "Downloaded tarball did not match the shasum the registry advertised.",
        )
    }
}

fn non_blank(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|v| !v.trim().is_empty())
}

/// Verifies `bytes` against whatever the registry advertised, preferring SRI.
///
/// Returns a specific reason on any failure, including "nothing to verify against".
pub fn assert_tarball_integrity(bytes: &[u8], dist: &TarballDist) -> Result<(), String> {
    let (result, fallback) = if let Some(integrity) = non_blank(dist.integrity.as_ref()) {
        (
            verify_subresource_integrity(bytes, integrity),
            "Tarball failed integrity verification.",
        )
    } else if let Some(shasum) = non_blank(dist.shasum.as_ref()) {
        (
            verify_shasum(bytes, shasum),
            "Tarball failed shasum verification.",
        )
    } else {
        return Err(
            "The registry published no integrity hash or shasum for this version — refusing to install it."
                .to_string(),
        );
    };
    if result.ok {
        Ok(())
    } else {
        Err(result.reason.unwrap_or_else(|| fallback.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BYTES: &[u8] = b"a pretend .tgz payload";

    fn sha512() -> String {
        BASE64.encode(Sha512::digest(BYTES))
    }

    fn sha256() -> String {
        BASE64.encode(Sha256::digest(BYTES))
    }

    #[test]
    fn sri_passes_on_matching_sha512_and_reports_algorithm() {
        let result = verify_subresource_integrity(BYTES, &format!("sha512-{}", sha512()));
        assert!(result.ok);
        assert_eq!(result.algorithm.as_deref(), Some("sha512"));
    }

    #[test]
    fn sri_passes_when_any_entry_in_space_separated_list_matches() {
        let result = verify_subresource_integrity(
            BYTES,
            &format!("sha256-not-the-hash sha512-{}", sha512()),
        );
        assert!(result.ok);
        assert_eq!(result.algorithm.as_deref(), Some("sha512"));
    }

    #[test]
    fn sri_accepts_sha256_and_uppercase_algorithm_names() {
        assert!(verify_subresource_integrity(BYTES, &format!("sha256-{}", sha256())).ok);
        assert!(verify_subresource_integrity(BYTES, &format!("SHA256-{}", sha256())).ok);
    }

    #[test]
    fn sri_fails_on_mismatch() {
        let result = verify_subresource_integrity(BYTES, &format!("sha512-{}", sha256()));
        assert!(!result.ok);
        assert!(result.reason.unwrap_or_default().contains("did not match"));
    }

    #[test]
    fn sri_rejects_unparseable_or_unsupported_strings() {
        assert!(!verify_subresource_integrity(BYTES, "deadbeef").ok);
        let unsupported = verify_subresource_integrity(BYTES, "md5-abc");
        assert!(!unsupported.ok);
        assert!(unsupported.reason.unwrap_or_default().contains("saw md5"));
    }

    #[test]
    fn shasum_checks_a_hex_sha1() {
        let hex = sha1_hex(BYTES);
        assert!(verify_shasum(BYTES, &hex).ok);
        assert!(verify_shasum(BYTES, &hex.to_uppercase()).ok);
        assert!(!verify_shasum(BYTES, &"f".repeat(40)).ok);
        assert!(!verify_shasum(BYTES, "not-hex").ok);
    }

    #[test]
    fn assert_prefers_sri_falls_back_to_shasum_and_errors_on_mismatch() {
        let sri = TarballDist {
            integrity: Some(format!("sha512-{}", sha512())),
            shasum: None,
        };
        assert!(assert_tarball_integrity(BYTES, &sri).is_ok());
        let shasum = TarballDist {
            integrity: None,
            shasum: Some(sha1_hex(BYTES)),
        };
        assert!(assert_tarball_integrity(BYTES, &shasum).is_ok());
        let mismatch = TarballDist {
            integrity: Some(format!("sha512-{}", sha256())),
            shasum: Some(sha1_hex(BYTES)),
        };
        let err = assert_tarball_integrity(BYTES, &mismatch).expect_err("mismatch");
        assert!(err.contains("did not match the integrity hash"), "{err}");
    }

    #[test]
    fn assert_refuses_a_version_with_nothing_to_verify_against() {
        for dist in [
            TarballDist::default(),
            TarballDist {
                integrity: Some("  ".to_string()),
                shasum: None,
            },
        ] {
            let err = assert_tarball_integrity(BYTES, &dist).expect_err("nothing to verify");
            assert!(err.contains("no integrity hash or shasum"), "{err}");
        }
    }
}
