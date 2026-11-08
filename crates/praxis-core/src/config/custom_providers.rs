//! User-added OpenAI-compatible provider endpoint configuration and sanitization (`FX-BF-044`).

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

/// Prefix for user-added custom provider IDs (`custom:<slug>`).
pub const CUSTOM_PROVIDER_PREFIX: &str = "custom:";

const RESERVED_HEADERS: &[&str] = &[
    "authorization",
    "content-type",
    "content-length",
    "accept",
    "host",
];

const LOOPBACK_HOSTS: &[&str] = &["localhost", "127.0.0.1", "::1", "[::1]"];

/// Authentication style for a custom provider endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProviderAuth {
    Bearer,
    None,
    Header { name: String },
}

/// Capabilities recorded by the last connection probe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub models: bool,
    pub chat: bool,
    pub streaming: bool,
    pub stream_usage: bool,
    pub tools: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub probed_at: String,
}

/// Validated custom OpenAI-compatible endpoint configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderConfig {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    pub protocol: String,
    pub base_url: String,
    pub api_path: String,
    pub auth: ProviderAuth,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_models: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_usage: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ProviderCapabilities>,
}

fn is_valid_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    if bytes.is_empty() || bytes.len() > 48 {
        return false;
    }
    if !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

pub(crate) fn is_valid_header_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    name.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'!' | b'#'
                    | b'$'
                    | b'%'
                    | b'&'
                    | b'\''
                    | b'*'
                    | b'+'
                    | b'.'
                    | b'^'
                    | b'_'
                    | b'`'
                    | b'|'
                    | b'~'
                    | b'-'
            )
    })
}

pub(crate) fn contains_word_bounded_pat(lower: &str) -> bool {
    let bytes = lower.as_bytes();
    let pat = b"pat";
    if bytes.len() < 3 {
        return false;
    }
    for i in 0..=(bytes.len() - 3) {
        if &bytes[i..i + 3] == pat {
            let prev_is_word =
                i > 0 && (bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
            let next_is_word = i + 3 < bytes.len()
                && (bytes[i + 3].is_ascii_alphanumeric() || bytes[i + 3] == b'_');
            if !prev_is_word && !next_is_word {
                return true;
            }
        }
    }
    false
}

fn is_secret_header_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("apikey")
        || lower.contains("api_key")
        || lower.contains("api-key")
        || contains_word_bounded_pat(&lower)
}

/// Returns `true` when `value` is a valid `custom:<slug>` provider identifier.
#[must_use]
pub fn is_custom_provider_id(value: &str) -> bool {
    let Some(slug) = value.strip_prefix(CUSTOM_PROVIDER_PREFIX) else {
        return false;
    };
    is_valid_slug(slug)
}

/// Returns a human-readable problem if `name` cannot carry an API key header, or `None` when valid.
#[must_use]
pub fn auth_header_name_problem(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Some("Header name is empty.".to_string());
    }
    if !is_valid_header_name(trimmed) {
        return Some(format!("“{trimmed}” is not a valid header name."));
    }
    if RESERVED_HEADERS.contains(&trimmed.to_ascii_lowercase().as_str()) {
        return Some(format!(
            "“{trimmed}” is set by Praxis and can't be overridden."
        ));
    }
    None
}

/// Returns a human-readable problem if `name` cannot be stored as a non-secret header.
#[must_use]
pub fn custom_header_name_problem(name: &str) -> Option<String> {
    if let Some(problem) = auth_header_name_problem(name) {
        return Some(problem);
    }
    if is_secret_header_name(name) {
        return Some(format!(
            "“{}” looks like a credential — put it in the API key field instead.",
            name.trim()
        ));
    }
    None
}

/// Returns a human-readable problem if `url` is not a valid `http(s)` server URL without credentials.
#[must_use]
pub fn custom_base_url_problem(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Some("Enter the server URL.".to_string());
    }
    let Ok(parsed) = Url::parse(trimmed) else {
        return Some("Not a valid URL.".to_string());
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Some("Use an http:// or https:// URL.".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Some("Put credentials in the API key field, not the URL.".to_string());
    }
    None
}

/// Returns `true` when `url` uses plain `http://` to a non-loopback host.
#[must_use]
pub fn is_insecure_remote_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url.trim()) else {
        return false;
    };
    if parsed.scheme() != "http" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    !LOOPBACK_HOSTS.contains(&host.to_ascii_lowercase().as_str())
}

/// Normalizes an API path: empty stays empty, otherwise one leading `/` and no trailing `/`.
#[must_use]
pub fn normalize_api_path(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

/// Generates a unique `custom:<slug>` ID from a human-readable label.
#[must_use]
pub fn custom_provider_id_for(label: &str, existing: &[String]) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in label.to_ascii_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let base: String = slug.trim_matches('-').chars().take(40).collect();
    let base = if base.is_empty() { "endpoint" } else { &base };
    let taken: HashSet<&str> = existing.iter().map(String::as_str).collect();
    let mut candidate = format!("{CUSTOM_PROVIDER_PREFIX}{base}");
    let mut n = 2usize;
    while taken.contains(candidate.as_str()) {
        candidate = format!("{CUSTOM_PROVIDER_PREFIX}{base}-{n}");
        n += 1;
    }
    candidate
}

fn read_auth(value: &Value) -> Option<ProviderAuth> {
    let obj = value.as_object()?;
    match obj.get("kind")?.as_str()? {
        "bearer" => Some(ProviderAuth::Bearer),
        "none" => Some(ProviderAuth::None),
        "header" => {
            let name = obj.get("name")?.as_str()?;
            if auth_header_name_problem(name).is_some() {
                return None;
            }
            Some(ProviderAuth::Header {
                name: name.trim().to_string(),
            })
        }
        _ => None,
    }
}

fn read_capabilities(value: &Value) -> Option<ProviderCapabilities> {
    let obj = value.as_object()?;
    let probed_at = obj.get("probedAt")?.as_str()?.to_string();
    let flag = |key: &str| obj.get(key).and_then(Value::as_bool).unwrap_or(false);
    let model = obj
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    Some(ProviderCapabilities {
        models: flag("models"),
        chat: flag("chat"),
        streaming: flag("streaming"),
        stream_usage: flag("streamUsage"),
        tools: flag("tools"),
        model,
        probed_at,
    })
}

/// Validates a single custom provider configuration object.
#[must_use]
pub fn sanitize_custom_provider(raw: &Value) -> Option<CustomProviderConfig> {
    let obj = raw.as_object()?;
    let id = obj.get("id")?.as_str()?;
    if !is_custom_provider_id(id) {
        return None;
    }
    let base_url_raw = obj.get("baseUrl")?.as_str()?;
    if custom_base_url_problem(base_url_raw).is_some() {
        return None;
    }
    let auth = read_auth(obj.get("auth")?)?;
    let label = obj
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(80).collect::<String>())
        .unwrap_or_else(|| id[CUSTOM_PROVIDER_PREFIX.len()..].to_string());

    let preset_id = obj
        .get("presetId")
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 40
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
        .map(ToString::to_string);

    let headers = obj
        .get("headers")
        .and_then(Value::as_object)
        .and_then(|map| {
            let mut out = BTreeMap::new();
            for (k, v) in map {
                if let Some(val_str) = v.as_str()
                    && custom_header_name_problem(k).is_none()
                    && !val_str.contains(['\r', '\n'])
                {
                    out.insert(k.trim().to_string(), val_str.to_string());
                }
            }
            (!out.is_empty()).then_some(out)
        });

    let manual_models = obj
        .get("manualModels")
        .and_then(Value::as_array)
        .and_then(|arr| {
            let mut seen = HashSet::new();
            let mut out = Vec::new();
            for item in arr {
                if let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty())
                    && seen.insert(s.to_string())
                {
                    out.push(s.to_string());
                }
            }
            (!out.is_empty()).then_some(out)
        });

    let stream_usage = obj.get("streamUsage").and_then(Value::as_bool);
    let capabilities = obj.get("capabilities").and_then(read_capabilities);

    Some(CustomProviderConfig {
        id: id.to_string(),
        label,
        preset_id,
        protocol: "openai-chat".to_string(),
        base_url: base_url_raw.trim().trim_end_matches('/').to_string(),
        api_path: obj
            .get("apiPath")
            .and_then(Value::as_str)
            .map(normalize_api_path)
            .unwrap_or_default(),
        auth,
        headers,
        manual_models,
        stream_usage,
        capabilities,
    })
}

/// Validates a list of custom providers, dropping malformed entries and duplicate IDs.
#[must_use]
pub fn sanitize_custom_providers(raw: Option<&Value>) -> Vec<CustomProviderConfig> {
    let Some(arr) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for entry in arr {
        if let Some(config) = sanitize_custom_provider(entry)
            && seen.insert(config.id.clone())
        {
            out.push(config);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_ids_and_header_validation_match_ts_suite() {
        assert!(is_custom_provider_id("custom:ollama-2"));
        assert!(!is_custom_provider_id("custom:"));
        assert!(!is_custom_provider_id("custom:Ollama"));
        assert!(!is_custom_provider_id("openai"));
        assert_eq!(
            custom_provider_id_for("Ollama · studio-mac", &[]),
            "custom:ollama-studio-mac"
        );
        assert_eq!(
            custom_provider_id_for(
                "Ollama",
                &["custom:ollama".to_string(), "custom:ollama-2".to_string()]
            ),
            "custom:ollama-3"
        );
        assert_eq!(custom_provider_id_for("···", &[]), "custom:endpoint");

        assert_eq!(custom_header_name_problem("HTTP-Referer"), None);
        assert_eq!(custom_header_name_problem("X-Title"), None);
        assert!(
            custom_header_name_problem("X-Api-Key")
                .unwrap_or_default()
                .contains("credential")
        );
        assert!(
            custom_header_name_problem("x-auth-token")
                .unwrap_or_default()
                .contains("credential")
        );
        assert!(
            custom_header_name_problem("Authorization")
                .unwrap_or_default()
                .contains("set by Praxis")
        );
        assert!(
            custom_header_name_problem("bad header")
                .unwrap_or_default()
                .contains("not a valid")
        );
    }
}
