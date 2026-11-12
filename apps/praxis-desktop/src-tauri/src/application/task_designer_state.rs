//! Task Designer canvas state: normalisation, connector-graph validation and
//! topological ordering. Port of `packages/core/src/taskDesigner/taskDesignerState.ts`.
use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{Map, Value, json};

pub struct Recovery {
    pub state: Value,
    pub repaired: bool,
    pub warning: Option<String>,
}

pub fn empty_state() -> Value {
    json!({ "nodes": [], "connectors": [], "zoom": 1, "toolbarPosition": { "x": 16, "y": 16 } })
}

fn as_str(value: &Value) -> Option<&str> {
    value.as_str()
}

fn as_number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

fn pick_first_string(values: &[&Value]) -> Option<String> {
    values.iter().find_map(|value| {
        let trimmed = value.as_str()?.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

pub fn fallback_project_key(issue_key: &str) -> String {
    if let Some((head, tail)) = issue_key.rsplit_once('-')
        && !tail.is_empty()
        && tail.bytes().all(|b| b.is_ascii_digit())
        && head.len() >= 2
        && head.as_bytes()[0].is_ascii_alphabetic()
        && head.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return head.to_uppercase();
    }
    if let Some((head, _)) = issue_key.split_once('#') {
        let head = head.trim();
        if !head.is_empty() {
            return head.to_owned();
        }
    }
    "UNKNOWN".into()
}

fn number_json(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn set_optional(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), json!(value));
    }
}

fn ticket_node(value: &Value, index: usize) -> Option<Value> {
    let object = value.as_object()?;
    if matches!(
        object.get("type").and_then(Value::as_str),
        Some("note" | "website")
    ) {
        return None;
    }
    let get = |key: &str| object.get(key).unwrap_or(&Value::Null);
    let issue_key = pick_first_string(&[get("issueKey"), get("key")])?;
    let id =
        pick_first_string(&[get("id")]).unwrap_or_else(|| format!("ticket-{issue_key}-{index}"));
    let summary =
        pick_first_string(&[get("summary"), get("title")]).unwrap_or_else(|| issue_key.clone());
    let issue_type =
        pick_first_string(&[get("issueType"), get("type")]).unwrap_or_else(|| "Unknown".into());
    let status =
        pick_first_string(&[get("status"), get("state")]).unwrap_or_else(|| "Unknown".into());
    let project_key =
        pick_first_string(&[get("projectKey")]).unwrap_or_else(|| fallback_project_key(&issue_key));
    let column = (index % 4) as f64;
    let row = (index / 4) as f64;
    let mut node = Map::new();
    node.insert("type".into(), json!("ticket"));
    node.insert("id".into(), json!(id));
    node.insert("issueKey".into(), json!(issue_key));
    node.insert("summary".into(), json!(summary));
    node.insert("issueType".into(), json!(issue_type));
    node.insert("status".into(), json!(status));
    set_optional(&mut node, "assignee", pick_first_string(&[get("assignee")]));
    set_optional(&mut node, "priority", pick_first_string(&[get("priority")]));
    node.insert("projectKey".into(), json!(project_key));
    node.insert(
        "x".into(),
        number_json(as_number(get("x")).unwrap_or(24.0 + column * 280.0)),
    );
    node.insert(
        "y".into(),
        number_json(as_number(get("y")).unwrap_or(72.0 + row * 150.0)),
    );
    Some(Value::Object(node))
}

fn note_node(value: &Value, index: usize) -> Option<Value> {
    let object = value.as_object()?;
    if object.get("type").and_then(Value::as_str) != Some("note") {
        return None;
    }
    let get = |key: &str| object.get(key).unwrap_or(&Value::Null);
    let column = (index % 4) as f64;
    let row = (index / 4) as f64;
    Some(json!({
        "type": "note",
        "id": pick_first_string(&[get("id")]).unwrap_or_else(|| format!("note-{index}")),
        "title": pick_first_string(&[get("title")]).unwrap_or_else(|| "Notes".into()),
        "content": pick_first_string(&[get("content"), get("summary")]).unwrap_or_default(),
        "x": number_json(as_number(get("x")).unwrap_or(24.0 + column * 280.0)),
        "y": number_json(as_number(get("y")).unwrap_or(72.0 + row * 150.0)),
        "width": number_json(as_number(get("width")).unwrap_or(280.0)),
        "height": number_json(as_number(get("height")).unwrap_or(190.0)),
    }))
}

fn website_node(value: &Value, index: usize) -> Option<Value> {
    let object = value.as_object()?;
    if object.get("type").and_then(Value::as_str) != Some("website") {
        return None;
    }
    let get = |key: &str| object.get(key).unwrap_or(&Value::Null);
    let url = pick_first_string(&[get("url")])?;
    let column = (index % 4) as f64;
    let row = (index / 4) as f64;
    Some(json!({
        "type": "website",
        "id": pick_first_string(&[get("id")]).unwrap_or_else(|| format!("website-{index}")),
        "url": url,
        "x": number_json(as_number(get("x")).unwrap_or(24.0 + column * 300.0)),
        "y": number_json(as_number(get("y")).unwrap_or(72.0 + row * 210.0)),
        "width": number_json(as_number(get("width")).unwrap_or(360.0)),
        "height": number_json(as_number(get("height")).unwrap_or(260.0)),
    }))
}

fn connector(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let id = object.get("id").and_then(as_str)?;
    let source = object.get("sourceNodeId").and_then(as_str)?;
    let target = object.get("targetNodeId").and_then(as_str)?;
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("sourceNodeId".into(), json!(source));
    out.insert("targetNodeId".into(), json!(target));
    for key in ["sourceDirection", "targetDirection"] {
        if let Some(direction) = object
            .get(key)
            .and_then(as_str)
            .filter(|direction| matches!(*direction, "top" | "right" | "bottom" | "left"))
        {
            out.insert(key.into(), json!(direction));
        }
    }
    Some(Value::Object(out))
}

fn warning_part(count: usize, singular: &str, plural: &str) -> Option<String> {
    (count > 0).then(|| format!("{count} {}", if count == 1 { singular } else { plural }))
}

fn missing(value: &Value, keys: [&str; 2]) -> bool {
    keys.iter().any(|key| as_number(&value[*key]).is_none())
}

/// `normalizeTaskDesignerPersistedState`; `None` is the "never saved" case.
pub fn normalize(value: Option<&Value>) -> Recovery {
    let Some(value) = value else {
        return Recovery {
            state: empty_state(),
            repaired: false,
            warning: None,
        };
    };
    if !value.is_object() {
        return Recovery {
            state: empty_state(),
            repaired: true,
            warning: Some(
                "Recovered Task Designer state: persisted payload was invalid and was reset."
                    .into(),
            ),
        };
    }
    let mut nodes: Vec<Value> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();
    let (mut dropped_nodes, mut deduped, mut coords, mut note_dims, mut site_dims) =
        (0, 0, 0, 0, 0);
    let raw_nodes = value["nodes"].as_array().cloned().unwrap_or_default();
    for (index, candidate) in raw_nodes.iter().enumerate() {
        let Some(node) = website_node(candidate, index)
            .or_else(|| note_node(candidate, index))
            .or_else(|| ticket_node(candidate, index))
        else {
            dropped_nodes += 1;
            continue;
        };
        let id = node["id"].as_str().unwrap_or("").to_owned();
        if seen_ids.contains(&id) {
            deduped += 1;
            continue;
        }
        if candidate.is_object() && missing(candidate, ["x", "y"]) {
            coords += 1;
        }
        if node["type"] == "note"
            && candidate.is_object()
            && missing(candidate, ["width", "height"])
        {
            note_dims += 1;
        }
        if node["type"] == "website"
            && candidate.is_object()
            && missing(candidate, ["width", "height"])
        {
            site_dims += 1;
        }
        seen_ids.insert(id);
        nodes.push(node);
    }

    let zoom = as_number(&value["zoom"])
        .map(|zoom| ((zoom * 100.0).round() / 100.0).clamp(0.5, 2.0))
        .unwrap_or(1.0);
    let toolbar = value["toolbarPosition"]
        .as_object()
        .map(|_| &value["toolbarPosition"]);
    let toolbar_x = toolbar
        .and_then(|toolbar| as_number(&toolbar["x"]))
        .unwrap_or(16.0);
    let toolbar_y = toolbar
        .and_then(|toolbar| as_number(&toolbar["y"]))
        .unwrap_or(16.0);

    let mut connectors: Vec<Value> = Vec::new();
    let mut seen_connector_ids: HashSet<String> = HashSet::new();
    let mut seen_edges: HashSet<String> = HashSet::new();
    let (mut dropped, mut stale, mut self_loops, mut dup_ids, mut dup_edges) = (0, 0, 0, 0, 0);
    for candidate in value["connectors"].as_array().cloned().unwrap_or_default() {
        let Some(link) = connector(&candidate) else {
            dropped += 1;
            continue;
        };
        let source = link["sourceNodeId"].as_str().unwrap_or("").to_owned();
        let target = link["targetNodeId"].as_str().unwrap_or("").to_owned();
        let id = link["id"].as_str().unwrap_or("").to_owned();
        if source == target {
            self_loops += 1;
            continue;
        }
        if !seen_ids.contains(&source) || !seen_ids.contains(&target) {
            stale += 1;
            continue;
        }
        if seen_connector_ids.contains(&id) {
            dup_ids += 1;
            continue;
        }
        let edge = format!("{source}\u{0}{target}");
        if seen_edges.contains(&edge) {
            dup_edges += 1;
            continue;
        }
        seen_connector_ids.insert(id);
        seen_edges.insert(edge);
        connectors.push(link);
    }

    let parts: Vec<String> = [
        warning_part(dropped_nodes, "invalid node", "invalid nodes"),
        warning_part(deduped, "duplicate node id", "duplicate node ids"),
        warning_part(
            coords,
            "node with invalid coordinates",
            "nodes with invalid coordinates",
        ),
        warning_part(
            note_dims,
            "note with invalid dimensions",
            "notes with invalid dimensions",
        ),
        warning_part(
            site_dims,
            "website preview with invalid dimensions",
            "website previews with invalid dimensions",
        ),
        warning_part(dropped, "invalid connector", "invalid connectors"),
        warning_part(stale, "stale connector", "stale connectors"),
        warning_part(self_loops, "self-loop connector", "self-loop connectors"),
        warning_part(dup_ids, "duplicate connector id", "duplicate connector ids"),
        warning_part(dup_edges, "duplicate edge", "duplicate edges"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let repaired = !parts.is_empty();
    Recovery {
        state: json!({
            "nodes": nodes,
            "connectors": connectors,
            "zoom": number_json(zoom),
            "toolbarPosition": { "x": number_json(toolbar_x), "y": number_json(toolbar_y) }
        }),
        repaired,
        warning: repaired.then(|| {
            format!(
                "Recovered Task Designer state: removed {}.",
                parts.join(", ")
            )
        }),
    }
}

/// `validateTaskDesignerConnectorGraph`: the first problem, as its user-facing message.
pub fn validate_graph(connectors: &[Value]) -> Option<&'static str> {
    let mut seen = HashSet::new();
    let edges: Vec<(String, String)> = connectors
        .iter()
        .map(|link| {
            (
                link["sourceNodeId"].as_str().unwrap_or("").to_owned(),
                link["targetNodeId"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect();
    for edge in &edges {
        if !seen.insert(edge.clone()) {
            return Some("Duplicate directed links are not allowed.");
        }
    }
    let mut adjacency: Vec<(String, Vec<String>)> = Vec::new();
    for (source, target) in &edges {
        match adjacency.iter_mut().find(|(id, _)| id == source) {
            Some((_, neighbours)) => neighbours.push(target.clone()),
            None => adjacency.push((source.clone(), vec![target.clone()])),
        }
    }
    let lookup: HashMap<&str, &Vec<String>> =
        adjacency.iter().map(|(id, n)| (id.as_str(), n)).collect();
    fn visit<'a>(
        node: &'a str,
        lookup: &HashMap<&'a str, &'a Vec<String>>,
        visited: &mut HashSet<&'a str>,
        active: &mut HashSet<&'a str>,
    ) -> bool {
        visited.insert(node);
        active.insert(node);
        for next in lookup.get(node).map(|n| n.as_slice()).unwrap_or(&[]) {
            if !visited.contains(next.as_str()) {
                if visit(next, lookup, visited, active) {
                    return true;
                }
            } else if active.contains(next.as_str()) {
                return true;
            }
        }
        active.remove(node);
        false
    }
    let mut visited = HashSet::new();
    let mut active = HashSet::new();
    for (id, _) in &adjacency {
        if !visited.contains(id.as_str()) && visit(id, &lookup, &mut visited, &mut active) {
            return Some("Directed links cannot create cycles.");
        }
    }
    None
}

/// Kahn's algorithm; ties break by input order. `None` when there is a cycle.
pub fn topological_order(nodes: &[Value], connectors: &[Value]) -> Option<Vec<String>> {
    let ids: Vec<String> = nodes
        .iter()
        .map(|n| n["id"].as_str().unwrap_or("").to_owned())
        .collect();
    let order: HashMap<&str, usize> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let mut adjacency: HashMap<&str, Vec<&str>> =
        ids.iter().map(|id| (id.as_str(), Vec::new())).collect();
    let mut in_degree: HashMap<&str, usize> = ids.iter().map(|id| (id.as_str(), 0)).collect();
    for link in connectors {
        let (Some(source), Some(target)) =
            (link["sourceNodeId"].as_str(), link["targetNodeId"].as_str())
        else {
            continue;
        };
        if !adjacency.contains_key(source) || !in_degree.contains_key(target) {
            continue;
        }
        adjacency.get_mut(source).expect("source").push(target);
        *in_degree.get_mut(target).expect("target") += 1;
    }
    for neighbours in adjacency.values_mut() {
        neighbours.sort_by(|a, b| compare_ids(a, b, &order));
    }
    let mut queue: VecDeque<&str> = ids
        .iter()
        .map(String::as_str)
        .filter(|id| in_degree[id] == 0)
        .collect();
    let mut ordered = Vec::new();
    while let Some(node) = queue.pop_front() {
        ordered.push(node.to_owned());
        for next in adjacency[node].clone() {
            let degree = in_degree.get_mut(next).expect("degree");
            *degree -= 1;
            if *degree == 0 {
                queue.push_back(next);
            }
        }
    }
    (ordered.len() == ids.len()).then_some(ordered)
}

pub fn compare_ids(left: &str, right: &str, order: &HashMap<&str, usize>) -> std::cmp::Ordering {
    let l = order.get(left).copied().unwrap_or(usize::MAX);
    let r = order.get(right).copied().unwrap_or(usize::MAX);
    l.cmp(&r).then_with(|| left.cmp(right))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_invalid_payloads_recover() {
        assert!(!normalize(None).repaired);
        let invalid = normalize(Some(&json!("x")));
        assert!(invalid.repaired);
        assert_eq!(invalid.state["toolbarPosition"]["x"], 16);
    }

    #[test]
    fn nodes_and_connectors_are_repaired() {
        let state = json!({
            "nodes": [
                { "type": "note", "id": "note-0", "x": 1, "y": 2 },
                { "issueKey": "APP-1", "id": "t1" },
                { "issueKey": "APP-1", "id": "t1" },
                { "bogus": true }
            ],
            "connectors": [
                { "id": "c1", "sourceNodeId": "t1", "targetNodeId": "note-0" },
                { "id": "c2", "sourceNodeId": "t1", "targetNodeId": "gone" },
                { "id": "c3", "sourceNodeId": "t1", "targetNodeId": "t1" }
            ],
            "zoom": 9
        });
        let recovered = normalize(Some(&state));
        assert!(recovered.repaired);
        assert_eq!(recovered.state["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(recovered.state["nodes"][1]["projectKey"], "APP");
        assert_eq!(recovered.state["connectors"].as_array().unwrap().len(), 1);
        assert_eq!(recovered.state["zoom"], 2);
        assert_eq!(
            recovered.warning.as_deref(),
            Some(
                "Recovered Task Designer state: removed 1 invalid node, 1 duplicate node id, 1 node with invalid coordinates, 1 note with invalid dimensions, 1 stale connector, 1 self-loop connector."
            )
        );
    }

    #[test]
    fn graph_validation_and_ordering() {
        let link =
            |id: &str, a: &str, b: &str| json!({ "id": id, "sourceNodeId": a, "targetNodeId": b });
        assert!(
            validate_graph(&[link("1", "a", "b"), link("2", "b", "a")])
                .unwrap()
                .contains("cycles")
        );
        assert!(
            validate_graph(&[link("1", "a", "b"), link("2", "a", "b")])
                .unwrap()
                .contains("Duplicate")
        );
        assert!(validate_graph(&[link("1", "a", "b")]).is_none());
        let nodes = vec![json!({"id": "b"}), json!({"id": "a"}), json!({"id": "c"})];
        assert_eq!(
            topological_order(&nodes, &[link("1", "a", "b")]).unwrap(),
            vec!["a", "c", "b"]
        );
        assert!(topological_order(&nodes, &[link("1", "a", "b"), link("2", "b", "a")]).is_none());
    }
}
