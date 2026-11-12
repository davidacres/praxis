use std::path::Path;

use praxis_host::HostContext;
use serde_json::{Value, json};

use super::ai_usage_stats as stats;
use super::{Result, failure, now, text};

const USAGE_SECRET_PREFIX: &str = "ai-usage:";

/// Mirrors the Electron `providerSnapshot` fallthrough: a provider with no account-usage adapter
/// reports `not-supported` with this reason. The CLI quota adapters (Codex, Claude Code) are not
/// ported, so they land here too, honestly, rather than inventing windows.
fn default_provider_snapshot(host: &HostContext, provider: &str) -> Value {
    if provider == "openai" {
        let has_key = std::env::var("OPENAI_ADMIN_KEY").is_ok_and(|v| !v.is_empty())
            || host.secrets().get(&format!("{USAGE_SECRET_PREFIX}openai")).is_some_and(|v| !v.is_empty());
        if !has_key {
            return json!({
                "provider": provider,
                "fetchedAt": now(),
                "windows": [],
                "unavailableReason": "Add an OpenAI Admin API key to view account usage.",
                "unavailableReasonCode": "not-configured"
            });
        }
    }
    json!({
        "provider": provider,
        "fetchedAt": now(),
        "windows": [],
        "unavailableReason": "This provider does not expose an account usage API to Praxis yet.",
        "unavailableReasonCode": "not-supported"
    })
}

/// The providers a dashboard reports on: every built-in the user has not turned off, plus enabled
/// custom endpoints, deduplicated (port of `enabledUsageProviders`).
fn enabled_usage_providers(host: &HostContext) -> Vec<String> {
    let ai = serde_json::to_value(host.settings().read().ai).unwrap_or(Value::Null);
    let providers = ai["providers"].as_object().cloned().unwrap_or_default();
    let is_enabled = |id: &str| providers.get(id).and_then(|p| p["enabled"].as_bool()) != Some(false);
    let mut out: Vec<String> = providers.keys().filter(|id| is_enabled(id)).cloned().collect();
    for endpoint in ai["customProviders"].as_array().into_iter().flatten() {
        if let Some(id) = endpoint["id"].as_str().filter(|id| is_enabled(id)) {
            out.push(id.to_owned());
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|id| seen.insert(id.clone()));
    out
}

/// One provider's account usage: a saved Alibaba Coding Plan endpoint reads its quota through the
/// console session; every other provider has no usage connection in this build.
fn snapshot_for(host: &HostContext, provider: &str) -> Value {
    match super::alibaba_usage::endpoint_base_url(host, provider) {
        Some(base_url) => super::alibaba_usage::usage_snapshot(host, provider, &base_url),
        None => default_provider_snapshot(host, provider),
    }
}

fn console_status(host: &HostContext, provider: &str) -> Value {
    json!({ "signedIn": super::alibaba_usage::endpoint_base_url(host, provider).is_some() && super::alibaba_usage::is_signed_in(host) })
}

fn require_coding_plan(host: &HostContext, provider: &str) -> Result<()> {
    super::alibaba_usage::endpoint_base_url(host, provider)
        .map(|_| ())
        .ok_or_else(|| failure("Console sign-in is only for an Alibaba Coding Plan endpoint."))
}

pub fn dispatch(
    host: &HostContext,
    user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "aiUsage:listEvents" => Ok(json!(stats::list_events(user_data_dir))),
        "aiUsage:dashboardSummary" => Ok(stats::dashboard_summary(&stats::list_events(user_data_dir), chrono::Utc::now())),
        "aiUsage:series" => {
            let granularity = stats::Granularity::parse(text(args, 0)?).ok_or_else(|| failure("Unknown usage granularity."))?;
            let periods = args.get(1).and_then(Value::as_u64).unwrap_or(1) as usize;
            let provider = args.get(2).and_then(Value::as_str).filter(|p| !p.is_empty());
            let model = args.get(3).and_then(Value::as_str).filter(|m| !m.is_empty());
            let events: Vec<Value> = stats::list_events(user_data_dir).into_iter().filter(|e| model.is_none_or(|m| e["model"].as_str() == Some(m))).collect();
            Ok(json!(stats::series(&events, granularity, periods, chrono::Utc::now(), provider)))
        }
        "aiUsage:compareLatestPeriod" => {
            let granularity = stats::Granularity::parse(text(args, 0)?).ok_or_else(|| failure("Unknown usage granularity."))?;
            Ok(stats::compare_latest_period(&stats::list_events(user_data_dir), granularity, chrono::Utc::now()))
        }
        "aiUsage:providerSnapshot" => {
            let provider = text(args, 0)?;
            Ok(snapshot_for(host, provider))
        }
        "aiUsage:providerHistory" => {
            let provider = text(args, 0)?;
            Ok(json!({
                "provider": provider,
                "fetchedAt": now(),
                "history": []
            }))
        }
        "aiUsage:providerSnapshots" => {
            let providers: Vec<String> = if let Some(arr) = args.first().and_then(Value::as_array) {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            } else {
                enabled_usage_providers(host)
            };
            let snapshots: Vec<Value> = providers.iter().map(|p| snapshot_for(host, p)).collect();
            Ok(json!({"snapshots": snapshots, "checkedAt": now()}))
        }
        "aiUsage:setProviderUsageKey" => {
            let provider = text(args, 0)?;
            let val = text(args, 1).unwrap_or("").trim();
            let key = format!("{USAGE_SECRET_PREFIX}{provider}");
            if val.is_empty() {
                host.secrets().delete(&key);
            } else {
                host.secrets().set(&key, val);
            }
            Ok(Value::Null)
        }
        "aiUsage:alibabaConsoleStatus" => Ok(console_status(host, text(args, 0)?)),
        // The sign-in window itself is the native shell's (it opens it on the console's own page and
        // hands the cookies it sees to `aiUsage:alibabaConsoleStoreSession`). With no window to open,
        // this reports where the session stands.
        "aiUsage:alibabaConsoleSignIn" => {
            let provider = text(args, 0)?;
            require_coding_plan(host, provider)?;
            Ok(console_status(host, provider))
        }
        "aiUsage:alibabaConsoleSignOut" => {
            super::alibaba_usage::sign_out(host);
            Ok(json!({ "signedIn": false }))
        }
        // Shell-only: where the sign-in window should go, and the cookies it ended up with.
        "aiUsage:alibabaConsoleTarget" => {
            let provider = text(args, 0)?;
            super::alibaba_usage::sign_in_target(host, provider).ok_or_else(|| failure("Console sign-in is only for an Alibaba Coding Plan endpoint."))
        }
        "aiUsage:alibabaConsoleStoreSession" => {
            let provider = text(args, 0)?;
            require_coding_plan(host, provider)?;
            super::alibaba_usage::store_session(host, args.get(1).and_then(Value::as_array).map_or(&[][..], Vec::as_slice));
            Ok(console_status(host, provider))
        }
        _ => Err(failure(format!("Unknown aiUsage channel: {channel}"))),
    }
}
