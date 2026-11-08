//! Telling a provider's quota complaint apart from an ordinary failure.
//!
//! Two different things arrive as text and need different handling:
//!
//! - An *error* from the provider's HTTP endpoint, which means the turn
//!   failed and the session must stop or hand over.
//! - A *reply* the model itself wrote, which means the model is alive and
//!   well and answered — just with a complaint in it. That is not an error and
//!   must never be treated as one.
//!
//! The two are told apart by their wording, so the wording matters: the
//! markers below are the ones providers actually use.

use serde::{Deserialize, Serialize};

/// The markers a provider uses when it is out of quota.
const LIMIT_MARKERS: &[&str] = &[
    "rate limit",
    "usage limit",
    "quota exceeded",
    "exceeded your quota",
    "exceeded your current quota",
    "quota",
    "insufficient_quota",
    "resource_exhausted",
    "too many requests",
];

/// The markers that mean the *model* answered with a complaint, rather than
/// the provider refusing the request.
const LIMIT_NOTICE_MARKERS: &[&str] = &[
    "usage limit reached",
    "rate limit reached",
    "quota exceeded",
    "insufficient_quota",
    "resource_exhausted",
    "daily limit",
    "weekly limit",
    "monthly limit",
    "too many requests",
];

/// The kind of limit a provider hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderLimitKind {
    /// The plan's allowance for the period is spent.
    UsageLimit,
    /// Too many requests in too short a time.
    RateLimit,
}

/// A provider's quota complaint, in a shape the UI can show and act on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLimitNotice {
    pub kind: ProviderLimitKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u32>,
}

/// Whether a provider error is a quota complaint rather than anything else.
///
/// The wording is matched case-insensitively, because providers are not
/// consistent about it.
#[must_use]
pub fn is_provider_limit_error(error: &str) -> bool {
    let text = error.trim();
    if text.is_empty() {
        return false;
    }
    let lower = text.to_lowercase();
    LIMIT_MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Whether a model's own reply is a quota complaint.
///
/// A reply like "usage limit reached for this account" is the model talking,
/// not a failed request. Treating it as an error would end a session that is
/// still perfectly alive.
#[must_use]
pub fn is_limit_notice_reply(reply: &str) -> bool {
    let lower = reply.trim().to_lowercase();
    LIMIT_NOTICE_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

/// The part of a provider error that names the quota complaint.
///
/// Starts at the marker rather than at the beginning of the message, so the
/// provider's own prefix — a request id, a URL, a stack frame — is dropped
/// and only the human-readable part is shown.
#[must_use]
pub fn extract_provider_limit_message(error: &str) -> Option<String> {
    let text = error.trim();
    if text.is_empty() {
        return None;
    }
    let lower = text.to_lowercase();
    // The longest markers come first: "usage limit reached" also contains
    // "usage limit", and the longer one is the better answer.
    let marker = [
        "usage limit reached",
        "rate limit reached",
        "exceeded your quota",
        "rate limit",
        "usage limit",
        "quota exceeded",
        "quota",
        "insufficient_quota",
        "resource_exhausted",
        "too many requests",
    ]
    .into_iter()
    .find(|marker| lower.contains(marker))?;
    let index = lower.find(marker)?;
    let message = text[index..].trim();
    Some(message.strip_suffix('.').unwrap_or(message).to_string())
}

#[cfg(test)]
mod tests {
    use super::{extract_provider_limit_message, is_limit_notice_reply, is_provider_limit_error};

    #[test]
    fn a_quota_complaint_from_the_provider_is_recognised() {
        assert!(is_provider_limit_error("Rate limit exceeded for gpt-4"));
        assert!(is_provider_limit_error("429 Too Many Requests"));
        assert!(is_provider_limit_error("You have exceeded your quota"));
        assert!(is_provider_limit_error(
            "insufficient_quota: credits exhausted"
        ));
        assert!(is_provider_limit_error("RESOURCE_EXHAUSTED: token limit"));
        assert!(is_provider_limit_error(
            "Usage limit reached for this account"
        ));
    }

    #[test]
    fn an_ordinary_failure_is_not_a_quota_complaint() {
        assert!(!is_provider_limit_error("network request failed"));
        assert!(!is_provider_limit_error("invalid api key"));
        assert!(!is_provider_limit_error(""));
        assert!(!is_provider_limit_error("   "));
    }

    #[test]
    fn a_models_own_complaint_is_a_reply_and_not_a_failed_request() {
        // The provider is answering normally; the model is just complaining.
        assert!(is_limit_notice_reply(
            "I've reached my usage limit reached for this account."
        ));
        assert!(is_limit_notice_reply("Your daily limit has been reached."));
        assert!(is_limit_notice_reply("weekly limit exceeded"));
    }

    #[test]
    fn an_ordinary_reply_is_not_a_limit_notice() {
        assert!(!is_limit_notice_reply(
            "Here is the answer to your question."
        ));
        assert!(!is_limit_notice_reply(""));
    }

    #[test]
    fn the_message_starts_at_the_marker_and_drops_the_providers_prefix() {
        let message = extract_provider_limit_message(
            "Error: 429 rate limit exceeded for requests. Please try again later.",
        );
        assert_eq!(
            message,
            Some("rate limit exceeded for requests. Please try again later".to_string())
        );
    }

    #[test]
    fn the_longest_marker_wins_so_the_message_names_the_real_complaint() {
        let message = extract_provider_limit_message("Usage limit reached for this account.");
        assert_eq!(
            message,
            Some("Usage limit reached for this account".to_string())
        );
    }

    #[test]
    fn a_message_without_a_marker_extracts_nothing() {
        assert_eq!(
            extract_provider_limit_message("network request failed"),
            None
        );
        assert_eq!(extract_provider_limit_message(""), None);
    }
}
