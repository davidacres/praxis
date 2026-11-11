//! `ai:listCliModelOptions` and `ai:listApiModelOptions`: the model pickers' data.
//! Ports `listCliModelOptions` / `listApiModelOptions` from `aiInstance.ts` and
//! `AcpAgentHost.listAvailableModels`.
//!
//! Both return `ModelOptions | null`. `null` means "no selector" (never an error), which is what
//! the renderer expects; a bare array here crashes the picker.

use std::collections::BTreeMap;
use std::time::Duration;

use praxis_ai::acp::connection::{AcpConnection, AcpSpawn, Incoming};
use praxis_ai::providers::environment::effective_path;
use praxis_ai::providers::model_catalog::{GatewayOptions, KeyAuth, list_catalog_models};
use praxis_ai::providers::model_pricing::{get_known_context_length, get_model_pricing};
use praxis_ai::providers::registry::{DescriptorKind, built_in_descriptors, gateway_key_from_env, resolve_executable, secret_key_for_provider};
use praxis_host::HostContext;
use serde_json::{Value, json};

use super::runtime::block_on;
use super::{Result, failure, text};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(25);

fn working_directory(host: &HostContext) -> String {
    let configured = host.settings().read().ai.working_directory.trim().to_owned();
    if configured.is_empty() { std::env::current_dir().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default() } else { configured }
}

/// Codex records its default context windows in its own catalog, unlike ACP's model selector.
fn codex_context_lengths() -> BTreeMap<String, u64> {
    let home = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from).or_else(|| std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".codex")));
    let Some(raw) = home.and_then(|home| std::fs::read_to_string(home.join("models_cache.json")).ok()) else { return BTreeMap::new() };
    let cache: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    cache["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| Some((model["slug"].as_str()?.to_owned(), model["context_window"].as_u64().filter(|length| *length > 0)?)))
        .collect()
}

/// Flattens ACP select options, which are either a flat list or grouped (e.g. by vendor).
fn flatten_choices(options: &Value) -> Vec<Value> {
    options
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| if entry.get("group").is_some() { entry["options"].as_array().cloned().unwrap_or_default() } else { vec![entry.clone()] })
        .collect()
}

/// Spawns the agent, completes `initialize` and `session/new`, and reads the model selector.
async fn read_model_selector(command: &str, args: Vec<String>, cwd: &str) -> std::result::Result<Option<Value>, String> {
    let resolved = resolve_executable(command, effective_path()).ok_or_else(|| format!("spawn {command} ENOENT"))?;
    let (connection, mut incoming) = AcpConnection::spawn(AcpSpawn {
        command: resolved.to_string_lossy().into_owned(),
        args,
        cwd: Some(cwd.to_owned()).filter(|cwd| !cwd.is_empty()),
        env: vec![("PATH".into(), effective_path().to_owned())],
    })
    .await?;
    let connection = std::sync::Arc::new(connection);
    // Nothing is granted during discovery: any request the agent makes is refused.
    let refuser = {
        let connection = std::sync::Arc::clone(&connection);
        tokio::spawn(async move {
            while let Some(message) = incoming.recv().await {
                match message {
                    Incoming::Request { id, .. } => {
                        let _ = connection.respond_error(&id, -32601, "Not available while listing models.").await;
                    }
                    Incoming::Closed => break,
                    Incoming::Notification { .. } => {}
                }
            }
        })
    };
    let outcome = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        connection.request("initialize", json!({ "protocolVersion": 1, "clientCapabilities": {} })).await.map_err(|e| e.to_string())?;
        let session = connection.request("session/new", json!({ "cwd": cwd, "mcpServers": [] })).await.map_err(|e| e.to_string())?;
        let options = session["configOptions"].as_array().cloned().unwrap_or_default();
        // By semantic category, with the id as a fallback for agents that predate categories.
        Ok::<_, String>(options.iter().find(|o| o["category"] == "model").or_else(|| options.iter().find(|o| o["id"] == "model")).cloned())
    })
    .await
    .map_err(|_| {
        let hint = String::new();
        format!("{command} did not finish starting within {}s.{hint}", HANDSHAKE_TIMEOUT.as_secs())
    });
    connection.shutdown().await;
    refuser.abort();
    outcome?
}

/// Completes ACP `initialize` without creating a session or sending a prompt, and returns the
/// stable subset of the agent's capabilities. Nothing is granted: requests are refused.
pub(super) async fn probe_acp_capabilities(command: &str, args: Vec<String>, cwd: &str) -> std::result::Result<Value, String> {
    let resolved = resolve_executable(command, effective_path()).ok_or_else(|| format!("spawn {command} ENOENT"))?;
    let (connection, mut incoming) = AcpConnection::spawn(AcpSpawn {
        command: resolved.to_string_lossy().into_owned(),
        args,
        cwd: Some(cwd.to_owned()).filter(|cwd| !cwd.is_empty()),
        env: vec![("PATH".into(), effective_path().to_owned())],
    })
    .await?;
    let connection = std::sync::Arc::new(connection);
    let refuser = {
        let connection = std::sync::Arc::clone(&connection);
        tokio::spawn(async move {
            while let Some(message) = incoming.recv().await {
                match message {
                    Incoming::Request { id, .. } => {
                        let _ = connection.respond_error(&id, -32601, "Not available during a capability probe.").await;
                    }
                    Incoming::Closed => break,
                    Incoming::Notification { .. } => {}
                }
            }
        })
    };
    let outcome = tokio::time::timeout(HANDSHAKE_TIMEOUT, connection.request("initialize", json!({ "protocolVersion": 1, "clientCapabilities": {} })))
        .await
        .map_err(|_| format!("{command} did not answer initialize within {}s.", HANDSHAKE_TIMEOUT.as_secs()))
        .and_then(|reply| reply.map_err(|error| error.to_string()));
    connection.shutdown().await;
    refuser.abort();
    let capabilities = outcome?["agentCapabilities"].clone();
    if capabilities.is_null() {
        return Err("The ACP provider did not advertise capabilities.".into());
    }
    Ok(json!({
        "protocol": "acp",
        "sessionResume": capabilities["sessionCapabilities"]["resume"].is_object() || capabilities["sessionCapabilities"]["resume"] == true,
        "sessionLoad": capabilities["loadSession"] == true,
        "sessionClose": capabilities["sessionCapabilities"]["close"].is_object() || capabilities["sessionCapabilities"]["close"] == true,
        "mcpHttp": capabilities["mcpCapabilities"]["http"] == true
    }))
}

pub(super) fn working_directory_for(host: &HostContext) -> String {
    working_directory(host)
}

fn list_cli(host: &HostContext, provider: &str) -> Result<Value> {
    let Some(descriptor) = built_in_descriptors().into_iter().find(|d| d.id == provider && d.kind == DescriptorKind::CliAgent) else {
        return Ok(Value::Null);
    };
    let settings = host.settings().read();
    let override_path = settings.ai.providers.get(provider).and_then(|config| config.cli_path.as_deref()).map(str::trim).filter(|path| !path.is_empty()).map(str::to_owned);
    drop(settings);
    let command = override_path.clone().or(descriptor.default_command.clone()).ok_or_else(|| failure("No command is configured for this provider."))?;
    let selector = block_on(read_model_selector(&command, descriptor.default_args.clone(), &working_directory(host))).map_err(failure)?;
    let Some(selector) = selector.filter(|option| option["type"] == "select") else { return Ok(Value::Null) };

    let codex = (provider == "codex-cli").then(codex_context_lengths);
    let options: Vec<Value> = flatten_choices(&selector["options"])
        .into_iter()
        .map(|choice| {
            let value = choice["value"].as_str().unwrap_or_default().to_owned();
            let usage = choice["_meta"]["copilotUsage"].as_str().filter(|usage| usage.ends_with('x') && usage[..usage.len() - 1].parse::<f64>().is_ok());
            let mut option = json!({ "value": value, "name": choice["name"] });
            if let Some(description) = choice["description"].as_str() {
                option["description"] = json!(description);
            }
            if let Some(usage) = usage {
                option["pricingLabel"] = json!(format!("{}× premium requests", &usage[..usage.len() - 1]));
            }
            let length = codex.as_ref().and_then(|lengths| lengths.get(&value).copied()).or_else(|| get_known_context_length(Some(&value), Some(provider)));
            if let Some(length) = length.filter(|length| *length > 0) {
                option["contextLength"] = json!(length);
            }
            if let Some(pricing) = get_model_pricing(Some(provider), Some(&value)).and_then(|rates| serde_json::to_value(rates).ok()) {
                option["pricing"] = pricing;
            }
            option
        })
        .collect();
    Ok(json!({ "currentValue": selector["currentValue"], "options": options }))
}

/// The gateway URL: configured, then the environment, then the default.
fn gateway_url(configured: &str) -> String {
    let configured = configured.trim();
    if !configured.is_empty() {
        return configured.to_owned();
    }
    ["AI_GATEWAY_URL", "VERCEL_AI_GATEWAY_URL", "FROSTY_VERCEL_URL"]
        .iter()
        .find_map(|name| std::env::var(name).ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty()))
        .unwrap_or_else(|| praxis_ai::providers::registry::DEFAULT_VERCEL_URL.to_owned())
}

fn list_api(host: &HostContext, provider: &str, force_refresh: bool) -> Result<Value> {
    let customs: Vec<Value> = host.settings().read().ai.custom_providers.iter().flatten().filter_map(|config| serde_json::to_value(config).ok()).collect();
    let custom = customs.iter().find(|config| config["id"] == provider);
    let descriptor = built_in_descriptors().into_iter().find(|d| d.id == provider);
    if descriptor.as_ref().is_some_and(|d| d.kind != DescriptorKind::Api) {
        return Ok(Value::Null);
    }
    if descriptor.is_none() && custom.is_none() {
        return Ok(Value::Null);
    }
    let settings = host.settings().read();
    let config = settings.ai.providers.get(provider);
    let api_key = host
        .secrets()
        .get(&secret_key_for_provider(provider))
        .map(|key| key.trim().to_owned())
        .filter(|key| !key.is_empty())
        .or_else(|| (provider == "vercel-gateway").then(gateway_key_from_env).flatten());
    let needs_key = custom.is_none_or(|config| config["auth"]["kind"] != "none");
    if api_key.is_none() && needs_key {
        return Ok(Value::Null);
    }
    let model = if provider == "vercel-gateway" { settings.ai.default_model.trim().to_owned() } else { config.and_then(|c| c.default_model.clone()).unwrap_or_default().trim().to_owned() };
    let url = if provider == "vercel-gateway" {
        gateway_url(&settings.ai.gateway_url)
    } else if let Some(custom) = custom {
        custom["baseUrl"].as_str().unwrap_or_default().to_owned()
    } else {
        config.and_then(|c| c.base_url.as_deref()).map(str::trim).filter(|u| !u.is_empty()).map(str::to_owned).or_else(|| descriptor.as_ref().and_then(|d| d.default_base_url.clone())).unwrap_or_default()
    };
    drop(settings);

    let mut options = GatewayOptions::new(url, api_key);
    let mut manual: Vec<String> = Vec::new();
    if let Some(custom) = custom {
        options.api_path = custom["apiPath"].as_str().map(str::to_owned);
        options.exact_path = true;
        options.auth = match custom["auth"]["kind"].as_str() {
            Some("none") => KeyAuth::None,
            Some("header") => KeyAuth::Header(custom["auth"]["name"].as_str().unwrap_or("Authorization").to_owned()),
            _ => KeyAuth::Bearer,
        };
        options.headers = custom["headers"].as_object().map(|map| map.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect()).unwrap_or_default();
        manual = custom["manualModels"].as_array().map(|m| m.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
    } else {
        options.api_path = descriptor.as_ref().and_then(|d| d.api_path.clone());
    }
    match block_on(list_catalog_models(provider, &options, &manual, force_refresh)) {
        Ok(choices) => Ok(json!({ "currentValue": Some(model).filter(|m| !m.is_empty()), "options": choices })),
        // The picker degrades to "no list" rather than showing an error.
        Err(_) => Ok(Value::Null),
    }
}

pub fn dispatch(host: &HostContext, channel: &str, args: &[Value]) -> Option<Result<Value>> {
    Some(match channel {
        "ai:listCliModelOptions" => text(args, 0).and_then(|provider| list_cli(host, provider)),
        "ai:listApiModelOptions" => text(args, 0).and_then(|provider| list_api(host, provider, args.get(1).and_then(Value::as_bool) == Some(true))),
        _ => return None,
    })
}
