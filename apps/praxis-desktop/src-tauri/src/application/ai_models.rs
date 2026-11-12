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
            let published = published_cli_metadata(provider, &value, choice["name"].as_str().unwrap_or_default());
            let mut option = json!({ "value": value, "name": choice["name"] });
            if let Some(label) = published["pricingLabel"].as_str() {
                option["pricingLabel"] = json!(label);
            }
            if let Some(label) = published["contextLabel"].as_str() {
                option["contextLabel"] = json!(label);
            }
            if let Some(description) = choice["description"].as_str() {
                option["description"] = json!(description);
            }
            if let Some(usage) = usage {
                option["pricingLabel"] = json!(format!("{}× premium requests", &usage[..usage.len() - 1]));
            }
            let length = codex.as_ref().and_then(|lengths| lengths.get(&value).copied()).or_else(|| get_known_context_length(Some(&value), Some(provider))).or_else(|| published["contextLength"].as_u64());
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

/// Canonical model family id, excluding CLI reasoning/speed parameters (`canonicalCliModelId`).
fn canonical_cli_model_id(value: &str) -> String {
    use regex::Regex;
    let lower = value.to_lowercase();
    let mut id = lower.split('[').next().unwrap_or_default().to_owned();
    id = Regex::new(r"\s*\([^)]*\)").expect("static").replace_all(&id, "").trim().to_owned();
    id = Regex::new(r"\s+").expect("static").replace_all(&id, "-").into_owned();
    // The original strips with a lookahead; repeat until nothing more matches.
    let suffix = Regex::new(r"-(?:thinking|extra-high|xhigh|high|medium|low|minimal|none|max|fast)(-|$)").expect("static");
    loop {
        let next = suffix.replace(&id, "$1").into_owned();
        if next == id {
            break;
        }
        id = next;
    }
    id = Regex::new(r"^(opus|sonnet|haiku|fable)-").expect("static").replace(&id, "claude-$1-").into_owned();
    id = Regex::new(r"^(claude-(?:opus|sonnet|haiku|fable)-\d+)-(\d+)(-|$)").expect("static").replace(&id, "$1.$2$3").into_owned();
    id = Regex::new(r"-\d{8}$").expect("static").replace(&id, "").into_owned();
    id.strip_prefix("glm-5p3").map_or(id.clone(), |rest| format!("glm-5.3{rest}"))
}

/// Published base token rates, checked 2026-10-11. API references, not charges against a CLI
/// subscription. Exact ids only; no family guesses.
fn reference_rates(id: &str) -> Option<(f64, f64)> {
    Some(match id {
        "gpt-6.1-sol" | "gpt-6-sol" => (2.0, 10.0), "gpt-6-astra" => (10.0, 50.0), "gpt-6-luna" => (0.1, 0.5),
        "gpt-5.6-sol" => (4.0, 20.0), "gpt-5.6-terra" => (2.0, 12.0), "gpt-5.6-luna" => (0.2, 1.2),
        "gpt-5.5" => (5.0, 30.0), "gpt-5.4" => (2.5, 15.0), "gpt-5.4-mini" => (0.75, 4.5), "gpt-5.4-nano" => (0.2, 1.25),
        "gpt-5.3-codex" | "gpt-5.2" => (1.75, 14.0), "gpt-5.1" => (1.25, 10.0), "gpt-5-mini" => (0.25, 2.0),
        "claude-opus-5.5" => (4.0, 20.0), "claude-sonnet-5.5" | "claude-sonnet-5" => (2.0, 10.0), "claude-haiku-5.5" => (0.1, 0.5),
        "claude-fable-5.1" | "claude-fable-5" => (10.0, 50.0), "claude-opus-5" | "claude-opus-4.8" | "claude-opus-4.7" | "claude-opus-4.6" | "claude-opus-4.5" => (5.0, 25.0),
        "claude-sonnet-4.6" | "claude-sonnet-4.5" | "claude-sonnet-4" => (3.0, 15.0), "claude-haiku-4.5" => (1.0, 5.0),
        "gemini-3.8-flash" | "gemini-3.7-flash" | "gemini-3.6-flash" => (0.75, 3.75), "gemini-3.1-pro" => (2.0, 12.0), "muse-spark-1.3" => (1.25, 4.25),
        "kimi-k3" => (3.0, 15.0), "glm-5.2" | "glm-5.3" => (1.4, 4.4), "glm-5.3-flash" => (0.15, 0.5), "kimi-k2.7-code" => (0.95, 4.0),
        "gemini-3.5-flash" => (1.5, 9.0), "gemini-3-flash" => (0.5, 3.0), "gemini-2.5-flash" => (0.3, 2.5),
        _ => return None,
    })
}

fn rate(value: f64) -> String {
    if value.fract() == 0.0 { format!("{}", value as i64) } else { format!("{value}") }
}

/// Context size and price label the vendors publish for a CLI model (`publishedCliModelMetadata`).
fn published_cli_metadata(provider: &str, value: &str, name: &str) -> Value {
    use regex::Regex;
    let id = canonical_cli_model_id(value);
    let resolved = if reference_rates(&id).is_some() { id.clone() } else { canonical_cli_model_id(name) };
    let mut metadata = json!({});
    if let Some((input, output)) = reference_rates(&resolved) {
        metadata["pricingLabel"] = json!(format!("API base ${} / ${} /1M", rate(input), rate(output)));
    }
    if Regex::new(r"^claude-(?:opus|sonnet|haiku|fable)-5(?:\.|$)").expect("static").is_match(&resolved) {
        metadata["contextLength"] = json!(1_000_000);
    }
    let gemini_flash = Regex::new(r"^gemini-3\.[678]-flash$").expect("static");
    if gemini_flash.is_match(&resolved) {
        metadata["contextLength"] = json!(1_048_576);
    }
    if provider == "cursor-cli" {
        let cursor_context = match id.as_str() { "grok-4.7" | "grok-4.6" | "grok-4.5" => Some(256_000), "composer-2.5" => Some(200_000), "gemini-3.8-flash" => Some(200_000), "muse-spark-1.3" => Some(300_000), _ => None };
        match cursor_context {
            Some(length) => metadata["contextLength"] = json!(length),
            None => {
                metadata.as_object_mut().map(|o| o.remove("contextLength"));
            }
        }
        if id.starts_with("grok-4.") || id == "composer-2.5" {
            let fast = value.contains("fast=true");
            let long = id == "grok-4.7" && value.contains("context=500k");
            let (input, output) = if id == "composer-2.5" {
                if fast { (3.0, 15.0) } else { (0.5, 2.5) }
            } else {
                let input = if long && fast { 6.0 } else if long || fast { 4.0 } else { 2.0 };
                let output = if (long && fast) || (fast && id == "grok-4.5") { 18.0 } else if long || fast { 12.0 } else { 6.0 };
                (input, output)
            };
            metadata["pricingLabel"] = json!(format!("${} / ${} /1M", rate(input), rate(output)));
        }
        if id == "gemini-3.8-flash" {
            metadata["pricingLabel"] = json!("$0.75 / $3.5 /1M");
        }
    } else if provider == "antigravity-cli" {
        if Regex::new(r"^gemini-3\.(?:1-pro|[678]-flash)$").expect("static").is_match(&id) || Regex::new(r"^claude-(?:opus|sonnet)-5\.5$").expect("static").is_match(&id) {
            metadata["contextLength"] = json!(1_000_000_u64.max(if gemini_flash.is_match(&id) || id == "gemini-3.1-pro" { 1_048_576 } else { 0 }));
        }
        if id == "gpt-oss-120b" {
            metadata["contextLength"] = json!(131_072);
            metadata["pricingLabel"] = json!("Open weights");
        }
    }
    if id == "auto" || (id == "default" && name.eq_ignore_ascii_case("auto")) {
        metadata["contextLabel"] = json!("Model dependent");
        metadata["pricingLabel"] = json!("Routed model rate");
    }
    metadata
}

/// Rejects a model the provider's current catalog does not list. A catalog that cannot be read is
/// not a rejection, and a model the user configured as the provider's default always passes.
pub fn assert_model_available(host: &HostContext, provider: &str, model: &str) -> Result<()> {
    let settings = host.settings().read();
    let configured = if provider == "vercel-gateway" { Some(settings.ai.default_model.clone()) } else { settings.ai.providers.get(provider).and_then(|c| c.default_model.clone()) };
    drop(settings);
    if configured.as_deref().map(str::trim) == Some(model) {
        return Ok(());
    }
    let descriptor = built_in_descriptors().into_iter().find(|d| d.id == provider);
    let label = descriptor.as_ref().map_or_else(|| provider.to_owned(), |d| d.label.clone());
    let options = match &descriptor {
        Some(d) if d.kind == DescriptorKind::CliAgent => list_cli(host, provider),
        _ => list_api(host, provider, false),
    };
    if let Ok(options) = options
        && let Some(list) = options["options"].as_array().filter(|list| !list.is_empty())
        && !list.iter().any(|option| option["value"] == model)
    {
        return Err(failure(format!("{model} is not available for {label}.")));
    }
    Ok(())
}

pub fn dispatch(host: &HostContext, channel: &str, args: &[Value]) -> Option<Result<Value>> {
    Some(match channel {
        "ai:listCliModelOptions" => text(args, 0).and_then(|provider| list_cli(host, provider)),
        "ai:listApiModelOptions" => text(args, 0).and_then(|provider| list_api(host, provider, args.get(1).and_then(Value::as_bool) == Some(true))),
        _ => return None,
    })
}
