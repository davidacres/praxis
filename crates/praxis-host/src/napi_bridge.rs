//! Optional N-API (`napi-rs`) in-process bindings for [`crate::HostContext`].

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::config::HostConfig;
use crate::context::HostContext;

/// N-API wrapper around [`HostContext`] for in-process Electron invocation.
#[napi]
pub struct NapiHostHandle {
    inner: HostContext,
}

#[napi]
impl NapiHostHandle {
    /// Creates an isolated [`NapiHostHandle`] for the given profile and settings file.
    #[napi(constructor)]
    pub fn new(
        user_data_dir: String,
        settings_path: String,
        demo_mode: bool,
        e2e_mode: bool,
    ) -> Result<Self> {
        let config = HostConfig::new(user_data_dir, settings_path, demo_mode, e2e_mode)
            .map_err(|err| Error::from_reason(err.to_string()))?;
        Ok(Self {
            inner: HostContext::new(config),
        })
    }

    /// Dispatches a serialized [`praxis_contracts::RustRpcRequest`] JSON string and returns
    /// the serialized [`praxis_contracts::RustRpcResponse`] JSON string.
    #[napi]
    pub fn dispatch_rpc_json(&self, raw_request: String) -> String {
        self.inner.dispatch_rpc_json(&raw_request)
    }

    /// Returns `true` if `channel` is registered on the underlying [`HostContext`].
    #[napi]
    pub fn has_channel(&self, channel: String) -> bool {
        self.inner.has_channel(&channel)
    }

    /// Returns all currently registered channel names.
    #[napi]
    pub fn registered_channels(&self) -> Vec<String> {
        self.inner.registered_channels()
    }
}
