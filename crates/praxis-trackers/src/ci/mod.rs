//! Read-only CI evidence providers (`packages/core/src/ci/`).

pub mod evidence_provider;
pub mod github_actions_evidence_provider;
pub mod gitlab_ci_evidence_provider;

pub use evidence_provider::*;
pub use github_actions_evidence_provider::*;
pub use gitlab_ci_evidence_provider::*;
