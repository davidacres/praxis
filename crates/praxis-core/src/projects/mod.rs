//! Project types, workflow stage resolution (`resolve_status`, `DEFAULT_WORKFLOW`),
//! and `project.praxis.md` marker-safe snapshot generation.

pub mod project_snapshot;
pub mod project_types;
pub mod project_workflow;

pub use project_snapshot::*;
pub use project_types::*;
pub use project_workflow::*;
