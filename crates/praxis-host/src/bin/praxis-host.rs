//! Standalone `praxis-host` binary supporting NDJSON `--stdio` RPC + event streaming
//! and single-shot `--rpc` invocation for Electron (`rustHostBridge.ts`) and isolated E2E tests.

use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};

use praxis_contracts::RustRpcRequest;
use praxis_host::mobile_bridge::{MobileBridge, register_mobile_channels};
use praxis_host::{
    HostCallClient, HostConfig, HostContext, HostInboundReply, HostWireFrame, host_status,
};

fn write_frame(writer: &Arc<Mutex<io::Stdout>>, frame: &HostWireFrame) {
    let Ok(line) = serde_json::to_string(frame) else {
        return;
    };
    if let Ok(mut guard) = writer.lock() {
        let _ = writeln!(guard, "{line}");
        let _ = guard.flush();
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let config = HostConfig::from_args_and_env(&args, &env)?;
    let host = HostContext::new(config);

    // Single-shot mode (`--rpc <json>`) for quick CLI probes.
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--rpc" {
            if let Some(raw_req) = iter.next() {
                println!("{}", host.dispatch_rpc_json(raw_req));
                return Ok(());
            }
        }
    }

    // Default / `--stdio` mode: emit Ready frame, forward all `HostEventBus` events as NDJSON
    // frames on stdout, and process incoming `RustRpcRequest` lines from stdin.
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let event_stdout = Arc::clone(&stdout);
    host.events().on_event(move |envelope| {
        write_frame(
            &event_stdout,
            &HostWireFrame::Event {
                envelope: envelope.clone(),
            },
        );
    });

    // Host-to-Electron calls share stdout with responses/events; replies arrive on stdin.
    let call_stdout = Arc::clone(&stdout);
    let calls = HostCallClient::new(move |frame| {
        write_frame(&call_stdout, &frame);
        true
    });

    // The mobile listener needs an async runtime; the stdin loop below stays on this thread.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let mobile = MobileBridge::new(runtime.handle().clone(), calls.clone());
    register_mobile_channels(&host, &mobile);
    praxis_host::profile_bridge::register_profile_channels(&host, runtime.handle());
    praxis_host::deployment_bridge::register_deployment_channels(&host, runtime.handle());
    praxis_host::ai_bridge::register_ai_channels(&host, runtime.handle());
    praxis_host::tracker_bridge::register_tracker_channels(&host, runtime.handle());
    let terminal =
        praxis_host::terminal_bridge::register_terminal_channels(&host, runtime.handle());

    write_frame(
        &stdout,
        &HostWireFrame::Ready {
            status: host_status(),
            registered_channels: host.registered_channels(),
        },
    );

    let stdin = io::stdin();
    for line_result in stdin.lock().lines() {
        let line = line_result?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(reply) = serde_json::from_str::<HostInboundReply>(trimmed) {
            calls.handle_reply(reply);
            continue;
        }
        let response = match serde_json::from_str::<RustRpcRequest>(trimmed) {
            Ok(req) => host.dispatch_rpc(req),
            Err(err) => praxis_contracts::RustRpcResponse {
                id: String::new(),
                ok: false,
                result: None,
                error: Some(praxis_contracts::RustRpcError {
                    code: "INVALID_RPC_REQUEST".to_string(),
                    message: format!("Invalid RustRpcRequest JSON: {err}"),
                }),
            },
        };
        write_frame(&stdout, &HostWireFrame::Response { envelope: response });
    }

    // Stdin closed: fail any outstanding calls so nothing waits on a dead channel.
    calls.close();
    mobile.shutdown();
    terminal.dispose();
    Ok(())
}
