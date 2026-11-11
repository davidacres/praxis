//! Provider status and API-key handling. Ports `aiInstance.ts`'s `buildProviderStatus`,
//! `listAiProviderStatuses` and the `ai:set*ApiKey` / reset / remove-custom handlers.
//!
//! Keys live in the secret store under the names the Electron app used
//! (`praxis.geminiApiKey`, `praxis.customProvider.<slug>.apiKey`, …), so keys migrated from it
//! are found. The key value itself never crosses IPC: only where it came from does.

use praxis_ai::providers::registry::{
    API_KEY_PROVIDERS, DescriptorKind, provider_presets, ProviderDescriptor, built_in_descriptors, gateway_key_from_env, is_custom_provider_id,
    is_executable_available, probe_cli_provider, secret_key_for_provider,
};
use praxis_ai::providers::model_catalog::{GatewayOptions, KeyAuth, fetch_models};
use praxis_ai::providers::provider_probe::probe_openai_compatible;
use praxis_core::config::custom_providers::{custom_base_url_problem, custom_header_name_problem, custom_provider_id_for, sanitize_custom_provider};
use praxis_host::HostContext;
use super::runtime::{block_on, runtime};
use serde_json::{Value, json};

use super::{Result, failure, text};

/// A provider id → its descriptor, including user-added custom endpoints.
struct Resolved {
    descriptor: ProviderDescriptor,
    /// `Some` for a custom endpoint: its serialized config.
    custom: Option<Value>,
}

/// Writes a settings patch and tells the renderer, as `settings:set` does. A handler that writes
/// settings without this leaves open windows showing stale data until they next reload.
fn write_settings(host: &HostContext, patch: &Value) -> Result<()> {
    let updated = host.settings().write(patch).map_err(failure)?;
    host.git_service().set_configured_executable(updated.git.executable_path.clone());
    host.events().emit("settings:changed", Some(serde_json::to_value(updated).map_err(failure)?));
    Ok(())
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

/// Which local OpenAI-compatible runtimes answer right now. Probes each `local` preset's
/// `/models` on loopback with a short timeout, side by side; nothing listening costs one refused
/// connection. `PRAXIS_LOCAL_RUNTIME_ORIGINS` (JSON: preset id → origin) points a preset at a
/// mock for tests.
fn detect_local_runtimes() -> Vec<Value> {
    let origins: serde_json::Map<String, Value> = std::env::var("PRAXIS_LOCAL_RUNTIME_ORIGINS").ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default();
    let probes = provider_presets().into_iter().filter(|preset| preset["group"] == "local").map(|preset| {
        let base = origins.get(preset["id"].as_str().unwrap_or_default()).and_then(Value::as_str).or(preset["baseUrl"].as_str()).unwrap_or_default().trim_end_matches('/').to_owned();
        async move {
            let mut options = GatewayOptions::new(base.clone(), None);
            options.api_path = preset["apiPath"].as_str().map(str::to_owned);
            options.exact_path = true;
            // The listing client has a 10s ceiling; a local runtime that does not answer in 700ms is not there.
            let models = tokio::time::timeout(std::time::Duration::from_millis(700), fetch_models(&options)).await.ok()?.ok()?;
            Some(json!({ "presetId": preset["id"], "label": preset["label"], "baseUrl": base, "modelCount": models.len() }))
        }
    });
    let handles: Vec<_> = probes.map(|probe| runtime().spawn(probe)).collect();
    block_on(async {
        let mut found = Vec::new();
        for handle in handles {
            if let Ok(Some(runtime)) = handle.await {
                found.push(runtime);
            }
        }
        found
    })
}

/// Connection options for a (sanitized) custom endpoint config.
fn custom_options(config: &Value, api_key: Option<String>) -> GatewayOptions {
    let mut options = GatewayOptions::new(config["baseUrl"].as_str().unwrap_or_default(), api_key);
    options.api_path = config["apiPath"].as_str().map(str::to_owned);
    options.exact_path = true;
    options.auth = match config["auth"]["kind"].as_str() {
        Some("none") => KeyAuth::None,
        Some("header") => KeyAuth::Header(config["auth"]["name"].as_str().unwrap_or("Authorization").to_owned()),
        _ => KeyAuth::Bearer,
    };
    options.headers = config["headers"].as_object().map(|map| map.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect()).unwrap_or_default();
    options
}

fn sanitized(draft: &Value) -> Option<Value> {
    sanitize_custom_provider(draft).and_then(|config| serde_json::to_value(config).ok())
}

/// Runs the capability probe against a saved endpoint or an unsaved draft. A typed key is used
/// for this call only and never stored. The result is written back to the saved endpoint only
/// when the probe targeted exactly what is saved.
fn test_custom_provider(host: &HostContext, args: &[Value]) -> Result<Value> {
    let config = sanitized(args.first().unwrap_or(&Value::Null)).ok_or_else(|| failure("Check the endpoint URL and authentication."))?;
    let options = args.get(1).cloned().unwrap_or(Value::Null);
    let typed_key = options["apiKey"].as_str().map(str::trim).filter(|key| !key.is_empty()).map(str::to_owned);
    let id = config["id"].as_str().unwrap_or_default().to_owned();
    let api_key = typed_key.clone().or_else(|| if config["auth"]["kind"] == "none" { None } else { stored_key(host, &id) });
    let result = block_on(probe_openai_compatible(&custom_options(&config, api_key), options["model"].as_str()));

    let customs = custom_configs(host);
    if let Some(saved) = customs.iter().find(|saved| saved["id"] == id)
        && typed_key.is_none()
        && saved["baseUrl"] == config["baseUrl"]
        && saved["apiPath"] == config["apiPath"]
        && saved["auth"]["kind"] == config["auth"]["kind"]
    {
        let capabilities = result["capabilities"].clone();
        let keep_stream_usage = capabilities["streamUsage"] == true || capabilities["streaming"] != true;
        let updated: Vec<Value> = customs
            .iter()
            .map(|provider| {
                if provider["id"] != id {
                    return provider.clone();
                }
                let mut next = provider.clone();
                next["capabilities"] = capabilities.clone();
                if !keep_stream_usage {
                    next["streamUsage"] = json!(false);
                }
                next
            })
            .collect();
        write_settings(host, &json!({ "ai": { "customProviders": updated } }))?;
    }
    Ok(result)
}

/// Adds or updates a custom endpoint and its key, validating it the way settings load does.
fn save_custom_provider(host: &HostContext, args: &[Value]) -> Result<Value> {
    let input = args.first().cloned().unwrap_or(Value::Null);
    let mut draft = input["config"].clone();
    let existing = custom_configs(host);
    let existing_ids: Vec<String> = existing.iter().filter_map(|config| config["id"].as_str().map(str::to_owned)).collect();
    let requested = draft["id"].as_str().map(str::to_owned);
    let is_update = requested.as_ref().is_some_and(|id| existing_ids.contains(id));
    let id = match (&requested, is_update) {
        (Some(id), true) => id.clone(),
        _ => custom_provider_id_for(draft["label"].as_str().unwrap_or_default(), &existing_ids),
    };
    if let Some(problem) = custom_base_url_problem(draft["baseUrl"].as_str().unwrap_or_default()) {
        return Err(failure(problem));
    }
    for name in draft["headers"].as_object().map(|headers| headers.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
        if let Some(problem) = custom_header_name_problem(&name) {
            return Err(failure(problem));
        }
    }
    draft["id"] = json!(id);
    let config = sanitized(&draft).ok_or_else(|| failure("Check the endpoint name, URL and authentication."))?;
    let customs: Vec<Value> = if is_update {
        existing.iter().map(|provider| if provider["id"] == id { config.clone() } else { provider.clone() }).collect()
    } else {
        existing.iter().cloned().chain(std::iter::once(config.clone())).collect()
    };
    let mut ai = json!({ "customProviders": customs });
    if let Some(model) = input["defaultModel"].as_str() {
        let trimmed = model.trim();
        ai["providers"] = json!({ id.clone(): { "defaultModel": if trimmed.is_empty() { Value::Null } else { json!(trimmed) } } });
    }
    write_settings(host, &json!({ "ai": ai }))?;
    if config["auth"]["kind"] == "none" {
        store_or_clear(host, &id, "")?;
    } else if let Some(key) = input["apiKey"].as_str() {
        store_or_clear(host, &id, key)?;
    }
    Ok(config)
}

pub fn dispatch(host: &HostContext, channel: &str, args: &[Value]) -> Option<Result<Value>> {
    Some(match channel {
        "ai:getStatus" => active_status(host),
        "ai:listProviderStatuses" => Ok(json!(list_statuses(host))),
        "ai:listProviderPresets" => Ok(json!(provider_presets())),
        "ai:detectLocalRuntimes" => Ok(json!(detect_local_runtimes())),
        "ai:testCustomProvider" => test_custom_provider(host, args),
        "ai:saveCustomProvider" => save_custom_provider(host, args),
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
            write_settings(host, &json!({ "ai": { "customProviders": remaining } }))?;
            store_or_clear(host, id, "")?;
            Ok(Value::Null)
        })(),
        _ => return None,
    })
}
