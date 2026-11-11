//! Board preferences persistence under `<userData>/board-preferences.json`.
use std::path::Path;

use serde_json::{Value, json};

use super::{Result, failure, storage};

const PREFS_KEY: &str = "praxis.boardColumnPreferences";

pub fn dispatch(root: &Path, channel: &str, args: &[Value]) -> Result<Value> {
    let file_path = root.join("board-preferences.json");
    match channel {
        "boardPrefs:get" => {
            let board_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| failure("boardPrefs:get requires a boardId argument."))?;
            let raw = storage::read(&file_path)?;
            let doc = storage::parse(&file_path, raw.as_deref())?;
            let prefs = doc
                .get(PREFS_KEY)
                .and_then(|map| map.get(board_id))
                .cloned()
                .unwrap_or_else(|| {
                    json!({
                        "workflowStatuses": [],
                        "orderedStatuses": []
                    })
                });
            Ok(prefs)
        }
        "boardPrefs:set" => {
            let board_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| failure("boardPrefs:set requires a boardId argument."))?;
            let new_prefs = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let raw = storage::read(&file_path)?;
            let mut doc = storage::parse(&file_path, raw.as_deref())?;
            if !doc.get(PREFS_KEY).is_some_and(Value::is_object) {
                doc[PREFS_KEY] = json!({});
            }
            if let Some(map) = doc.get_mut(PREFS_KEY).and_then(Value::as_object_mut) {
                map.insert(board_id.to_string(), new_prefs);
            }
            let encoded = storage::encoded(&doc)?;
            storage::write_atomic(&file_path, &encoded, false)?;
            Ok(Value::Null)
        }
        _ => Err(failure(format!(
            "Unsupported boardPrefs channel: {channel}"
        ))),
    }
}
