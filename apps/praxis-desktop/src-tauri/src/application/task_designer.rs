use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Value, json};

use praxis_host::HostContext;

use super::storage::{Catalog, parse, read, write_atomic};
use super::task_designer_plan as plan;
use super::task_designer_state::{fallback_project_key, normalize, validate_graph};
use super::{Result, boards, failure, text};

fn task_designer_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("task-designer.json")
}

fn primary_canvas_key(board_id: &str, connection_id: Option<&str>) -> String {
    let scope = connection_id.map(str::trim).filter(|id| !id.is_empty()).unwrap_or("default");
    format!("canvas.{scope}.{board_id}")
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

fn pick(values: &[&Value]) -> Option<String> {
    values.iter().find_map(|value| {
        let trimmed = value.as_str()?.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

/// `normalizeIssuePayload`.
fn issue_payload(issue: &Value, requested: &str) -> Option<Value> {
    let issue_key = pick(&[&issue["key"], &json!(requested)])?;
    let mut payload = json!({
        "issueKey": issue_key,
        "summary": pick(&[&issue["summary"]]).unwrap_or_else(|| issue_key.clone()),
        "issueType": pick(&[&issue["issueType"]]).unwrap_or_else(|| "Unknown".into()),
        "status": pick(&[&issue["status"]]).unwrap_or_else(|| "Unknown".into()),
        "projectKey": pick(&[&issue["projectKey"]]).unwrap_or_else(|| fallback_project_key(&issue_key)),
    });
    if let Some(assignee) = pick(&[&issue["assignee"]]) {
        payload["assignee"] = json!(assignee);
    }
    if let Some(priority) = pick(&[&issue["priority"]]) {
        payload["priority"] = json!(priority);
    }
    Some(payload)
}

fn resolve_issue(host: &HostContext, catalog: &mut Catalog, key: &str, connection_id: Option<&str>) -> Result<Value> {
    let fetch = |catalog: &mut Catalog, key: &str| {
        let mut args = vec![json!(key)];
        if let Some(id) = connection_id {
            args.push(json!(id));
        }
        boards::dispatch(host, catalog, "issue:get", &args)
    };
    let issue = fetch(catalog, key)?;
    let main = issue_payload(&issue, key).ok_or_else(|| failure(format!("Unable to resolve {key}.")))?;
    let main_key = main["issueKey"].as_str().unwrap_or("").to_owned();
    let mut related: Vec<(String, &'static str)> = Vec::new();
    let mut add = |related: &mut Vec<(String, &'static str)>, key: String, relation: &'static str| {
        if key.is_empty() || key == main_key {
            return;
        }
        match related.iter_mut().find(|(existing, _)| *existing == key) {
            Some(entry) => entry.1 = relation,
            None => related.push((key, relation)),
        }
    };
    for dependency in issue["dependsOn"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        add(&mut related, dependency.trim().to_owned(), "dependsOn");
    }
    for sub in issue["subTasks"].as_array().into_iter().flatten() {
        if let Some(sub_key) = sub["key"].as_str() {
            add(&mut related, sub_key.trim().to_owned(), "subTask");
        }
    }
    let mut related_issues = Vec::new();
    let mut relations = Vec::new();
    for (related_key, relation) in related {
        let Ok(found) = fetch(catalog, &related_key) else { continue };
        let Some(mut normalized) = issue_payload(&found, &related_key) else { continue };
        let normalized_key = normalized["issueKey"].as_str().unwrap_or("").to_owned();
        normalized["relation"] = json!(relation);
        related_issues.push(normalized);
        relations.push(if relation == "dependsOn" {
            json!({ "relation": relation, "sourceIssueKey": normalized_key, "targetIssueKey": main_key })
        } else {
            json!({ "relation": relation, "sourceIssueKey": main_key, "targetIssueKey": normalized_key })
        });
    }
    Ok(json!({ "mainIssue": main, "relatedIssues": related_issues, "relations": relations }))
}

fn generate_master_plan(host: &HostContext, state: &Value) -> Result<Value> {
    let normalized = normalize(Some(state)).state;
    let tickets: Vec<Value> = normalized["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|node| node["type"] == "ticket")
        .cloned()
        .collect();
    let ids: std::collections::HashSet<&str> = tickets.iter().filter_map(|n| n["id"].as_str()).collect();
    let connectors: Vec<Value> = normalized["connectors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| {
            c["sourceNodeId"].as_str().is_some_and(|id| ids.contains(id))
                && c["targetNodeId"].as_str().is_some_and(|id| ids.contains(id))
        })
        .cloned()
        .collect();
    if tickets.is_empty() {
        return Err(failure("Add at least one ticket node before generating a master plan."));
    }
    if let Some(message) = validate_graph(&connectors) {
        return Err(failure(format!("Cannot generate master plan: {message}")));
    }
    let working_directory = host.settings().read().ai.working_directory.trim().to_owned();
    if working_directory.is_empty() {
        return Err(failure("Set a working directory under Settings → AI before generating a master plan."));
    }
    let plans = Path::new(&working_directory).join(plan::MASTER_PLAN_DIRECTORY_NAME);
    let master = plans.join(plan::MASTER_PLAN_FILE_NAME);
    let generated = plans
        .join(plan::GENERATED_FEATURES_ROOT_SEGMENT)
        .join(plan::GENERATED_FEATURES_DIRECTORY_NAME);
    let artifacts = plan::artifacts(&tickets, &connectors);
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(&plans)?;
        std::fs::write(&master, &artifacts.master_plan_markdown)?;
        let _ = std::fs::remove_dir_all(&generated);
        std::fs::create_dir_all(&generated)?;
        for feature in &artifacts.features {
            let name = format!("feature-{}-{}", feature.reference, feature.slug);
            let directory = generated.join(&name);
            std::fs::create_dir_all(&directory)?;
            std::fs::write(directory.join(format!("{name}.md")), plan::feature_markdown(feature))?;
            for story in &feature.stories {
                std::fs::write(
                    directory.join(format!("story-{}-{}-{}.md", feature.reference, story.story_number, story.slug)),
                    plan::story_markdown(story),
                )?;
            }
        }
        Ok(())
    };
    write().map_err(|error| {
        failure(format!(
            "Unable to write {}\\{}: {error}",
            plan::MASTER_PLAN_DIRECTORY_NAME,
            plan::MASTER_PLAN_FILE_NAME
        ))
    })?;
    let fingerprint = {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(artifacts.master_plan_markdown.as_bytes());
        hash.iter().map(|byte| format!("{byte:02x}")).collect::<String>()
    };
    Ok(json!({
        "outputPath": master,
        "generatedFeaturesPath": generated,
        "generatedFeatureCount": artifacts.features.len(),
        "generatedStoryCount": artifacts.story_count,
        "fingerprint": fingerprint
    }))
}

fn flow_recommendation_error(host: &HostContext, nodes: Option<usize>) -> praxis_contracts::RustRpcError {
    let _ = host;
    let key_configured = ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "FROSTY_VERCEL_API_KEY"]
        .iter()
        .any(|name| std::env::var(name).is_ok_and(|value| !value.trim().is_empty()));
    if !key_configured {
        return failure("No Vercel AI Gateway API key configured. Add one under Settings → AI Provider.");
    }
    if nodes.is_some_and(|count| count < 2) {
        return failure("Add at least two ticket nodes before requesting an AI recommendation.");
    }
    failure("AI flow recommendation through the gateway is not implemented in the desktop backend yet.")
}

pub fn dispatch(
    host: &HostContext,
    catalog: &mut Catalog,
    user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "taskDesigner:getState" => {
            let key = primary_canvas_key(text(args, 0)?, args.get(1).and_then(Value::as_str));
            let mut canvases = read_all_canvases(user_data_dir)?;
            let recovered = normalize(canvases.get(&key));
            if recovered.repaired {
                canvases.insert(key, recovered.state.clone());
                save_all_canvases(user_data_dir, &canvases)?;
            }
            Ok(recovered.state)
        }
        "taskDesigner:setState" => {
            let key = primary_canvas_key(text(args, 0)?, args.get(1).and_then(Value::as_str));
            let incoming = args.get(2).ok_or_else(|| failure("Canvas state is required."))?;
            let mut canvases = read_all_canvases(user_data_dir)?;
            let recovered = normalize(Some(incoming));
            if recovered.repaired {
                canvases.insert(key, recovered.state.clone());
                save_all_canvases(user_data_dir, &canvases)?;
                return Ok(json!({
                    "ok": false,
                    "warning": recovered.warning.unwrap_or_else(|| "Recovered invalid canvas state while saving.".into()),
                    "state": recovered.state
                }));
            }
            let connectors: Vec<Value> = recovered.state["connectors"].as_array().cloned().unwrap_or_default();
            if let Some(message) = validate_graph(&connectors) {
                let persisted = normalize(canvases.get(&key)).state;
                return Ok(json!({ "ok": false, "warning": message, "state": persisted }));
            }
            canvases.insert(key, recovered.state.clone());
            save_all_canvases(user_data_dir, &canvases)?;
            Ok(json!({ "ok": true, "state": recovered.state }))
        }
        "taskDesigner:resolveIssue" => {
            let key = args.first().and_then(Value::as_str).map(str::trim).unwrap_or("");
            if key.is_empty() {
                return Err(failure("Dropped issue key is missing."));
            }
            resolve_issue(host, catalog, key, args.get(1).and_then(Value::as_str))
        }
        "taskDesigner:recommendFlow" => {
            let nodes = args.first().and_then(Value::as_array).map_or(0, Vec::len);
            Err(flow_recommendation_error(host, Some(nodes)))
        }
        "taskDesigner:recommendBoardFlow" => Err(flow_recommendation_error(host, None)),
        "taskDesigner:generateMasterPlan" => {
            let state = args.get(2).ok_or_else(|| failure("Canvas state is required."))?;
            generate_master_plan(host, state)
        }
        _ => Err(failure("Unknown task designer operation.")),
    }
}
