//! Failure copy for the prompt check (port of `promptClarityDiagnostics.ts`). Prompts, model
//! replies and credentials never appear in diagnostics.

use std::sync::OnceLock;

use regex::Regex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    ProviderRequest,
    ResponseValidation,
    CacheWrite,
}

impl Stage {
    pub fn name(self) -> &'static str {
        match self {
            Self::ProviderRequest => "provider-request",
            Self::ResponseValidation => "response-validation",
            Self::CacheWrite => "cache-write",
        }
    }
}

fn matches(cell: &'static OnceLock<Regex>, pattern: &str, text: &str) -> bool {
    cell.get_or_init(|| Regex::new(pattern).expect("static pattern"))
        .is_match(text)
}

macro_rules! check {
    ($pattern:expr, $text:expr) => {{
        static CELL: OnceLock<Regex> = OnceLock::new();
        matches(&CELL, $pattern, $text)
    }};
}

/// Technical detail for the Output log.
pub fn diagnostic(stage: Stage, error: &str) -> String {
    if stage == Stage::ResponseValidation {
        let detail = if check!(
            r"^(The clarity check reply|Invalid evidence or fix|Ungrounded evidence|Missing suggestion)",
            error
        ) {
            error
        } else {
            "The reply was not valid JSON."
        };
        return format!(
            "The model returned an invalid clarity assessment. {detail} Retry the check or choose a different prompt-analysis model in Settings → AI Provider → Routing."
        );
    }
    if stage == Stage::CacheWrite {
        return "The AI check completed, but Praxis could not save its result locally. Check available disk space and access to the app data folder.".into();
    }
    let text = if check!(r"(?i)timeout|timed out|abort|AnalysisCancelledError", error) {
        "The prompt check timed out after 20 seconds. The provider may be slow or a CLI agent may still be starting. Retry or choose a faster prompt-analysis model."
    } else if check!(
        r"(?i)\b(401|403)\b|unauthori[sz]ed|authentication|invalid.*key",
        error
    ) {
        "The prompt-check provider rejected authentication or access. Check its credentials and model access in Settings → AI Provider."
    } else if check!(r"(?i)\b429\b|rate.limit|quota|credit|allowance", error) {
        "The prompt-check provider reported a rate or usage limit. Check its allowance, wait, or choose another prompt-analysis provider."
    } else if check!(
        r"(?i)\b(400|404)\b|model.*(not found|unsupported|invalid)",
        error
    ) {
        "The prompt-check provider rejected the request or selected model. Check the prompt-analysis model and endpoint in Settings → AI Provider → Routing."
    } else if check!(r"(?i)\b5\d{2}\b", error) {
        "The prompt-check provider returned a server error. Retry shortly or choose another prompt-analysis provider."
    } else if check!(
        r"(?i)fetch failed|ECONN|ENOTFOUND|network|connection refused|error sending request",
        error
    ) {
        "Praxis could not connect to the prompt-check provider. Check the endpoint and network connection."
    } else {
        "The prompt-check provider request failed. Check the provider configuration and selected prompt-analysis model in Settings → AI Provider → Routing."
    };
    text.into()
}

/// Short, actionable copy for the composer.
pub fn failure(stage: Stage, error: &str, cli_agent: bool) -> String {
    if stage != Stage::ProviderRequest {
        return if stage == Stage::CacheWrite {
            "Analysis unavailable. Check available disk space, then retry."
        } else {
            "Analysis unavailable. Please retry."
        }
        .into();
    }
    if check!(r"(?i)timeout|timed out|abort|AnalysisCancelledError", error) {
        return "Analysis unavailable. Please retry.".into();
    }
    if check!(
        r"(?i)\b(401|403)\b|unauthori[sz]ed|authentication|invalid.*key",
        error
    ) {
        return if cli_agent {
            "AI provider requires authentication. Open the selected CLI agent and sign in, then retry."
        } else {
            "AI provider requires authentication. Update its API key in Settings → AI Providers → Providers, then retry."
        }
        .into();
    }
    if check!(r"(?i)\b429\b|rate.limit|quota|credit|allowance", error) {
        return "Rate limit reached.".into();
    }
    "Analysis unavailable. Please retry.".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_provider_failures_to_composer_copy() {
        assert_eq!(
            failure(Stage::ProviderRequest, "HTTP 429: slow down", false),
            "Rate limit reached."
        );
        assert!(
            failure(Stage::ProviderRequest, "HTTP 401: nope", false).contains("Update its API key")
        );
        assert_eq!(
            failure(Stage::ProviderRequest, "HTTP 500", false),
            "Analysis unavailable. Please retry."
        );
        assert_eq!(
            failure(Stage::ResponseValidation, "bad", false),
            "Analysis unavailable. Please retry."
        );
    }

    #[test]
    fn response_validation_diagnostics_keep_known_reasons_only() {
        assert!(
            diagnostic(Stage::ResponseValidation, "Ungrounded evidence for target.")
                .contains("invalid clarity assessment. Ungrounded evidence for target.")
        );
        assert!(
            diagnostic(Stage::ResponseValidation, "private text")
                .contains("The reply was not valid JSON.")
        );
        assert!(!diagnostic(Stage::ResponseValidation, "private text").contains("private"));
    }
}
