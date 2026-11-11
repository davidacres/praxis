use std::path::Path;

use praxis_host::HostContext;
use serde_json::{Value, json};

use super::storage::{parse, read, write_atomic};
use super::{Result, failure, text};

fn agent_runtime_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("agent-runtime-state.json")
}

fn read_runtime_state(user_data_dir: &Path) -> Result<Value> {
    let path = agent_runtime_file(user_data_dir);
    if let Some(content) = read(&path)? {
        let val = parse(&path, Some(&content))?;
        return Ok(val);
    }
    Ok(json!({
        "activeAgents": {},
        "approvedProjects": {},
        "customItems": []
    }))
}

fn save_runtime_state(user_data_dir: &Path, val: &Value) -> Result<()> {
    let path = agent_runtime_file(user_data_dir);
    let encoded = super::storage::encoded(val)?;
    write_atomic(&path, &encoded, false)
}

pub fn dispatch(
    _host: &HostContext,
    user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "agentRuntime:roots" => {
            let native_root = user_data_dir.join("agent-runtime").join("native");
            let user_root = user_data_dir.join("agent-runtime").join("user");
            // `native`/`user`/`projects` are the authoring roots; `agents`,
            // `profiles`, `runtimeHosts` and `skills` are the discovery-path
            // shape Settings renders (`{ global, project }` each).
            let global_agents = user_data_dir.join("agents");
            let global_skills = user_data_dir.join("skills");
            let discovery = |global: &Path, project: &str| {
                json!({ "global": global.to_string_lossy(), "project": project })
            };
            Ok(json!({
                "native": native_root.to_string_lossy(),
                "user": user_root.to_string_lossy(),
                "projects": [],
                "agents": discovery(&global_agents, ".praxis/agents"),
                "profiles": discovery(&global_agents, ".praxis/agents"),
                "runtimeHosts": discovery(&global_agents, ".praxis/agents"),
                "skills": discovery(&global_skills, ".praxis/skills")
            }))
        }
        "agentRuntime:list" | "agentRuntime:refresh" => {
            // The renderer consumes AgentRuntimeSnapshot, not an item array.
            // Persisted authoring records are not proof of a running agent host.
            Ok(json!({
                "agents": [], "runtimeHosts": [], "profiles": [], "skills": [],
                "capabilities": {}, "hosts": {}, "instructions": [],
                "refreshedAt": super::now()
            }))
        }
        "agentRuntime:start" => {
            let agent_id = text(args, 0)?;
            let mut state = read_runtime_state(user_data_dir)?;
            if state.get("activeAgents").is_none() {
                state["activeAgents"] = json!({});
            }
            state["activeAgents"][agent_id] = json!(true);
            save_runtime_state(user_data_dir, &state)?;
            Ok(json!({ "ok": true, "agentId": agent_id, "active": true }))
        }
        "agentRuntime:stop" => {
            let agent_id = text(args, 0)?;
            let mut state = read_runtime_state(user_data_dir)?;
            if state.get("activeAgents").is_none() {
                state["activeAgents"] = json!({});
            }
            state["activeAgents"][agent_id] = json!(false);
            save_runtime_state(user_data_dir, &state)?;
            Ok(json!({ "ok": true, "agentId": agent_id, "active": false }))
        }
        "agentRuntime:restart" => {
            let agent_id = text(args, 0)?;
            let mut state = read_runtime_state(user_data_dir)?;
            if state.get("activeAgents").is_none() {
                state["activeAgents"] = json!({});
            }
            state["activeAgents"][agent_id] = json!(true);
            save_runtime_state(user_data_dir, &state)?;
            Ok(json!({ "ok": true, "agentId": agent_id, "active": true }))
        }
        "agentRuntime:activateSkill" => {
            let agent_id = text(args, 0)?;
            let skill_name = text(args, 1)?;
            Ok(json!({
                "ok": true,
                "agentId": agent_id,
                "skillName": skill_name
            }))
        }
        "agentRuntime:createAgent" => {
            let input = args.first().cloned().unwrap_or_else(|| json!({}));
            let id = input.get("id").and_then(Value::as_str).unwrap_or("agent");
            let name = input.get("name").and_then(Value::as_str).unwrap_or(id);
            let item = json!({
                "id": id,
                "name": name,
                "description": input.get("description").and_then(Value::as_str).unwrap_or(""),
                "kind": "agent",
                "scope": "user",
                "active": true
            });
            let mut state = read_runtime_state(user_data_dir)?;
            if let Some(list) = state.get_mut("customItems").and_then(Value::as_array_mut) {
                list.push(item.clone());
            } else {
                state["customItems"] = json!([item.clone()]);
            }
            save_runtime_state(user_data_dir, &state)?;
            Ok(item)
        }
        "agentRuntime:createProfile" => {
            let input = args.first().cloned().unwrap_or_else(|| json!({}));
            let id = input.get("id").and_then(Value::as_str).unwrap_or("profile");
            let name = input.get("name").and_then(Value::as_str).unwrap_or(id);
            let item = json!({
                "id": id,
                "name": name,
                "description": input.get("description").and_then(Value::as_str).unwrap_or(""),
                "kind": "profile",
                "scope": "user",
                "active": true
            });
            let mut state = read_runtime_state(user_data_dir)?;
            if let Some(list) = state.get_mut("customItems").and_then(Value::as_array_mut) {
                list.push(item.clone());
            } else {
                state["customItems"] = json!([item.clone()]);
            }
            save_runtime_state(user_data_dir, &state)?;
            Ok(item)
        }
        "agentRuntime:createSkill" => {
            let input = args.first().cloned().unwrap_or_else(|| json!({}));
            let id = input.get("id").and_then(Value::as_str).unwrap_or("skill");
            let name = input.get("name").and_then(Value::as_str).unwrap_or(id);
            let item = json!({
                "id": id,
                "name": name,
                "description": input.get("description").and_then(Value::as_str).unwrap_or(""),
                "kind": "skill",
                "scope": "user",
                "active": true
            });
            let mut state = read_runtime_state(user_data_dir)?;
            if let Some(list) = state.get_mut("customItems").and_then(Value::as_array_mut) {
                list.push(item.clone());
            } else {
                state["customItems"] = json!([item.clone()]);
            }
            save_runtime_state(user_data_dir, &state)?;
            Ok(item)
        }
        "agentRuntime:previewImport" => {
            let kind = text(args, 0).unwrap_or("agent");
            let source_dir = text(args, 1).unwrap_or("");
            Ok(json!({
                "kind": kind,
                "sourceDir": source_dir,
                "valid": true,
                "conflicts": []
            }))
        }
        "agentRuntime:importItem" => {
            let kind = text(args, 0).unwrap_or("agent");
            let source_dir = text(args, 1).unwrap_or("");
            Ok(json!({
                "ok": true,
                "kind": kind,
                "sourceDir": source_dir
            }))
        }
        "agentRuntime:approveNativeProject" => {
            let project_root = text(args, 0)?;
            let approved = args.get(1).and_then(Value::as_bool).unwrap_or(true);
            let mut state = read_runtime_state(user_data_dir)?;
            if state.get("approvedProjects").is_none() {
                state["approvedProjects"] = json!({});
            }
            state["approvedProjects"][project_root] = json!(approved);
            save_runtime_state(user_data_dir, &state)?;
            Ok(json!({ "ok": true, "approved": approved }))
        }
        "agentRuntime:revealNative" | "agentRuntime:copyNative" => Ok(json!({ "ok": true })),
        _ => Err(failure(format!("Unknown agentRuntime channel: {channel}"))),
    }
}
