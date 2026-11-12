//! Workflow definition validation (`workflowValidation.ts` port).
//!
//! Works over the stored JSON rather than the typed definition, because the designer
//! validates drafts that may not deserialize yet and reports every problem by path.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde_json::{Value, json};

use crate::types::WORKFLOW_MAX_LOOP_ITERATIONS;

/// Bounds on a map node's fan-out; a fan-out is cost, so it is never unbounded.
pub const MAP_MAX_CONCURRENCY: i64 = 8;
pub const MAP_MAX_ITEMS: i64 = 50;

const NODE_TYPES: [&str; 7] = [
    "agent-task",
    "check",
    "deployment",
    "approval",
    "join",
    "merge",
    "map",
];
const EDGE_OUTCOMES: [&str; 4] = ["success", "failure", "always", "findings"];
const ARTIFACT_KINDS: [&str; 7] = [
    "plan",
    "diff",
    "report",
    "test-results",
    "log",
    "note",
    "findings",
];
const TOOL_MODES: [&str; 3] = ["read-only", "project-only", "full"];
const SCOPES: [&str; 2] = ["global", "project"];

/// One validation problem, addressed by field path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowIssue {
    pub path: String,
    pub message: String,
}

/// The outcome of validating one definition.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkflowValidationResult {
    pub errors: Vec<WorkflowIssue>,
    pub warnings: Vec<WorkflowIssue>,
}

impl WorkflowValidationResult {
    #[must_use]
    pub fn valid(&self) -> bool {
        self.errors.is_empty()
    }

    /// The `WorkflowValidationResult` JSON the renderer reads.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let issues = |list: &[WorkflowIssue]| -> Vec<Value> {
            list.iter()
                .map(|issue| json!({ "path": issue.path, "message": issue.message }))
                .collect()
        };
        json!({
            "valid": self.valid(),
            "errors": issues(&self.errors),
            "warnings": issues(&self.warnings),
        })
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

fn is_int(value: Option<&Value>) -> Option<i64> {
    let v = value?;
    if let Some(i) = v.as_i64() {
        return Some(i);
    }
    v.as_f64()
        .filter(|f| f.fract() == 0.0 && f.is_finite())
        .map(|f| f as i64)
}

fn issue(errors: &mut Vec<WorkflowIssue>, path: impl Into<String>, message: impl Into<String>) {
    errors.push(WorkflowIssue {
        path: path.into(),
        message: message.into(),
    });
}

fn is_loop_edge(edge: &Value) -> bool {
    edge.get("loop").is_some_and(|v| !v.is_null())
}

fn dag_edges(definition: &Value) -> Vec<&Value> {
    array(definition, "edges")
        .iter()
        .filter(|edge| !is_loop_edge(edge))
        .collect()
}

fn node_outputs(node: &Value) -> &[Value] {
    array(node, "outputs")
}

fn node_gate(node: &Value) -> Option<&str> {
    match str_of(node, "type") {
        "agent-task" | "check" | "deployment" | "map" => {
            node.get("satisfiesGate").and_then(Value::as_str)
        }
        _ => None,
    }
}

fn ancestors_of(definition: &Value, node_id: &str) -> BTreeSet<String> {
    let mut inbound: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for edge in dag_edges(definition) {
        inbound
            .entry(str_of(edge, "to"))
            .or_default()
            .push(str_of(edge, "from"));
    }
    let mut seen = BTreeSet::new();
    let mut queue: VecDeque<&str> = inbound
        .get(node_id)
        .map(|v| v.iter().copied().collect())
        .unwrap_or_default();
    while let Some(id) = queue.pop_front() {
        if !seen.insert(id.to_string()) {
            continue;
        }
        if let Some(parents) = inbound.get(id) {
            queue.extend(parents.iter().copied());
        }
    }
    seen
}

fn reachable_from(definition: &Value, entry: &str) -> BTreeSet<String> {
    let mut outbound: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for edge in dag_edges(definition) {
        outbound
            .entry(str_of(edge, "from"))
            .or_default()
            .push(str_of(edge, "to"));
    }
    let mut reachable = BTreeSet::new();
    let mut queue = VecDeque::from([entry]);
    while let Some(id) = queue.pop_front() {
        if !reachable.insert(id.to_string()) {
            continue;
        }
        if let Some(next) = outbound.get(id) {
            queue.extend(next.iter().copied());
        }
    }
    reachable
}

fn find_cycle(definition: &Value, ids: &[String]) -> Option<Vec<String>> {
    let known: BTreeSet<&str> = ids.iter().map(String::as_str).collect();
    let mut outbound: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for edge in dag_edges(definition) {
        let (from, to) = (str_of(edge, "from"), str_of(edge, "to"));
        if known.contains(from) && known.contains(to) {
            outbound.entry(from).or_default().push(to);
        }
    }
    fn walk<'a>(
        id: &'a str,
        outbound: &BTreeMap<&'a str, Vec<&'a str>>,
        visited: &mut BTreeSet<&'a str>,
        stack: &mut Vec<&'a str>,
    ) -> Option<Vec<String>> {
        visited.insert(id);
        stack.push(id);
        for next in outbound.get(id).into_iter().flatten().copied() {
            if let Some(pos) = stack.iter().position(|s| *s == next) {
                let mut cycle: Vec<String> =
                    stack[pos..].iter().map(|s| (*s).to_string()).collect();
                cycle.push(next.to_string());
                return Some(cycle);
            }
            if !visited.contains(next) {
                if let Some(found) = walk(next, outbound, visited, stack) {
                    return Some(found);
                }
            }
        }
        stack.pop();
        None
    }
    let mut visited = BTreeSet::new();
    for id in ids {
        if visited.contains(id.as_str()) {
            continue;
        }
        let mut stack = Vec::new();
        if let Some(found) = walk(id, &outbound, &mut visited, &mut stack) {
            return Some(found);
        }
    }
    None
}

/// Validates a workflow definition (and, when given, the policy profile it must satisfy).
#[must_use]
pub fn validate_workflow(definition: &Value, policy: Option<&Value>) -> WorkflowValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    validate_header(definition, &mut errors);
    let nodes_by_id = validate_nodes(definition, &mut errors);
    validate_edges(definition, &nodes_by_id, &mut errors);
    validate_entry_and_shape(definition, &nodes_by_id, &mut errors, &mut warnings);
    validate_artifacts(definition, &mut errors);
    validate_gates(definition, &mut errors);
    validate_parameters(definition, &mut errors);
    if let Some(policy) = policy {
        validate_policy(definition, policy, &mut errors);
    }
    WorkflowValidationResult { errors, warnings }
}

fn validate_header(definition: &Value, errors: &mut Vec<WorkflowIssue>) {
    if definition.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        issue(errors, "schemaVersion", "Expected schema 1.");
    }
    if text(definition, "id").is_none() {
        issue(errors, "id", "id is required.");
    }
    if text(definition, "name").is_none() {
        issue(errors, "name", "name is required.");
    }
    let scope = str_of(definition, "scope");
    if !SCOPES.contains(&scope) {
        issue(errors, "scope", "scope must be global or project.");
    }
    if definition
        .get("version")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        < 1.0
    {
        issue(errors, "version", "version must be 1 or greater.");
    }
    if scope == "project" && text(definition, "projectId").is_none() {
        issue(
            errors,
            "projectId",
            "A project-scoped workflow requires projectId.",
        );
    }
    if scope == "global" && text(definition, "projectId").is_some() {
        issue(
            errors,
            "projectId",
            "A global workflow must not carry projectId.",
        );
    }
}

fn attempts_and_timeout(node: &Value, at: &str, errors: &mut Vec<WorkflowIssue>) {
    if node
        .get("maxAttempts")
        .and_then(Value::as_f64)
        .is_some_and(|n| n < 1.0)
    {
        issue(
            errors,
            format!("{at}.maxAttempts"),
            "maxAttempts must be 1 or greater.",
        );
    }
    if node
        .get("timeoutMs")
        .and_then(Value::as_f64)
        .is_some_and(|n| n <= 0.0)
    {
        issue(
            errors,
            format!("{at}.timeoutMs"),
            "timeoutMs must be greater than zero.",
        );
    }
}

fn validate_nodes<'a>(
    definition: &'a Value,
    errors: &mut Vec<WorkflowIssue>,
) -> BTreeMap<String, &'a Value> {
    let mut by_id = BTreeMap::new();
    let nodes = array(definition, "nodes");
    if nodes.is_empty() {
        issue(errors, "nodes", "A workflow needs at least one node.");
    }
    for (index, node) in nodes.iter().enumerate() {
        let at = format!("nodes[{index}]");
        match text(node, "id") {
            None => issue(errors, format!("{at}.id"), "Node id is required."),
            Some(id) if by_id.contains_key(&id) => {
                issue(
                    errors,
                    format!("{at}.id"),
                    format!("Duplicate node id: {id}"),
                );
            }
            Some(id) => {
                by_id.insert(id, node);
            }
        }
        if text(node, "name").is_none() {
            issue(errors, format!("{at}.name"), "Node name is required.");
        }
        let kind = str_of(node, "type");
        if !NODE_TYPES.contains(&kind) {
            let shown = node.get("type").map_or_else(
                || "undefined".to_string(),
                |v| v.as_str().map_or_else(|| v.to_string(), str::to_string),
            );
            issue(
                errors,
                format!("{at}.type"),
                format!("Unsupported node type: {shown}"),
            );
            continue;
        }
        match kind {
            "agent-task" => validate_agent_task(node, &at, errors),
            "check" => validate_check(node, &at, errors),
            "deployment" => {
                if text(node, "deploymentProfileId").is_none() {
                    issue(
                        errors,
                        format!("{at}.deploymentProfileId"),
                        "A deployment stage must name a deployment profile id.",
                    );
                }
                attempts_and_timeout(node, &at, errors);
            }
            "merge" => validate_merge(node, &at, errors),
            "map" => validate_map(node, &at, errors),
            "approval" if text(node, "prompt").is_none() => {
                issue(
                    errors,
                    format!("{at}.prompt"),
                    "An approval node needs a prompt.",
                );
            }
            _ => {}
        }
        validate_node_outputs(node, &at, errors);
    }
    by_id
}

fn validate_merge(node: &Value, at: &str, errors: &mut Vec<WorkflowIssue>) {
    attempts_and_timeout(node, at, errors);
    for (index, declared) in array(node, "declaredPaths").iter().enumerate() {
        let declared = declared.as_str().unwrap_or("");
        let windows_abs = declared.len() >= 3
            && declared.as_bytes()[0].is_ascii_alphabetic()
            && declared.as_bytes()[1] == b':'
            && matches!(declared.as_bytes()[2], b'/' | b'\\');
        if declared.starts_with('/')
            || windows_abs
            || declared.split(['/', '\\']).any(|part| part == "..")
        {
            issue(
                errors,
                format!("{at}.declaredPaths[{index}]"),
                "A declared path is relative to the repository and stays inside it.",
            );
        }
    }
}

fn agent_field<'a>(node: &'a Value, key: &str) -> Option<&'a Value> {
    node.get("agent").and_then(|a| a.get(key))
}

fn validate_map(node: &Value, at: &str, errors: &mut Vec<WorkflowIssue>) {
    if agent_field(node, "agentId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        issue(
            errors,
            format!("{at}.agent.agentId"),
            "A map stage must name the agent each item runs.",
        );
    }
    if text(node, "instructions").is_none() {
        issue(
            errors,
            format!("{at}.instructions"),
            "A map stage needs instructions for each item.",
        );
    }
    match text(node, "over") {
        None => issue(
            errors,
            format!("{at}.over"),
            "A map stage must name the artifact it fans out over.",
        ),
        Some(over) => {
            if !array(node, "inputs")
                .iter()
                .any(|i| i.as_str() == Some(over.as_str()))
            {
                issue(
                    errors,
                    format!("{at}.over"),
                    format!(
                        "A map stage fans out over one of its inputs; add \"{over}\" to its inputs."
                    ),
                );
            }
        }
    }
    let mutates = node
        .get("mutatesWorktree")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !mutates && agent_field(node, "toolMode").and_then(Value::as_str) == Some("full") {
        issue(
            errors,
            format!("{at}.agent.toolMode"),
            "A non-mutating map stage cannot request full tool mode; use read-only or project-only.",
        );
    }
    match is_int(node.get("concurrency")) {
        Some(c) if (1..=MAP_MAX_CONCURRENCY).contains(&c) => {}
        _ => issue(
            errors,
            format!("{at}.concurrency"),
            format!("concurrency must be between 1 and {MAP_MAX_CONCURRENCY}."),
        ),
    }
    match is_int(node.get("maxItems")) {
        Some(c) if (1..=MAP_MAX_ITEMS).contains(&c) => {}
        _ => issue(
            errors,
            format!("{at}.maxItems"),
            format!("maxItems must be between 1 and {MAP_MAX_ITEMS}."),
        ),
    }
    if node
        .get("timeoutMs")
        .and_then(Value::as_f64)
        .is_some_and(|n| n <= 0.0)
    {
        issue(
            errors,
            format!("{at}.timeoutMs"),
            "timeoutMs must be greater than zero.",
        );
    }
}

fn validate_agent_task(node: &Value, at: &str, errors: &mut Vec<WorkflowIssue>) {
    if agent_field(node, "agentId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        issue(
            errors,
            format!("{at}.agent.agentId"),
            "An agent stage must name an Agent Hub agent id.",
        );
    }
    if !agent_field(node, "scope")
        .and_then(Value::as_str)
        .is_some_and(|s| SCOPES.contains(&s))
    {
        issue(
            errors,
            format!("{at}.agent.scope"),
            "Agent scope must be global or project.",
        );
    }
    if !agent_field(node, "toolMode")
        .and_then(Value::as_str)
        .is_some_and(|s| TOOL_MODES.contains(&s))
    {
        issue(
            errors,
            format!("{at}.agent.toolMode"),
            "toolMode must be read-only, project-only, or full.",
        );
    }
    if text(node, "instructions").is_none() {
        issue(
            errors,
            format!("{at}.instructions"),
            "An agent stage needs instructions.",
        );
    }
    let mutates = node
        .get("mutatesWorktree")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !mutates && agent_field(node, "toolMode").and_then(Value::as_str) == Some("full") {
        issue(
            errors,
            format!("{at}.agent.toolMode"),
            "A non-mutating stage cannot request full tool mode; use read-only or project-only.",
        );
    }
    if let Some(prints) = agent_field(node, "skillFingerprints").and_then(Value::as_object) {
        let requested: Vec<&str> = agent_field(node, "skillNames")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        for name in prints.keys() {
            if !requested.contains(&name.as_str()) {
                issue(
                    errors,
                    format!("{at}.agent.skillFingerprints.{name}"),
                    format!("Fingerprint pins skill \"{name}\", which the stage does not request."),
                );
            }
        }
    }
    attempts_and_timeout(node, at, errors);
}

fn validate_check(node: &Value, at: &str, errors: &mut Vec<WorkflowIssue>) {
    if text(node, "command").is_none() {
        issue(
            errors,
            format!("{at}.command"),
            "A check node needs a command.",
        );
    }
    if node
        .get("successExitCodes")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
    {
        issue(
            errors,
            format!("{at}.successExitCodes"),
            "successExitCodes cannot be empty; omit it to default to [0].",
        );
    }
    attempts_and_timeout(node, at, errors);
}

fn validate_node_outputs(node: &Value, at: &str, errors: &mut Vec<WorkflowIssue>) {
    let mut seen = BTreeSet::new();
    for (index, artifact) in node_outputs(node).iter().enumerate() {
        let path = format!("{at}.outputs[{index}]");
        match text(artifact, "id") {
            None => issue(errors, format!("{path}.id"), "Artifact id is required."),
            Some(id) if !seen.insert(id.clone()) => {
                issue(
                    errors,
                    format!("{path}.id"),
                    format!("Duplicate artifact id on node: {id}"),
                );
            }
            Some(_) => {}
        }
        let kind = str_of(artifact, "kind");
        if !ARTIFACT_KINDS.contains(&kind) {
            let shown = artifact.get("kind").map_or_else(
                || "undefined".to_string(),
                |v| v.as_str().map_or_else(|| v.to_string(), str::to_string),
            );
            issue(
                errors,
                format!("{path}.kind"),
                format!("Unsupported artifact kind: {shown}"),
            );
        }
        if artifact.get("publishTo").and_then(Value::as_str) == Some("board")
            && (kind != "plan" || str_of(node, "type") != "agent-task")
        {
            issue(
                errors,
                format!("{path}.publishTo"),
                "Only a plan output of an agent stage can be published to the board.",
            );
        }
    }
}

fn validate_predicate(predicate: &Value, at: &str, errors: &mut Vec<WorkflowIssue>) {
    if let Some(min) = predicate.get("minCount").filter(|v| !v.is_null()) {
        if is_int(Some(min)).is_none_or(|n| n < 1) {
            issue(
                errors,
                format!("{at}.minCount"),
                "minCount must be a whole number of 1 or more.",
            );
        }
    }
}

fn validate_edges(
    definition: &Value,
    nodes_by_id: &BTreeMap<String, &Value>,
    errors: &mut Vec<WorkflowIssue>,
) {
    let mut seen = BTreeSet::new();
    for (index, edge) in array(definition, "edges").iter().enumerate() {
        let at = format!("edges[{index}]");
        match text(edge, "id") {
            None => issue(errors, format!("{at}.id"), "Edge id is required."),
            Some(id) if !seen.insert(id.clone()) => {
                issue(
                    errors,
                    format!("{at}.id"),
                    format!("Duplicate edge id: {id}"),
                );
            }
            Some(_) => {}
        }
        let (from, to) = (str_of(edge, "from"), str_of(edge, "to"));
        if !nodes_by_id.contains_key(from) {
            issue(
                errors,
                format!("{at}.from"),
                format!(
                    "Edge references unknown node: {}",
                    if from.is_empty() { "(empty)" } else { from }
                ),
            );
        }
        if !nodes_by_id.contains_key(to) {
            issue(
                errors,
                format!("{at}.to"),
                format!(
                    "Edge references unknown node: {}",
                    if to.is_empty() { "(empty)" } else { to }
                ),
            );
        }
        if !from.is_empty() && from == to {
            issue(
                errors,
                format!("{at}.to"),
                "An edge cannot loop a node to itself.",
            );
        }
        let on = str_of(edge, "on");
        if !EDGE_OUTCOMES.contains(&on) {
            issue(
                errors,
                format!("{at}.on"),
                "Edge outcome must be success, failure, always, or findings.",
            );
        }
        if let Some(source) = nodes_by_id.get(from) {
            if on == "findings"
                && !node_outputs(source)
                    .iter()
                    .any(|o| str_of(o, "kind") == "findings")
            {
                let name = text(source, "name").unwrap_or_else(|| from.to_string());
                issue(
                    errors,
                    format!("{at}.on"),
                    format!(
                        "A findings edge routes on what \"{name}\" found, but that stage declares no findings output."
                    ),
                );
            }
        }
        if let Some(when) = edge.get("when").filter(|v| !v.is_null()) {
            validate_predicate(when, &format!("{at}.when"), errors);
            if let Some(param) = when
                .get("metric")
                .and_then(|m| m.get("valueFromParameter"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                let numeric = array(definition, "parameters")
                    .iter()
                    .find(|p| str_of(p, "id") == param)
                    .is_some_and(|p| str_of(p, "kind") != "text");
                if !numeric {
                    issue(
                        errors,
                        format!("{at}.when.metric.valueFromParameter"),
                        format!(
                            "valueFromParameter must name a numeric run parameter; \"{param}\" is not one."
                        ),
                    );
                }
            }
        }
        if let Some(lp) = edge.get("loop").filter(|v| !v.is_null()) {
            match is_int(lp.get("maxIterations")) {
                Some(n) if (1..=i64::from(WORKFLOW_MAX_LOOP_ITERATIONS)).contains(&n) => {}
                _ => issue(
                    errors,
                    format!("{at}.loop.maxIterations"),
                    format!(
                        "A loop edge needs a budget of 1 to {WORKFLOW_MAX_LOOP_ITERATIONS} iterations."
                    ),
                ),
            }
            if let Some(best) = lp.get("keepBest").filter(|v| !v.is_null()) {
                if text(best, "metric").is_none() {
                    issue(
                        errors,
                        format!("{at}.loop.keepBest.metric"),
                        "Keep-best needs the metric it compares.",
                    );
                }
                if best.get("patience").is_some_and(|p| !p.is_null())
                    && is_int(best.get("patience")).is_none_or(|n| n < 1)
                {
                    issue(
                        errors,
                        format!("{at}.loop.keepBest.patience"),
                        "Patience is a whole number of passes, 1 or more.",
                    );
                }
            }
            if nodes_by_id.contains_key(from)
                && nodes_by_id.contains_key(to)
                && from != to
                && !ancestors_of(definition, from).contains(to)
            {
                issue(
                    errors,
                    format!("{at}.loop"),
                    format!(
                        "A loop edge must point back to a stage upstream of \"{from}\"; \"{to}\" is not."
                    ),
                );
            }
        }
    }

    let dag = dag_edges(definition);
    for (index, node) in array(definition, "nodes").iter().enumerate() {
        let id = str_of(node, "id");
        let inbound: Vec<&&Value> = dag.iter().filter(|e| str_of(e, "to") == id).collect();
        if str_of(node, "type") == "join" {
            if inbound.len() < 2 {
                issue(
                    errors,
                    format!("nodes[{index}]"),
                    format!("Join \"{id}\" needs at least two inbound edges."),
                );
            }
            if str_of(node, "mode") == "all-required"
                && !inbound
                    .iter()
                    .any(|e| e.get("required").and_then(Value::as_bool) == Some(true))
            {
                issue(
                    errors,
                    format!("nodes[{index}].mode"),
                    format!(
                        "Join \"{id}\" is all-required but no inbound edge is required; it would never release."
                    ),
                );
            }
            continue;
        }
        let sources: BTreeSet<&str> = inbound.iter().map(|e| str_of(e, "from")).collect();
        if sources.len() > 1 {
            let listed: Vec<&str> = sources.iter().copied().collect();
            issue(
                errors,
                format!("nodes[{index}]"),
                format!(
                    "Node \"{id}\" has {} concurrent parents ({}); converge them through a join node.",
                    sources.len(),
                    listed.join(", ")
                ),
            );
        }
    }

    for (index, node) in array(definition, "nodes").iter().enumerate() {
        if str_of(node, "type") != "check" {
            continue;
        }
        let Some(recovery) = node.get("failureRecovery").filter(|v| !v.is_null()) else {
            continue;
        };
        let at = format!("nodes[{index}].failureRecovery");
        let Some(repair_id) = text(recovery, "repairNodeId") else {
            issue(
                errors,
                format!("{at}.repairNodeId"),
                "A recovery repairNodeId is required.",
            );
            continue;
        };
        if is_int(recovery.get("maxAttempts")).is_none_or(|n| n < 1) {
            issue(
                errors,
                format!("{at}.maxAttempts"),
                "Recovery maxAttempts must be a positive integer.",
            );
        }
        match nodes_by_id.get(&repair_id) {
            Some(repair) if str_of(repair, "type") == "agent-task" => {
                if repair.get("mutatesWorktree").and_then(Value::as_bool) != Some(true) {
                    issue(
                        errors,
                        format!("{at}.repairNodeId"),
                        "A recovery agent-task must mutate the worktree.",
                    );
                }
            }
            _ => issue(
                errors,
                format!("{at}.repairNodeId"),
                "A recovery target must be an agent-task node.",
            ),
        }
        let node_id = str_of(node, "id");
        if !array(definition, "edges").iter().any(|e| {
            str_of(e, "from") == node_id
                && str_of(e, "to") == repair_id
                && str_of(e, "on") == "failure"
        }) {
            issue(
                errors,
                "edges",
                format!(
                    "Recovery target \"{repair_id}\" must have a failure edge from \"{node_id}\"."
                ),
            );
        }
    }
}

fn validate_entry_and_shape(
    definition: &Value,
    nodes_by_id: &BTreeMap<String, &Value>,
    errors: &mut Vec<WorkflowIssue>,
    warnings: &mut Vec<WorkflowIssue>,
) {
    let Some(entry) = text(definition, "entryNodeId") else {
        issue(errors, "entryNodeId", "entryNodeId is required.");
        return;
    };
    if !nodes_by_id.contains_key(&entry) {
        issue(
            errors,
            "entryNodeId",
            format!("entryNodeId references unknown node: {entry}"),
        );
        return;
    }
    if dag_edges(definition)
        .iter()
        .any(|e| str_of(e, "to") == entry)
    {
        issue(
            errors,
            "entryNodeId",
            "The entry node cannot have inbound edges.",
        );
    }
    let ids: Vec<String> = nodes_by_id.keys().cloned().collect();
    if let Some(cycle) = find_cycle(definition, &ids) {
        issue(
            errors,
            "edges",
            format!(
                "Workflow contains a cycle: {}. To loop back on purpose, mark the edge that returns as a loop edge with an iteration budget.",
                cycle.join(" → ")
            ),
        );
        return;
    }

    let nodes = array(definition, "nodes");
    for (index, node) in nodes.iter().enumerate() {
        if str_of(node, "type") != "agent-task" {
            continue;
        }
        if let Some(refutes) = text(node, "refutes") {
            let at = format!("nodes[{index}].refutes");
            match nodes_by_id.get(&refutes) {
                None => issue(
                    errors,
                    &at,
                    format!("refutes names an unknown stage: {refutes}"),
                ),
                Some(target) => {
                    let tname = str_of(target, "name");
                    if !node_outputs(target)
                        .iter()
                        .any(|o| str_of(o, "kind") == "findings")
                    {
                        issue(
                            errors,
                            &at,
                            format!(
                                "\"{tname}\" declares no findings output, so there is nothing to refute."
                            ),
                        );
                    } else if !ancestors_of(definition, str_of(node, "id"))
                        .contains(str_of(target, "id"))
                    {
                        issue(
                            errors,
                            &at,
                            format!(
                                "\"{}\" can only refute a stage that runs before it; \"{tname}\" does not.",
                                str_of(node, "name")
                            ),
                        );
                    }
                }
            }
            if !node_outputs(node)
                .iter()
                .any(|o| str_of(o, "kind") == "findings")
            {
                issue(
                    errors,
                    &at,
                    "A skeptic delivers its verdicts as a findings output; declare one.",
                );
            }
            if node.get("mutatesWorktree").and_then(Value::as_bool) == Some(true) {
                issue(
                    errors,
                    format!("nodes[{index}].mutatesWorktree"),
                    "A skeptic only reads; it cannot mutate the worktree.",
                );
            }
        }
    }
    for (index, node) in nodes.iter().enumerate() {
        if str_of(node, "type") != "agent-task" {
            continue;
        }
        if let Some(independent) = text(node, "independentOf") {
            let at = format!("nodes[{index}].independentOf");
            match nodes_by_id.get(&independent) {
                None => issue(
                    errors,
                    &at,
                    format!("independentOf names an unknown stage: {independent}"),
                ),
                Some(target) => {
                    let ttype = str_of(target, "type");
                    if ttype != "agent-task" && ttype != "map" {
                        issue(
                            errors,
                            &at,
                            format!(
                                "independentOf must name an agent stage; \"{}\" is not one.",
                                str_of(target, "name")
                            ),
                        );
                    } else if !ancestors_of(definition, str_of(node, "id"))
                        .contains(str_of(target, "id"))
                    {
                        issue(
                            errors,
                            &at,
                            format!(
                                "\"{}\" can only be independent of a stage that runs before it; \"{}\" does not.",
                                str_of(node, "name"),
                                str_of(target, "name")
                            ),
                        );
                    }
                }
            }
        }
    }

    let reachable = reachable_from(definition, &entry);
    for id in nodes_by_id.keys() {
        if reachable.contains(id) {
            continue;
        }
        let index = nodes
            .iter()
            .position(|n| str_of(n, "id") == id)
            .unwrap_or(0);
        issue(
            errors,
            format!("nodes[{index}]"),
            format!("Node \"{id}\" is unreachable from the entry node."),
        );
    }
    for (id, node) in nodes_by_id {
        if str_of(node, "type") == "approval" || !reachable.contains(id) {
            continue;
        }
        if array(definition, "edges")
            .iter()
            .any(|e| str_of(e, "from") == id)
        {
            continue;
        }
        let index = nodes
            .iter()
            .position(|n| str_of(n, "id") == id)
            .unwrap_or(0);
        issue(
            warnings,
            format!("nodes[{index}]"),
            format!("Node \"{id}\" has no outbound edges; the run ends here."),
        );
    }
}

fn validate_artifacts(definition: &Value, errors: &mut Vec<WorkflowIssue>) {
    let nodes = array(definition, "nodes");
    let mut produced_by: BTreeMap<String, String> = BTreeMap::new();
    for (index, node) in nodes.iter().enumerate() {
        let node_id = str_of(node, "id").to_string();
        for artifact in node_outputs(node) {
            let Some(id) = text(artifact, "id") else {
                continue;
            };
            if let Some(owner) = produced_by.get(&id) {
                if *owner != node_id {
                    issue(
                        errors,
                        format!("nodes[{index}].outputs"),
                        format!("Artifact \"{id}\" is already produced by node \"{owner}\"."),
                    );
                    continue;
                }
            }
            produced_by.insert(id, node_id.clone());
        }
    }
    for (index, node) in nodes.iter().enumerate() {
        let inputs = array(node, "inputs");
        if inputs.is_empty() {
            continue;
        }
        let node_id = str_of(node, "id");
        let ancestors = ancestors_of(definition, node_id);
        for (input_index, input) in inputs.iter().enumerate() {
            let input = input.as_str().unwrap_or("");
            let path = format!("nodes[{index}].inputs[{input_index}]");
            let Some(owner) = produced_by.get(input) else {
                issue(
                    errors,
                    path,
                    format!("Input \"{input}\" is not produced by any node."),
                );
                continue;
            };
            if owner == node_id {
                issue(
                    errors,
                    path,
                    format!("Node \"{node_id}\" cannot consume its own output \"{input}\"."),
                );
                continue;
            }
            if !ancestors.contains(owner) {
                issue(
                    errors,
                    path,
                    format!(
                        "Input \"{input}\" comes from node \"{owner}\", which is not upstream of \"{node_id}\"."
                    ),
                );
            }
        }
    }
}

fn validate_gates(definition: &Value, errors: &mut Vec<WorkflowIssue>) {
    let nodes = array(definition, "nodes");
    for (index, node) in nodes.iter().enumerate() {
        if str_of(node, "type") != "approval" {
            continue;
        }
        let required = array(node, "requiredGates");
        if required.is_empty() {
            continue;
        }
        let ancestors = ancestors_of(definition, str_of(node, "id"));
        let satisfied: BTreeSet<&str> = nodes
            .iter()
            .filter(|n| ancestors.contains(str_of(n, "id")))
            .filter_map(|n| node_gate(n))
            .collect();
        for (gate_index, gate) in required.iter().enumerate() {
            let gate = gate.as_str().unwrap_or("");
            if !satisfied.contains(gate) {
                issue(
                    errors,
                    format!("nodes[{index}].requiredGates[{gate_index}]"),
                    format!("No upstream node satisfies the required \"{gate}\" gate."),
                );
            }
        }
        if let Some(thresholds) = node.get("gateThresholds").and_then(Value::as_object) {
            for gate in thresholds.keys() {
                for owner in nodes.iter().filter(|n| node_gate(n) == Some(gate.as_str())) {
                    if !node_outputs(owner)
                        .iter()
                        .any(|o| str_of(o, "kind") == "findings")
                    {
                        issue(
                            errors,
                            format!("nodes[{index}].gateThresholds.{gate}"),
                            format!(
                                "Gate \"{gate}\" has a threshold but its stage \"{}\" does not produce findings.",
                                str_of(owner, "name")
                            ),
                        );
                    }
                }
            }
        }
    }
}

fn valid_parameter_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && id.len() <= 40
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn validate_parameters(definition: &Value, errors: &mut Vec<WorkflowIssue>) {
    let mut seen = BTreeSet::new();
    for (index, parameter) in array(definition, "parameters").iter().enumerate() {
        let at = format!("parameters[{index}]");
        let id = str_of(parameter, "id");
        if !valid_parameter_id(id) {
            issue(
                errors,
                format!("{at}.id"),
                "A parameter id is a short name of letters, digits, - and _.",
            );
        } else if seen.contains(id) {
            issue(
                errors,
                format!("{at}.id"),
                format!("Duplicate parameter id: {id}"),
            );
        }
        seen.insert(id.to_string());
        if text(parameter, "label").is_none() {
            issue(errors, format!("{at}.label"), "A parameter needs a label.");
        }
        if let (Some(min), Some(max)) = (
            parameter.get("min").and_then(Value::as_f64),
            parameter.get("max").and_then(Value::as_f64),
        ) {
            if min > max {
                issue(
                    errors,
                    format!("{at}.min"),
                    "min cannot be greater than max.",
                );
            }
        }
        if let Some(bind) = parameter
            .get("bindsLoopEdge")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            let is_loop = array(definition, "edges")
                .iter()
                .any(|e| str_of(e, "id") == bind && is_loop_edge(e));
            if !is_loop {
                issue(
                    errors,
                    format!("{at}.bindsLoopEdge"),
                    format!("bindsLoopEdge must name a loop edge; \"{bind}\" is not one."),
                );
            }
            if str_of(parameter, "kind") != "integer" {
                issue(
                    errors,
                    format!("{at}.kind"),
                    "A parameter that sets a loop budget must be an integer.",
                );
            }
            if parameter
                .get("max")
                .and_then(Value::as_f64)
                .is_some_and(|m| m > f64::from(WORKFLOW_MAX_LOOP_ITERATIONS))
            {
                issue(
                    errors,
                    format!("{at}.max"),
                    format!("A loop budget cannot exceed {WORKFLOW_MAX_LOOP_ITERATIONS}."),
                );
            }
        }
    }
}

fn validate_policy(definition: &Value, policy: &Value, errors: &mut Vec<WorkflowIssue>) {
    let nodes = array(definition, "nodes");
    let name = str_of(policy, "name");
    let approvals: Vec<(usize, &Value)> = nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| str_of(n, "type") == "approval")
        .collect();
    if policy.get("requireHumanApproval").and_then(Value::as_bool) == Some(true)
        && approvals.is_empty()
    {
        issue(
            errors,
            "nodes",
            format!(
                "Policy \"{name}\" requires a human approval stage, but this workflow has none."
            ),
        );
    }
    let satisfied: BTreeSet<&str> = nodes.iter().filter_map(|n| node_gate(n)).collect();
    let required_gates: Vec<&str> = array(policy, "requiredGates")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    for (index, gate) in required_gates.iter().enumerate() {
        if !satisfied.contains(gate) {
            issue(
                errors,
                format!("policy.requiredGates[{index}]"),
                format!(
                    "Policy \"{name}\" requires a \"{gate}\" gate, which no node in this workflow satisfies."
                ),
            );
        }
    }
    if let Some(thresholds) = policy.get("gateThresholds").and_then(Value::as_object) {
        for gate in thresholds.keys() {
            if let Some(owner) = nodes.iter().find(|n| node_gate(n) == Some(gate.as_str())) {
                if !node_outputs(owner)
                    .iter()
                    .any(|o| str_of(o, "kind") == "findings")
                {
                    issue(
                        errors,
                        format!("policy.gateThresholds.{gate}"),
                        format!(
                            "Gate \"{gate}\" has a threshold but its stage \"{}\" does not produce findings.",
                            str_of(owner, "name")
                        ),
                    );
                }
            }
        }
    }
    let allow_bypass = policy
        .get("allowGateBypass")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    for (index, node) in &approvals {
        if !allow_bypass && node.get("allowBypass").and_then(Value::as_bool) == Some(true) {
            issue(
                errors,
                format!("nodes[{index}].allowBypass"),
                format!("Policy \"{name}\" forbids gate bypass."),
            );
        }
        for gate in &required_gates {
            if array(node, "requiredGates")
                .iter()
                .any(|g| g.as_str() == Some(gate))
            {
                continue;
            }
            issue(
                errors,
                format!("nodes[{index}].requiredGates"),
                format!("Policy \"{name}\" requires approval to wait on the \"{gate}\" gate."),
            );
        }
    }
    let cap = policy.get("maxAttemptsPerNode").and_then(Value::as_f64);
    for (index, node) in nodes.iter().enumerate() {
        if !matches!(
            str_of(node, "type"),
            "agent-task" | "check" | "deployment" | "merge"
        ) {
            continue;
        }
        if let (Some(attempts), Some(cap)) = (node.get("maxAttempts").and_then(Value::as_f64), cap)
        {
            if attempts > cap {
                issue(
                    errors,
                    format!("nodes[{index}].maxAttempts"),
                    format!("Policy \"{name}\" caps attempts at {cap}."),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Value {
        json!({
            "schemaVersion": 1, "id": "w", "name": "W", "scope": "project", "projectId": "p", "version": 1,
            "entryNodeId": "a",
            "nodes": [
                { "id": "a", "name": "A", "type": "check", "command": "true", "inputs": [], "outputs": [] },
                { "id": "b", "name": "B", "type": "check", "command": "true", "inputs": [], "outputs": [] }
            ],
            "edges": [{ "id": "e", "from": "a", "to": "b", "on": "success" }]
        })
    }

    #[test]
    fn a_connected_definition_is_valid_and_warns_about_its_terminal_stage() {
        let result = validate_workflow(&base(), None);
        assert!(result.valid(), "{:?}", result.errors);
        assert_eq!(result.warnings.len(), 1);
        assert_eq!(result.warnings[0].path, "nodes[1]");
    }

    #[test]
    fn unknown_edge_targets_unreachable_nodes_and_cycles_are_errors() {
        let mut def = base();
        def["edges"] = json!([
            { "id": "e1", "from": "a", "to": "b", "on": "success" },
            { "id": "e2", "from": "b", "to": "a", "on": "success" },
            { "id": "e3", "from": "b", "to": "zzz", "on": "success" }
        ]);
        let result = validate_workflow(&def, None);
        let messages: Vec<&str> = result.errors.iter().map(|e| e.message.as_str()).collect();
        assert!(messages.iter().any(|m| m.contains("unknown node: zzz")));
        assert!(
            messages
                .iter()
                .any(|m| m.contains("The entry node cannot have inbound edges."))
        );
    }

    #[test]
    fn a_missing_command_is_reported_by_path() {
        let mut def = base();
        def["nodes"][0]["command"] = json!("  ");
        let result = validate_workflow(&def, None);
        assert!(result.errors.iter().any(|e| e.path == "nodes[0].command"));
    }
}
