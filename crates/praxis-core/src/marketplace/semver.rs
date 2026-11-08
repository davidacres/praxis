//! Semver comparator for ordering add-on versions and gating `minAppVersion` (`semver.ts` port).
//!
//! Supports `MAJOR.MINOR.PATCH` with an optional leading `v`, optional `-prerelease`,
//! and an ignored `+build`.

use serde::{Deserialize, Serialize};

/// One dot-separated prerelease identifier (`numeric` or `alphanumeric`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PrereleaseIdentifier {
    Numeric(u64),
    Alphanumeric(String),
}

/// Parsed semantic version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub prerelease: Vec<PrereleaseIdentifier>,
}

fn is_valid_ident_chars(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// Parses a semver string, or returns `None` when it is not valid semver.
#[must_use]
pub fn parse_version(value: &str) -> Option<ParsedVersion> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_v = trimmed.strip_prefix('v').unwrap_or(trimmed);

    // Strip optional `+build`
    let (core_and_pre, build_opt) = match without_v.split_once('+') {
        Some((left, build)) => (left, Some(build)),
        None => (without_v, None),
    };
    if let Some(build) = build_opt {
        if !is_valid_ident_chars(build) {
            return None;
        }
    }

    // Split optional `-prerelease`
    let (core, pre_opt) = match core_and_pre.split_once('-') {
        Some((left, pre)) => (left, Some(pre)),
        None => (core_and_pre, None),
    };
    if let Some(pre) = pre_opt {
        if !is_valid_ident_chars(pre) {
            return None;
        }
    }

    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    for part in &parts {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    let major = parts[0].parse::<u64>().ok()?;
    let minor = parts[1].parse::<u64>().ok()?;
    let patch = parts[2].parse::<u64>().ok()?;

    let prerelease = match pre_opt {
        Some(pre) => pre
            .split('.')
            .map(|part| {
                if !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) {
                    if let Ok(num) = part.parse::<u64>() {
                        return PrereleaseIdentifier::Numeric(num);
                    }
                }
                PrereleaseIdentifier::Alphanumeric(part.to_string())
            })
            .collect(),
        None => Vec::new(),
    };

    Some(ParsedVersion {
        major,
        minor,
        patch,
        prerelease,
    })
}

/// Returns `true` when `value` is a valid semver string.
#[must_use]
pub fn is_valid_version(value: &str) -> bool {
    parse_version(value).is_some()
}

fn compare_prerelease(a: &[PrereleaseIdentifier], b: &[PrereleaseIdentifier]) -> i32 {
    if a.is_empty() && b.is_empty() {
        return 0;
    }
    if a.is_empty() {
        return 1;
    }
    if b.is_empty() {
        return -1;
    }

    let len = a.len().max(b.len());
    for i in 0..len {
        let Some(ai) = a.get(i) else {
            return -1;
        };
        let Some(bi) = b.get(i) else {
            return 1;
        };
        if ai == bi {
            continue;
        }
        return match (ai, bi) {
            (PrereleaseIdentifier::Numeric(an), PrereleaseIdentifier::Numeric(bn)) => {
                if an < bn {
                    -1
                } else {
                    1
                }
            }
            // Numeric identifiers always have lower precedence than alphanumeric ones.
            (PrereleaseIdentifier::Numeric(_), PrereleaseIdentifier::Alphanumeric(_)) => -1,
            (PrereleaseIdentifier::Alphanumeric(_), PrereleaseIdentifier::Numeric(_)) => 1,
            (PrereleaseIdentifier::Alphanumeric(as_), PrereleaseIdentifier::Alphanumeric(bs)) => {
                if as_ < bs {
                    -1
                } else {
                    1
                }
            }
        };
    }
    0
}

/// Returns a negative number when `a < b`, zero when equal, positive when `a > b`.
/// Unparseable versions sort below every valid one, and equal to each other.
#[must_use]
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let pa = parse_version(a);
    let pb = parse_version(b);
    match (pa, pb) {
        (None, None) => 0,
        (None, Some(_)) => -1,
        (Some(_), None) => 1,
        (Some(pa), Some(pb)) => {
            if pa.major != pb.major {
                return if pa.major < pb.major { -1 } else { 1 };
            }
            if pa.minor != pb.minor {
                return if pa.minor < pb.minor { -1 } else { 1 };
            }
            if pa.patch != pb.patch {
                return if pa.patch < pb.patch { -1 } else { 1 };
            }
            compare_prerelease(&pa.prerelease, &pb.prerelease)
        }
    }
}

/// Returns `true` when `candidate` is a strictly higher version than `current`.
#[must_use]
pub fn is_newer_version(candidate: &str, current: &str) -> bool {
    compare_versions(candidate, current) > 0
}

/// Returns the highest version in `versions`, or `None` when none parse.
#[must_use]
pub fn max_version<S: AsRef<str>>(versions: &[S]) -> Option<String> {
    let mut best: Option<&str> = None;
    for version in versions {
        let v = version.as_ref();
        if !is_valid_version(v) {
            continue;
        }
        if best.is_none_or(|b| is_newer_version(v, b)) {
            best = Some(v);
        }
    }
    best.map(str::to_string)
}

/// Returns `true` when `version` is at least `minimum` (both must be valid semver).
#[must_use]
pub fn meets_minimum(version: &str, minimum: &str) -> bool {
    if !is_valid_version(version) || !is_valid_version(minimum) {
        return false;
    }
    compare_versions(version, minimum) >= 0
}

/// Returns a copy of `versions` sorted newest-first.
#[must_use]
pub fn sort_versions_descending<S: AsRef<str>>(versions: &[S]) -> Vec<String> {
    let mut out: Vec<String> = versions.iter().map(|s| s.as_ref().to_string()).collect();
    out.sort_by(|a, b| match compare_versions(b, a) {
        x if x < 0 => std::cmp::Ordering::Less,
        0 => std::cmp::Ordering::Equal,
        _ => std::cmp::Ordering::Greater,
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_accepts_major_minor_patch_with_optional_v_prerelease_build() {
        assert_eq!(
            parse_version("1.2.3"),
            Some(ParsedVersion {
                major: 1,
                minor: 2,
                patch: 3,
                prerelease: vec![],
            })
        );
        assert_eq!(
            parse_version("v0.0.1"),
            Some(ParsedVersion {
                major: 0,
                minor: 0,
                patch: 1,
                prerelease: vec![],
            })
        );
        assert_eq!(
            parse_version("2.0.0-rc.1"),
            Some(ParsedVersion {
                major: 2,
                minor: 0,
                patch: 0,
                prerelease: vec![
                    PrereleaseIdentifier::Alphanumeric("rc".to_string()),
                    PrereleaseIdentifier::Numeric(1),
                ],
            })
        );
        assert_eq!(
            parse_version("1.4.0-beta.2+build.9"),
            Some(ParsedVersion {
                major: 1,
                minor: 4,
                patch: 0,
                prerelease: vec![
                    PrereleaseIdentifier::Alphanumeric("beta".to_string()),
                    PrereleaseIdentifier::Numeric(2),
                ],
            })
        );
    }

    #[test]
    fn parse_version_rejects_non_semver_strings() {
        for bad in ["", "1", "1.2", "1.2.x", "latest", "1.2.3.4", "a.b.c"] {
            assert_eq!(parse_version(bad), None, "{bad}");
            assert!(!is_valid_version(bad), "{bad}");
        }
    }

    #[test]
    fn compare_versions_orders_by_major_then_minor_then_patch() {
        assert!(compare_versions("2.0.0", "1.9.9") > 0);
        assert!(compare_versions("1.2.0", "1.10.0") < 0);
        assert!(compare_versions("1.2.3", "1.2.4") < 0);
        assert_eq!(compare_versions("3.1.4", "3.1.4"), 0);
    }

    #[test]
    fn compare_versions_places_prerelease_below_release_and_orders_identifiers_per_spec() {
        assert!(compare_versions("1.0.0-alpha", "1.0.0") < 0);
        assert!(compare_versions("1.0.0-alpha", "1.0.0-alpha.1") < 0);
        assert!(compare_versions("1.0.0-alpha.1", "1.0.0-alpha.beta") < 0);
        assert!(compare_versions("1.0.0-beta", "1.0.0-beta.2") < 0);
        assert!(compare_versions("1.0.0-beta.2", "1.0.0-beta.11") < 0);
        assert!(compare_versions("1.0.0-rc.1", "1.0.0") < 0);
    }

    #[test]
    fn unparseable_versions_sort_below_valid_and_equal_to_each_other() {
        assert!(compare_versions("garbage", "0.0.1") < 0);
        assert!(compare_versions("0.0.1", "garbage") > 0);
        assert_eq!(compare_versions("garbage", "nonsense"), 0);
    }

    #[test]
    fn is_newer_version_is_strict_greater_than() {
        assert!(is_newer_version("1.2.4", "1.2.3"));
        assert!(!is_newer_version("1.2.3", "1.2.3"));
        assert!(!is_newer_version("1.2.2", "1.2.3"));
    }

    #[test]
    fn max_version_returns_highest_parseable_version_ignoring_junk() {
        assert_eq!(
            max_version(&["1.0.0", "1.2.0", "1.10.0", "1.9.0"]),
            Some("1.10.0".to_string())
        );
        assert_eq!(
            max_version(&["2.0.0-rc.1", "1.9.9", "2.0.0"]),
            Some("2.0.0".to_string())
        );
        assert_eq!(max_version(&["nope", "also-nope"]), None);
        let empty: [&str; 0] = [];
        assert_eq!(max_version(&empty), None);
    }

    #[test]
    fn meets_minimum_is_inclusive_and_rejects_non_semver_inputs() {
        assert!(meets_minimum("1.2.3", "1.2.3"));
        assert!(meets_minimum("1.3.0", "1.2.9"));
        assert!(!meets_minimum("1.2.0", "1.2.9"));
        assert!(!meets_minimum("1.2.0", "not-semver"));
        assert!(!meets_minimum("whatever", "1.0.0"));
    }

    #[test]
    fn sort_versions_descending_does_not_mutate_input() {
        let input = ["1.0.0", "1.2.0", "1.1.0"];
        let sorted = sort_versions_descending(&input);
        assert_eq!(sorted, vec!["1.2.0", "1.1.0", "1.0.0"]);
    }
}
