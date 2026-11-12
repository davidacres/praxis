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
    let scope = connection_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or("default");
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

fn resolve_issue(
    host: &HostContext,
    catalog: &mut Catalog,
    key: &str,
    connection_id: Option<&str>,
) -> Result<Value> {
    let fetch = |catalog: &mut Catalog, key: &str| {
        let mut args = vec![json!(key)];
        if let Some(id) = connection_id {
            args.push(json!(id));
        }
        boards::dispatch(host, catalog, "issue:get", &args)
    };
    let issue = fetch(catalog, key)?;
    let main =
        issue_payload(&issue, key).ok_or_else(|| failure(format!("Unable to resolve {key}.")))?;
    let main_key = main["issueKey"].as_str().unwrap_or("").to_owned();
    let mut related: Vec<(String, &'static str)> = Vec::new();
    let mut add =
        |related: &mut Vec<(String, &'static str)>, key: String, relation: &'static str| {
            if key.is_empty() || key == main_key {
                return;
            }
            match related.iter_mut().find(|(existing, _)| *existing == key) {
                Some(entry) => entry.1 = relation,
                None => related.push((key, relation)),
            }
        };
    for dependency in issue["dependsOn"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
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
        let Ok(found) = fetch(catalog, &related_key) else {
            continue;
        };
        let Some(mut normalized) = issue_payload(&found, &related_key) else {
            continue;
        };
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
    let ids: std::collections::HashSet<&str> =
        tickets.iter().filter_map(|n| n["id"].as_str()).collect();
    let connectors: Vec<Value> = normalized["connectors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| {
            c["sourceNodeId"]
                .as_str()
                .is_some_and(|id| ids.contains(id))
                && c["targetNodeId"]
                    .as_str()
                    .is_some_and(|id| ids.contains(id))
        })
        .cloned()
        .collect();
    if tickets.is_empty() {
        return Err(failure(
            "Add at least one ticket node before generating a master plan.",
        ));
    }
    if let Some(message) = validate_graph(&connectors) {
        return Err(failure(format!("Cannot generate master plan: {message}")));
    }
    let working_directory = host
        .settings()
        .read()
        .ai
        .working_directory
        .trim()
        .to_owned();
    if working_directory.is_empty() {
        return Err(failure(
            "Set a working directory under Settings → AI before generating a master plan.",
        ));
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
            std::fs::write(
                directory.join(format!("{name}.md")),
                plan::feature_markdown(feature),
            )?;
            for story in &feature.stories {
                std::fs::write(
                    directory.join(format!(
                        "story-{}-{}-{}.md",
                        feature.reference, story.story_number, story.slug
                    )),
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
        hash.iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    Ok(json!({
        "outputPath": master,
        "generatedFeaturesPath": generated,
        "generatedFeatureCount": artifacts.features.len(),
        "generatedStoryCount": artifacts.story_count,
        "fingerprint": fingerprint
    }))
}

const RECOMMENDATION_SYSTEM_PROMPT: &str =
    "You are an execution-planning assistant for a task designer canvas.
Return exactly one JSON code block and nothing else.

Schema:
{
  \"orderedNodeIds\": [\"required ordered list of canvas node ids\"],
  \"connectors\": [
    {
      \"sourceNodeId\": \"canvas node id\",
      \"targetNodeId\": \"canvas node id\"
    }
  ],
  \"rationale\": \"optional short explanation\"
}

Rules:
- Include every known node id exactly once in orderedNodeIds.
- Keep connector directions forward according to orderedNodeIds.
- Do not create self-links.
- Prefer the minimum connectors needed for a clear start-to-finish flow.
- Never include markdown outside the single JSON code block.";

fn json_payload(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if let Some(start) = lower.find("```json") {
        let rest = &text[start + 7..];
        if let Some(end) = rest.find("```") {
            return Some(rest[..end].trim().to_owned());
        }
    }
    let trimmed = text.trim();
    trimmed.starts_with('{').then(|| trimmed.to_owned())
}

/// `parseTaskDesignerFlowRecommendation`: every canvas node exactly once, forward connectors only.
fn parse_recommendation(text: &str, nodes: &[Value]) -> Option<Value> {
    let parsed: Value = serde_json::from_str(&json_payload(text)?).ok()?;
    parsed.as_object()?;
    let ids: Vec<String> = nodes
        .iter()
        .filter_map(|n| n["id"].as_str().map(str::to_owned))
        .collect();
    let mut ordered: Vec<String> = Vec::new();
    for id in parsed["orderedNodeIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let id = id.trim();
        if !id.is_empty() && ids.iter().any(|n| n == id) && !ordered.iter().any(|n| n == id) {
            ordered.push(id.to_owned());
        }
    }
    for id in &ids {
        if !ordered.contains(id) {
            ordered.push(id.clone());
        }
    }
    if ordered.len() != nodes.len() {
        return None;
    }
    let index = |id: &str| ordered.iter().position(|n| n == id);
    let mut connectors: Vec<(String, String)> = Vec::new();
    for connector in parsed["connectors"].as_array().into_iter().flatten() {
        let source = connector["sourceNodeId"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_owned();
        let target = connector["targetNodeId"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_owned();
        if source.is_empty() || target.is_empty() || source == target {
            continue;
        }
        let (Some(from), Some(to)) = (index(&source), index(&target)) else {
            continue;
        };
        if from >= to || connectors.iter().any(|(s, t)| *s == source && *t == target) {
            continue;
        }
        connectors.push((source, target));
    }
    if connectors.is_empty() {
        for pair in ordered.windows(2) {
            connectors.push((pair[0].clone(), pair[1].clone()));
        }
    }
    let mut result = json!({
        "orderedNodeIds": ordered,
        "connectors": connectors.iter().map(|(s, t)| json!({ "sourceNodeId": s, "targetNodeId": t })).collect::<Vec<_>>()
    });
    if let Some(rationale) = parsed["rationale"]
        .as_str()
        .map(str::trim)
        .filter(|r| !r.is_empty())
    {
        result["rationale"] = json!(rationale);
    }
    Some(result)
}

fn gateway_key_configured(host: &HostContext) -> bool {
    super::ai_providers::api_connection(host, "vercel-gateway")
        .map(|(connection, _)| {
            connection
                .options
                .api_key
                .as_deref()
                .is_some_and(|k| !k.trim().is_empty())
        })
        .unwrap_or(false)
}

fn recommend_with_gateway(
    host: &HostContext,
    nodes: &[Value],
    connectors: &[Value],
) -> Result<Value> {
    let (connection, model) = super::ai_providers::api_connection(host, "vercel-gateway")?;
    if nodes.is_empty() {
        return Ok(json!({ "orderedNodeIds": [], "connectors": [] }));
    }
    let prompt = [
        "Recommend a start-to-finish execution flow for this existing task-designer canvas."
            .to_owned(),
        "Prioritize dependency-safe sequencing and practical implementation order.".to_owned(),
        String::new(),
        "Canvas nodes (JSON):".to_owned(),
        serde_json::to_string_pretty(nodes).unwrap_or_default(),
        String::new(),
        "Existing directed connectors (JSON):".to_owned(),
        serde_json::to_string_pretty(connectors).unwrap_or_default(),
    ]
    .join("\n");
    let (content, _) = super::runtime::block_on(super::api_host::run_provider_prompt(
        &connection,
        &model,
        RECOMMENDATION_SYSTEM_PROMPT,
        &prompt,
        None,
        |_| {},
    ))
    .map_err(failure)?;
    parse_recommendation(&content, nodes)
        .ok_or_else(|| failure("Gateway flow recommendation did not return a valid JSON result."))
}

fn recommend_flow(host: &HostContext, args: &[Value]) -> Result<Value> {
    if !gateway_key_configured(host) {
        return Err(failure(
            "No Vercel AI Gateway API key configured. Add one under Settings → AI Provider.",
        ));
    }
    let nodes = args
        .first()
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if nodes.len() < 2 {
        return Err(failure(
            "Add at least two ticket nodes before requesting an AI recommendation.",
        ));
    }
    let connectors = args
        .get(1)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    recommend_with_gateway(host, &nodes, &connectors)
}

fn recommend_board_flow(
    host: &HostContext,
    catalog: &mut Catalog,
    args: &[Value],
) -> Result<Value> {
    if !gateway_key_configured(host) {
        return Err(failure(
            "No Vercel AI Gateway API key configured. Add one under Settings → AI Provider.",
        ));
    }
    let board = args.first().cloned().unwrap_or(Value::Null);
    let name = board["name"].as_str().unwrap_or_default().to_owned();
    let details = boards::dispatch(host, catalog, "board:get", &[board.clone()])?;
    let issues = details["issues"].as_array().cloned().unwrap_or_default();
    if issues.is_empty() {
        return Err(failure(format!(
            "Board \"{name}\" has no tickets to recommend."
        )));
    }
    if issues.len() < 2 {
        return Err(failure(format!(
            "Board \"{name}\" needs at least two tickets for AI recommendation."
        )));
    }
    let nodes: Vec<Value> = issues
        .iter()
        .enumerate()
        .map(|(index, issue)| {
            let mut node = json!({
                "id": format!("board-{}-{index}", issue["key"].as_str().unwrap_or_default()),
                "issueKey": issue["key"], "summary": issue["summary"], "issueType": issue["issueType"],
                "status": issue["status"], "projectKey": issue["projectKey"]
            });
            for field in ["assignee", "priority"] {
                if !issue[field].is_null() {
                    node[field] = issue[field].clone();
                }
            }
            node
        })
        .collect();
    let recommendation = recommend_with_gateway(host, &nodes, &[])?;
    Ok(json!({ "boardName": name, "nodes": nodes, "recommendation": recommendation }))
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
            let incoming = args
                .get(2)
                .ok_or_else(|| failure("Canvas state is required."))?;
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
            let connectors: Vec<Value> = recovered.state["connectors"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if let Some(message) = validate_graph(&connectors) {
                let persisted = normalize(canvases.get(&key)).state;
                return Ok(json!({ "ok": false, "warning": message, "state": persisted }));
            }
            canvases.insert(key, recovered.state.clone());
            save_all_canvases(user_data_dir, &canvases)?;
            Ok(json!({ "ok": true, "state": recovered.state }))
        }
        "taskDesigner:resolveIssue" => {
            let key = args
                .first()
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if key.is_empty() {
                return Err(failure("Dropped issue key is missing."));
            }
            resolve_issue(host, catalog, key, args.get(1).and_then(Value::as_str))
        }
        "taskDesigner:recommendFlow" => recommend_flow(host, args),
        "taskDesigner:recommendBoardFlow" => recommend_board_flow(host, catalog, args),
        "taskDesigner:generateMasterPlan" => {
            let state = args
                .get(2)
                .ok_or_else(|| failure("Canvas state is required."))?;
            generate_master_plan(host, state)
        }
        _ => Err(failure("Unknown task designer operation.")),
    }
}
