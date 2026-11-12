//! Master-plan artifact builders for the Task Designer. Port of
//! `packages/core/src/taskDesigner/masterPlan.ts`.
use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

use super::task_designer_state::{compare_ids, topological_order};

pub const MASTER_PLAN_DIRECTORY_NAME: &str = "plans";
pub const MASTER_PLAN_FILE_NAME: &str = "master-plan.md";
pub const GENERATED_FEATURES_ROOT_SEGMENT: &str = "features";
pub const GENERATED_FEATURES_DIRECTORY_NAME: &str = "generated-from-designer";
const STORIES_PER_FEATURE: usize = 3;

const PRIORITY: &str = "P2";
const COMPLEXITY: &str = "Low";
const RISK: &str = "Low";
const CONFIDENCE: &str = "High";

#[derive(Clone)]
pub struct Story {
    node: Value,
    pub order: usize,
    pub feature_number: usize,
    pub story_number: usize,
    pub reference: String,
    pub slug: String,
    pub dependencies: Vec<String>,
}

pub struct Feature {
    pub reference: String,
    pub slug: String,
    pub title: String,
    pub stories: Vec<Story>,
    pub dependencies: Vec<String>,
}

pub struct Artifacts {
    pub master_plan_markdown: String,
    pub features: Vec<Feature>,
    pub story_count: usize,
}

fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn two_digits(value: usize) -> String {
    format!("{value:02}")
}

fn slug(value: &str, fallback: &str) -> String {
    let mut out = String::new();
    for c in value.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c.is_whitespace() || c == '_' {
            out.push(match c {
                '_' => '-',
                c if c.is_whitespace() => '-',
                c => c,
            });
        }
    }
    let mut collapsed = String::new();
    for c in out.chars() {
        if c == '-' && collapsed.ends_with('-') {
            continue;
        }
        collapsed.push(c);
    }
    let trimmed = collapsed.trim_matches('-');
    let cut: String = trimmed.chars().take(64).collect();
    let cut = cut.trim_end_matches('-');
    if cut.is_empty() { fallback.to_owned() } else { cut.to_owned() }
}

fn execution_priority(priority: Option<&str>) -> String {
    let normalized = single_line(priority.unwrap_or("")).to_uppercase();
    let bytes = normalized.as_bytes();
    if bytes.len() == 2 && bytes[0] == b'P' && (b'0'..=b'4').contains(&bytes[1]) {
        normalized
    } else {
        PRIORITY.into()
    }
}

fn text(node: &Value, key: &str) -> String {
    node[key].as_str().unwrap_or("").to_owned()
}

fn ordered_nodes(nodes: &[Value], connectors: &[Value]) -> Vec<Value> {
    let by_id: HashMap<String, &Value> = nodes.iter().map(|n| (text(n, "id"), n)).collect();
    let ids = topological_order(nodes, connectors)
        .unwrap_or_else(|| nodes.iter().map(|n| text(n, "id")).collect());
    ids.iter().filter_map(|id| by_id.get(id).map(|n| (*n).clone())).collect()
}

fn node_order(nodes: &[Value]) -> HashMap<String, usize> {
    nodes.iter().enumerate().map(|(i, n)| (text(n, "id"), i)).collect()
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

pub fn master_plan_markdown(nodes: &[Value], connectors: &[Value]) -> String {
    let ordered = ordered_nodes(nodes, connectors);
    let by_id: HashMap<String, &Value> = nodes.iter().map(|n| (text(n, "id"), n)).collect();
    let order = node_order(&ordered);
    let order_ref: HashMap<&str, usize> = order.iter().map(|(k, v)| (k.as_str(), *v)).collect();
    let mut rows: Vec<&Value> = connectors
        .iter()
        .filter(|c| {
            by_id.contains_key(&text(c, "sourceNodeId")) && by_id.contains_key(&text(c, "targetNodeId"))
        })
        .collect();
    rows.sort_by(|l, r| {
        compare_ids(l["sourceNodeId"].as_str().unwrap_or(""), r["sourceNodeId"].as_str().unwrap_or(""), &order_ref)
            .then_with(|| compare_ids(l["targetNodeId"].as_str().unwrap_or(""), r["targetNodeId"].as_str().unwrap_or(""), &order_ref))
            .then_with(|| text(l, "id").cmp(&text(r, "id")))
    });
    let deps = rows.len();
    let mut lines: Vec<String> = vec![
        "# Task Designer Master Plan".into(),
        String::new(),
        "**Status:** Proposed".into(),
        "**Type:** Master Plan".into(),
        format!("**Priority:** {PRIORITY}"),
        format!(
            "**Dependencies:** {}",
            if deps > 0 { format!("{deps} directed graph link{}", plural(deps)) } else { "None".into() }
        ),
        format!("**Complexity:** {COMPLEXITY}"),
        format!("**Risk:** {RISK}"),
        format!("**Confidence:** {CONFIDENCE}"),
        String::new(),
        "## Description".into(),
        format!(
            "Generated from the Task Designer graph with {} ticket node{} and {deps} dependency link{}.",
            ordered.len(),
            plural(ordered.len()),
            plural(deps)
        ),
        String::new(),
        "## Goals".into(),
        "1. Execute planned tickets in deterministic topological order.".into(),
        "2. Keep graph dependencies explicit and reviewable in markdown.".into(),
        "3. Persist a local master plan artifact under plans/.".into(),
        String::new(),
        "## Non-Goals".into(),
        "1. Does not execute or mutate tickets automatically.".into(),
        "2. Does not infer extra dependencies beyond directed links.".into(),
        "3. Does not modify manually-authored plan files outside generated artifacts.".into(),
        String::new(),
        "## Phase Overview".into(),
    ];
    if ordered.is_empty() {
        lines.push("1. No ticket nodes are currently defined.".into());
    } else {
        for (index, node) in ordered.iter().enumerate() {
            let summary = single_line(node["summary"].as_str().unwrap_or(""));
            lines.push(format!(
                "{}. **Phase {} — {}:** {}",
                index + 1,
                index + 1,
                text(node, "issueKey"),
                if summary.is_empty() { "(no summary)".into() } else { summary }
            ));
        }
    }
    lines.push(String::new());
    lines.push("## Dependencies".into());
    if rows.is_empty() {
        lines.push("1. No explicit directed dependencies are currently defined.".into());
    } else {
        for (index, link) in rows.iter().enumerate() {
            let (Some(source), Some(target)) =
                (by_id.get(&text(link, "sourceNodeId")), by_id.get(&text(link, "targetNodeId")))
            else {
                continue;
            };
            lines.push(format!("{}. {} → {}", index + 1, text(source, "issueKey"), text(target, "issueKey")));
        }
    }
    lines.extend([
        String::new(),
        "## Verification".into(),
        "1. Generate the master plan artifact from Task Designer and confirm the metadata block includes status, type, priority, dependencies, complexity, risk, and confidence.".into(),
        "2. Verify each dependency row maps to an explicit connector in the graph.".into(),
        "3. Re-generate without changing the graph and confirm the file content is unchanged.".into(),
        "4. Run `npm run check-types`.".into(),
    ]);
    format!("{}\n", lines.join("\n"))
}

pub fn feature_artifacts(nodes: &[Value], connectors: &[Value]) -> Vec<Feature> {
    let ordered = ordered_nodes(nodes, connectors);
    let by_id: HashMap<String, &Value> = nodes.iter().map(|n| (text(n, "id"), n)).collect();
    let order = node_order(&ordered);
    let order_ref: HashMap<&str, usize> = order.iter().map(|(k, v)| (k.as_str(), *v)).collect();
    let mut incoming: HashMap<String, Vec<String>> = HashMap::new();
    for link in connectors {
        let (source, target) = (text(link, "sourceNodeId"), text(link, "targetNodeId"));
        if by_id.contains_key(&source) && by_id.contains_key(&target) {
            incoming.entry(target).or_default().push(source);
        }
    }
    let stories: Vec<Story> = ordered
        .iter()
        .enumerate()
        .map(|(index, node)| {
            let feature_number = index / STORIES_PER_FEATURE + 1;
            let story_number = index % STORIES_PER_FEATURE + 1;
            let mut ids = incoming.get(&text(node, "id")).cloned().unwrap_or_default();
            ids.sort_by(|l, r| compare_ids(l, r, &order_ref));
            let dependencies = ids
                .iter()
                .map(|source| {
                    let source_order = order.get(source).copied().unwrap_or(0);
                    format!(
                        "{}.{}",
                        two_digits(source_order / STORIES_PER_FEATURE + 1),
                        source_order % STORIES_PER_FEATURE + 1
                    )
                })
                .collect();
            Story {
                node: node.clone(),
                order: index + 1,
                feature_number,
                story_number,
                reference: format!("{}.{story_number}", two_digits(feature_number)),
                slug: slug(
                    node["summary"].as_str().unwrap_or(""),
                    &format!("story-{}-{story_number}", two_digits(feature_number)),
                ),
                dependencies,
            }
        })
        .collect();
    let mut grouped: BTreeMap<usize, Vec<Story>> = BTreeMap::new();
    for story in stories {
        grouped.entry(story.feature_number).or_default().push(story);
    }
    grouped
        .into_iter()
        .map(|(number, stories)| {
            let mut dependencies: Vec<String> = Vec::new();
            for story in &stories {
                for dependency in &story.dependencies {
                    let feature_ref = dependency.split('.').next().unwrap_or("");
                    let entry = format!("Feature {feature_ref}");
                    if feature_ref != two_digits(number) && !dependencies.contains(&entry) {
                        dependencies.push(entry);
                    }
                }
            }
            dependencies.sort();
            let first = &stories[0];
            let summary = single_line(first.node["summary"].as_str().unwrap_or(""));
            let title = format!(
                "Execution Slice {} — {}",
                two_digits(number),
                if summary.is_empty() { text(&first.node, "issueKey") } else { summary }
            );
            Feature {
                reference: two_digits(number),
                slug: slug(&title, &format!("feature-{}", two_digits(number))),
                title,
                stories,
                dependencies,
            }
        })
        .collect()
}

pub fn feature_markdown(feature: &Feature) -> String {
    let rank = |p: &str| p[1..].parse::<usize>().unwrap_or(usize::MAX);
    let mut priorities: Vec<String> =
        feature.stories.iter().map(|s| execution_priority(s.node["priority"].as_str())).collect();
    priorities.sort_by_key(|p| rank(p));
    let priority = priorities.first().cloned().unwrap_or_else(|| PRIORITY.into());
    let mut lines: Vec<String> = vec![
        format!("# Feature {}: {}", feature.reference, feature.title),
        String::new(),
        "**Status:** Proposed".into(),
        "**Type:** Feature".into(),
        format!("**Priority:** {priority}"),
        format!(
            "**Dependencies:** {}",
            if feature.dependencies.is_empty() { "None".into() } else { feature.dependencies.join(", ") }
        ),
        format!("**Complexity:** {COMPLEXITY}"),
        format!("**Risk:** {RISK}"),
        format!("**Confidence:** {CONFIDENCE}"),
        String::new(),
        "## Description".into(),
        format!("Generated from Task Designer graph order for story slice group {}.", feature.reference),
        String::new(),
        "## Items".into(),
        String::new(),
        "| Ref | Type | Name | Ticket | Status |".into(),
        "| --- | --- | --- | --- | --- |".into(),
    ];
    for story in &feature.stories {
        let summary = single_line(story.node["summary"].as_str().unwrap_or(""));
        lines.push(format!(
            "| {} | Story | {} | {} | {} |",
            story.reference,
            if summary.is_empty() { "(no summary)".into() } else { summary },
            text(&story.node, "issueKey"),
            text(&story.node, "status")
        ));
    }
    lines.push(String::new());
    lines.push("## Dependencies".into());
    if feature.dependencies.is_empty() {
        lines.push("1. No cross-feature dependencies.".into());
    } else {
        for (index, dependency) in feature.dependencies.iter().enumerate() {
            lines.push(format!("{}. Depends on {dependency}.", index + 1));
        }
    }
    lines.extend([
        String::new(),
        "## Verification".into(),
        "1. Confirm the metadata block includes status, type, priority, dependencies, complexity, risk, and confidence.".into(),
        "2. Execute stories in listed order and verify cross-feature dependencies are satisfied first.".into(),
        "3. Run `npm run check-types`.".into(),
    ]);
    format!("{}\n", lines.join("\n"))
}

pub fn story_markdown(story: &Story) -> String {
    let key = text(&story.node, "issueKey");
    let summary = single_line(story.node["summary"].as_str().unwrap_or(""));
    let deps = if story.dependencies.is_empty() { "None".to_owned() } else { story.dependencies.join(", ") };
    let mut lines: Vec<String> = vec![
        format!("# Story {}: {}", story.reference, if summary.is_empty() { key.clone() } else { summary }),
        String::new(),
        "**Status:** Proposed".into(),
        "**Type:** Story".into(),
        format!("**Priority:** {}", execution_priority(story.node["priority"].as_str())),
        format!("**Dependencies:** {deps}"),
        format!("**Complexity:** {COMPLEXITY}"),
        format!("**Risk:** {RISK}"),
        format!("**Confidence:** {CONFIDENCE}"),
        format!("**Source Ticket:** {key}"),
        String::new(),
        "## Description".into(),
        format!("Implement execution phase {} from the Task Designer graph using ticket {key}.", story.order),
        String::new(),
        "## Implementation Activities".into(),
        format!("1. Deliver the scope represented by ticket {key}."),
        "2. Keep implementation aligned with upstream dependency ordering.".into(),
        "3. Ensure the slice remains independently reviewable.".into(),
        String::new(),
        "## Acceptance Criteria".into(),
        "1. The ticket scope is implemented as a functional, compilable slice.".into(),
        "2. Graph dependencies are respected by execution order.".into(),
        "3. `npm run check-types` passes.".into(),
        String::new(),
        "## References".into(),
        format!("1. Ticket: {key}"),
        format!("2. Graph order: {}", story.order),
    ];
    if !story.dependencies.is_empty() {
        lines.push(format!("3. Upstream story refs: {deps}"));
    }
    lines.extend([
        String::new(),
        "## Verification".into(),
        format!("1. Validate behavior for ticket {key} in isolation."),
        format!("2. Confirm prerequisite story refs are completed first: {deps}."),
        "3. Run `npm run check-types`.".into(),
    ]);
    format!("{}\n", lines.join("\n"))
}

pub fn artifacts(nodes: &[Value], connectors: &[Value]) -> Artifacts {
    let features = feature_artifacts(nodes, connectors);
    let story_count = features.iter().map(|f| f.stories.len()).sum();
    Artifacts { master_plan_markdown: master_plan_markdown(nodes, connectors), features, story_count }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn plan_orders_tickets_and_groups_three_stories_per_feature() {
        let ticket = |id: &str, key: &str, summary: &str| {
            json!({ "type": "ticket", "id": id, "issueKey": key, "summary": summary, "status": "To Do", "priority": "p1" })
        };
        let nodes = vec![ticket("b", "B-1", "Second"), ticket("a", "A-1", "First step"), ticket("c", "C-1", "Third"), ticket("d", "D-1", "Fourth")];
        let links = vec![json!({ "id": "l", "sourceNodeId": "a", "targetNodeId": "b" })];
        let plan = artifacts(&nodes, &links);
        assert!(plan.master_plan_markdown.contains("1. **Phase 1 — A-1:** First step"));
        assert!(plan.master_plan_markdown.contains("1. A-1 → B-1"));
        assert_eq!(plan.features.len(), 2);
        assert_eq!(plan.story_count, 4);
        assert_eq!(plan.features[0].stories[1].dependencies, Vec::<String>::new());
        assert_eq!(plan.features[1].stories[0].dependencies, vec!["01.1"]);
        assert_eq!(plan.features[1].dependencies, vec!["Feature 01"]);
        assert_eq!(plan.features[0].slug, "execution-slice-01-first-step");
        assert!(story_markdown(&plan.features[0].stories[0]).contains("**Priority:** P1"));
    }
}
