//! The AI runtime: provider wire adapters, the model tables that describe
//! them, the usage ledger that records what each turn cost, MCP/ACP tooling
//! transports, durable team chat, and interactive gadgets.

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

pub mod acp;
pub mod coordination;
pub mod gadgets;
pub mod mcp;
pub mod providers;
pub mod session;
pub mod team_chat;
pub mod usage_stats;
