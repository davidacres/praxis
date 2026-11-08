//! How a reasoning or "thinking" request is shaped, per provider.
//!
//! Anthropic ships two mutually-exclusive thinking modes, and which one a
//! model accepts is decided by its generation, not by anything in the
//! response:
//!
//! - `extended` — `thinking: {type: 'enabled', budget_tokens: N}`. The only
//!   mode on Claude 4.5 and earlier; deprecated but still accepted on 4.6.
//! - `adaptive` — `thinking: {type: 'adaptive'}` plus `output_config: {effort}`.
//!   Required by Claude 4.7 and later, which reject `type: 'enabled'` with a
//!   400 error.
//!
//! Sending the wrong one is a hard request failure, so the mode is derived
//! from the model id rather than probed.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::model_pricing::normalize_model_name;

/// Normalized reasoning/thinking effort level. Each per-provider wire builder
/// translates this into its own request parameter — Anthropic's `thinking`
/// block, the OpenAI-compatible `reasoning_effort` string, or Gemini's
/// `generationConfig.thinkingConfig`. `Off` means "don't ask for extra
/// reasoning", not "explicitly disable a model's own default behaviour".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Off,
    Low,
    Medium,
    High,
}

impl ReasoningEffort {
    /// The wire spelling of this level.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

/// Every selectable effort level, in the order the UI offers them.
pub const REASONING_EFFORT_LEVELS: [ReasoningEffort; 4] = [
    ReasoningEffort::Off,
    ReasoningEffort::Low,
    ReasoningEffort::Medium,
    ReasoningEffort::High,
];

/// Anthropic's two thinking modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnthropicThinkingMode {
    Adaptive,
    Extended,
}

/// Aliases with no numeric generation in the id. Every one is a 5.x model.
const ADAPTIVE_CLAUDE_ALIASES: &[&str] = &["fable", "mythos"];

/// The CLI agent hosts, whose reasoning is relayed as content.
const ACP_REASONING_PROVIDERS: &[&str] = &[
    "claude-code-cli",
    "codex-cli",
    "copilot-cli",
    "antigravity-cli",
    "cursor-cli",
];

/// `major[.minor]` from a Claude id, or `None` when it carries no digits.
fn claude_generation(normalized: &str) -> Option<(u32, u32)> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"(\d+)(?:[.\-](\d+))?").expect("the Claude generation pattern is valid")
    });
    let captures = pattern.captures(normalized)?;
    let major = captures.get(1)?.as_str().parse::<u32>().ok()?;
    let minor = captures
        .get(2)
        .and_then(|minor| minor.as_str().parse::<u32>().ok())
        .unwrap_or(0);
    Some((major, minor))
}

fn is_anthropic_reasoning_model(normalized: &str) -> bool {
    if !normalized.contains("claude") {
        return false;
    }
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"(^|-)(opus|sonnet|haiku)-[3-9]")
            .expect("the Anthropic family pattern is valid")
    });
    normalized.contains("claude-3-7")
        || normalized.contains("claude-3.7")
        || pattern.is_match(normalized)
        || ADAPTIVE_CLAUDE_ALIASES
            .iter()
            .any(|alias| normalized.contains(alias))
}

fn is_gemini_reasoning_model(normalized: &str) -> bool {
    normalized.contains("gemini-2.5") || normalized.contains("gemini-3")
}

fn is_openai_reasoning_model(normalized: &str) -> bool {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN
        .get_or_init(|| Regex::new(r"^o[134](-|$)").expect("the OpenAI family pattern is valid"));
    pattern.is_match(normalized) || normalized.contains("gpt-5") || normalized.contains("gpt-6")
}

/// The reasoning family a model id needs, independent of which connection is
/// routing the request — a gateway/custom-endpoint model id like
/// `anthropic/claude-sonnet-4.6` still needs Anthropic's `thinking` shape, not
/// OpenAI's `reasoning_effort`, even though the HTTP request goes to an
/// OpenAI-compatible endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningFamily {
    Anthropic,
    Gemini,
    OpenAi,
}

/// Which real provider's reasoning parameter a model id needs.
#[must_use]
pub fn detect_reasoning_family(model: Option<&str>) -> Option<ReasoningFamily> {
    let model = model?;
    let normalized = normalize_model_name(model);
    if is_anthropic_reasoning_model(&normalized) {
        return Some(ReasoningFamily::Anthropic);
    }
    if is_gemini_reasoning_model(&normalized) {
        return Some(ReasoningFamily::Gemini);
    }
    if is_openai_reasoning_model(&normalized) {
        return Some(ReasoningFamily::OpenAi);
    }
    None
}

/// Which thinking mode a Claude model id needs, or `None` when the id cannot
/// be placed on Anthropic's compatibility table (a custom alias, a future
/// name). Callers omit the `thinking` parameter entirely in that case, which
/// is always accepted — 5.x models think by default, and 4.x ones simply
/// don't.
#[must_use]
pub fn anthropic_thinking_mode(model: Option<&str>) -> Option<AnthropicThinkingMode> {
    let model = model?;
    let normalized = normalize_model_name(model);
    if !normalized.contains("claude") {
        return None;
    }
    let Some((major, minor)) = claude_generation(&normalized) else {
        return ADAPTIVE_CLAUDE_ALIASES
            .iter()
            .any(|alias| normalized.contains(alias))
            .then_some(AnthropicThinkingMode::Adaptive);
    };
    // 4.6 accepts both modes; Anthropic recommends adaptive, so prefer it.
    if major >= 5 || (major == 4 && minor >= 6) {
        return Some(AnthropicThinkingMode::Adaptive);
    }
    Some(AnthropicThinkingMode::Extended)
}

/// Anthropic's `thinking.budget_tokens` for a level, or `None` for `Off`.
#[must_use]
pub fn anthropic_thinking_budget(level: Option<ReasoningEffort>) -> Option<u32> {
    match level? {
        ReasoningEffort::Off => None,
        ReasoningEffort::Low => Some(1_024),
        ReasoningEffort::Medium => Some(4_096),
        ReasoningEffort::High => Some(8_192),
    }
}

/// The Anthropic `thinking` request configuration for a model and effort
/// level, in whichever mode that model accepts. `None` means "send no
/// `thinking` parameter at all" — the right answer for `Off`, and for a model
/// whose generation cannot be determined.
///
/// Adaptive mode also carries `output_config`, and always asks for
/// `display: 'summarized'`: on Claude 4.7+ `display` defaults to `'omitted'`,
/// which returns thinking blocks with an empty `thinking` field. Without it the
/// request succeeds, the reasoning tokens are billed, and the chat pane shows
/// nothing — the failure mode is silent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicThinkingConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_config: Option<serde_json::Value>,
}

/// The Anthropic `thinking` request configuration for a model and effort
/// level, in whichever mode that model accepts. `None` means "send no
/// `thinking` parameter at all" — the right answer for `Off`, and for a model
/// whose generation cannot be determined.
///
/// Adaptive mode also carries `output_config`, and always asks for
/// `display: 'summarized'`: on Claude 4.7+ `display` defaults to `'omitted'`,
/// which returns thinking blocks with an empty `thinking` field. Without it the
/// request succeeds, the reasoning tokens are billed, and the chat pane shows
/// nothing — the failure mode is silent.
#[must_use]
pub fn anthropic_thinking_config(
    model: Option<&str>,
    level: Option<ReasoningEffort>,
) -> Option<AnthropicThinkingConfig> {
    let level = level?;
    if level == ReasoningEffort::Off {
        return None;
    }
    match anthropic_thinking_mode(model)? {
        AnthropicThinkingMode::Extended => {
            let budget = anthropic_thinking_budget(Some(level))?;
            Some(AnthropicThinkingConfig {
                thinking: Some(serde_json::json!({
                    "type": "enabled",
                    "budget_tokens": budget,
                })),
                output_config: None,
            })
        }
        AnthropicThinkingMode::Adaptive => Some(AnthropicThinkingConfig {
            thinking: Some(serde_json::json!({
                "type": "adaptive",
                "display": "summarized",
            })),
            output_config: Some(serde_json::json!({ "effort": level.as_str() })),
        }),
    }
}

/// Gemini's `generationConfig.thinkingConfig.thinkingBudget` for a level, or
/// `None` for `Off`.
#[must_use]
pub fn gemini_thinking_budget(level: Option<ReasoningEffort>) -> Option<u32> {
    anthropic_thinking_budget(level)
}

/// Whether a session's turns can produce reasoning *text* to display, and if
/// not why. Absent reasoning is a normal outcome rather than a failure, so the
/// UI names the case instead of rendering a blank.
///
/// - `Text` — the route returns readable reasoning; show it.
/// - `Opaque` — the model reasons but this route never returns the text.
/// - `NotRequested` — the session asked for no reasoning (`effort: 'off'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningAvailability {
    Text,
    Opaque,
    NotRequested,
}

/// Every selectable provider model may have a reasoning default. Direct
/// provider adapters translate the normalized value, OpenAI-compatible
/// endpoints receive `reasoning_effort`, and ACP agents consume their
/// advertised `thought_level` option. The model family only selects the wire
/// shape; it must not hide the UI for new, aliased, or provider-specific ids.
#[must_use]
pub fn supports_reasoning_effort(provider: Option<&str>, _model: Option<&str>) -> bool {
    provider.is_some()
}

/// Whether reasoning text will come back for a session.
#[must_use]
pub fn reasoning_availability(
    provider: Option<&str>,
    model: Option<&str>,
    effort: Option<ReasoningEffort>,
) -> ReasoningAvailability {
    // A CLI agent relays thinking as content, whatever model it is driving.
    if let Some(provider) = provider {
        if ACP_REASONING_PROVIDERS.contains(&provider) {
            return ReasoningAvailability::Text;
        }
    }
    // Only an explicit `off` opts out. `None` is not "no reasoning": the
    // hosts resolve it to the provider's per-model default and then to
    // `medium`, so thinking is requested.
    if effort == Some(ReasoningEffort::Off) {
        return ReasoningAvailability::NotRequested;
    }
    // OpenAI's own HTTP endpoint never returns reasoning text for its
    // reasoning models — only `completion_tokens_details.reasoning_tokens`.
    // That count is why the telemetry bar can still say thinking happened.
    if provider == Some("openai") && detect_reasoning_family(model) == Some(ReasoningFamily::OpenAi)
    {
        return ReasoningAvailability::Opaque;
    }
    ReasoningAvailability::Text
}

#[cfg(test)]
mod tests {
    use super::{
        AnthropicThinkingMode, ReasoningAvailability, ReasoningEffort, ReasoningFamily,
        anthropic_thinking_config, anthropic_thinking_mode, detect_reasoning_family,
        reasoning_availability, supports_reasoning_effort,
    };

    #[test]
    fn a_newer_claude_generation_uses_adaptive_thinking_and_an_older_one_uses_extended() {
        assert_eq!(
            anthropic_thinking_mode(Some("claude-fable-5.1")),
            Some(AnthropicThinkingMode::Adaptive)
        );
        assert_eq!(
            anthropic_thinking_mode(Some("claude-opus-4-8")),
            Some(AnthropicThinkingMode::Adaptive)
        );
        assert_eq!(
            anthropic_thinking_mode(Some("claude-opus-4-5")),
            Some(AnthropicThinkingMode::Extended)
        );
        assert_eq!(
            anthropic_thinking_mode(Some("claude-3-7-sonnet")),
            Some(AnthropicThinkingMode::Extended)
        );
        assert_eq!(
            anthropic_thinking_mode(Some("claude-internal-preview")),
            None
        );
    }

    #[test]
    fn the_adaptive_configuration_asks_for_a_summarized_thought_and_carries_the_effort() {
        let config =
            anthropic_thinking_config(Some("claude-fable-5.1"), Some(ReasoningEffort::Low));
        let config = config.expect("an adaptive configuration is built");
        assert_eq!(
            config.thinking,
            Some(serde_json::json!({ "type": "adaptive", "display": "summarized" }))
        );
        assert_eq!(
            config.output_config,
            Some(serde_json::json!({ "effort": "low" }))
        );
    }

    #[test]
    fn the_extended_configuration_asks_for_a_thinking_budget_and_no_output_config() {
        let config =
            anthropic_thinking_config(Some("claude-opus-4-5"), Some(ReasoningEffort::Medium));
        let config = config.expect("an extended configuration is built");
        assert_eq!(
            config.thinking,
            Some(serde_json::json!({ "type": "enabled", "budget_tokens": 4096 }))
        );
        assert_eq!(config.output_config, None);
    }

    #[test]
    fn no_thinking_configuration_is_built_when_thinking_is_turned_off() {
        assert_eq!(
            anthropic_thinking_config(Some("claude-opus-4-5"), Some(ReasoningEffort::Off)),
            None
        );
        assert_eq!(
            anthropic_thinking_config(Some("claude-opus-4-5"), None),
            None
        );
    }

    #[test]
    fn the_reasoning_family_follows_the_model_id_even_through_a_gateway_prefix() {
        assert_eq!(detect_reasoning_family(Some("glm-5.3")), None);
        assert_eq!(
            detect_reasoning_family(Some("gpt-5.1")),
            Some(ReasoningFamily::OpenAi)
        );
        assert_eq!(
            detect_reasoning_family(Some("anthropic/claude-sonnet-4.6")),
            Some(ReasoningFamily::Anthropic)
        );
        assert_eq!(
            detect_reasoning_family(Some("gemini-2.5-flash")),
            Some(ReasoningFamily::Gemini)
        );
    }

    #[test]
    fn any_provider_with_a_model_may_offer_reasoning_effort() {
        assert!(supports_reasoning_effort(Some("openai"), None));
        assert!(!supports_reasoning_effort(None, None));
    }

    #[test]
    fn reasoning_is_opaque_on_the_openai_endpoint_and_off_when_it_was_not_requested() {
        assert_eq!(
            reasoning_availability(Some("openai"), Some("gpt-6-luna"), None),
            ReasoningAvailability::Opaque
        );
        assert_eq!(
            reasoning_availability(
                Some("anthropic"),
                Some("claude-opus-4-5"),
                Some(ReasoningEffort::Low)
            ),
            ReasoningAvailability::Text
        );
        assert_eq!(
            reasoning_availability(
                Some("openai"),
                Some("gpt-6-luna"),
                Some(ReasoningEffort::Off)
            ),
            ReasoningAvailability::NotRequested
        );
        assert_eq!(
            reasoning_availability(
                Some("claude-code-cli"),
                Some("claude-sonnet-4-5"),
                Some(ReasoningEffort::Medium)
            ),
            ReasoningAvailability::Text
        );
    }
}
