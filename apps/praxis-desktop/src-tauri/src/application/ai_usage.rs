use std::path::Path;

use praxis_host::HostContext;
use serde_json::{Value, json};

use super::ai_usage_stats as stats;
use super::{Result, failure, now, text};

const USAGE_SECRET_PREFIX: &str = "ai-usage:";

fn default_provider_snapshot(provider: &str) -> Value {
    json!({
        "provider": provider,
        "fetchedAt": now(),
        "windows": [],
        "unavailableReason": "Account usage is not connected in this Tauri build.",
        "unavailableReasonCode": "not-supported"
    })
}

/// One provider's account usage: a saved Alibaba Coding Plan endpoint reads its quota through the
/// console session; every other provider has no usage connection in this build.
fn snapshot_for(host: &HostContext, provider: &str) -> Value {
    match super::alibaba_usage::endpoint_base_url(host, provider) {
        Some(base_url) => super::alibaba_usage::usage_snapshot(host, provider, &base_url),
        None => default_provider_snapshot(provider),
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
                // Saved Coding Plan endpoints are the only custom endpoints with a usage connection.
                ["openai", "anthropic", "google"].map(String::from).into_iter().chain(super::alibaba_usage::endpoint_ids(host)).collect()
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
