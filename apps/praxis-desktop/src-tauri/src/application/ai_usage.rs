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
            Ok(default_provider_snapshot(provider))
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
                vec!["openai".into(), "anthropic".into(), "google".into()]
            };
            let snapshots: Vec<Value> = providers
                .iter()
                .map(|p| default_provider_snapshot(p))
                .collect();
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
        "aiUsage:alibabaConsoleStatus" => Ok(json!({ "signedIn": false })),
        "aiUsage:alibabaConsoleSignIn" => Ok(json!({ "signedIn": false })),
        "aiUsage:alibabaConsoleSignOut" => Ok(json!({ "signedIn": false })),
        _ => Err(failure(format!("Unknown aiUsage channel: {channel}"))),
    }
}
