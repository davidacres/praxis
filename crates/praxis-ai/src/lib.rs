//! AI provider wire adapters (Anthropic, Gemini, OpenAI/Custom), MCP client and
//! internal MCP servers, ACP stdio agent host, durable team chat, and gadget validation.

/// Supported built-in LLM wire protocol families.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireProtocolFamily {
    AnthropicMessages,
    GoogleGemini,
    OpenAiResponses,
    OpenAiChatCompletions,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_protocol_families_are_distinct() {
        assert_ne!(
            WireProtocolFamily::AnthropicMessages,
            WireProtocolFamily::GoogleGemini
        );
    }
}
