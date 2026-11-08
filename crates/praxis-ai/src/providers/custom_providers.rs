//! Custom AI providers: an OpenAI-compatible endpoint Praxis does not know
//! about, with its own base URL, model and headers.
//!
//! Two things here are security decisions rather than validation:
//!
//! - A custom base URL may only be plain HTTP when it points at localhost.
//!   A provider's traffic carries the user's API key and prompt content, so
//!   sending it in the clear to a remote host is refused outright.
//! - A base URL may not carry credentials (`https://user:pass@host`), because
//!   they would be written into logs and settings in the clear.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// The characters an HTTP header name may use.
fn header_name_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$").expect("the header name pattern is valid")
    })
}

/// The characters a secret name may use.
fn secret_name_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"^[A-Za-z0-9_]+$").expect("the secret name pattern is valid"))
}

/// A provider id, which is `custom-` followed by a slug.
fn slug_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9-]*$").expect("the slug pattern is valid"))
}

/// A base URL that points at this machine.
fn local_host_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)^https?://(localhost|127\.0\.0\.1|\[::1\])(:|/|$)")
            .expect("the local host pattern is valid")
    })
}

/// A base URL that carries credentials.
fn credential_url_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)^https?://[^/]*@").expect("the credential URL pattern is valid")
    })
}

/// A custom provider as it is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// Extra headers, by header name. The values are secrets.
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

/// A custom provider being edited, before it is saved.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CustomProviderInput {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// Header names whose value is a secret.
    pub headers: HashMap<String, String>,
    /// Header names whose value is not a secret.
    pub header_names: Vec<String>,
}

/// The problem with a custom base URL, if there is one.
#[must_use]
pub fn custom_base_url_problem(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Some("A base URL is required.".to_string());
    }
    let lowered = trimmed.to_lowercase();
    if !lowered.starts_with("https://") && !lowered.starts_with("http://") {
        return Some("The base URL must start with https:// or http://.".to_string());
    }
    // Plain HTTP is only allowed to this machine: the request carries the
    // user's API key and their prompt content.
    if lowered.starts_with("http://") && !local_host_pattern().is_match(trimmed) {
        return Some("The base URL must use https:// unless it points at localhost.".to_string());
    }
    if credential_url_pattern().is_match(trimmed) {
        return Some("The base URL must not contain credentials.".to_string());
    }
    None
}

/// Whether a header name may be sent.
#[must_use]
pub fn is_valid_custom_provider_header_name(name: &str) -> bool {
    header_name_pattern().is_match(name)
}

/// Whether a secret name may be stored.
#[must_use]
pub fn is_valid_custom_provider_secret_name(name: &str) -> bool {
    secret_name_pattern().is_match(name)
}

/// Every problem with a custom provider draft. An empty list means it is
/// good to save.
#[must_use]
pub fn validate_custom_provider(input: &CustomProviderInput) -> Vec<String> {
    let mut problems = Vec::new();
    if input.name.trim().is_empty() {
        problems.push("A name is required.".to_string());
    }
    if let Some(problem) = custom_base_url_problem(&input.base_url) {
        problems.push(problem);
    }
    if input.api_key.trim().is_empty() && input.headers.is_empty() {
        problems.push("An API key or at least one custom header is required.".to_string());
    }
    if input.model.trim().is_empty() {
        problems.push("A model is required.".to_string());
    }
    for (name, value) in &input.headers {
        if !is_valid_custom_provider_header_name(name) {
            problems.push(format!("Header name \"{name}\" is not valid."));
            continue;
        }
        if value.trim().is_empty() {
            problems.push(format!("Header \"{name}\" must have a value."));
        }
    }
    for name in &input.header_names {
        if !is_valid_custom_provider_header_name(name) {
            problems.push(format!("Header name \"{name}\" is not valid."));
        }
    }
    problems
}

/// A slug for a name: accented letters lose their accents, everything else
/// that is not a letter or a digit becomes a dash.
#[must_use]
pub fn slugify(value: &str) -> String {
    let folded: String = value
        .nfkd()
        .filter(|character| !is_combining_mark(*character))
        .collect();
    let mut slug = String::with_capacity(folded.len());
    let mut pending_dash = false;
    for character in folded.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(character.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}

/// The provider id a saved custom provider should carry.
///
/// A provider whose name does not slug cleanly gets the plain `custom` id
/// rather than one derived from the name, so the id never depends on text
/// that may change.
#[must_use]
pub fn custom_provider_id_draft(config: &CustomProviderConfig) -> String {
    let slug = slugify(&config.name);
    if slug.is_empty() || slug.len() < 2 || slug.ends_with('-') {
        return "custom".to_string();
    }
    format!("custom-{slug}")
}

/// The headers to send with a custom provider request.
///
/// The API key goes in as a bearer token first; a custom header with an
/// unusable name or an empty value is dropped rather than sent, because an
/// empty `Authorization` is worse than no header at all.
#[must_use]
pub fn custom_provider_headers(config: &CustomProviderConfig) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    let api_key = config.api_key.trim();
    if !api_key.is_empty() {
        headers.insert("Authorization".to_string(), format!("Bearer {api_key}"));
    }
    for (name, value) in &config.headers {
        if !is_valid_custom_provider_header_name(name) {
            continue;
        }
        if value.trim().is_empty() {
            continue;
        }
        headers.insert(name.clone(), value.clone());
    }
    headers
}

/// The secret fields a custom provider holds, so they can be listed and
/// removed without the values being shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderSecretFields {
    /// The provider's API key.
    pub api_key: String,
    /// The names of the extra header secrets.
    pub headers: Vec<String>,
}

/// The secret fields a custom provider holds.
#[must_use]
pub fn custom_provider_secret_fields(config: &CustomProviderConfig) -> CustomProviderSecretFields {
    let mut headers: Vec<String> = config
        .headers
        .keys()
        .filter(|name| is_valid_custom_provider_header_name(name))
        .cloned()
        .collect();
    headers.sort();
    CustomProviderSecretFields {
        api_key: config.api_key.clone(),
        headers,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CustomProviderConfig, CustomProviderInput, custom_base_url_problem,
        custom_provider_headers, custom_provider_id_draft, custom_provider_secret_fields,
        is_valid_custom_provider_header_name, is_valid_custom_provider_secret_name, slugify,
        validate_custom_provider,
    };
    use std::collections::HashMap;

    fn input() -> CustomProviderInput {
        CustomProviderInput {
            name: "ACME Gateway".to_string(),
            base_url: "https://ai.acme.dev/v1".to_string(),
            api_key: "sk-test".to_string(),
            model: "acme-large".to_string(),
            headers: HashMap::from([("x-team".to_string(), "platform".to_string())]),
            header_names: vec!["x-trace".to_string()],
        }
    }

    fn config() -> CustomProviderConfig {
        CustomProviderConfig {
            id: Some("custom-acme-gateway".to_string()),
            name: "ACME Gateway".to_string(),
            base_url: "https://ai.acme.dev/v1".to_string(),
            api_key: "sk-test".to_string(),
            model: "acme-large".to_string(),
            headers: HashMap::from([("x-team".to_string(), "platform".to_string())]),
        }
    }

    #[test]
    fn a_valid_provider_has_no_problems() {
        assert_eq!(validate_custom_provider(&input()), Vec::<String>::new());
    }

    #[test]
    fn a_missing_name_is_reported() {
        let mut draft = input();
        draft.name = "  ".to_string();
        assert_eq!(
            validate_custom_provider(&draft),
            vec!["A name is required.".to_string()]
        );
    }

    #[test]
    fn a_missing_base_url_is_reported() {
        let mut draft = input();
        draft.base_url = "".to_string();
        assert_eq!(
            validate_custom_provider(&draft),
            vec!["A base URL is required.".to_string()]
        );
    }

    #[test]
    fn a_non_http_base_url_is_reported() {
        let mut draft = input();
        draft.base_url = "ai.acme.dev/v1".to_string();
        assert_eq!(
            validate_custom_provider(&draft),
            vec!["The base URL must start with https:// or http://.".to_string()]
        );
    }

    #[test]
    fn an_insecure_remote_base_url_is_reported() {
        let mut draft = input();
        draft.base_url = "http://ai.acme.dev/v1".to_string();
        assert_eq!(
            validate_custom_provider(&draft),
            vec!["The base URL must use https:// unless it points at localhost.".to_string()]
        );
    }

    #[test]
    fn a_localhost_http_base_url_is_allowed() {
        let mut draft = input();
        draft.base_url = "http://localhost:11434/v1".to_string();
        assert_eq!(validate_custom_provider(&draft), Vec::<String>::new());
        assert_eq!(custom_base_url_problem("http://localhost:11434/v1"), None);
        assert_eq!(custom_base_url_problem("http://127.0.0.1:1234/v1"), None);
        assert_eq!(custom_base_url_problem("http://[::1]:1234/v1"), None);
    }

    #[test]
    fn a_base_url_with_credentials_is_reported() {
        let mut draft = input();
        draft.base_url = "https://user:pass@ai.acme.dev/v1".to_string();
        assert_eq!(
            validate_custom_provider(&draft),
            vec!["The base URL must not contain credentials.".to_string()]
        );
    }

    #[test]
    fn a_missing_api_key_is_reported_only_when_there_are_no_headers() {
        let mut draft = input();
        draft.api_key = "".to_string();
        assert_eq!(
            validate_custom_provider(&draft),
            vec!["An API key or at least one custom header is required.".to_string()]
        );

        let mut with_header = draft.clone();
        with_header.headers = HashMap::from([("x-team".to_string(), "platform".to_string())]);
        assert_eq!(validate_custom_provider(&with_header), Vec::<String>::new());
    }

    #[test]
    fn a_missing_model_is_reported() {
        let mut draft = input();
        draft.model = " ".to_string();
        assert_eq!(
            validate_custom_provider(&draft),
            vec!["A model is required.".to_string()]
        );
    }

    #[test]
    fn an_invalid_header_name_is_reported() {
        let mut draft = input();
        draft.headers = HashMap::from([("bad header".to_string(), "value".to_string())]);
        assert_eq!(
            validate_custom_provider(&draft),
            vec!["Header name \"bad header\" is not valid.".to_string()]
        );

        let mut plain = input();
        plain.header_names = vec!["bad header".to_string()];
        assert_eq!(
            validate_custom_provider(&plain),
            vec!["Header name \"bad header\" is not valid.".to_string()]
        );
    }

    #[test]
    fn a_header_without_a_value_is_reported() {
        let mut draft = input();
        draft.headers = HashMap::from([("x-team".to_string(), "   ".to_string())]);
        assert_eq!(
            validate_custom_provider(&draft),
            vec!["Header \"x-team\" must have a value.".to_string()]
        );
    }

    #[test]
    fn the_api_key_is_sent_as_a_bearer_token_and_empty_headers_are_dropped() {
        let mut saved = config();
        saved
            .headers
            .insert("x-empty".to_string(), "  ".to_string());
        saved
            .headers
            .insert("bad header".to_string(), "value".to_string());
        let headers = custom_provider_headers(&saved);
        assert_eq!(
            headers.get("Authorization").map(String::as_str),
            Some("Bearer sk-test")
        );
        assert_eq!(headers.get("x-team").map(String::as_str), Some("platform"));
        assert!(!headers.contains_key("x-empty"));
        assert!(!headers.contains_key("bad header"));
    }

    #[test]
    fn the_secret_fields_are_listed_without_their_values() {
        let fields = custom_provider_secret_fields(&config());
        assert_eq!(fields.api_key, "sk-test");
        assert_eq!(fields.headers, vec!["x-team".to_string()]);
    }

    #[test]
    fn a_provider_id_is_derived_from_the_name_and_falls_back_when_the_name_is_unusable() {
        assert_eq!(
            custom_provider_id_draft(&config()),
            "custom-acme-gateway".to_string()
        );
        let mut unnamed = config();
        unnamed.name = "!!!".to_string();
        assert_eq!(custom_provider_id_draft(&unnamed), "custom".to_string());
        let mut single = config();
        single.name = "x".to_string();
        assert_eq!(custom_provider_id_draft(&single), "custom".to_string());
    }

    #[test]
    fn a_slug_keeps_letters_and_digits_and_drops_everything_else() {
        assert_eq!(slugify("ACME Gateway"), "acme-gateway");
        assert_eq!(slugify("Café Provider"), "cafe-provider");
        assert_eq!(slugify("  spaced  out  "), "spaced-out");
        assert_eq!(slugify("!!!"), "");
    }

    #[test]
    fn header_and_secret_names_are_checked_against_their_own_rules() {
        assert!(is_valid_custom_provider_header_name("x-team"));
        assert!(is_valid_custom_provider_header_name("X-Trace-Id"));
        assert!(!is_valid_custom_provider_header_name("bad header"));
        assert!(!is_valid_custom_provider_header_name(""));

        assert!(is_valid_custom_provider_secret_name("apiKey"));
        assert!(!is_valid_custom_provider_secret_name("api key"));
        assert!(!is_valid_custom_provider_secret_name("api-key"));
    }
}
