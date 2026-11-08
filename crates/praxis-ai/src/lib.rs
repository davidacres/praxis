//! The AI runtime: provider wire adapters, the model tables that describe
//! them, and the usage ledger that records what each turn cost.

/// Which wire protocol an AI provider speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WireProtocolFamily {
    /// Anthropic Messages API.
    Anthropic,
    /// Gemini `generateContent` API.
    Gemini,
    /// OpenAI-compatible Chat Completions API.
    OpenAiCompatible,
}

pub mod providers;
pub mod usage_stats;
