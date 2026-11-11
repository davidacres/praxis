//! A shared multi-thread runtime for the application layer's async work (ACP agents, HTTP).
//!
//! RPC handlers are synchronous and run on blocking or plain threads, so they `block_on` this
//! runtime; long-lived work (agent sessions) is `spawn`ed on it and reports through host events.

use std::future::Future;
use std::sync::OnceLock;

use tokio::runtime::{Builder, Runtime};

pub fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        Builder::new_multi_thread()
            .worker_threads(4)
            .thread_name("praxis-app")
            .enable_all()
            .build()
            .expect("the application runtime must start")
    })
}

/// Runs `future` to completion from a synchronous handler.
pub fn block_on<F: Future>(future: F) -> F::Output {
    runtime().block_on(future)
}
