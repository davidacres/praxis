//! Validates the `praxis` block from an add-on package's `package.json` (`addonManifest.ts` port).
//!
//! `errors` are blocking — an entry with any is dropped from the catalogue and cannot be
//! installed. `warnings` are cosmetic gaps worth surfacing but not worth hiding the add-on over.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::catalog_types::{AddonDisplay, AddonDisplayMode, AddonKind, AddonManifest};
use super::semver::is_valid_version;

/// Result of [`validate_addon_manifest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddonManifestValidation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<AddonManifest>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// `^[a-z0-9][a-z0-9-]{0,63}$`
fn is_valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    let lower_alnum = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    !bytes.is_empty()
        && bytes.len() <= 64
        && lower_alnum(&bytes[0])
        && bytes[1..].iter().all(|b| lower_alnum(b) || *b == b'-')
}

fn optional_string(record: &Map<String, Value>, field: &str) -> Option<String> {
    record
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Validates an untrusted `praxis` manifest value.
#[must_use]
pub fn validate_addon_manifest(value: &Value) -> AddonManifestValidation {
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    let Some(record) = value.as_object() else {
        return AddonManifestValidation {
            manifest: None,
            errors: vec!["The `praxis` manifest is missing or is not an object.".to_string()],
            warnings,
        };
    };

    // JSON `1` and `1.0` are the same number in the TS original.
    if record.get("schemaVersion").and_then(Value::as_f64) != Some(1.0) {
        errors.push("`schemaVersion` must be 1.".to_string());
    }

    let kind = record
        .get("kind")
        .and_then(Value::as_str)
        .and_then(AddonKind::parse);
    if kind.is_none() {
        errors.push(
            "`kind` must be one of theme, surface-pack, agent, skill, workflow-template."
                .to_string(),
        );
    }

    let id = record.get("id").and_then(Value::as_str);
    if !id.is_some_and(is_valid_id) {
        errors.push(
            "`id` must be lower-kebab-case, start with a letter or digit, and be ≤ 64 characters."
                .to_string(),
        );
    }

    let name = record.get("name").and_then(Value::as_str);
    match name {
        Some(name) if !name.trim().is_empty() => {
            // JS `string.length` counts UTF-16 code units.
            if name.encode_utf16().count() > 80 {
                errors.push("`name` must be ≤ 80 characters.".to_string());
            }
        }
        _ => errors.push("`name` is required.".to_string()),
    }

    for field in ["summary", "author", "homepage"] {
        if record.get(field).is_some_and(|v| !v.is_string()) {
            errors.push(format!("`{field}` must be a string when present."));
        }
    }

    if let Some(homepage) = record.get("homepage").and_then(Value::as_str)
        && !homepage
            .get(..8)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))
    {
        errors.push("`homepage` must be an https URL.".to_string());
    }

    for field in ["contentVersion", "minAppVersion"] {
        if let Some(raw) = record.get(field)
            && !raw.as_str().is_some_and(is_valid_version)
        {
            errors.push(format!(
                "`{field}` must be a semver string (MAJOR.MINOR.PATCH) when present."
            ));
        }
    }

    let display = record
        .get("display")
        .and_then(|raw| validate_display(raw, &mut errors));

    if !record.contains_key("summary") {
        warnings.push("No `summary` — the catalogue row will have no description.".to_string());
    }
    if !record.contains_key("author") {
        warnings.push("No `author`.".to_string());
    }

    // With no errors, kind, id, and name are all present (each pushes an error when absent).
    let (true, Some(kind), Some(id), Some(name)) = (errors.is_empty(), kind, id, name) else {
        return AddonManifestValidation {
            manifest: None,
            errors,
            warnings,
        };
    };
    let manifest = AddonManifest {
        schema_version: 1,
        kind,
        id: id.to_string(),
        name: name.trim().to_string(),
        summary: optional_string(record, "summary"),
        content_version: optional_string(record, "contentVersion"),
        min_app_version: optional_string(record, "minAppVersion"),
        author: optional_string(record, "author"),
        homepage: optional_string(record, "homepage"),
        display,
    };
    AddonManifestValidation {
        manifest: Some(manifest),
        errors,
        warnings,
    }
}

/// Validates and normalizes `display`; an empty or colourless block collapses to `None`.
fn validate_display(raw: &Value, errors: &mut Vec<String>) -> Option<AddonDisplay> {
    let Some(display) = raw.as_object() else {
        errors.push("`display` must be an object when present.".to_string());
        return None;
    };

    let mut preview = BTreeMap::new();
    if let Some(raw_preview) = display.get("preview") {
        match raw_preview.as_object() {
            Some(entries) => {
                for (key, entry) in entries {
                    if let Some(colour) = entry.as_str() {
                        preview.insert(key.clone(), colour.to_string());
                    }
                }
            }
            None => errors.push("`display.preview` must be a map of colour tokens.".to_string()),
        }
    }

    let mode = match display.get("mode").and_then(Value::as_str) {
        Some("light") => Some(AddonDisplayMode::Light),
        Some("dark") => Some(AddonDisplayMode::Dark),
        _ => None,
    };
    if display.contains_key("mode") && mode.is_none() {
        errors.push("`display.mode` must be \"light\" or \"dark\".".to_string());
    }

    if preview.is_empty() && mode.is_none() {
        return None;
    }
    Some(AddonDisplay {
        preview: (!preview.is_empty()).then_some(preview),
        mode,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base(overrides: Value) -> Value {
        let mut value = json!({
            "schemaVersion": 1,
            "kind": "theme",
            "id": "nord-aurora",
            "name": "Nord Aurora",
            "summary": "A cool, muted palette.",
            "author": "acme"
        });
        if let (Some(target), Some(extra)) = (value.as_object_mut(), overrides.as_object()) {
            for (key, entry) in extra {
                target.insert(key.clone(), entry.clone());
            }
        }
        value
    }

    fn errors_of(value: &Value) -> String {
        validate_addon_manifest(value).errors.join(",")
    }

    #[test]
    fn well_formed_manifest_validates_and_is_normalized() {
        let result = validate_addon_manifest(&base(json!({ "name": "  Nord Aurora  " })));
        assert!(result.errors.is_empty());
        assert!(result.warnings.is_empty());
        let manifest = result.manifest.expect("manifest");
        assert_eq!(manifest.name, "Nord Aurora");
        assert_eq!(manifest.kind, AddonKind::Theme);
        assert_eq!(manifest.id, "nord-aurora");
    }

    #[test]
    fn missing_or_non_object_manifest_is_a_single_blocking_error() {
        assert_eq!(validate_addon_manifest(&Value::Null).manifest, None);
        assert_eq!(validate_addon_manifest(&json!("nope")).errors.len(), 1);
        assert_eq!(validate_addon_manifest(&json!([])).errors.len(), 1);
    }

    #[test]
    fn schema_version_must_be_exactly_1() {
        assert!(errors_of(&base(json!({ "schemaVersion": 2 }))).contains("schemaVersion"));
        assert!(errors_of(&base(json!({ "schemaVersion": "1" }))).contains("schemaVersion"));
        assert!(errors_of(&base(json!({ "schemaVersion": 1.0 }))).is_empty());
    }

    #[test]
    fn kind_must_be_a_known_kind() {
        for kind in ["surface-pack", "agent", "skill", "workflow-template"] {
            assert!(
                errors_of(&base(json!({ "kind": kind }))).is_empty(),
                "{kind}"
            );
        }
        assert!(errors_of(&base(json!({ "kind": "connection" }))).contains("kind"));
    }

    #[test]
    fn id_must_be_lower_kebab_and_bounded() {
        let too_long = "a".repeat(65);
        for bad in ["Nord", "nord_aurora", "-nord", "nörd", too_long.as_str()] {
            assert!(
                errors_of(&base(json!({ "id": bad }))).contains("id"),
                "{bad}"
            );
        }
        for good in ["a", "nord-aurora-2", "9-lives"] {
            assert!(errors_of(&base(json!({ "id": good }))).is_empty(), "{good}");
        }
    }

    #[test]
    fn name_is_required_and_length_bounded() {
        assert!(errors_of(&base(json!({ "name": "   " }))).contains("name"));
        assert!(errors_of(&base(json!({ "name": 123 }))).contains("name"));
        assert!(errors_of(&base(json!({ "name": "x".repeat(81) }))).contains("80"));
    }

    #[test]
    fn homepage_must_be_an_https_url_when_present() {
        assert!(errors_of(&base(json!({ "homepage": "https://example.com/x" }))).is_empty());
        assert!(errors_of(&base(json!({ "homepage": "HTTPS://example.com" }))).is_empty());
        assert!(errors_of(&base(json!({ "homepage": "http://example.com" }))).contains("homepage"));
        assert!(errors_of(&base(json!({ "homepage": "ftp://x" }))).contains("homepage"));
        assert!(errors_of(&base(json!({ "homepage": 7 }))).contains("homepage"));
    }

    #[test]
    fn content_and_min_app_versions_must_be_semver_when_present() {
        assert!(
            errors_of(&base(
                json!({ "contentVersion": "1.2.0", "minAppVersion": "0.2.0" })
            ))
            .is_empty()
        );
        assert!(errors_of(&base(json!({ "contentVersion": "1.2" }))).contains("contentVersion"));
        assert!(errors_of(&base(json!({ "minAppVersion": "latest" }))).contains("minAppVersion"));
    }

    #[test]
    fn display_hints_are_validated_and_normalized() {
        let result = validate_addon_manifest(&base(json!({
            "display": {
                "preview": { "canvas": "#111", "accent": "#88c0d0", "bogus": 42 },
                "mode": "dark"
            }
        })));
        assert!(result.errors.is_empty());
        let display = result.manifest.and_then(|m| m.display).expect("display");
        assert_eq!(display.mode, Some(AddonDisplayMode::Dark));
        let preview = display.preview.expect("preview");
        assert_eq!(preview.len(), 2);
        assert_eq!(preview["canvas"], "#111");
        assert_eq!(preview["accent"], "#88c0d0");
    }

    #[test]
    fn malformed_display_block_is_a_blocking_error() {
        assert!(errors_of(&base(json!({ "display": "nope" }))).contains("display"));
        assert!(
            errors_of(&base(json!({ "display": { "preview": [] } }))).contains("display.preview")
        );
        assert!(
            errors_of(&base(json!({ "display": { "mode": "sepia" } }))).contains("display.mode")
        );
    }

    #[test]
    fn empty_or_colourless_display_collapses_to_none() {
        for display in [json!({}), json!({ "preview": {} })] {
            let manifest = validate_addon_manifest(&base(json!({ "display": display })))
                .manifest
                .expect("manifest");
            assert_eq!(manifest.display, None);
        }
    }

    #[test]
    fn absent_summary_and_author_are_warnings_not_errors() {
        let result = validate_addon_manifest(&json!({
            "schemaVersion": 1, "kind": "theme", "id": "bare", "name": "Bare"
        }));
        assert!(result.manifest.is_some());
        assert!(result.errors.is_empty());
        assert_eq!(result.warnings.len(), 2);
    }
}
