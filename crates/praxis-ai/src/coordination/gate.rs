//! What a tool executor asks before a side effect (FX-BF-048 / TASK-393).

/// The longest an agent may wait for a resource in one call: it reports back, then decides.
pub const COORDINATION_MAX_WAIT_MS: i64 = 120_000;

/// The answer to a gate request. On success the caller releases the claim after the side effect.
#[derive(Debug, Clone)]
pub enum GateDecision {
    Granted { request_id: String },
    Refused { reason: String },
}

/// The message a refused tool hands back to the agent: who has it, and what to do.
pub fn refusal_for_agent(reason: &str, wait_tool: Option<&str>) -> String {
    let wait = wait_tool.map_or_else(|| "or wait and try again later".to_owned(), |tool| format!("or call {tool} to wait for it (bounded)"));
    format!("Not done: {reason} Another session is using it. Work on something else, {wait}; do not retry in a loop.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_names_the_wait_tool_when_there_is_one() {
        assert!(refusal_for_agent("busy.", Some("wait_for_files")).contains("call wait_for_files to wait for it (bounded)"));
        assert!(refusal_for_agent("busy.", None).contains("or wait and try again later"));
    }
}
