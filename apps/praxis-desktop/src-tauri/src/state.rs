use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Mutex;

use praxis_host::{HostCallClient, HostConfig, HostContext, HostServices};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::Emitter;

pub const SHELL_CHANNELS: &[&str] = &[
    "app:getVersion",
    "window:reload",
    "window:minimize",
    "window:toggleMaximize",
    "window:isMaximized",
    "window:close",
    "window:confirmClose",
    "window:cancelClose",
    "window:supportsVibrancy",
    "window:setSurfaceVibrancy",
    "window:getZoomFactor",
    "window:setZoomFactor",
    "window:setNotificationView",
    "dialog:pickFolder",
    "shell:openExternal",
    "workspaces:saveToFile",
    "workspaces:openFromFile",
];

#[derive(Deserialize)]
struct Contract {
    methods: Vec<Method>,
    events: BTreeSet<String>,
}
#[derive(Deserialize)]
struct Method {
    method: String,
    channel: String,
}

/// Makes secrets durable and imports the retired Electron app's `secrets.json` once.
///
/// `use_os_keychain` is the shipping path (OS credential store, one-time macOS Keychain prompt
/// to read Electron's "Safe Storage" key). Otherwise secrets go to a file inside the profile
/// and the keychain is never touched — the e2e server and tests use this.
pub fn attach_secret_persistence(host: &HostContext, use_os_keychain: bool) {
    use praxis_host::electron_secrets::{derive_key, import_legacy};
    use praxis_host::secret_backends::{FileSecretBackend, KeychainSecretBackend};
    let profile = host.config().user_data_dir.clone();
    if use_os_keychain {
        host.secrets().attach_backend(std::sync::Arc::new(KeychainSecretBackend::new(&profile)));
    } else {
        host.secrets().attach_backend(std::sync::Arc::new(FileSecretBackend::new(profile.join("praxis-secrets.json"))));
    }
    let report = import_legacy(&profile, host.secrets(), || {
        if !use_os_keychain {
            return None;
        }
        #[cfg(target_os = "macos")]
        {
            // Verified against a real Electron profile: service "Praxis Safe Storage",
            // account "Praxis Key".
            praxis_host::electron_secrets::macos_safe_storage_password("Praxis Safe Storage", "Praxis Key")
                .map(|password| derive_key(&password))
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    });
    if report.imported + report.locked + report.undecryptable > 0 {
        eprintln!(
            "[secrets] Electron import: {} imported, {} locked, {} undecryptable",
            report.imported, report.locked, report.undecryptable
        );
    }
}

pub struct DesktopState {
    pub host: HostContext,
    pub zoom: Mutex<f64>,
    contract: Contract,
    services: HostServices,
    runtime: Mutex<Option<tokio::runtime::Runtime>>,
    event_subscription: u64,
}

impl DesktopState {
    pub fn new(
        default_dir: PathBuf,
        app: tauri::AppHandle,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut env: BTreeMap<String, String> = std::env::vars().collect();
        env.entry("PRAXIS_USER_DATA_DIR".into())
            .or_insert_with(|| default_dir.to_string_lossy().into_owned());
        let config =
            HostConfig::from_args_and_env(&std::env::args().skip(1).collect::<Vec<_>>(), &env)?;
        let host = HostContext::new(config);
        let zoom = host.settings().read().appearance.zoom_factor;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        // The current mobile bridge proxies execution/pairing to Electron. Fail
        // those reverse calls closed until their Rust application adapter exists.
        let calls = HostCallClient::new(|_| false);
        calls.close();
        let services = HostServices::register(&host, runtime.handle(), calls);
        crate::application::Application::register(&host, env!("CARGO_PKG_VERSION"));
        attach_secret_persistence(&host, std::env::var("PRAXIS_E2E").as_deref() != Ok("1"));
        let contract: Contract = serde_json::from_str(include_str!("../desktop-contract.json"))?;
        let events = contract.events.clone();
        let event_subscription = host.events().on_event(move |envelope| {
            if events.contains(&envelope.channel) {
                // Never broadcast to untrusted child browser webviews.
                if let Err(error) = app.emit_to("main", "praxis:event", envelope) {
                    eprintln!("Praxis event delivery failed: {error}");
                }
            }
        });
        Ok(Self {
            host,
            zoom: Mutex::new(zoom),
            contract,
            services,
            runtime: Mutex::new(Some(runtime)),
            event_subscription,
        })
    }

    pub fn allows(&self, channel: &str) -> bool {
        self.contract
            .methods
            .iter()
            .any(|method| method.channel == channel)
    }

    pub fn capabilities(&self) -> Value {
        contract_audit(&self.host)
    }

    pub fn shutdown(&self) {
        self.host.events().off_event(self.event_subscription);
        self.services.shutdown();
        if let Ok(mut runtime) = self.runtime.lock()
            && let Some(runtime) = runtime.take()
        {
            runtime.shutdown_background();
        }
    }
}

/// The generated renderer contract: allowed method channels and event channels.
pub fn contract_channels() -> Result<(BTreeSet<String>, BTreeSet<String>), Box<dyn std::error::Error>> {
    let contract: Contract = serde_json::from_str(include_str!("../desktop-contract.json"))?;
    Ok((contract.methods.into_iter().map(|m| m.channel).collect(), contract.events))
}

pub fn contract_audit(host: &HostContext) -> Value {
    let contract: Contract = serde_json::from_str(include_str!("../desktop-contract.json"))
        .expect("generated desktop contract");
    let methods: Vec<Value> = contract
        .methods
        .iter()
        .map(|method| {
            let registered = SHELL_CHANNELS.contains(&method.channel.as_str())
                || host.has_channel(&method.channel);
            // Registration says nothing about payloads, side effects or UI behavior.
            // Only an independent, per-channel parity receipt can establish that.
            let parity_verified = false;
            json!({
                "method": method.method,
                "channel": method.channel,
                "registered": registered,
                "parityVerified": parity_verified
            })
        })
        .collect();
    let registered = methods
        .iter()
        .filter(|method| method["registered"] == true)
        .count();
    let verified = methods
        .iter()
        .filter(|method| method["parityVerified"] == true)
        .count();
    let parity_verified = registered == methods.len() && verified == methods.len();
    json!({
        "shell": "tauri",
        "transport": "in-process",
        "methodCount": methods.len(),
        "registeredCount": registered,
        "missingCount": methods.len() - registered,
        "verifiedCount": verified,
        "methods": methods,
        "eventChannels": contract.events,
        "mobileExecution": "in-process: paired devices and appearance handled natively",
        "parityVerified": parity_verified
    })
}

/// Headless inventory uses exactly the same composition as the GUI, with no stdio
/// RPC and no webview. This is registration evidence, not behavioral parity.
pub fn print_contract_audit() -> Result<(), Box<dyn std::error::Error>> {
    let env = std::env::vars().collect();
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let host = HostContext::new(HostConfig::from_args_and_env(&args, &env)?);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let calls = HostCallClient::new(|_| false);
    calls.close();
    let services = HostServices::register(&host, runtime.handle(), calls);
    crate::application::Application::register(&host, env!("CARGO_PKG_VERSION"));
    println!("{}", serde_json::to_string_pretty(&contract_audit(&host))?);
    services.shutdown();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_contract_excludes_internal_host_controls() {
        let contract: Contract =
            serde_json::from_str(include_str!("../desktop-contract.json")).expect("contract");
        assert!(contract.methods.len() > 400);
        for channel in [
            "host:secrets:seed",
            "host:emitEvent",
            "host:getConfig",
            "terminal:dispose",
            "mobile:start",
            "workspaces:openFile",
            "workspaces:writeFile",
        ] {
            assert!(
                !contract
                    .methods
                    .iter()
                    .any(|method| method.channel == channel),
                "{channel}"
            );
        }
        assert!(
            contract
                .methods
                .iter()
                .any(|method| method.channel == "settings:set")
        );
    }

    #[test]
    fn capabilities_do_not_claim_missing_channels_or_parity() {
        let config = HostConfig::for_user_data_dir(
            std::env::temp_dir().join("praxis-tauri-audit-test"),
            false,
            true,
        )
        .expect("config");
        let host = HostContext::new(config);
        let report = contract_audit(&host);
        assert!(report["missingCount"].as_u64().expect("count") > 0);
        assert_eq!(report["parityVerified"], false);
        let missing = report["methods"]
            .as_array()
            .expect("methods")
            .iter()
            .find(|method| method["channel"] == "ai:startConversation")
            .expect("conversation contract");
        assert_eq!(missing["registered"], false);
        assert_eq!(missing["parityVerified"], false);
    }

    #[test]
    fn full_composition_registers_contract_without_claiming_parity() {
        let config = HostConfig::for_user_data_dir(
            std::env::temp_dir().join("praxis-tauri-full-audit-test"),
            false,
            true,
        )
        .expect("config");
        let host = HostContext::new(config);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let calls = HostCallClient::new(|_| false);
        calls.close();
        let services = HostServices::register(&host, runtime.handle(), calls);
        crate::application::Application::register(&host, "0.1.0");
        let report = contract_audit(&host);
        assert_eq!(report["missingCount"], 0);
        assert_eq!(report["registeredCount"], report["methodCount"]);
        assert_eq!(report["verifiedCount"], 0);
        assert_eq!(report["parityVerified"], false);
        services.shutdown();
    }
}
