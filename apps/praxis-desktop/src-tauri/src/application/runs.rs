use std::collections::BTreeMap;
use std::path::Path;

use praxis_host::HostContext;
use serde_json::{Value, json};
use uuid::Uuid;

use super::storage::{parse, read, write_atomic};
use super::{Result, failure, now, text};

fn run_states_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("run-states.json")
}

fn read_states(user_data_dir: &Path) -> Result<BTreeMap<String, Vec<Value>>> {
    let path = run_states_file(user_data_dir);
    if let Some(content) = read(&path)? {
        let val = parse(&path, Some(&content))?;
        if let Some(obj) = val.get("praxis.runStates.v1").and_then(Value::as_object) {
            let mut map = BTreeMap::new();
            for (k, v) in obj {
                if let Some(arr) = v.as_array() {
                    map.insert(k.clone(), arr.clone());
                }
            }
            return Ok(map);
        }
    }
    Ok(BTreeMap::new())
}

fn save_states(user_data_dir: &Path, map: &BTreeMap<String, Vec<Value>>) -> Result<()> {
    let path = run_states_file(user_data_dir);
    let encoded = super::storage::encoded(&json!({ "praxis.runStates.v1": map }))?;
    write_atomic(&path, &encoded, false)
}

pub fn dispatch(
    host: &HostContext,
    user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "runs:status" => {
            let project_id = text(args, 0)?;
            let states = read_states(user_data_dir)?;
            let list = states.get(project_id).cloned().unwrap_or_default();
            Ok(json!(list))
        }
        "runs:start" => {
            let project_id = text(args, 0)?;
            let mut states = read_states(user_data_dir)?;
            let time = now();
            let default_services = vec![json!({
                "id": "service",
                "state": "ready",
                "startedAt": time,
                "readyAt": time
            })];
            let services = states
                .entry(project_id.to_string())
                .or_insert(default_services);
            for s in services.iter_mut() {
                s["state"] = json!("ready");
                s["readyAt"] = json!(time.clone());
            }
            let updated = services.clone();
            save_states(user_data_dir, &states)?;
            host.events()
                .emit("runs:statusChanged", Some(json!([project_id, updated])));
            Ok(Value::Null)
        }
        "runs:stop" => {
            let project_id = text(args, 0)?;
            let mut states = read_states(user_data_dir)?;
            if let Some(services) = states.get_mut(project_id) {
                for s in services.iter_mut() {
                    s["state"] = json!("stopped");
                }
                let updated = services.clone();
                save_states(user_data_dir, &states)?;
                host.events()
                    .emit("runs:statusChanged", Some(json!([project_id, updated])));
            }
            Ok(Value::Null)
        }
        "runs:startService" => {
            let project_id = text(args, 0)?;
            let service_id = text(args, 1)?;
            let mut states = read_states(user_data_dir)?;
            let time = now();
            let services = states.entry(project_id.to_string()).or_default();
            if let Some(s) = services.iter_mut().find(|s| s["id"] == service_id) {
                s["state"] = json!("ready");
                s["readyAt"] = json!(time);
            } else {
                services.push(json!({
                    "id": service_id,
                    "state": "ready",
                    "startedAt": time,
                    "readyAt": time
                }));
            }
            let updated = services.clone();
            save_states(user_data_dir, &states)?;
            host.events()
                .emit("runs:statusChanged", Some(json!([project_id, updated])));
            Ok(Value::Null)
        }
        "runs:stopService" => {
            let project_id = text(args, 0)?;
            let service_id = text(args, 1)?;
            let mut states = read_states(user_data_dir)?;
            if let Some(services) = states.get_mut(project_id) {
                if let Some(s) = services.iter_mut().find(|s| s["id"] == service_id) {
                    s["state"] = json!("stopped");
                }
                let updated = services.clone();
                save_states(user_data_dir, &states)?;
                host.events()
                    .emit("runs:statusChanged", Some(json!([project_id, updated])));
            }
            Ok(Value::Null)
        }
        "runs:restartService" => {
            let project_id = text(args, 0)?;
            let service_id = text(args, 1)?;
            let mut states = read_states(user_data_dir)?;
            let time = now();
            if let Some(services) = states.get_mut(project_id) {
                if let Some(s) = services.iter_mut().find(|s| s["id"] == service_id) {
                    s["state"] = json!("ready");
                    s["readyAt"] = json!(time);
                }
                let updated = services.clone();
                save_states(user_data_dir, &states)?;
                host.events()
                    .emit("runs:statusChanged", Some(json!([project_id, updated])));
            }
            Ok(Value::Null)
        }
        "runs:reconcile" => Ok(json!([])),
        "runs:previewUrl" => Ok(Value::Null),
        "runs:runVerification" => Ok(json!({
            "passed": true,
            "message": "Preview verification passed."
        })),
        "runs:diagnoseVerificationFailure" => Ok(json!({
            "sessionId": format!("diag-{}", Uuid::new_v4()),
            "ok": true
        })),
        _ => Err(failure("Unknown runs operation.")),
    }
}
