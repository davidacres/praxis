//! Scheduled-run request files: how an agent asks Praxis for a draft schedule without driving the
//! app (`scheduledRunRequest.ts` port).
//!
//! An agent writes `<workspace>/.praxis/scheduled-runs/<name>.json`. Praxis reads it, resolves each
//! listed ticket against the project's board, checks the order against the plan's dependencies, and
//! saves an unarmed draft. It then writes `<name>.status.json` beside the request so the agent can
//! confirm the result.
//!
//! Everything here is pure: parsing, ticket resolution, ordering and the status record. File
//! watching and saving live in the desktop main process. A request can only ever create or update a
//! *draft* — arming stays a person's decision.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use praxis_contracts::IssueSummary;

use crate::scheduled_run::{ScheduledTicketRef, ticket_ref_key};

/// The kind every request file declares.
pub const SCHEDULED_RUN_REQUEST_KIND: &str = "praxis.scheduledRunRequest";
/// The folder, inside the workspace, that holds request files.
pub const SCHEDULED_RUN_REQUEST_FOLDER: &str = ".praxis/scheduled-runs";
/// The suffix of the status file written beside a request.
pub const SCHEDULED_RUN_REQUEST_STATUS_SUFFIX: &str = ".status.json";

/// `as-listed` keeps the file's order and fails if it breaks a dependency; `dependencies` sorts it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduledRunRequestOrder {
    AsListed,
    Dependencies,
}

/// A request file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRunRequest {
    pub schema_version: u32,
    pub kind: String,
    pub name: String,
    /// Needed only when several projects share the workspace folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Defaults to the project's default schedule workflow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    /// Local wall-clock start in `timezone`: `YYYY-MM-DD` and `HH:mm`.
    pub date: String,
    pub time: String,
    pub timezone: String,
    pub order: ScheduledRunRequestOrder,
    /// Board keys or plan IDs (e.g. `TASK-476`), in the wanted run order.
    pub tickets: Vec<String>,
    /// Dependencies outside the queue that are known to be finished even though the board does not
    /// say so.
    pub satisfied_dependencies: Vec<String>,
    /// Tickets allowed at once (default 2 for parallel task authoring; 1 keeps sequential).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrency: Option<i64>,
}

/// One ticket of a resolved request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRunRequestEntry {
    pub sequence: u32,
    pub issue_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_id: Option<String>,
    pub title: String,
}

/// The status written beside a request file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRunRequestStatus {
    pub schema_version: u32,
    pub state: ScheduledRunRequestState,
    /// SHA-256 of the request file this status describes; a changed request is read again.
    pub request_hash: String,
    pub checked_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_start_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<ScheduledRunRequestEntry>>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// Whether a request was taken in or turned down.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledRunRequestState {
    Imported,
    Rejected,
}

/// Everything wrong with a request, listed at once so the agent can fix them in one go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledRunRequestError {
    pub problems: Vec<String>,
}

impl ScheduledRunRequestError {
    #[must_use]
    pub fn new(problems: Vec<String>) -> Self {
        Self { problems }
    }

    /// Every problem, as one readable sentence.
    #[must_use]
    pub fn message(&self) -> String {
        self.problems.join(" ")
    }
}

impl std::fmt::Display for ScheduledRunRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl std::error::Error for ScheduledRunRequestError {}

/// The SHA-256 of a request file's text.
#[must_use]
pub fn scheduled_run_request_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The draft a request owns: stable across edits of the same file, distinct per project.
#[must_use]
pub fn scheduled_run_request_run_id(project_id: &str, file_name: &str) -> String {
    let digest = Sha256::digest(format!("{project_id}\u{0}{file_name}").as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("run-request-{}", &hex[..20])
}

/// True for a request file name (not its status sidecar or a hidden/temp file).
#[must_use]
pub fn is_scheduled_run_request_file(file_name: &str) -> bool {
    file_name.ends_with(".json")
        && !file_name.ends_with(SCHEDULED_RUN_REQUEST_STATUS_SUFFIX)
        && !file_name.starts_with('.')
}

/// The status file that belongs to a request file.
#[must_use]
pub fn scheduled_run_request_status_file(file_name: &str) -> String {
    let stem = file_name.strip_suffix(".json").unwrap_or(file_name);
    format!("{stem}{SCHEDULED_RUN_REQUEST_STATUS_SUFFIX}")
}

fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn is_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 2 || byte.is_ascii_digit())
}

fn string_list(
    value: Option<&serde_json::Value>,
    field: &str,
    problems: &mut Vec<String>,
) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Some(items) = value.as_array() else {
        problems.push(format!("\"{field}\" must be a list of non-empty strings."));
        return Vec::new();
    };
    let mut list = Vec::new();
    for item in items {
        match item.as_str() {
            Some(text) if !text.trim().is_empty() => list.push(text.trim().to_string()),
            _ => {
                problems.push(format!("\"{field}\" must be a list of non-empty strings."));
                return Vec::new();
            }
        }
    }
    list
}

fn optional_string(
    value: Option<&serde_json::Value>,
    field: &str,
    problems: &mut Vec<String>,
) -> Option<String> {
    let value = value?;
    match value.as_str() {
        Some(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        _ => {
            problems.push(format!(
                "\"{field}\" must be a non-empty string when present."
            ));
            None
        }
    }
}

/// Parses and shape-checks a request file. Every problem is listed at once.
pub fn parse_scheduled_run_request(
    text: &str,
) -> Result<ScheduledRunRequest, ScheduledRunRequestError> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|error| {
        ScheduledRunRequestError::new(vec![format!("The request is not valid JSON: {error}")])
    })?;
    let raw = value.as_object().ok_or_else(|| {
        ScheduledRunRequestError::new(vec!["The request must be a JSON object.".to_string()])
    })?;
    let mut problems: Vec<String> = Vec::new();
    if raw.get("schemaVersion").and_then(serde_json::Value::as_u64) != Some(1) {
        problems.push("\"schemaVersion\" must be 1.".to_string());
    }
    if raw.get("kind").and_then(serde_json::Value::as_str) != Some(SCHEDULED_RUN_REQUEST_KIND) {
        problems.push(format!(
            "\"kind\" must be \"{SCHEDULED_RUN_REQUEST_KIND}\"."
        ));
    }
    let name = raw
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if name.is_empty() {
        problems.push("\"name\" is required.".to_string());
    }
    let date = raw
        .get("date")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if !is_date(&date) {
        problems.push("\"date\" must be YYYY-MM-DD.".to_string());
    }
    let time = raw
        .get("time")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if !is_time(&time) {
        problems.push("\"time\" must be HH:mm (24-hour).".to_string());
    }
    let timezone = raw
        .get("timezone")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if timezone.is_empty() {
        problems
            .push("\"timezone\" is required (an IANA zone such as \"Europe/London\").".to_string());
    }
    let order = match raw.get("order") {
        None | Some(serde_json::Value::Null) => ScheduledRunRequestOrder::AsListed,
        Some(value) => match value.as_str() {
            Some("as-listed") => ScheduledRunRequestOrder::AsListed,
            Some("dependencies") => ScheduledRunRequestOrder::Dependencies,
            _ => {
                problems.push("\"order\" must be \"as-listed\" or \"dependencies\".".to_string());
                ScheduledRunRequestOrder::AsListed
            }
        },
    };
    let tickets = string_list(raw.get("tickets"), "tickets", &mut problems);
    if raw.contains_key("tickets") && tickets.is_empty() {
        problems.push("\"tickets\" must list at least one ticket.".to_string());
    }
    if !raw.contains_key("tickets") {
        problems.push("\"tickets\" is required.".to_string());
    }
    let satisfied_dependencies = string_list(
        raw.get("satisfiedDependencies"),
        "satisfiedDependencies",
        &mut problems,
    );
    let project_id = optional_string(raw.get("projectId"), "projectId", &mut problems);
    let workflow_id = optional_string(raw.get("workflowId"), "workflowId", &mut problems);
    let mut max_concurrency = None;
    if let Some(value) = raw.get("maxConcurrency") {
        match value.as_i64() {
            Some(number) if (1..=4).contains(&number) => max_concurrency = Some(number),
            _ => problems
                .push("\"maxConcurrency\" must be a whole number between 1 and 4.".to_string()),
        }
    }
    if !problems.is_empty() {
        return Err(ScheduledRunRequestError::new(problems));
    }
    Ok(ScheduledRunRequest {
        schema_version: 1,
        kind: SCHEDULED_RUN_REQUEST_KIND.to_string(),
        name,
        project_id,
        workflow_id,
        date,
        time,
        timezone,
        order,
        tickets,
        satisfied_dependencies,
        max_concurrency,
    })
}

/// A resolved request: the tickets to run, in order, and what to warn about.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedScheduledRunRequest {
    pub tickets: Vec<ScheduledTicketRef>,
    pub entries: Vec<ScheduledRunRequestEntry>,
    pub warnings: Vec<String>,
    /// The tickets that share a step with the one before them.
    pub with_previous: Vec<String>,
    pub max_concurrency: i64,
}

fn is_done(issue: &IssueSummary) -> bool {
    issue
        .status_category
        .as_deref()
        .unwrap_or_default()
        .to_lowercase()
        == "done"
}

fn label(issue: &IssueSummary) -> String {
    match &issue.planning_id {
        Some(planning_id) if !planning_id.is_empty() => {
            format!("{planning_id} ({})", issue.key)
        }
        _ => issue.key.clone(),
    }
}

/// Resolves the request's tickets against the board's issues and fixes the run order. A reference
/// matches a board key exactly, otherwise a plan ID; it must match exactly one issue. Every
/// dependency of a queued ticket must be queued earlier, already done, or named in
/// `satisfiedDependencies`.
pub fn resolve_scheduled_run_request(
    request: &ScheduledRunRequest,
    issues: &[IssueSummary],
    connection_id: &str,
) -> Result<ResolvedScheduledRunRequest, ScheduledRunRequestError> {
    let mut problems: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let find = |reference: &str, problems: &mut Vec<String>| -> Option<&IssueSummary> {
        if let Some(exact) = issues.iter().find(|issue| issue.key == reference) {
            return Some(exact);
        }
        let matches: Vec<&IssueSummary> = issues
            .iter()
            .filter(|issue| issue.planning_id.as_deref() == Some(reference))
            .collect();
        if matches.len() > 1 {
            problems.push(format!(
                "{reference} matches more than one board item ({}); use the board key.",
                matches
                    .iter()
                    .map(|issue| issue.key.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            return None;
        }
        if matches.is_empty() {
            problems.push(format!("{reference} was not found on the project's board."));
        }
        matches.into_iter().next()
    };

    let mut selected: Vec<&IssueSummary> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for reference in &request.tickets {
        let Some(issue) = find(reference, &mut problems) else {
            continue;
        };
        if seen.contains(&issue.key) {
            problems.push(format!("{} is listed more than once.", label(issue)));
            continue;
        }
        seen.push(issue.key.clone());
        selected.push(issue);
        if is_done(issue) {
            warnings.push(format!(
                "{} is already done; the run will skip it.",
                label(issue)
            ));
        }
    }

    let mut satisfied: Vec<String> = Vec::new();
    for reference in &request.satisfied_dependencies {
        let key = issues
            .iter()
            .find(|issue| issue.key == *reference)
            .or_else(|| {
                issues
                    .iter()
                    .find(|issue| issue.planning_id.as_deref() == Some(reference.as_str()))
            })
            .map_or_else(|| reference.clone(), |issue| issue.key.clone());
        satisfied.push(key);
    }

    // Dependencies inside the queue become ordering edges; the rest must be finished.
    let mut queued_deps: Vec<(String, Vec<String>)> = Vec::new();
    for issue in &selected {
        let mut in_queue: Vec<String> = Vec::new();
        for dependency in issue.depends_on.iter().flatten() {
            if seen.contains(dependency) {
                in_queue.push(dependency.clone());
                continue;
            }
            let target = issues.iter().find(|candidate| candidate.key == *dependency);
            if satisfied.contains(dependency) || target.is_some_and(is_done) {
                continue;
            }
            problems.push(format!(
                "{} depends on {}, which is not in the queue and not done. Queue it, or list it in \"satisfiedDependencies\" if it is finished.",
                label(issue),
                target.map_or_else(|| dependency.clone(), label)
            ));
        }
        queued_deps.push((issue.key.clone(), in_queue));
    }
    let deps_of = |key: &str| -> Vec<String> {
        queued_deps
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, deps)| deps.clone())
            .unwrap_or_default()
    };

    let mut ordered: Vec<&IssueSummary> = selected.clone();
    if request.order == ScheduledRunRequestOrder::AsListed {
        let position = |key: &str| {
            selected
                .iter()
                .position(|issue| issue.key == key)
                .map(|index| index as i64)
                .unwrap_or(-1)
        };
        for issue in &selected {
            for dependency in deps_of(&issue.key) {
                if position(&dependency) > position(&issue.key) {
                    let target = issues.iter().find(|candidate| candidate.key == dependency);
                    problems.push(format!(
                        "{} is listed before its dependency {}.",
                        label(issue),
                        target.map_or_else(|| dependency.clone(), label)
                    ));
                }
            }
        }
    } else {
        // Stable topological sort: always take the earliest-listed ticket whose dependencies are
        // placed.
        let mut placed: Vec<String> = Vec::new();
        let mut remaining: Vec<&IssueSummary> = selected.clone();
        ordered = Vec::new();
        while !remaining.is_empty() {
            let index = remaining
                .iter()
                .position(|issue| deps_of(&issue.key).iter().all(|dep| placed.contains(dep)));
            let Some(index) = index else {
                problems.push(format!(
                    "These tickets depend on each other in a cycle: {}.",
                    remaining
                        .iter()
                        .map(|issue| label(issue))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
                break;
            };
            let next = remaining.remove(index);
            placed.push(next.key.clone());
            ordered.push(next);
        }
    }

    if !problems.is_empty() {
        return Err(ScheduledRunRequestError::new(problems));
    }

    // Group ready tickets into parallel steps (up to max_concurrency, default 2 for the skill).
    let max_concurrency = request.max_concurrency.unwrap_or(2);
    let mut steps: Vec<Vec<&IssueSummary>> = Vec::new();
    let mut step_placed: Vec<String> = Vec::new();
    let mut step_remaining: Vec<&IssueSummary> = ordered.clone();
    while !step_remaining.is_empty() {
        let mut ready_indices: Vec<usize> = Vec::new();
        for (index, issue) in step_remaining.iter().enumerate() {
            if deps_of(&issue.key)
                .iter()
                .all(|dep| step_placed.contains(dep))
            {
                ready_indices.push(index);
                if ready_indices.len() as i64 >= max_concurrency {
                    break;
                }
            }
        }
        if ready_indices.is_empty() {
            let fallback = step_remaining.remove(0);
            step_placed.push(fallback.key.clone());
            steps.push(vec![fallback]);
            continue;
        }
        let mut batch: Vec<&IssueSummary> = Vec::new();
        for index in ready_indices.iter().rev() {
            batch.insert(0, step_remaining.remove(*index));
        }
        for issue in &batch {
            step_placed.push(issue.key.clone());
        }
        steps.push(batch);
    }

    let final_ordered: Vec<&IssueSummary> = steps.iter().flatten().copied().collect();
    let mut with_previous: Vec<String> = Vec::new();
    for step in &steps {
        for issue in step.iter().skip(1) {
            with_previous.push(ticket_ref_key(connection_id, &issue.key));
        }
    }

    let entries: Vec<ScheduledRunRequestEntry> = final_ordered
        .iter()
        .enumerate()
        .map(|(index, issue)| ScheduledRunRequestEntry {
            sequence: index as u32 + 1,
            issue_key: issue.key.clone(),
            planning_id: issue.planning_id.clone(),
            title: issue.summary.clone(),
        })
        .collect();
    Ok(ResolvedScheduledRunRequest {
        tickets: final_ordered
            .iter()
            .map(|issue| ScheduledTicketRef {
                connection_id: connection_id.to_string(),
                issue_key: issue.key.clone(),
                title: issue.summary.clone(),
            })
            .collect(),
        entries,
        warnings,
        with_previous,
        max_concurrency,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(
        key: &str,
        planning_id: &str,
        depends_on: &[&str],
        status_category: &str,
    ) -> IssueSummary {
        serde_json::from_value(serde_json::json!({
            "key": key,
            "planningId": planning_id,
            "summary": format!("{planning_id}: Title"),
            "status": "To Do",
            "statusCategory": status_category,
            "issueType": "Task",
            "projectKey": "PRX",
            "dependsOn": depends_on,
        }))
        .expect("issue")
    }

    fn board() -> Vec<IssueSummary> {
        vec![
            issue("PRX-1", "TASK-1", &[], "To Do"),
            issue("PRX-2", "TASK-2", &["PRX-1"], "To Do"),
            issue("PRX-3", "TASK-3", &["PRX-2"], "To Do"),
            issue("PRX-0", "TASK-0", &[], "done"),
        ]
    }

    fn request(extra: serde_json::Value) -> String {
        let mut value = serde_json::json!({
            "schemaVersion": 1,
            "kind": "praxis.scheduledRunRequest",
            "name": "Night run",
            "date": "2026-11-01",
            "time": "22:00",
            "timezone": "Europe/London",
            "tickets": ["TASK-1", "TASK-2"],
        });
        if let (Some(base), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
        value.to_string()
    }

    fn problems(result: Result<impl std::fmt::Debug, ScheduledRunRequestError>) -> Vec<String> {
        match result {
            Ok(value) => panic!("expected a request error, got {value:?}"),
            Err(error) => error.problems,
        }
    }

    #[test]
    fn parse_accepts_a_minimal_request_and_defaults_order_to_as_listed() {
        let parsed = parse_scheduled_run_request(&request(serde_json::json!({}))).expect("parsed");
        assert_eq!(parsed.order, ScheduledRunRequestOrder::AsListed);
        assert_eq!(parsed.tickets, vec!["TASK-1", "TASK-2"]);
        assert!(parsed.satisfied_dependencies.is_empty());
        assert_eq!(parsed.name, "Night run");
        assert_eq!(parsed.timezone, "Europe/London");
    }

    #[test]
    fn parse_reports_every_shape_problem_at_once() {
        let found = problems(parse_scheduled_run_request(
            r#"{"schemaVersion":2,"kind":"x","date":"1/11/2026","time":"10pm","tickets":[]}"#,
        ));
        assert!(found.len() >= 6, "{}", found.join("\n"));
        assert_eq!(
            problems(parse_scheduled_run_request("{ nope")).len(),
            1,
            "a file that is not JSON has one problem"
        );
    }

    #[test]
    fn resolve_matches_plan_ids_and_board_keys_and_keeps_the_listed_order() {
        let parsed = parse_scheduled_run_request(&request(serde_json::json!({
            "tickets": ["TASK-1", "PRX-2", "TASK-3"]
        })))
        .expect("parsed");
        let resolved =
            resolve_scheduled_run_request(&parsed, &board(), "project:p1").expect("resolved");
        assert_eq!(
            resolved
                .tickets
                .iter()
                .map(|ticket| ticket.issue_key.as_str())
                .collect::<Vec<_>>(),
            vec!["PRX-1", "PRX-2", "PRX-3"]
        );
        assert_eq!(resolved.tickets[0].connection_id, "project:p1");
        assert_eq!(
            resolved
                .entries
                .iter()
                .map(|entry| entry.planning_id.clone().unwrap_or_default())
                .collect::<Vec<_>>(),
            vec!["TASK-1", "TASK-2", "TASK-3"]
        );
    }

    #[test]
    fn as_listed_rejects_a_ticket_placed_before_its_dependency() {
        let parsed = parse_scheduled_run_request(&request(serde_json::json!({
            "tickets": ["TASK-2", "TASK-1"]
        })))
        .expect("parsed");
        let found = problems(resolve_scheduled_run_request(&parsed, &board(), "c"));
        let text = found.join(" ");
        assert!(
            text.contains("TASK-2 (PRX-2) is listed before its dependency TASK-1"),
            "{text}"
        );
    }

    #[test]
    fn dependencies_order_sorts_stably_and_detects_cycles() {
        let parsed = parse_scheduled_run_request(&request(serde_json::json!({
            "order": "dependencies",
            "tickets": ["TASK-3", "TASK-2", "TASK-1"]
        })))
        .expect("parsed");
        let sorted = resolve_scheduled_run_request(&parsed, &board(), "c").expect("resolved");
        assert_eq!(
            sorted
                .tickets
                .iter()
                .map(|ticket| ticket.issue_key.as_str())
                .collect::<Vec<_>>(),
            vec!["PRX-1", "PRX-2", "PRX-3"]
        );

        let cyclic = vec![
            issue("A-1", "T-A", &["A-2"], "To Do"),
            issue("A-2", "T-B", &["A-1"], "To Do"),
        ];
        let parsed = parse_scheduled_run_request(&request(serde_json::json!({
            "order": "dependencies",
            "tickets": ["T-A", "T-B"]
        })))
        .expect("parsed");
        let found = problems(resolve_scheduled_run_request(&parsed, &cyclic, "c"));
        assert!(found.join(" ").contains("cycle"), "{}", found.join(" "));
    }

    #[test]
    fn an_unqueued_dependency_must_be_done_or_declared_satisfied() {
        let parsed = parse_scheduled_run_request(&request(serde_json::json!({
            "tickets": ["TASK-2"]
        })))
        .expect("parsed");
        let found = problems(resolve_scheduled_run_request(&parsed, &board(), "c"));
        assert!(
            found
                .join(" ")
                .contains("depends on TASK-1 (PRX-1), which is not in the queue"),
            "{}",
            found.join(" ")
        );

        let parsed = parse_scheduled_run_request(&request(serde_json::json!({
            "tickets": ["TASK-2"],
            "satisfiedDependencies": ["TASK-1"]
        })))
        .expect("parsed");
        let ok = resolve_scheduled_run_request(&parsed, &board(), "c").expect("resolved");
        assert_eq!(ok.tickets[0].issue_key, "PRX-2");

        let done_board = vec![
            issue("PRX-1", "TASK-1", &[], "done"),
            issue("PRX-2", "TASK-2", &["PRX-1"], "To Do"),
        ];
        let parsed = parse_scheduled_run_request(&request(serde_json::json!({
            "tickets": ["TASK-2"]
        })))
        .expect("parsed");
        assert_eq!(
            resolve_scheduled_run_request(&parsed, &done_board, "c")
                .expect("resolved")
                .tickets
                .len(),
            1
        );
    }

    #[test]
    fn resolve_rejects_unknown_duplicate_and_ambiguous_references_and_warns_about_done_tickets() {
        let mut ambiguous = board();
        ambiguous.push(issue("PRX-9", "TASK-1", &[], "To Do"));
        let parsed = parse_scheduled_run_request(&request(serde_json::json!({
            "tickets": ["TASK-1", "NOPE", "PRX-0", "PRX-0"]
        })))
        .expect("parsed");
        let found = problems(resolve_scheduled_run_request(&parsed, &ambiguous, "c"));
        let text = found.join("\n");
        assert!(
            text.contains("TASK-1 matches more than one board item"),
            "{text}"
        );
        assert!(text.contains("NOPE was not found"), "{text}");
        assert!(text.contains("listed more than once"), "{text}");

        let parsed = parse_scheduled_run_request(&request(serde_json::json!({
            "tickets": ["TASK-0"]
        })))
        .expect("parsed");
        let warned = resolve_scheduled_run_request(&parsed, &board(), "c").expect("resolved");
        assert!(
            warned.warnings[0].contains("already done"),
            "{}",
            warned.warnings[0]
        );
    }

    #[test]
    fn resolve_groups_independent_tickets_into_parallel_steps_with_a_maximum_of_two() {
        let board = vec![
            issue("PRX-1", "TASK-1", &[], "To Do"),
            issue("PRX-2", "TASK-2", &[], "To Do"),
            issue("PRX-3", "TASK-3", &["PRX-1"], "To Do"),
            issue("PRX-4", "TASK-4", &["PRX-2"], "To Do"),
            issue("PRX-5", "TASK-5", &[], "To Do"),
        ];
        let parsed = parse_scheduled_run_request(&request(serde_json::json!({
            "tickets": ["TASK-1", "TASK-2", "TASK-3", "TASK-4", "TASK-5"]
        })))
        .expect("parsed");
        let resolved =
            resolve_scheduled_run_request(&parsed, &board, "project:p1").expect("resolved");
        assert_eq!(resolved.max_concurrency, 2);
        assert_eq!(
            resolved
                .tickets
                .iter()
                .map(|ticket| ticket.issue_key.as_str())
                .collect::<Vec<_>>(),
            vec!["PRX-1", "PRX-2", "PRX-3", "PRX-4", "PRX-5"]
        );
        assert_eq!(
            resolved.with_previous,
            vec![
                "project:p1\u{0}PRX-2".to_string(),
                "project:p1\u{0}PRX-4".to_string()
            ]
        );

        let parsed = parse_scheduled_run_request(&request(serde_json::json!({
            "tickets": ["TASK-1", "TASK-2"],
            "maxConcurrency": 1
        })))
        .expect("parsed");
        let sequential =
            resolve_scheduled_run_request(&parsed, &board, "project:p1").expect("resolved");
        assert_eq!(sequential.max_concurrency, 1);
        assert!(sequential.with_previous.is_empty());
    }

    #[test]
    fn file_naming_helpers() {
        assert!(is_scheduled_run_request_file("night.json"));
        assert!(!is_scheduled_run_request_file("night.status.json"));
        assert!(!is_scheduled_run_request_file(".night.json"));
        assert_eq!(
            scheduled_run_request_status_file("night.json"),
            "night.status.json"
        );
        assert_eq!(
            scheduled_run_request_run_id("p1", "night.json"),
            scheduled_run_request_run_id("p1", "night.json")
        );
        assert_ne!(
            scheduled_run_request_run_id("p1", "night.json"),
            scheduled_run_request_run_id("p2", "night.json")
        );
        assert_eq!(
            scheduled_run_request_hash("night").len(),
            64,
            "a SHA-256 in hex"
        );
    }
}
