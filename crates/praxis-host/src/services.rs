//! Shared service composition for the stdio host and in-process desktop shells.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use praxis_workflows::terminal_manager::TerminalManager;
use tokio::runtime::Handle;

use crate::mobile_bridge::{MobileBridge, register_mobile_channels};
use crate::{HostCallClient, HostContext};

/// Owns the resources that must be stopped before the caller's runtime exits.
/// Construct and shut down on a synchronous thread, outside a Tokio async task.
pub struct HostServices {
    calls: HostCallClient,
    mobile: Arc<MobileBridge>,
    terminal: Arc<TerminalManager>,
    stopped: AtomicBool,
}

impl HostServices {
    /// Registers all domain bridges against one shared context and async runtime.
    /// The caller supplies reverse-call handling; no stdio or process is created here.
    #[must_use]
    pub fn register(host: &HostContext, runtime: &Handle, calls: HostCallClient) -> Self {
        let mobile = MobileBridge::new(runtime.clone(), calls.clone());
        register_mobile_channels(host, &mobile);
        crate::profile_bridge::register_profile_channels(host, runtime);
        crate::deployment_bridge::register_deployment_channels(host, runtime);
        crate::ai_bridge::register_ai_channels(host, runtime);
        crate::tracker_bridge::register_tracker_channels(host, runtime);
        crate::workflow_bridge::register_workflow_channels(host);
        let terminal = crate::terminal_bridge::register_terminal_channels(host, runtime);
        Self {
            calls,
            mobile,
            terminal,
            stopped: AtomicBool::new(false),
        }
    }

    /// Fails pending reverse calls and releases listeners and PTYs exactly once.
    pub fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        self.calls.close();
        self.mobile.shutdown();
        self.terminal.dispose();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostConfig;
    use praxis_contracts::RustRpcRequest;
    use serde_json::{Value, json};
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn shared_services_dispatch_in_process_and_shutdown_reverse_calls() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let profile = std::env::temp_dir().join(format!(
            "praxis-host-services-{}-{unique}",
            std::process::id()
        ));
        let config = HostConfig::for_user_data_dir(&profile, false, true).expect("config");
        let host = HostContext::new(config);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let calls = HostCallClient::new(|_| false);
        let services = HostServices::register(&host, runtime.handle(), calls.clone());
        for channel in [
            "settings:set",
            "terminal:create",
            "tracker:getIssues",
            "ai:preflightProvider",
            "workflows:createRun",
            "mobile:start",
            "deployments:prepare",
        ] {
            assert!(host.has_channel(channel), "missing {channel}");
        }
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_event = Arc::clone(&captured);
        let subscription = host.events().on_event(move |event| {
            captured_event.lock().expect("events").push(event.clone());
        });
        let response = host.dispatch_rpc(RustRpcRequest {
            id: "settings-test".into(),
            channel: "settings:set".into(),
            args: vec![json!({})],
        });
        assert!(response.ok, "{:?}", response.error);
        assert!(profile.join("settings.json").is_file());
        assert_eq!(
            captured.lock().expect("events")[0].channel,
            "settings:changed"
        );
        assert!(host.events().off_event(subscription));
        let missing = host.dispatch_rpc(RustRpcRequest {
            id: "missing".into(),
            channel: "no:fallback".into(),
            args: vec![],
        });
        assert_eq!(
            missing.error.expect("missing error").code,
            "CHANNEL_NOT_REGISTERED"
        );
        services.shutdown();
        services.shutdown();
        assert_eq!(
            runtime.block_on(calls.call("mobile.read", Value::Null, Duration::from_secs(1))),
            Err(crate::HostCallError::Closed)
        );
        std::fs::remove_dir_all(profile).expect("remove test profile");
    }
}
