//! The `gitlab` tracker backend (`packages/core/src/gitlab/`): the REST client, the
//! connection's config surface, and the board service built on them.

pub mod api_service;
pub mod config_store;

pub use api_service::*;
pub use config_store::*;
