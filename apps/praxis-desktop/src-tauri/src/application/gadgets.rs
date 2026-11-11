use std::path::Path;

use praxis_ai::gadgets::block_parser::{ChatBlockParseOptions, parse_chat_blocks};
use praxis_ai::gadgets::contracts::GadgetScope;
use praxis_host::HostContext;
use serde_json::{Value, json};
use uuid::Uuid;

use super::storage::{parse, read, write_atomic};
use super::{Result, failure, now, text};

fn gadgets_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("gadgets.json")
}

fn read_gadgets_store(user_data_dir: &Path) -> Result<Value> {
    let path = gadgets_file(user_data_dir);
    if let Some(content) = read(&path)? {
        let val = parse(&path, Some(&content))?;
        return Ok(val);
    }
    Ok(json!({
        "sessions": {},
        "submissions": [],
        "revoked": {}
    }))
}

fn save_gadgets_store(user_data_dir: &Path, val: &Value) -> Result<()> {
    let path = gadgets_file(user_data_dir);
    let encoded = super::storage::encoded(val)?;
    write_atomic(&path, &encoded, false)
}

pub fn dispatch(
    host: &HostContext,
    user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "gadgets:getBlocks" => {
            let session_id = text(args, 0)?;
            let store = read_gadgets_store(user_data_dir)?;
            let blocks = store
                .get("praxis.gadgetBlocks")
                .or_else(|| store.get("sessions"))
                .and_then(|s| s.get(session_id))
                .cloned()
                .unwrap_or_else(|| json!([]));
            Ok(blocks)
        }
        "gadgets:publish" => {
            let session_id = text(args, 0)?;
            let raw_blocks = args.get(1).cloned().unwrap_or_else(|| json!([]));
            let mut store = read_gadgets_store(user_data_dir)?;
            let key = if store.get("praxis.gadgetBlocks").is_some() {
                "praxis.gadgetBlocks"
            } else {
                "sessions"
            };
            if store.get(key).is_none() {
                store[key] = json!({});
            }
            store[key][session_id] = raw_blocks.clone();
            save_gadgets_store(user_data_dir, &store)?;
            host.events()
                .emit("gadgets:changed", Some(json!(session_id)));
            Ok(raw_blocks)
        }
        "gadgets:publishFromText" => {
            let session_id = text(args, 0)?;
            let id_prefix = text(args, 1).unwrap_or("block");
            let text_content = text(args, 2).unwrap_or("");
            let options = ChatBlockParseOptions {
                scope: GadgetScope {
                    host_id: "praxis-desktop".into(),
                    session_id: session_id.to_string(),
                    project_id: None,
                    work_id: None,
                    revision: None,
                },
                issued_at: now(),
                id_prefix: id_prefix.to_string(),
            };
            let parsed = parse_chat_blocks(text_content, &options);
            let mut store = read_gadgets_store(user_data_dir)?;
            if store.get("sessions").is_none() {
                store["sessions"] = json!({});
            }
            let blocks_json = serde_json::to_value(&parsed.blocks).map_err(failure)?;
            store["sessions"][session_id] = blocks_json.clone();
            save_gadgets_store(user_data_dir, &store)?;
            host.events()
                .emit("gadgets:changed", Some(json!(session_id)));
            Ok(blocks_json)
        }
        "gadgets:submit" => {
            let request = args
                .first()
                .ok_or_else(|| failure("Gadget submission request is required."))?;
            let session_id = request
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let gadget_id = request
                .get("gadgetId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let action_id = request
                .get("actionId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let correlation_id = request
                .get("correlationId")
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let idempotency_key = request
                .get("idempotencyKey")
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let at = now();

            let mut store = read_gadgets_store(user_data_dir)?;
            let submission = json!({
                "version": 1,
                "gadgetId": gadget_id,
                "actionId": action_id,
                "correlationId": correlation_id,
                "idempotencyKey": idempotency_key,
                "status": "applied",
                "at": at,
                "outcome": { "acknowledged": true },
                "message": format!("Recorded: {action_id}")
            });
            if let Some(list) = store.get_mut("submissions").and_then(Value::as_array_mut) {
                list.push(submission.clone());
            } else {
                store["submissions"] = json!([submission.clone()]);
            }
            save_gadgets_store(user_data_dir, &store)?;
            if !session_id.is_empty() {
                host.events()
                    .emit("gadgets:changed", Some(json!(session_id)));
            }
            Ok(submission)
        }
        "gadgets:replay" => {
            let after_seq = args.first().and_then(Value::as_u64).unwrap_or(0) as usize;
            let store = read_gadgets_store(user_data_dir)?;
            let subs = store
                .get("submissions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let sliced = if after_seq < subs.len() {
                subs[after_seq..].to_vec()
            } else {
                vec![]
            };
            Ok(json!(sliced))
        }
        "gadgets:revoke" => {
            let session_id = text(args, 0)?;
            let gadget_id = text(args, 1)?;
            let mut store = read_gadgets_store(user_data_dir)?;
            let key = format!("{session_id}::{gadget_id}");
            if store.get("revoked").is_none() {
                store["revoked"] = json!({});
            }
            store["revoked"][key] = json!(true);
            save_gadgets_store(user_data_dir, &store)?;
            host.events()
                .emit("gadgets:changed", Some(json!(session_id)));
            Ok(Value::Null)
        }
        "gadgets:clear" => {
            let session_id = text(args, 0)?;
            let mut store = read_gadgets_store(user_data_dir)?;
            if let Some(sessions) = store.get_mut("sessions").and_then(Value::as_object_mut) {
                sessions.remove(session_id);
            }
            save_gadgets_store(user_data_dir, &store)?;
            host.events()
                .emit("gadgets:changed", Some(json!(session_id)));
            Ok(Value::Null)
        }
        _ => Err(failure(format!("Unknown gadgets channel: {channel}"))),
    }
}
