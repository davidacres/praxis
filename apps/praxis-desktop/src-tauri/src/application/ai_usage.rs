use std::collections::HashMap;
use std::path::Path;

use praxis_ai::usage_stats::{AiUsageEvent, summarize_usage};
use praxis_host::HostContext;
use serde_json::{Value, json};

use super::storage::{parse, read};
use super::{Result, failure, now, text};

const USAGE_SECRET_PREFIX: &str = "ai-usage:";

fn usage_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("ai-usage.json")
}

fn read_usage_events(user_data_dir: &Path) -> Result<Vec<AiUsageEvent>> {
    let path = usage_file(user_data_dir);
    if let Some(content) = read(&path)? {
        let val = parse(&path, Some(&content))?;
        if let Some(events_val) = val.get("events") {
            let events: Vec<AiUsageEvent> =
                serde_json::from_value(events_val.clone()).map_err(failure)?;
            return Ok(events);
        }
    }
    Ok(Vec::new())
}

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
        "aiUsage:listEvents" => {
            let events = read_usage_events(user_data_dir)?;
            Ok(json!(events))
        }
        "aiUsage:dashboardSummary" => {
            let events = read_usage_events(user_data_dir)?;
            let total = summarize_usage(&events);
            let mut by_model: HashMap<String, Value> = HashMap::new();
            let mut by_provider: HashMap<String, Value> = HashMap::new();

            for ev in &events {
                let m_entry = by_model.entry(ev.model.clone()).or_insert_with(|| {
                    json!({
                        "requests": 0,
                        "inputTokens": 0,
                        "outputTokens": 0,
                        "totalTokens": 0,
                        "costUsd": 0.0
                    })
                });
                let req = m_entry["requests"].as_u64().unwrap_or(0) + 1;
                let inp = m_entry["inputTokens"].as_u64().unwrap_or(0) + ev.tokens.input;
                let out = m_entry["outputTokens"].as_u64().unwrap_or(0) + ev.tokens.output;
                let cost = m_entry["costUsd"].as_f64().unwrap_or(0.0) + ev.cost_usd.unwrap_or(0.0);
                *m_entry = json!({
                    "requests": req,
                    "inputTokens": inp,
                    "outputTokens": out,
                    "totalTokens": inp + out,
                    "costUsd": cost
                });

                let p_entry = by_provider.entry(ev.provider.clone()).or_insert_with(|| {
                    json!({
                        "requests": 0,
                        "inputTokens": 0,
                        "outputTokens": 0,
                        "totalTokens": 0,
                        "costUsd": 0.0
                    })
                });
                let p_req = p_entry["requests"].as_u64().unwrap_or(0) + 1;
                let p_inp = p_entry["inputTokens"].as_u64().unwrap_or(0) + ev.tokens.input;
                let p_out = p_entry["outputTokens"].as_u64().unwrap_or(0) + ev.tokens.output;
                let p_cost =
                    p_entry["costUsd"].as_f64().unwrap_or(0.0) + ev.cost_usd.unwrap_or(0.0);
                *p_entry = json!({
                    "requests": p_req,
                    "inputTokens": p_inp,
                    "outputTokens": p_out,
                    "totalTokens": p_inp + p_out,
                    "costUsd": p_cost
                });
            }

            let summary = json!({
                "requests": total.requests,
                "inputTokens": total.input_tokens,
                "outputTokens": total.output_tokens,
                "totalTokens": total.total_tokens(),
                "costUsd": total.cost_usd
            });

            Ok(json!({
                "today": summary,
                "thisWeek": summary,
                "thisMonth": summary,
                "byModel": by_model,
                "byProvider": by_provider
            }))
        }
        "aiUsage:series" => {
            let events = read_usage_events(user_data_dir)?;
            let total = summarize_usage(&events);
            let bucket = json!({
                "periodStart": now(),
                "requests": total.requests,
                "inputTokens": total.input_tokens,
                "outputTokens": total.output_tokens,
                "totalTokens": total.total_tokens(),
                "costUsd": total.cost_usd
            });
            Ok(json!([bucket]))
        }
        "aiUsage:compareLatestPeriod" => {
            let events = read_usage_events(user_data_dir)?;
            let total = summarize_usage(&events);
            let summary = json!({
                "requests": total.requests,
                "inputTokens": total.input_tokens,
                "outputTokens": total.output_tokens,
                "totalTokens": total.total_tokens(),
                "costUsd": total.cost_usd
            });
            Ok(json!({
                "current": summary,
                "previous": {
                    "requests": 0,
                    "inputTokens": 0,
                    "outputTokens": 0,
                    "totalTokens": 0,
                    "costUsd": 0.0
                },
                "deltaTokens": total.total_tokens(),
                "deltaCost": total.cost_usd
            }))
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
