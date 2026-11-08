//! Provider wire adapters and the tables that describe them.
//!
//! Each module mirrors a file under `packages/core/src/ai/providers/`, and
//! keeps the same names and rules so the two implementations can be compared
//! side by side.

pub mod custom_providers;
pub mod local_runtime_detection;
pub mod model_pricing;
pub mod provider_limit_error;
pub mod provider_preflight;
pub mod reasoning_support;
pub mod wire;
