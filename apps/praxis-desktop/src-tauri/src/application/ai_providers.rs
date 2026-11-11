//! Provider status and API-key handling. Ports `aiInstance.ts`'s `buildProviderStatus`,
//! `listAiProviderStatuses` and the `ai:set*ApiKey` / reset / remove-custom handlers.
//!
//! Keys live in the secret store under the names the Electron app used
//! (`praxis.geminiApiKey`, `praxis.customProvider.<slug>.apiKey`, …), so keys migrated from it
//! are found. The key value itself never crosses IPC: only where it came from does.

use praxis_ai::providers::registry::{
    API_KEY_PROVIDERS, DescriptorKind, ProviderDescriptor, built_in_descriptors, gateway_key_from_env, is_custom_provider_id,
    is_executable_available, probe_cli_provider, secret_key_for_provider,
};
use praxis_host::HostContext;
use serde_json::{Value, json};

use super::{Result, failure, text};

/// A provider id → its descriptor, including user-added custom endpoints.
struct Resolved {
    descriptor: ProviderDescriptor,
    /// `Some` for a custom endpoint: its serialized config.
    custom: Option<Value>,
}

fn custom_configs(host: &HostContext) -> Vec<Value> {
    host.settings()
        .read()
        .ai
        .custom_providers
        .as_ref()
        .map(|configs| configs.iter().filter_map(|config| serde_json::to_value(config).ok()).collect())
        .unwrap_or_default()
}

fn resolve_all(host: &HostContext) -> Vec<Resolved> {
    let mut all: Vec<Resolved> = built_in_descriptors().into_iter().map(|descriptor| Resolved { descriptor, custom: None }).collect();
    for config in custom_configs(host) {
        let descriptor = ProviderDescriptor {
            id: config["id"].as_str().unwrap_or_default().to_owned(),
            kind: DescriptorKind::Api,
            label: config["label"].as_str().unwrap_or_default().to_owned(),
            default_base_url: config["baseUrl"].as_str().map(str::to_owned),
            // No shipped default: the model comes from the server's list or the user.
            default_model: String::new(),
            api_path: config["apiPath"].as_str().map(str::to_owned),
            default_command: None,
            default_args: Vec::new(),
        };
        all.push(Resolved { descriptor, custom: Some(config) });
    }
    all
}

fn find(host: &HostContext, provider: &str) -> Result<Resolved> {
    resolve_all(host).into_iter().find(|candidate| candidate.descriptor.id == provider).ok_or_else(|| {
        failure(if is_custom_provider_id(provider) {
            format!(
                "The AI endpoint “{}” was removed. Choose another provider in Settings → AI Provider.",
                provider.trim_start_matches("custom:")
            )
        } else {
            format!("Unknown AI provider “{provider}”.")
        })
    })
}

/// A custom endpoint set to "No key" (a local runtime) needs none; CLI providers never do.
fn needs_api_key(resolved: &Resolved) -> bool {
    resolved.descriptor.kind == DescriptorKind::Api && resolved.custom.as_ref().is_none_or(|config| config["auth"]["kind"] != "none")
}

fn stored_key(host: &HostContext, provider: &str) -> Option<String> {
    host.secrets().get(&secret_key_for_provider(provider)).map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
}

/// `secret`, `env` (the gateway's environment fallback only) or `none`.
fn key_source(host: &HostContext, provider: &str) -> &'static str {
    if stored_key(host, provider).is_some() {
        "secret"
    } else if provider == "vercel-gateway" && gateway_key_from_env().is_some() {
        "env"
    } else {
        "none"
    }
}

/// Status snapshot for one provider.
fn build_status(host: &HostContext, resolved: &Resolved) -> Value {
    let settings = host.settings().read();
    let ai = &settings.ai;
    let descriptor = &resolved.descriptor;
    let config = ai.providers.get(&descriptor.id);
    let enabled = config.and_then(|config| config.enabled) != Some(false);

    if descriptor.kind == DescriptorKind::CliAgent {
        // Auth is the CLI's own (`claude login`, …), outside this app. "Configured" is a real,
        // free check that the command resolves to a spawnable executable.
        let override_path = config.and_then(|config| config.cli_path.as_deref()).map(str::trim).filter(|path| !path.is_empty());
        let command = override_path.or(descriptor.default_command.as_deref());
        let configured = command.is_none_or(is_executable_available);
        let mut status = json!({
            "provider": descriptor.id, "label": descriptor.label, "kind": "cli-agent", "configured": configured, "enabled": enabled,
            "keySource": "none", "gatewayUrl": command.unwrap_or("bundled runtime"), "defaultModel": "",
            "agentName": ai.agent_name, "activeTasks": []
        });
        if let Some(command) = command {
            status["preflight"] = probe_cli_provider(command).to_json();
        }
        return status;
    }

    let source = key_source(host, &descriptor.id);
    let gateway_url = if descriptor.id == "vercel-gateway" {
        Some(ai.gateway_url.trim().to_owned()).filter(|url| !url.is_empty()).or_else(|| descriptor.default_base_url.clone())
    } else if resolved.custom.is_some() {
        descriptor.default_base_url.clone()
    } else {
        config.and_then(|config| config.base_url.as_deref()).map(str::trim).filter(|url| !url.is_empty()).map(str::to_owned).or_else(|| descriptor.default_base_url.clone())
    };
    let default_model = if descriptor.id == "vercel-gateway" { ai.default_model.clone() } else { config.and_then(|config| config.default_model.clone()).unwrap_or_default() };
    let mut status = json!({
        "provider": descriptor.id, "label": descriptor.label, "kind": "api",
        "configured": source != "none" || !needs_api_key(resolved),
        "enabled": enabled, "keySource": source, "gatewayUrl": gateway_url, "defaultModel": default_model,
        "agentName": ai.agent_name, "activeTasks": []
    });
    if let Some(custom) = &resolved.custom {
        status["custom"] = json!(true);
        status["needsKey"] = json!(custom["auth"]["kind"] != "none");
        if !custom["capabilities"].is_null() {
            status["capabilities"] = custom["capabilities"].clone();
        }
    }
    status
}

fn list_statuses(host: &HostContext) -> Vec<Value> {
    // Probing a CLI can take a moment; do the providers side by side.
    let all = resolve_all(host);
    std::thread::scope(|scope| {
        let handles: Vec<_> = all.iter().map(|resolved| scope.spawn(|| build_status(host, resolved))).collect();
        handles.into_iter().filter_map(|handle| handle.join().ok()).collect()
    })
}

fn active_status(host: &HostContext) -> Result<Value> {
    let active = host.settings().read().ai.active_provider.clone();
    Ok(build_status(host, &find(host, &active)?))
}

fn store_or_clear(host: &HostContext, provider: &str, value: &str) -> Result<()> {
    let key = secret_key_for_provider(provider);
    let trimmed = value.trim();
    let done = if trimmed.is_empty() { host.secrets().delete(&key) || !host.secrets().has(&key) } else { host.secrets().set(&key, trimmed) };
    if done { Ok(()) } else { Err(failure("The key could not be saved to the secure store.")) }
}

pub fn dispatch(host: &HostContext, channel: &str, args: &[Value]) -> Option<Result<Value>> {
    Some(match channel {
        "ai:getStatus" => active_status(host),
        "ai:listProviderStatuses" => Ok(json!(list_statuses(host))),
        "ai:setApiKey" => {
            let active = host.settings().read().ai.active_provider.clone();
            store_or_clear(host, &active, text(args, 0).unwrap_or_default()).and_then(|()| active_status(host))
        }
        "ai:setProviderApiKey" => (|| {
            let provider = text(args, 0)?;
            store_or_clear(host, provider, text(args, 1).unwrap_or_default())?;
            Ok(build_status(host, &find(host, provider)?))
        })(),
        "ai:resetProviderApiKeys" => {
            let customs = custom_configs(host).into_iter().filter_map(|config| config["id"].as_str().map(str::to_owned));
            let all: Vec<String> = API_KEY_PROVIDERS.iter().map(|id| (*id).to_owned()).chain(customs).collect();
            all.iter().try_for_each(|provider| store_or_clear(host, provider, "")).map(|()| Value::Null)
        }
        "ai:removeCustomProvider" => (|| {
            let id = text(args, 0)?;
            if !is_custom_provider_id(id) {
                return Err(failure(format!("“{id}” is a built-in provider and can't be removed.")));
            }
            let remaining: Vec<Value> = custom_configs(host).into_iter().filter(|config| config["id"] != id).collect();
            host.settings().write(&json!({ "ai": { "customProviders": remaining } })).map_err(failure)?;
            store_or_clear(host, id, "")?;
            Ok(Value::Null)
        })(),
        _ => return None,
    })
}
