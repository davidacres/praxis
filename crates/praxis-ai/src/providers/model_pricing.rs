//! Static USD-per-million-token rates for the models Praxis talks to.
//!
//! No provider exposes a billing API to read these from, so they are
//! transcribed from each provider's published price list. They are a starting
//! point for the usage dashboard, not an invoice: a price change shows up here
//! only once the table is updated.
//!
//! Free-tier models are listed with zero rates rather than omitted, so a
//! lookup miss always means "unpriced" and never "free".

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::wire::TokenUsage;

/// The CLI agent hosts, whose plans price differently from the API models.
const ACP_MODEL_PROVIDERS: &[&str] = &[
    "claude-code-cli",
    "codex-cli",
    "copilot-cli",
    "antigravity-cli",
    "cursor-cli",
];

/// Static USD-per-million-token rates for one model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPriceRates {
    pub input_per_million_usd: f64,
    pub output_per_million_usd: f64,
}

/// A dollar amount, with the currency it is in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsdCost {
    pub amount: f64,
    pub currency: String,
}

const ZAI_PRICING: &[(&str, f64, f64)] = &[
    ("glm-5.3-flash", 0.15, 0.5),
    ("glm-5.3-flashx", 0.37, 1.25),
    ("glm-5.3", 1.4, 4.4),
    ("glm-5.2", 1.4, 4.4),
    ("glm-5.1", 1.4, 4.4),
    ("glm-5", 1.0, 3.2),
    ("glm-4.7", 0.6, 2.2),
    ("glm-4.7-flashx", 0.07, 0.4),
    ("glm-4.7-flash", 0.0, 0.0),
    ("glm-4.6", 0.6, 2.2),
    ("glm-4.5", 0.6, 2.2),
    ("glm-4.5-x", 2.2, 8.9),
    ("glm-4.5-air", 0.2, 1.1),
    ("glm-4.5-airx", 1.1, 4.5),
    ("glm-4.5-flash", 0.0, 0.0),
    ("glm-4-32b-0414-128k", 0.1, 0.1),
    ("glm-4.6v", 0.3, 0.9),
    ("glm-4.6v-flashx", 0.04, 0.4),
    ("glm-4.6v-flash", 0.0, 0.0),
    ("glm-4.5v", 0.6, 1.8),
    ("glm-ocr", 0.03, 0.03),
];

const OPENAI_PRICING: &[(&str, f64, f64)] = &[
    ("gpt-4o", 2.5, 10.0),
    ("gpt-4o-2024-08-06", 2.5, 10.0),
    ("gpt-4o-2024-11-20", 2.5, 10.0),
    ("gpt-4o-mini", 0.15, 0.6),
    ("gpt-4o-mini-2024-07-18", 0.15, 0.6),
    ("o1", 15.0, 60.0),
    ("o1-2024-12-17", 15.0, 60.0),
    ("o1-preview", 15.0, 60.0),
    ("o1-mini", 1.1, 4.4),
    ("o3-mini", 1.1, 4.4),
    ("o3", 10.0, 40.0),
    ("gpt-4.5-preview", 75.0, 150.0),
    ("gpt-4-turbo", 10.0, 30.0),
    ("gpt-4-turbo-2024-04-09", 10.0, 30.0),
    ("gpt-4", 30.0, 60.0),
    ("gpt-3.5-turbo", 0.5, 1.5),
    ("chatgpt-4o-latest", 5.0, 15.0),
];

const ANTHROPIC_PRICING: &[(&str, f64, f64)] = &[
    ("claude-3-7-sonnet-20250219", 3.0, 15.0),
    ("claude-3-7-sonnet", 3.0, 15.0),
    ("claude-3.7-sonnet", 3.0, 15.0),
    ("claude-3-7-sonnet-latest", 3.0, 15.0),
    ("claude-3-5-sonnet-20241022", 3.0, 15.0),
    ("claude-3-5-sonnet-20240620", 3.0, 15.0),
    ("claude-3-5-sonnet", 3.0, 15.0),
    ("claude-3.5-sonnet", 3.0, 15.0),
    ("claude-3-5-sonnet-latest", 3.0, 15.0),
    ("claude-sonnet-4-6", 3.0, 15.0),
    ("claude-sonnet-4.6", 3.0, 15.0),
    ("claude-haiku-5-5", 0.1, 0.5),
    ("claude-haiku-5.5", 0.1, 0.5),
    ("claude-3-5-haiku-20241022", 0.8, 4.0),
    ("claude-3-5-haiku", 0.8, 4.0),
    ("claude-3.5-haiku", 0.8, 4.0),
    ("claude-3-5-haiku-latest", 0.8, 4.0),
    ("claude-3-haiku-20240307", 0.25, 1.25),
    ("claude-3-haiku", 0.25, 1.25),
    ("claude-3-opus-20240229", 15.0, 75.0),
    ("claude-3-opus", 15.0, 75.0),
    ("claude-3-opus-latest", 15.0, 75.0),
    ("claude-opus-4-6", 15.0, 75.0),
    ("claude-opus-4.6", 15.0, 75.0),
];

const GEMINI_PRICING: &[(&str, f64, f64)] = &[
    ("gemini-2.5-pro", 1.25, 5.0),
    ("gemini-2.5-pro-latest", 1.25, 5.0),
    ("gemini-2.5-flash", 0.075, 0.3),
    ("gemini-2.5-flash-latest", 0.075, 0.3),
    ("gemini-2.0-flash", 0.1, 0.4),
    ("gemini-2.0-flash-001", 0.1, 0.4),
    ("gemini-2.0-flash-exp", 0.1, 0.4),
    ("gemini-2.0-flash-lite", 0.075, 0.3),
    ("gemini-2.0-flash-lite-001", 0.075, 0.3),
    ("gemini-2.0-flash-lite-preview-02-05", 0.075, 0.3),
    ("gemini-1.5-pro", 1.25, 5.0),
    ("gemini-1.5-pro-002", 1.25, 5.0),
    ("gemini-1.5-pro-latest", 1.25, 5.0),
    ("gemini-1.5-flash", 0.075, 0.3),
    ("gemini-1.5-flash-002", 0.075, 0.3),
    ("gemini-1.5-flash-latest", 0.075, 0.3),
    ("gemini-1.5-flash-8b", 0.0375, 0.15),
    ("gemini-1.5-flash-8b-latest", 0.0375, 0.15),
];

const MINIMAX_PRICING: &[(&str, f64, f64)] = &[
    ("minimax-m3.1-flash-preview", 0.1, 0.1),
    ("minimax-text-01", 0.2, 1.1),
    ("minimax-abab6.5s", 0.1, 0.1),
];
/// Looks a model up in one of the tables above.
fn lookup(table: &[(&str, f64, f64)], key: &str) -> Option<ModelPriceRates> {
    table
        .iter()
        .find(|(name, _, _)| *name == key)
        .map(|(_, input, output)| ModelPriceRates {
            input_per_million_usd: *input,
            output_per_million_usd: *output,
        })
}

/// The table that lists a provider's own models, if it has one.
fn pricing_table_for(provider: &str) -> Option<&'static [(&'static str, f64, f64)]> {
    match provider {
        "z-ai" => Some(ZAI_PRICING),
        "openai" => Some(OPENAI_PRICING),
        "anthropic" => Some(ANTHROPIC_PRICING),
        "gemini" => Some(GEMINI_PRICING),
        _ => None,
    }
}

/// Strips the routing prefix from a model id, so `anthropic/claude-sonnet-4.6`
/// and `claude-sonnet-4.6` price the same.
#[must_use]
pub fn normalize_model_name(raw: &str) -> String {
    let trimmed = raw.trim().to_lowercase();
    for prefix in [
        "openai/",
        "anthropic/",
        "google/",
        "models/",
        "vercel/",
        "meta/",
    ] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    trimmed
}

/// Reads the context window an ACP model advertises in its id, as in
/// `claude-sonnet-4-6[1m,context=1000000]`.
fn acp_context_length(model: &str) -> Option<u64> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\[(?:[^\]]*,)?context=(\d+(?:\.\d+)?)([km]?)(?:,|\])")
            .expect("the ACP context pattern is valid")
    });
    let captures = pattern.captures(model)?;
    let number: f64 = captures.get(1)?.as_str().parse().ok()?;
    let unit = captures
        .get(2)
        .map_or("", |unit| unit.as_str())
        .to_lowercase();
    let size = number
        * match unit.as_str() {
            "m" => 1_000_000.0,
            "k" => 1_000.0,
            _ => 1.0,
        };
    // JavaScript's `Number.isSafeInteger` guard: a whole number that fits an
    // IEEE double exactly.
    if size > 0.0 && size.fract() == 0.0 && size <= 9_007_199_254_740_991.0 {
        Some(size as u64)
    } else {
        None
    }
}

/// The context window of a model, when it is known.
///
/// Only models whose limits are published are listed; anything else returns
/// `None` rather than a guess, so callers can fall back to their own budget.
#[must_use]
pub fn get_known_context_length(model: Option<&str>, provider: Option<&str>) -> Option<u64> {
    let model = model?;
    if let Some(provider) = provider {
        if ACP_MODEL_PROVIDERS.contains(&provider) {
            // Cursor exposes the selected context in its model id. Other CLI
            // hosts need their own metadata; an API model window is not a CLI
            // session limit.
            return if provider == "cursor-cli" {
                acp_context_length(model)
            } else {
                None
            };
        }
    }
    let normalized = normalize_model_name(model);

    if normalized.starts_with("glm-") {
        return Some(128_000);
    }
    if normalized.starts_with("claude-haiku-5")
        || normalized.contains("haiku-5")
        || normalized == "haiku"
    {
        return Some(1_000_000);
    }
    if normalized.starts_with("claude-3")
        || normalized.starts_with("claude-2")
        || normalized.starts_with("claude-sonnet")
        || normalized.starts_with("claude-opus")
        || normalized.starts_with("claude-haiku")
        || normalized.contains("sonnet")
        || normalized.contains("opus")
        || normalized.contains("haiku")
    {
        return Some(200_000);
    }
    if normalized.starts_with("gemini-") || normalized.contains("gemini") {
        return Some(if normalized.contains("pro") {
            2_097_152
        } else {
            1_048_576
        });
    }
    if normalized.starts_with("o1-mini") || normalized.starts_with("o1-preview") {
        return Some(128_000);
    }
    if normalized.starts_with("o1") || normalized.starts_with("o3") {
        return Some(200_000);
    }
    if normalized.starts_with("gpt-4o")
        || normalized.starts_with("chatgpt-4o")
        || normalized.starts_with("gpt-4.5")
        || normalized.starts_with("gpt-4-turbo")
    {
        return Some(128_000);
    }
    if normalized.starts_with("gpt-4-32k") {
        return Some(32_768);
    }
    if normalized == "gpt-4" || normalized.starts_with("gpt-4-") {
        return Some(8_192);
    }
    if normalized.starts_with("gpt-3.5") {
        return Some(16_385);
    }
    if normalized.contains("deepseek") {
        return Some(128_000);
    }
    if normalized.starts_with("qwen") || normalized.contains("qwen") {
        return Some(
            if normalized.contains("max") || normalized.contains("plus") {
                1_000_000
            } else {
                131_072
            },
        );
    }
    None
}

/// The rates for a model, when they are known.
///
/// The provider's own table wins; failing that the model is looked up across
/// every table, because a gateway-hosted model keeps its own name. A model
/// that matches no table falls back to the closest relative it is named after.
#[must_use]
pub fn get_model_pricing(provider: Option<&str>, model: Option<&str>) -> Option<ModelPriceRates> {
    // CLI plans and API billing are different products. Only explicit adapter
    // pricing may be displayed for CLI models, never an API-table fallback.
    if let Some(provider) = provider {
        if ACP_MODEL_PROVIDERS.contains(&provider) {
            return None;
        }
    }
    let model = model?;
    let raw = model.trim().to_lowercase();
    let normalized = normalize_model_name(model);

    // 1. The provider's own table.
    if let Some(table) = provider.and_then(pricing_table_for) {
        if let Some(rates) = lookup(table, &raw).or_else(|| lookup(table, &normalized)) {
            return Some(rates);
        }
    }

    // 2. Any table, for a model reached through a gateway.
    for table in [
        ZAI_PRICING,
        OPENAI_PRICING,
        ANTHROPIC_PRICING,
        GEMINI_PRICING,
    ] {
        if let Some(rates) = lookup(table, &raw).or_else(|| lookup(table, &normalized)) {
            return Some(rates);
        }
    }

    // 3. The closest relative the model is named after.
    if normalized.contains("sonnet") {
        return lookup(ANTHROPIC_PRICING, "claude-3-5-sonnet");
    }
    if normalized.contains("haiku-5.5")
        || normalized.contains("5-5-haiku")
        || normalized.contains("5.5-haiku")
        || normalized.contains("haiku-5")
        || normalized == "haiku"
    {
        return lookup(ANTHROPIC_PRICING, "claude-haiku-5-5");
    }
    if normalized.contains("haiku-3.5")
        || normalized.contains("3-5-haiku")
        || normalized.contains("3.5-haiku")
    {
        return lookup(ANTHROPIC_PRICING, "claude-3-5-haiku");
    }
    if normalized.contains("haiku") {
        return lookup(ANTHROPIC_PRICING, "claude-3-haiku");
    }
    if normalized.contains("opus") {
        return lookup(ANTHROPIC_PRICING, "claude-3-opus");
    }
    if normalized.starts_with("gpt-4o-mini") {
        return lookup(OPENAI_PRICING, "gpt-4o-mini");
    }
    if normalized.starts_with("gpt-4o") || normalized.starts_with("chatgpt-4o") {
        return lookup(OPENAI_PRICING, "gpt-4o");
    }
    if normalized.starts_with("o1-mini") {
        return lookup(OPENAI_PRICING, "o1-mini");
    }
    if normalized.starts_with("o3-mini") {
        return lookup(OPENAI_PRICING, "o3-mini");
    }
    if normalized.starts_with("o1-preview") {
        return lookup(OPENAI_PRICING, "o1-preview");
    }
    if normalized.starts_with("o1") {
        return lookup(OPENAI_PRICING, "o1");
    }
    if normalized.starts_with("o3") {
        return lookup(OPENAI_PRICING, "o3");
    }
    if normalized.starts_with("gpt-4.5") {
        return lookup(OPENAI_PRICING, "gpt-4.5-preview");
    }
    if normalized.starts_with("gpt-4-turbo") {
        return lookup(OPENAI_PRICING, "gpt-4-turbo");
    }
    if normalized.starts_with("gpt-3.5") {
        return lookup(OPENAI_PRICING, "gpt-3.5-turbo");
    }
    if normalized.starts_with("gpt-4") {
        return lookup(OPENAI_PRICING, "gpt-4");
    }
    if normalized.starts_with("gemini-") || normalized.contains("gemini") {
        if normalized.contains("flash-8b") {
            return lookup(GEMINI_PRICING, "gemini-1.5-flash-8b");
        }
        if normalized.contains("flash-lite") {
            return lookup(GEMINI_PRICING, "gemini-2.0-flash-lite");
        }
        if normalized.contains("flash") {
            return lookup(GEMINI_PRICING, "gemini-2.5-flash");
        }
        if normalized.contains("pro") {
            return lookup(GEMINI_PRICING, "gemini-2.5-pro");
        }
    }
    if normalized.starts_with("glm-") {
        if normalized.starts_with("glm-5.3-flash") {
            return lookup(ZAI_PRICING, "glm-5.3-flash");
        }
        if normalized.starts_with("glm-5") {
            return lookup(ZAI_PRICING, "glm-5");
        }
        if normalized.starts_with("glm-4.7-flash") {
            return lookup(ZAI_PRICING, "glm-4.7-flash");
        }
        if normalized.starts_with("glm-4") {
            return lookup(ZAI_PRICING, "glm-4.5");
        }
    }
    if normalized.contains("minimax") || raw.contains("minimax") {
        if let Some(rates) = lookup(MINIMAX_PRICING, &raw) {
            return Some(rates);
        }
        if let Some(rates) = lookup(MINIMAX_PRICING, &normalized) {
            return Some(rates);
        }
        if normalized.contains("flash") {
            return lookup(MINIMAX_PRICING, "minimax-m3.1-flash-preview");
        }
        return lookup(MINIMAX_PRICING, "minimax-text-01");
    }
    None
}

/// The dollar cost of one turn, when the provider's rates are known.
///
/// Only `z-ai` is priced here: the other providers bill through a plan the
/// user already holds, so their usage is reported in tokens rather than
/// dollars.
#[must_use]
pub fn estimate_cost_usd(
    provider: Option<&str>,
    model: Option<&str>,
    usage: TokenUsage,
) -> Option<UsdCost> {
    let provider = provider?;
    let model = model?;
    if provider != "z-ai" {
        return None;
    }
    let rates = lookup(ZAI_PRICING, &model.trim().to_lowercase())?;
    let input = usage.input_tokens.unwrap_or(0) as f64;
    let output = usage.output_tokens.unwrap_or(0) as f64;
    let amount = (input / 1_000_000.0) * rates.input_per_million_usd
        + (output / 1_000_000.0) * rates.output_per_million_usd;
    Some(UsdCost {
        amount,
        currency: "USD".to_string(),
    })
}

/// The dollar cost of one turn, from the same rates the dashboard shows.
#[must_use]
pub fn estimate_turn_cost(
    provider: Option<&str>,
    model: Option<&str>,
    usage: TokenUsage,
) -> Option<UsdCost> {
    let model = model?;
    let rates = get_model_pricing(provider, Some(model))?;
    let input = usage.input_tokens.unwrap_or(0) as f64;
    let output = usage.output_tokens.unwrap_or(0) as f64;
    let amount = (input / 1_000_000.0) * rates.input_per_million_usd
        + (output / 1_000_000.0) * rates.output_per_million_usd;
    Some(UsdCost {
        amount,
        currency: "USD".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        ModelPriceRates, estimate_cost_usd, estimate_turn_cost, get_known_context_length,
        get_model_pricing, normalize_model_name,
    };
    use crate::providers::wire::TokenUsage;

    fn rates(input: f64, output: f64) -> ModelPriceRates {
        ModelPriceRates {
            input_per_million_usd: input,
            output_per_million_usd: output,
        }
    }

    fn usage(input: u64, output: u64) -> TokenUsage {
        TokenUsage {
            input_tokens: Some(input),
            output_tokens: Some(output),
            ..TokenUsage::default()
        }
    }

    #[test]
    fn cli_metadata_does_not_substitute_api_prices_or_context_guesses() {
        for provider in [
            "codex-cli",
            "claude-code-cli",
            "copilot-cli",
            "antigravity-cli",
            "cursor-cli",
        ] {
            assert_eq!(
                get_model_pricing(Some(provider), Some("claude-sonnet-4-6")),
                None
            );
            assert_eq!(
                get_known_context_length(Some("claude-sonnet-4-6"), Some(provider)),
                None
            );
        }
        assert_eq!(
            get_known_context_length(
                Some("gpt-5.6-sol[context=272k,reasoning=medium]"),
                Some("cursor-cli")
            ),
            Some(272_000)
        );
        assert_eq!(
            get_known_context_length(
                Some("claude-opus-5[thinking=true,context=300k,effort=high]"),
                Some("cursor-cli")
            ),
            Some(300_000)
        );
        assert_eq!(
            get_known_context_length(Some("unknown[context=0k]"), Some("cursor-cli")),
            None
        );
        assert_eq!(
            get_model_pricing(Some("custom:example-cli"), Some("gpt-4o")),
            Some(rates(2.5, 10.0))
        );
    }

    #[test]
    fn a_known_zai_model_prices_input_and_output_tokens_independently() {
        let cost = estimate_cost_usd(Some("z-ai"), Some("glm-5.3"), usage(500_000, 250_000));
        let cost = cost.expect("glm-5.3 is priced");
        assert_eq!(cost.currency, "USD");
        // $1.40/M input, $4.40/M output.
        assert!(
            (cost.amount - (0.7 + 1.1)).abs() < 1e-9,
            "unexpected cost {}",
            cost.amount
        );
    }

    #[test]
    fn model_id_matching_ignores_case_and_surrounding_whitespace() {
        let cost = estimate_cost_usd(Some("z-ai"), Some("  GLM-5.3  "), usage(1_000_000, 0));
        let cost = cost.expect("glm-5.3 is priced");
        assert!(
            (cost.amount - 1.4).abs() < 1e-9,
            "unexpected cost {}",
            cost.amount
        );
    }

    #[test]
    fn a_free_tier_model_prices_at_zero_rather_than_being_unpriced() {
        let cost = estimate_cost_usd(
            Some("z-ai"),
            Some("glm-4.5-flash"),
            usage(1_000_000, 1_000_000),
        );
        assert_eq!(
            cost,
            Some(super::UsdCost {
                amount: 0.0,
                currency: "USD".to_string()
            })
        );
    }

    #[test]
    fn an_unknown_model_for_a_priced_provider_returns_none_not_zero() {
        assert_eq!(
            estimate_cost_usd(Some("z-ai"), Some("glm-99-nonexistent"), usage(1_000, 0)),
            None
        );
    }

    #[test]
    fn a_provider_with_no_maintained_price_table_in_estimate_cost_returns_none() {
        assert_eq!(
            estimate_cost_usd(Some("openai"), Some("gpt-4o-mini"), usage(1_000, 1_000)),
            None
        );
    }

    #[test]
    fn estimate_turn_cost_prices_openai_anthropic_and_other_supported_providers() {
        let cost = estimate_turn_cost(
            Some("openai"),
            Some("gpt-4o-mini"),
            usage(1_000_000, 1_000_000),
        );
        let cost = cost.expect("gpt-4o-mini is priced");
        assert!(
            (cost.amount - 0.75).abs() < 1e-9,
            "unexpected cost {}",
            cost.amount
        );
    }

    #[test]
    fn a_missing_provider_or_model_returns_none() {
        assert_eq!(
            estimate_cost_usd(None, Some("glm-5.3"), usage(1_000, 0)),
            None
        );
        assert_eq!(estimate_cost_usd(Some("z-ai"), None, usage(1_000, 0)), None);
    }

    #[test]
    fn get_model_pricing_provides_rates_for_all_major_providers_and_gateway_models() {
        // OpenAI
        assert_eq!(
            get_model_pricing(Some("openai"), Some("gpt-4o")),
            Some(rates(2.5, 10.0))
        );
        assert_eq!(
            get_model_pricing(Some("openai"), Some("gpt-4o-mini")),
            Some(rates(0.15, 0.6))
        );

        // Anthropic
        assert_eq!(
            get_model_pricing(Some("anthropic"), Some("claude-3-5-sonnet-20241022")),
            Some(rates(3.0, 15.0))
        );
        assert_eq!(
            get_model_pricing(Some("anthropic"), Some("claude-3-5-haiku-20241022")),
            Some(rates(0.8, 4.0))
        );
        assert_eq!(
            get_model_pricing(Some("anthropic"), Some("claude-haiku-5-5")),
            Some(rates(0.1, 0.5))
        );
        assert_eq!(
            get_model_pricing(Some("claude-code-cli"), Some("haiku")),
            None
        );

        // Gemini
        assert_eq!(
            get_model_pricing(Some("gemini"), Some("gemini-2.5-pro")),
            Some(rates(1.25, 5.0))
        );
        assert_eq!(
            get_model_pricing(Some("gemini"), Some("gemini-2.5-flash")),
            Some(rates(0.075, 0.3))
        );

        // Z.ai
        assert_eq!(
            get_model_pricing(Some("z-ai"), Some("glm-5.3")),
            Some(rates(1.4, 4.4))
        );

        // Vercel Gateway prefixed models
        assert_eq!(
            get_model_pricing(Some("vercel-gateway"), Some("anthropic/claude-3.5-sonnet")),
            Some(rates(3.0, 15.0))
        );
        assert_eq!(
            get_model_pricing(Some("vercel-gateway"), Some("openai/gpt-4o")),
            Some(rates(2.5, 10.0))
        );
    }

    #[test]
    fn get_known_context_length_covers_all_providers_and_models() {
        assert_eq!(
            get_known_context_length(Some("gpt-4o"), Some("openai")),
            Some(128_000)
        );
        assert_eq!(
            get_known_context_length(Some("o1"), Some("openai")),
            Some(200_000)
        );
        assert_eq!(
            get_known_context_length(Some("claude-3-5-sonnet-20241022"), Some("anthropic")),
            Some(200_000)
        );
        assert_eq!(
            get_known_context_length(Some("claude-haiku-5-5"), Some("anthropic")),
            Some(1_000_000)
        );
        assert_eq!(
            get_known_context_length(Some("haiku"), Some("claude-code-cli")),
            None
        );
        assert_eq!(
            get_known_context_length(Some("gemini-2.5-pro"), Some("gemini")),
            Some(2_097_152)
        );
        assert_eq!(
            get_known_context_length(Some("gemini-2.5-flash"), Some("gemini")),
            Some(1_048_576)
        );
        assert_eq!(
            get_known_context_length(Some("glm-5.3"), Some("z-ai")),
            Some(128_000)
        );
        assert_eq!(
            get_known_context_length(Some("anthropic/claude-3-7-sonnet"), Some("vercel-gateway")),
            Some(200_000)
        );
        assert_eq!(get_known_context_length(Some("mock/model"), None), None);
    }

    #[test]
    fn normalize_model_name_strips_only_the_routing_prefix() {
        assert_eq!(
            normalize_model_name("anthropic/claude-sonnet-4.6"),
            "claude-sonnet-4.6"
        );
        assert_eq!(normalize_model_name("  OpenAI/GPT-4o "), "gpt-4o");
        assert_eq!(normalize_model_name("gpt-4o"), "gpt-4o");
        assert_eq!(
            normalize_model_name("openai/openai/gpt-4o"),
            "openai/gpt-4o"
        );
    }
}
