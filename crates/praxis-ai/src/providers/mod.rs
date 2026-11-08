//! Provider wire adapters and the tables that describe them.
//!
//! Each module mirrors a file under `packages/core/src/ai/providers/`, and
//! keeps the same names and rules so the two implementations can be compared
//! side by side.

pub mod model_pricing;
pub mod reasoning_support;
pub mod wire;
