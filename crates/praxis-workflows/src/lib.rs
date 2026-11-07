//! Workflow stage state machine, gates, check runner, managed run services,
//! portable-pty terminal manager, and cron scheduled run coordinator.

/// High-level execution state of a governed workflow run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkflowRunState {
    Idle,
    Running,
    PausedAtGate,
    Completed,
    Failed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_run_state_transitions_are_distinct() {
        assert_ne!(WorkflowRunState::Idle, WorkflowRunState::Completed);
    }
}
