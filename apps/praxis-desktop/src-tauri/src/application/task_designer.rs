use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Value, json};

use super::storage::{parse, read, write_atomic};
use super::{Result, failure, text};

fn task_designer_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("task-designer.json")
}

fn canvas_keys(board_id: &str, connection_id: Option<&str>) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(conn) = connection_id {
        keys.push(format!("canvas.{conn}.{board_id}"));
        keys.push(format!("{conn}::{board_id}"));
    }
    keys.push(format!("canvas.{board_id}"));
    keys.push(format!("default::{board_id}"));
    keys
}

fn primary_canvas_key(board_id: &str, connection_id: Option<&str>) -> String {
    format!("canvas.{}.{}", connection_id.unwrap_or("default"), board_id)
}

fn default_canvas_state() -> Value {
    json!({
        "nodes": [],
        "connectors": [],
        "viewport": { "x": 0.0, "y": 0.0, "zoom": 1.0 }
    })
}

fn read_all_canvases(user_data_dir: &Path) -> Result<BTreeMap<String, Value>> {
    let path = task_designer_file(user_data_dir);
    if let Some(content) = read(&path)? {
        let val = parse(&path, Some(&content))?;
        if let Some(obj) = val.as_object() {
            let mut map = BTreeMap::new();
            for (k, v) in obj {
                map.insert(k.clone(), v.clone());
            }
            return Ok(map);
        }
    }
    Ok(BTreeMap::new())
}

fn save_all_canvases(user_data_dir: &Path, map: &BTreeMap<String, Value>) -> Result<()> {
    let path = task_designer_file(user_data_dir);
    let encoded = super::storage::encoded(&json!(map))?;
    write_atomic(&path, &encoded, false)
}

pub fn dispatch(user_data_dir: &Path, channel: &str, args: &[Value]) -> Result<Value> {
    match channel {
        "taskDesigner:getState" => {
            let board_id = text(args, 0)?;
            let connection_id = args.get(1).and_then(Value::as_str);
            let candidates = canvas_keys(board_id, connection_id);
            let canvases = read_all_canvases(user_data_dir)?;
            for key in &candidates {
                if let Some(state) = canvases.get(key) {
                    return Ok(state.clone());
                }
            }
            Ok(default_canvas_state())
        }
        "taskDesigner:setState" => {
            let board_id = text(args, 0)?;
            let connection_id = args.get(1).and_then(Value::as_str);
            let state = args
                .get(2)
                .cloned()
                .ok_or_else(|| failure("Canvas state is required."))?;
            let key = primary_canvas_key(board_id, connection_id);
            let mut canvases = read_all_canvases(user_data_dir)?;
            canvases.insert(key, state.clone());
            save_all_canvases(user_data_dir, &canvases)?;
            Ok(json!({
                "ok": true,
                "state": state
            }))
        }
        "taskDesigner:resolveIssue" => {
            let issue_key = text(args, 0)?;
            let project_key = issue_key.split('-').next().unwrap_or("PROJ").to_uppercase();
            Ok(json!({
                "mainIssue": {
                    "issueKey": issue_key,
                    "summary": format!("Task {issue_key}"),
                    "issueType": "Task",
                    "status": "Todo",
                    "assignee": Value::Null,
                    "priority": Value::Null,
                    "projectKey": project_key
                },
                "relatedIssues": []
            }))
        }
        "taskDesigner:recommendFlow" => {
            let connectors = args.get(1).cloned().unwrap_or_else(|| json!([]));
            Ok(json!({
                "connectors": connectors,
                "confidence": 1.0
            }))
        }
        "taskDesigner:recommendBoardFlow" => {
            let board = args.first().cloned().unwrap_or_else(|| json!({}));
            let stages = board.get("stages").cloned().unwrap_or_else(|| json!([]));
            Ok(json!({
                "stages": stages,
                "connectors": []
            }))
        }
        "taskDesigner:generateMasterPlan" => Ok(json!({
            "masterPlanMarkdown": "# Generated Master Plan\n\nExecution flow generated from Task Designer DAG.\n",
            "features": [],
            "stories": []
        })),
        _ => Err(failure("Unknown task designer operation.")),
    }
}
