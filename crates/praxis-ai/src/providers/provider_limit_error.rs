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

/// Rate, usage, credit and quota limits across providers, exactly as `providerLimitError.ts`
/// matches them (Claude Code: "You've hit your session limit", Anthropic: "credit balance is too
/// low", OpenAI: "insufficient_quota", Gemini: "RESOURCE_EXHAUSTED", Codex: "usage limit reached").
fn limit_regex() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(concat!(
            r"(?i)(?:weekly|monthly|daily|hourly|session|usage|rate|spending|billing|plan|tier|budget)[_ -]?limit",
            r"|(?:hit|reached|exceeded) (?:your |its |the )?(?:\w+ )?(?:limit|budget|quota)",
            r"|quota|insufficient[_ -]?(?:quota|balance|funds|credits?|budget)|out of quota|too many requests|resource[_ -]?exhausted",
            r"|(?:credits?|budget)[_ -]?(?:exhausted|depleted|empty|expired|zero|insufficient|out|exceeded)",
            r"|out of (?:credits?|budget)|no (?:credits?|budget) remaining|run out of (?:credits?|budget)|\bover[_ -]?budget\b",
            r"|credit balance (?:is )?too low|balance (?:is )?too low|no resource package|please recharge|\b1113\b",
            r"|rate[_ -]?limit|rate[_ -]?limited"
        ))
        .expect("static pattern")
    })
}

/// True when an error or message indicates a rate, usage, session, credit, quota, or budget limit.
#[must_use]
pub fn is_provider_limit_error(error: &str) -> bool {
    !error.is_empty() && limit_regex().is_match(error)
}

/// A reply this long is prose, not a notice.
const MAX_LIMIT_NOTICE_LENGTH: usize = 500;

/// True when a *successfully completed* turn's reply is itself a limit notice.
///
/// CLI agents report a hit limit as an ordinary assistant message that ends the turn normally.
/// The limit vocabulary also appears in perfectly good answers, so the text only counts when it is
/// short and has no structure a notice never has: a gadget fence or more than a few lines.
#[must_use]
pub fn is_limit_notice_reply(reply: &str) -> bool {
    let text = reply.trim();
    if text.is_empty() || text.chars().count() > MAX_LIMIT_NOTICE_LENGTH {
        return false;
    }
    if text.contains("```") || text.lines().count() > 4 {
        return false;
    }
    is_provider_limit_error(text)
}

/// The user-facing message explaining the quota, credit or budget exhaustion. Always a message:
/// text that names no limit gets the generic explanation, as `extractProviderLimitMessage` does.
#[must_use]
pub fn extract_provider_limit_message(error: &str) -> Option<String> {
    // Strip generic transport/RPC wrappers.
    let wrappers = regex::Regex::new(r"(?is)^(?:The stage session failed:\s*)?(?:RequestError:\s*)?(?:Internal error:\s*)?(?:Provider error:\s*)?(?:Gateway returned \d+:\s*)?").expect("static pattern");
    let mut cleaned = wrappers.replace(error, "").trim().to_owned();
    // A notice passes through several layers, each of which extracts again.
    let repeated = regex::Regex::new(r"(?i)^(?:Provider limit reached:\s*)+").expect("static pattern");
    cleaned = repeated.replace(&cleaned, "").trim().to_owned();
    // If it is or contains JSON, use the inner message.
    if let Some(start) = cleaned.find('{')
        && cleaned.ends_with('}')
        && let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&cleaned[start..])
        && let Some(message) = parsed["error"]["message"].as_str()
    {
        cleaned = message.to_owned();
    }
    if !cleaned.is_empty() && limit_regex().is_match(&cleaned) {
        return Some(format!("Provider limit reached: {cleaned}"));
    }
    Some("Provider usage limit, budget, or credits exhausted. The session was halted and will not retry automatically.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{extract_provider_limit_message, is_limit_notice_reply, is_provider_limit_error};

    #[test]
    fn a_quota_complaint_from_the_provider_is_recognised() {
        assert!(is_provider_limit_error("Rate limit exceeded for gpt-4"));
        assert!(is_provider_limit_error("429 Too Many Requests"));
        assert!(is_provider_limit_error("You have exceeded your quota"));
        assert!(is_provider_limit_error("insufficient_quota: credits exhausted"));
        assert!(is_provider_limit_error("RESOURCE_EXHAUSTED: token limit"));
        assert!(is_provider_limit_error("Usage limit reached for this account"));
        assert!(is_provider_limit_error("You've hit your session limit \u{b7} resets 12:50pm"));
        assert!(is_provider_limit_error("Insufficient balance: credits exhausted"));
    }

    #[test]
    fn an_ordinary_failure_is_not_a_quota_complaint() {
        assert!(!is_provider_limit_error("network request failed"));
        assert!(!is_provider_limit_error("invalid api key"));
        assert!(!is_provider_limit_error(""));
    }

    #[test]
    fn only_a_short_unstructured_reply_is_a_notice() {
        assert!(is_limit_notice_reply("You've hit your session limit"));
        assert!(!is_limit_notice_reply("Here is the answer to your question."));
        assert!(!is_limit_notice_reply(&format!("rate limit\n```\nx\n```")));
        assert!(!is_limit_notice_reply(&"rate limit ".repeat(80)));
    }

    #[test]
    fn the_message_unwraps_json_and_prefixes_once() {
        let message = extract_provider_limit_message("OpenAI request failed: {\"error\":{\"message\":\"insufficient quota: credits exhausted\"}}").unwrap();
        assert_eq!(message, "Provider limit reached: insufficient quota: credits exhausted");
        let again = extract_provider_limit_message(&message).unwrap();
        assert_eq!(again, message);
    }

    #[test]
    fn a_message_without_a_limit_gets_the_generic_explanation() {
        assert!(extract_provider_limit_message("network request failed").unwrap().starts_with("Provider usage limit"));
    }
}
