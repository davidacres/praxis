//! Prompt and session feedback scoring: the deterministic engine behind the composer coach and the
//! session scorecard (port of `packages/core/src/ai/feedback`). Pure and host-neutral; the desktop
//! host supplies the session, the workspace facts, and the model call.

pub mod capability;
pub mod clarity;
pub mod diagnostics;
pub mod execution;
pub mod grounding;
pub mod prompt_signals;
pub mod scorer;
pub mod store;
pub mod types;

pub use scorer::{build_suggested_prompt, evaluate, finding_rule_key};
pub use types::{
    CLARITY_CHECKLIST_VERSION, EvaluationInput, PriorContext, SCORING_RUBRIC_VERSION, Symbol,
    WorkspaceHints,
};
