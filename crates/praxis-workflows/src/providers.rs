//! The slice of the AI provider registry (`ai/providers/registry.ts`) the workflow engine
//! reads: display names for run messages, and whether a custom endpoint can call tools.
//!
//! Like the TS registry this is process-wide: built-in providers are fixed, and the host
//! registers user-added endpoints with [`register_custom_providers`] when settings load.

use std::sync::{PoisonError, RwLock};

/// A user-added API endpoint (`custom:<id>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomProviderInfo {
    /// Full provider id, `custom:<id>`.
    pub id: String,
    pub label: String,
    /// `Some(false)` when the endpoint declared it cannot call tools.
    pub supports_tools: Option<bool>,
}

const BUILT_IN_LABELS: &[(&str, &str)] = &[
    ("vercel-gateway", "Vercel AI Gateway"),
    ("openai", "OpenAI"),
    ("anthropic", "Anthropic"),
    ("gemini", "Google Gemini"),
    ("z-ai", "Z.ai"),
    ("claude-code-cli", "Claude Code (local)"),
    ("codex-cli", "Codex CLI (local)"),
    ("copilot-cli", "GitHub Copilot (local)"),
    ("antigravity-cli", "Antigravity"),
    ("cursor-cli", "Cursor (local)"),
];

static CUSTOM_PROVIDERS: RwLock<Vec<CustomProviderInfo>> = RwLock::new(Vec::new());

/// Replaces the registered custom endpoints.
pub fn register_custom_providers(providers: Vec<CustomProviderInfo>) {
    *CUSTOM_PROVIDERS
        .write()
        .unwrap_or_else(PoisonError::into_inner) = providers;
}

fn label_of(provider: &str) -> Option<String> {
    if let Some((_, label)) = BUILT_IN_LABELS.iter().find(|(id, _)| *id == provider) {
        return Some((*label).to_string());
    }
    CUSTOM_PROVIDERS
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .find(|custom| custom.id == provider)
        .map(|custom| custom.label.clone())
}

/// A provider's name for messages: its label without a trailing "(local)" or " CLI",
/// or the raw id when the provider is unknown.
#[must_use]
pub fn provider_display_name(provider: &str) -> String {
    let Some(label) = label_of(provider) else {
        return provider.to_string();
    };
    let without_local = label
        .strip_suffix("(local)")
        .map_or(label.as_str(), str::trim_end);
    without_local
        .strip_suffix(" CLI")
        .unwrap_or(without_local)
        .to_string()
}

/// Whether a registered custom endpoint declared it cannot call tools.
#[must_use]
pub fn custom_provider_lacks_tools(provider: &str) -> bool {
    CUSTOM_PROVIDERS
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .any(|custom| custom.id == provider && custom.supports_tools == Some(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names_drop_local_and_cli_suffixes() {
        assert_eq!(provider_display_name("codex-cli"), "Codex");
        assert_eq!(provider_display_name("claude-code-cli"), "Claude Code");
        assert_eq!(provider_display_name("anthropic"), "Anthropic");
        assert_eq!(provider_display_name("unknown-ai"), "unknown-ai");
    }
}
