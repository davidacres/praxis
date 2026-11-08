//! Shell-agnostic service container (`HostContext`) and typed RPC channel dispatcher.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use praxis_contracts::{RustRpcError, RustRpcRequest, RustRpcResponse};
use serde_json::{Value, json};

use crate::config::HostConfig;
use crate::events::HostEventBus;
use crate::host_status;
use crate::secrets::HostSecretStore;

/// Handler function signature for synchronous or runtime-backed RPC channels.
pub type RpcHandlerFn = dyn Fn(&HostContext, &[Value]) -> Result<Value, RustRpcError> + Send + Sync;

/// Shell-agnostic Rust host service container and RPC router.
#[derive(Clone)]
pub struct HostContext {
    config: Arc<HostConfig>,
    events: HostEventBus,
    secrets: HostSecretStore,
    handlers: Arc<RwLock<BTreeMap<String, Arc<RpcHandlerFn>>>>,
}

impl std::fmt::Debug for HostContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostContext")
            .field("config", &self.config)
            .field("registered_channels", &self.registered_channels())
            .finish_non_exhaustive()
    }
}

impl HostContext {
    /// Initializes a new [`HostContext`] with the given isolated [`HostConfig`] and registers
    /// built-in host diagnostic, event, and secret-bridge channels.
    #[must_use]
    pub fn new(config: HostConfig) -> Self {
        let ctx = Self {
            config: Arc::new(config),
            events: HostEventBus::default(),
            secrets: HostSecretStore::new(),
            handlers: Arc::new(RwLock::new(BTreeMap::new())),
        };
        ctx.register_builtin_handlers();
        ctx
    }

    /// Returns the host's runtime configuration.
    #[must_use]
    pub fn config(&self) -> &HostConfig {
        &self.config
    }

    /// Returns the broadcast event bus for domain notifications.
    #[must_use]
    pub fn events(&self) -> &HostEventBus {
        &self.events
    }

    /// Returns the `safeStorage`-unlocked secret store.
    #[must_use]
    pub fn secrets(&self) -> &HostSecretStore {
        &self.secrets
    }

    /// Registers or replaces an RPC handler for `channel`.
    pub fn register_handler<F>(&self, channel: impl Into<String>, handler: F)
    where
        F: Fn(&Self, &[Value]) -> Result<Value, RustRpcError> + Send + Sync + 'static,
    {
        if let Ok(mut guard) = self.handlers.write() {
            guard.insert(channel.into(), Arc::new(handler));
        }
    }

    /// Returns `true` if `channel` has a registered Rust RPC handler.
    #[must_use]
    pub fn has_channel(&self, channel: &str) -> bool {
        self.handlers
            .read()
            .is_ok_and(|guard| guard.contains_key(channel))
    }

    /// Returns the sorted list of all channels currently registered in this host container.
    #[must_use]
    pub fn registered_channels(&self) -> Vec<String> {
        self.handlers
            .read()
            .map(|guard| guard.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Dispatches a typed [`RustRpcRequest`] to the matching channel handler.
    #[must_use]
    pub fn dispatch_rpc(&self, request: RustRpcRequest) -> RustRpcResponse {
        let handler = self
            .handlers
            .read()
            .ok()
            .and_then(|guard| guard.get(&request.channel).cloned());

        let Some(handler) = handler else {
            return RustRpcResponse {
                id: request.id,
                ok: false,
                result: None,
                error: Some(RustRpcError {
                    code: "CHANNEL_NOT_REGISTERED".to_string(),
                    message: format!("Rust host channel '{}' is not registered.", request.channel),
                }),
            };
        };

        match handler(self, &request.args) {
            Ok(result) => RustRpcResponse {
                id: request.id,
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(err) => RustRpcResponse {
                id: request.id,
                ok: false,
                result: None,
                error: Some(err),
            },
        }
    }

    /// Deserializes a JSON [`RustRpcRequest`], dispatches it, and serializes the [`RustRpcResponse`].
    #[must_use]
    pub fn dispatch_rpc_json(&self, raw_request: &str) -> String {
        let response = match serde_json::from_str::<RustRpcRequest>(raw_request) {
            Ok(req) => self.dispatch_rpc(req),
            Err(err) => RustRpcResponse {
                id: String::new(),
                ok: false,
                result: None,
                error: Some(RustRpcError {
                    code: "INVALID_RPC_REQUEST".to_string(),
                    message: format!("Invalid RustRpcRequest JSON: {err}"),
                }),
            },
        };
        serde_json::to_string(&response).unwrap_or_else(|_| {
            r#"{"id":"","ok":false,"error":{"code":"SERIALIZATION_ERROR","message":"Failed to serialize RPC response."}}"#.to_string()
        })
    }

    fn register_builtin_handlers(&self) {
        self.register_handler("host:status", |_ctx, _args| {
            serde_json::to_value(host_status()).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("host:getConfig", |ctx, _args| {
            Ok(json!({
                "userDataDir": ctx.config.user_data_dir.to_string_lossy(),
                "settingsPath": ctx.config.settings_path.to_string_lossy(),
                "demoMode": ctx.config.demo_mode,
                "e2eMode": ctx.config.e2e_mode,
                "registeredChannels": ctx.registered_channels(),
            }))
        });

        self.register_handler("host:ping", |_ctx, args| {
            Ok(json!({
                "pong": true,
                "args": args,
            }))
        });

        self.register_handler("host:emitEvent", |ctx, args| {
            let channel = args
                .first()
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message:
                        "host:emitEvent requires a non-empty channel name as its first argument."
                            .to_string(),
                })?;
            let payload = args.get(1).cloned();
            let envelope = ctx.events.emit(channel, payload);
            serde_json::to_value(envelope).map_err(|err| RustRpcError {
                code: "INTERNAL_ERROR".to_string(),
                message: err.to_string(),
            })
        });

        self.register_handler("host:secrets:get", |ctx, args| {
            let key = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "host:secrets:get requires a string key.".to_string(),
                })?;
            Ok(match ctx.secrets.get(key) {
                Some(val) => Value::String(val),
                None => Value::Null,
            })
        });

        self.register_handler("host:secrets:has", |ctx, args| {
            let key = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "host:secrets:has requires a string key.".to_string(),
                })?;
            Ok(Value::Bool(ctx.secrets.has(key)))
        });

        self.register_handler("host:secrets:set", |ctx, args| {
            let key = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "host:secrets:set requires a string key.".to_string(),
                })?;
            let value = args.get(1).and_then(Value::as_str).unwrap_or_default();
            Ok(Value::Bool(ctx.secrets.set(key, value)))
        });

        self.register_handler("host:secrets:delete", |ctx, args| {
            let key = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: "host:secrets:delete requires a string key.".to_string(),
                })?;
            Ok(Value::Bool(ctx.secrets.delete(key)))
        });

        self.register_handler("host:secrets:listKeys", |ctx, _args| {
            Ok(json!(ctx.secrets.keys()))
        });

        self.register_handler("host:secrets:seed", |ctx, args| {
            let map_val = args.first().cloned().unwrap_or_else(|| json!({}));
            let entries: BTreeMap<String, String> =
                serde_json::from_value(map_val).map_err(|err| RustRpcError {
                    code: "INVALID_ARGUMENT".to_string(),
                    message: format!("host:secrets:seed requires a string record: {err}"),
                })?;
            Ok(json!(ctx.secrets.seed(entries)))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_context() -> HostContext {
        let config = HostConfig::new(
            "/tmp/praxis-test-profile",
            "/tmp/praxis-test-profile/test-settings.json",
            true,
            true,
        )
        .expect("config");
        HostContext::new(config)
    }

    #[test]
    fn dispatches_builtin_status_and_config_channels() {
        let ctx = test_context();
        let status_res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-1".to_string(),
            channel: "host:status".to_string(),
            args: vec![],
        });
        assert!(status_res.ok);
        assert_eq!(
            status_res
                .result
                .as_ref()
                .and_then(|v| v.get("protocolVersion")),
            Some(&json!(1))
        );

        let cfg_res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-2".to_string(),
            channel: "host:getConfig".to_string(),
            args: vec![],
        });
        assert!(cfg_res.ok);
        let cfg_val = cfg_res.result.expect("config result");
        assert_eq!(cfg_val.get("demoMode"), Some(&json!(true)));
        assert_eq!(cfg_val.get("e2eMode"), Some(&json!(true)));
        assert_eq!(
            cfg_val.get("userDataDir"),
            Some(&json!("/tmp/praxis-test-profile"))
        );
    }

    #[test]
    fn returns_structured_error_for_unregistered_channel() {
        let ctx = test_context();
        let res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-missing".to_string(),
            channel: "nonexistent:channel".to_string(),
            args: vec![],
        });
        assert!(!res.ok);
        assert_eq!(
            res.error.as_ref().map(|e| e.code.as_str()),
            Some("CHANNEL_NOT_REGISTERED")
        );
    }

    #[test]
    fn custom_handler_and_event_emission_roundtrip() {
        let ctx = test_context();
        ctx.register_handler("custom:echo", |host, args| {
            host.events()
                .emit("custom:echoed", Some(json!({ "count": args.len() })));
            Ok(json!({ "received": args }))
        });

        let captured = Arc::new(RwLock::new(Vec::new()));
        let captured_clone = Arc::clone(&captured);
        ctx.events().on_event(move |env| {
            if let Ok(mut guard) = captured_clone.write() {
                guard.push(env.clone());
            }
        });

        let res = ctx.dispatch_rpc(RustRpcRequest {
            id: "req-echo".to_string(),
            channel: "custom:echo".to_string(),
            args: vec![json!("alpha"), json!(42)],
        });
        assert!(res.ok);
        assert_eq!(res.result, Some(json!({ "received": ["alpha", 42] })));

        let events = captured.read().expect("lock");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].channel, "custom:echoed");
        assert_eq!(events[0].payload, Some(json!({ "count": 2 })));
    }
}
