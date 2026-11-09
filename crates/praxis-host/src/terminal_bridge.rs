//! Source-run terminal cutover. PTYs and their event stream are owned by Rust.
use std::sync::Arc;

use praxis_contracts::RustRpcError;
use praxis_workflows::terminal_manager::{TerminalEvent, TerminalManager};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::runtime::Handle;

use crate::HostContext;

fn failure(error: impl std::fmt::Display) -> RustRpcError {
    RustRpcError {
        code: "TERMINAL_ERROR".into(),
        message: error.to_string(),
    }
}
fn encoded(value: impl Serialize) -> Result<Value, RustRpcError> {
    serde_json::to_value(value).map_err(failure)
}
fn text(args: &[Value], index: usize) -> Result<&str, RustRpcError> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| failure("Terminal argument must be a string."))
}
fn size(args: &[Value], index: usize) -> Result<u32, RustRpcError> {
    args.get(index)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| failure("Terminal dimensions must be non-negative integers."))
}

pub fn register_terminal_channels(host: &HostContext, handle: &Handle) -> Arc<TerminalManager> {
    let (manager, mut events) = TerminalManager::new();
    let manager = Arc::new(manager);
    let bus = host.events().clone();
    handle.spawn(async move {
        while let Some(event) = events.recv().await {
            let (channel, payload) = match event {
                TerminalEvent::Output(value) => ("terminal:output", encoded(value)),
                TerminalEvent::Exit(value) => ("terminal:exit", encoded(value)),
                TerminalEvent::ContextAvailability(value) => {
                    ("terminal:contextAvailability", encoded(value))
                }
                TerminalEvent::Command(value) => ("terminal:command", encoded(value)),
            };
            if let Ok(payload) = payload {
                bus.emit(channel, Some(payload));
            }
        }
    });
    let m = Arc::clone(&manager);
    host.register_handler("terminal:dispose", move |_, _| {
        m.dispose();
        Ok(Value::Null)
    });
    let m = Arc::clone(&manager);
    host.register_handler("terminal:listProfiles", move |_, _| {
        encoded(m.list_profiles())
    });
    let m = Arc::clone(&manager);
    host.register_handler("terminal:list", move |_, _| encoded(m.list()));
    let m = Arc::clone(&manager);
    host.register_handler("terminal:create", move |_, args| {
        let input = serde_json::from_value(args.first().cloned().unwrap_or_else(|| json!({})))
            .map_err(failure)?;
        encoded(m.create(&input).map_err(failure)?)
    });
    let m = Arc::clone(&manager);
    host.register_handler("terminal:write", move |_, args| {
        m.write(text(args, 0)?, text(args, 1)?).map_err(failure)?;
        Ok(Value::Null)
    });
    let m = Arc::clone(&manager);
    host.register_handler("terminal:resize", move |_, args| {
        m.resize(text(args, 0)?, size(args, 1)?, size(args, 2)?)
            .map_err(failure)?;
        Ok(Value::Null)
    });
    let m = Arc::clone(&manager);
    host.register_handler("terminal:kill", move |_, args| {
        m.kill(text(args, 0)?);
        Ok(Value::Null)
    });
    let m = Arc::clone(&manager);
    host.register_handler("terminal:getBuffer", move |_, args| {
        encoded(m.buffer(text(args, 0)?).map_err(failure)?)
    });
    let m = Arc::clone(&manager);
    host.register_handler("terminal:getContext", move |_, args| {
        encoded(m.context(text(args, 0)?).map_err(failure)?)
    });
    let m = Arc::clone(&manager);
    host.register_handler("terminal:listCommands", move |_, args| {
        encoded(m.commands(text(args, 0)?).map_err(failure)?)
    });
    manager
}
