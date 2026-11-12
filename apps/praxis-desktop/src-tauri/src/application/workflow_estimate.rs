//! What a run could cost, at worst, before it starts (`workflowEstimate.ts` port).
//!
//! Loops and fan-out make a run's cost open-ended, so the start dialog shows the ceiling: every loop
//! spent, every stage using every attempt, every map at its item cap. Token and spend ranges need
//! measured stage sessions in the usage log; without enough of them the estimate says so instead of
//! showing a number nobody measured.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use praxis_workflows::types::WORKFLOW_MAX_LOOP_ITERATIONS;
use serde_json::{Map, Value, json};

/// Fewer measured stage sessions than this and a token range would be a guess.
pub const MIN_STAGE_SAMPLES: usize = 3;

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn is_loop(edge: &Value) -> bool {
    edge.get("loop").is_some_and(|l| !l.is_null())
}

/// A loop edge's budget: its own, or the run parameter bound to it, capped at the ceiling.
fn loop_budget(definition: &Value, parameters: &Value, edge: &Value) -> u64 {
    let own = edge["loop"]["maxIterations"].as_u64().unwrap_or(0);
    let bound = array(definition, "parameters")
        .iter()
        .find(|p| p["bindsLoopEdge"] == edge["id"])
        .and_then(|p| parameters.get(s(p, "id")))
        .and_then(Value::as_f64)
        .map(|v| v as u64);
    bound
        .unwrap_or(own)
        .min(u64::from(WORKFLOW_MAX_LOOP_ITERATIONS))
}

fn reach(outbound: &BTreeMap<&str, Vec<&str>>, from: &str) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut queue = VecDeque::from([from]);
    while let Some(id) = queue.pop_front() {
        if !seen.insert(id.to_string()) {
            continue;
        }
        if let Some(next) = outbound.get(id) {
            queue.extend(next.iter().copied());
        }
    }
    seen
}

fn attempts_of(node: &Value) -> u64 {
    if matches!(
        s(node, "type"),
        "agent-task" | "check" | "deployment" | "merge"
    ) {
        node["maxAttempts"].as_u64().unwrap_or(1).max(1)
    } else {
        1
    }
}

/// The worst-case shape of a run of `definition`.
#[must_use]
pub fn estimate_workflow_run(
    definition: &Value,
    parameters: &Value,
    threshold: u64,
    provider_for: &dyn Fn(&Value) -> Option<String>,
    tier_model: &dyn Fn(Option<&str>, Option<&str>) -> Option<String>,
) -> Value {
    let edges = array(definition, "edges");
    let nodes = array(definition, "nodes");
    let loops: Vec<&Value> = edges.iter().filter(|e| is_loop(e)).collect();
    let budgets: BTreeMap<&str, u64> = loops
        .iter()
        .map(|e| (s(e, "id"), loop_budget(definition, parameters, e)))
        .collect();
    let mut outbound: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for edge in edges.iter().filter(|e| !is_loop(e)) {
        outbound
            .entry(s(edge, "from"))
            .or_default()
            .push(s(edge, "to"));
    }
    let bodies: Vec<(&str, BTreeSet<String>)> = loops
        .iter()
        .map(|edge| {
            let from_target = reach(&outbound, s(edge, "to"));
            let body = from_target
                .into_iter()
                .filter(|id| {
                    id == s(edge, "from") || reach(&outbound, id).contains(s(edge, "from"))
                })
                .collect();
            (s(edge, "id"), body)
        })
        .collect();
    let mut recovery: BTreeMap<String, u64> = BTreeMap::new();
    for node in nodes {
        if s(node, "type") == "check" {
            if let Some(r) = node.get("failureRecovery").filter(|r| !r.is_null()) {
                let attempts = r["maxAttempts"].as_u64().unwrap_or(0);
                recovery.insert(s(r, "repairNodeId").to_string(), attempts);
                *recovery.entry(s(node, "id").to_string()).or_insert(0) += attempts;
            }
        }
    }

    let mut stages = Vec::new();
    for node in nodes {
        let kind = s(node, "type");
        if node["enabled"] == json!(false)
            || !matches!(
                kind,
                "agent-task" | "check" | "map" | "deployment" | "merge"
            )
        {
            continue;
        }
        let id = s(node, "id");
        let passes: u64 = bodies
            .iter()
            .filter(|(_, body)| body.contains(id))
            .map(|(edge_id, _)| budgets.get(edge_id).copied().unwrap_or(0) + 1)
            .product();
        let items = if kind == "map" {
            node["maxItems"].as_u64().unwrap_or(1)
        } else {
            1
        };
        let is_repair = nodes.iter().any(|c| {
            s(c, "type") == "check" && c["failureRecovery"]["repairNodeId"].as_str() == Some(id)
        });
        let first_pass = if is_repair { 0 } else { items };
        let worst_case = passes
            * items
            * if is_repair {
                recovery.get(id).copied().unwrap_or(1)
            } else {
                attempts_of(node) + recovery.get(id).copied().unwrap_or(0)
            };
        let is_agent = matches!(kind, "agent-task" | "map");
        let provider = if is_agent { provider_for(node) } else { None };
        let tier = if is_agent {
            node.get("modelTier").and_then(Value::as_str)
        } else {
            None
        };
        let model = if is_agent {
            node.get("model")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .map(str::to_string)
                .or_else(|| tier_model(provider.as_deref(), tier))
        } else {
            None
        };
        let mut stage = Map::new();
        stage.insert("nodeId".into(), json!(id));
        stage.insert("name".into(), json!(s(node, "name")));
        stage.insert("type".into(), json!(kind));
        stage.insert("firstPass".into(), json!(first_pass));
        stage.insert("worstCase".into(), json!(worst_case));
        stage.insert("isAgent".into(), json!(is_agent));
        if let Some(tier) = tier {
            stage.insert("tier".into(), json!(tier));
        }
        if let Some(model) = model {
            stage.insert("model".into(), json!(model));
        }
        if let Some(provider) = provider {
            stage.insert("provider".into(), json!(provider));
        }
        stages.push(Value::Object(stage));
    }

    let sum = |agent: bool, key: &str| -> u64 {
        stages
            .iter()
            .filter(|st| st["isAgent"] == json!(agent))
            .map(|st| st[key].as_u64().unwrap_or(0))
            .sum()
    };
    let (first_pass_agents, worst_agents, worst_checks) = (
        sum(true, "firstPass"),
        sum(true, "worstCase"),
        sum(false, "worstCase"),
    );
    json!({
        "stages": stages,
        "loops": loops.iter().map(|e| json!({
            "edgeId": s(e, "id"), "from": s(e, "from"), "to": s(e, "to"),
            "budget": budgets.get(s(e, "id")).copied().unwrap_or(0),
        })).collect::<Vec<_>>(),
        "firstPassAgentLaunches": first_pass_agents,
        "worstCaseAgentLaunches": worst_agents,
        "worstCaseCheckLaunches": worst_checks,
        "notEstimable": format!(
            "Not estimable: fewer than {MIN_STAGE_SAMPLES} workflow stage sessions have reported usage on this machine."
        ),
        "threshold": threshold,
        "needsConfirm": worst_agents > threshold,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_loop_multiplies_the_stages_in_its_body_and_a_retry_budget_multiplies_attempts() {
        let definition = json!({
            "nodes": [
                { "id": "a", "type": "agent-task", "name": "Implement", "maxAttempts": 2, "modelTier": "strong" },
                { "id": "b", "type": "agent-task", "name": "Review", "maxAttempts": 1 },
                { "id": "c", "type": "check", "name": "QA" },
            ],
            "edges": [
                { "id": "e1", "from": "a", "to": "b", "on": "success" },
                { "id": "e2", "from": "b", "to": "c", "on": "success" },
                { "id": "loop", "from": "b", "to": "a", "on": "findings", "loop": { "maxIterations": 3 } },
            ],
        });
        let none = |_: &Value| None;
        let no_tier = |_: Option<&str>, _: Option<&str>| None;
        let estimate = estimate_workflow_run(&definition, &json!({}), 40, &none, &no_tier);
        assert_eq!(estimate["firstPassAgentLaunches"], 2);
        // Implement: 4 passes x 2 attempts; Review: 4 passes x 1 attempt.
        assert_eq!(estimate["worstCaseAgentLaunches"], 12);
        assert_eq!(estimate["worstCaseCheckLaunches"], 1);
        assert_eq!(estimate["needsConfirm"], false);
    }

    #[test]
    fn a_parameter_bound_to_a_loop_sets_its_budget() {
        let definition = json!({
            "nodes": [
                { "id": "a", "type": "agent-task", "name": "Improve" },
                { "id": "b", "type": "check", "name": "Measure" },
            ],
            "edges": [
                { "id": "e1", "from": "a", "to": "b", "on": "success" },
                { "id": "loop", "from": "b", "to": "a", "on": "findings", "loop": { "maxIterations": 3 } },
            ],
            "parameters": [{ "id": "rounds", "kind": "integer", "bindsLoopEdge": "loop" }],
        });
        let none = |_: &Value| None;
        let no_tier = |_: Option<&str>, _: Option<&str>| None;
        let estimate =
            estimate_workflow_run(&definition, &json!({ "rounds": 7 }), 5, &none, &no_tier);
        assert_eq!(estimate["loops"][0]["budget"], 7);
        assert_eq!(estimate["worstCaseAgentLaunches"], 8);
        assert_eq!(estimate["needsConfirm"], true);
    }
}
