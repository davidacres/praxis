//! The AI workflow channels: delivery, feature decomposition, sub-task delivery, GitLab
//! merge-request actions and the local peer review. Ports `aiWorkflowIpc.ts` and the `aiIpc.ts`
//! peer-review handlers, with the task contracts and result parsers of core's
//! `deliveryWorkflow.ts`, `featureDecompositionWorkflow.ts` and `mergeRequestWorkflow.ts`.
//!
//! A workflow run is an ordinary agent session started through `ai:delegate` with a prebuilt task
//! contract. What makes it a workflow is the `delivery` metadata on the session record and the
//! completion watcher below, which waits for the session to settle and then finalizes it from the
//! structured result block the agent was told to end with (creating the decomposed sub-tasks,
//! posting merge-request replies).
//!
//! These channels launch agents and call the tracker, so they run outside the profile lock.

use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use praxis_host::HostContext;
use praxis_contracts::RustRpcRequest;
use praxis_trackers::gitlab::api_service::{CreateGitLabMergeRequestInput, GitLabApiConfig, GitLabApiService, is_praxis_managed_merge_request_note, wrap_praxis_managed_merge_request_note};
use regex::Regex;
use serde_json::{Value, json};

use super::session_store::store;
use super::{Result, failure, text};

pub const CHANNELS: [&str; 8] = [
    "ai:localPeerReview",
    "ai:localPeerReviewFollowUp",
    "ai:startDelivery",
    "ai:decomposeFeature",
    "ai:startSubTaskDelivery",
    "ai:listMergeRequests",
    "ai:createMergeRequest",
    "ai:checkMergeRequestFeedback",
];

const DELIVERY_RESULT_MARKER: &str = "DELIVERY_RESULT";
const FEATURE_DECOMPOSITION_RESULT_MARKER: &str = "FEATURE_DECOMPOSITION_RESULT";
const MERGE_REQUEST_FEEDBACK_RESULT_MARKER: &str = "MERGE_REQUEST_FEEDBACK_RESULT";

// ── small text helpers ───────────────────────────────────────────────────

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a valid built-in pattern")
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn non_empty(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|v| !v.is_empty())
}

/// A branch name as a ticket or an agent wrote it: no whitespace, only branch-safe characters.
fn sanitize_branch_candidate(value: &str) -> Option<String> {
    static SAFE: OnceLock<Regex> = OnceLock::new();
    let trimmed = value.trim().trim_matches('`').to_owned();
    let safe = SAFE.get_or_init(|| re(r"^[A-Za-z0-9._/-]+$"));
    (!trimmed.is_empty() && !trimmed.chars().any(char::is_whitespace) && safe.is_match(&trimmed)).then_some(trimmed)
}

fn extract_branch_from_text(text: Option<&str>) -> Option<String> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let text = text.filter(|t| !t.trim().is_empty())?.replace("\r\n", "\n");
    let patterns = PATTERNS.get_or_init(|| {
        [r"(?im)^\s*\*\*Branch:\*\*\s*(.+)$", r"(?im)^\s*\*\*Base branch:\*\*\s*(.+)$", r"(?im)^\s*Branch\s*:\s*(.+)$", r"(?im)^\s*Base branch\s*:\s*(.+)$"].iter().map(|p| re(p)).collect()
    });
    patterns.iter().find_map(|pattern| pattern.captures(&text).and_then(|c| sanitize_branch_candidate(&c[1])))
}

/// The base branch a ticket asks for: the newest comment that names one, else the description.
pub fn extract_delivery_base_branch(issue: &Value) -> Option<String> {
    let stamp = |comment: &Value| comment["updated"].as_str().or_else(|| comment["created"].as_str()).unwrap_or_default().to_owned();
    let mut comments: Vec<&Value> = issue["comments"].as_array().into_iter().flatten().collect();
    comments.sort_by_key(|comment| std::cmp::Reverse(stamp(comment)));
    comments.iter().find_map(|comment| extract_branch_from_text(comment["body"].as_str())).or_else(|| extract_branch_from_text(issue["description"].as_str()))
}

/// What is wrong with the delivery settings, one message per problem (empty when ready).
pub fn validate_delivery_settings(enabled: bool, publish_command: &str, artifact_pattern: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if !enabled {
        errors.push("Delivery workflow is disabled in Praxis settings.".to_owned());
    }
    if publish_command.is_empty() {
        errors.push("Set praxis.ai.deliveryPublishCommand to the repo-specific MSI publish command.".to_owned());
    }
    if artifact_pattern.is_empty() {
        errors.push("Set praxis.ai.deliveryArtifactPattern to the MSI artifact path or glob.".to_owned());
    }
    errors
}

/// `path.win32.resolve(base, relative)` for the shapes a publish script takes. The command is a
/// PowerShell line for a Windows runner, so joins use Windows semantics on any host.
fn win32_resolve(base: &str, relative: &str) -> String {
    let joined = format!("{}\\{}", base.replace('/', "\\"), relative.replace('/', "\\"));
    let (root, rest) = match joined.as_bytes() {
        [drive, b':', ..] if drive.is_ascii_alphabetic() => (joined[..2].to_owned() + "\\", joined[2..].trim_start_matches('\\').to_owned()),
        _ => ("\\".to_owned(), joined.trim_start_matches('\\').to_owned()),
    };
    let mut parts: Vec<&str> = Vec::new();
    for segment in rest.split('\\') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("{root}{}", parts.join("\\"))
}

fn is_win32_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('\\') || path.starts_with('/') || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/'))
}

/// Rewrites `pwsh -File script.ps1` so the script runs from the worktree, not the app's folder.
pub fn resolve_delivery_publish_command(publish_command: &str, worktree_path: &str) -> String {
    static FILE_FORM: OnceLock<Regex> = OnceLock::new();
    let trimmed = publish_command.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let pattern = FILE_FORM.get_or_init(|| re(r#"(?is)^(?P<shell>pwsh|powershell(?:\.exe)?)(?P<prefix>.*?)\s+-File\s+(?P<script>"[^"]+"|'[^']+'|[^\s]+)(?P<suffix>.*)$"#));
    let Some(captures) = pattern.captures(trimmed) else { return trimmed.to_owned() };
    let script = captures["script"].trim();
    let quoted = script.len() >= 2 && ((script.starts_with('"') && script.ends_with('"')) || (script.starts_with('\'') && script.ends_with('\'')));
    let script = if quoted { &script[1..script.len() - 1] } else { script };
    let resolved = if is_win32_absolute(script) { script.to_owned() } else { win32_resolve(worktree_path, script) };
    let literal = |value: &str| format!("'{}'", value.replace('\'', "''"));
    let suffix = captures["suffix"].trim();
    format!(
        "{}{} -Command \"& {{ Set-Location -LiteralPath {}; & {}{} }}\"",
        &captures["shell"],
        &captures["prefix"],
        literal(worktree_path),
        literal(&resolved),
        if suffix.is_empty() { String::new() } else { format!(" {suffix}") }
    )
}

// ── task contracts ───────────────────────────────────────────────────────

fn with_workflow(mut task: Value, workflow: Option<&Value>) -> Value {
    if let Some(workflow) = workflow.filter(|w| w.is_object()) {
        task["workflow"] = workflow.clone();
    }
    task
}

fn description_block(issue: &Value, limit: usize) -> Option<String> {
    non_empty(&issue["description"]).map(|d| format!("Ticket description:\n{}", truncate(d, limit)))
}

fn join_parts(parts: Vec<Option<String>>) -> String {
    parts.into_iter().flatten().collect::<Vec<_>>().join("\n\n")
}

fn delivery_result_contract(sub_task: bool) -> String {
    let mut lines = vec![
        "CRITICAL — YOU MUST INCLUDE THIS BLOCK. The automation pipeline that processes your response depends on parsing this structured output. If you omit it, the entire workflow fails.".to_owned(),
        String::new(),
        format!("When the work is complete, end your final response with {DELIVERY_RESULT_MARKER} followed by exactly one JSON code block."),
        "Use this schema:".to_owned(),
        "```json".to_owned(),
        "{".to_owned(),
        "  \"status\": \"success\" | \"failure\",".to_owned(),
        "  \"summary\": \"concise implementation summary\",".to_owned(),
        "  \"branch\": \"pushed branch name\",".to_owned(),
        "  \"commitHash\": \"git commit hash or empty string\",".to_owned(),
        "  \"pushedRef\": \"remote ref or empty string\",".to_owned(),
    ];
    if sub_task {
        lines.push("  \"buildIdentifier\": \"\",".to_owned());
        lines.push("  \"artifactPaths\": [],".to_owned());
    } else {
        lines.push("  \"buildIdentifier\": \"required when status is success; use the MSI build suffix such as 01\",".to_owned());
        lines.push("  \"artifactPaths\": [\"relative-or-absolute-artifact-path\"],".to_owned());
    }
    lines.push("  \"failureReason\": \"required when status is failure\"".to_owned());
    lines.push("}".to_owned());
    lines.push("```".to_owned());
    if !sub_task {
        lines.push("Use artifactPaths relative to the worktree root when possible.".to_owned());
    }
    lines.push(String::new());
    lines.push("REMINDER: Your final message MUST end with the structured result block above. Do not end with a plain-text summary.".to_owned());
    lines.join("\n")
}

fn analysis_context(analysis: Option<&Value>) -> Option<String> {
    let analysis = analysis.filter(|a| a.is_object())?;
    Some(["Implementation analysis summary:", analysis["summary"].as_str().unwrap_or_default(), "", "Implementation plan from the completed analysis session:", analysis["implementationPlan"].as_str().unwrap_or("(not provided)")].join("\n"))
}

pub struct DeliveryOptions<'a> {
    pub base_branch: &'a str,
    pub branch_name: &'a str,
    pub worktree_path: &'a str,
    pub publish_command: &'a str,
    pub artifact_pattern: &'a str,
    pub workflow: Option<&'a Value>,
}

pub fn build_delivery_task(issue: &Value, options: &DeliveryOptions<'_>) -> Value {
    let key = issue["key"].as_str().unwrap_or_default();
    let summary = issue["summary"].as_str().unwrap_or_default();
    let (branch, worktree) = (options.branch_name, options.worktree_path);
    let task = json!({
        "kind": "jira-delivery",
        "goal": format!("Implement {key}: {summary} from base branch {} in the dedicated worktree at {worktree}.", options.base_branch),
        "scope": join_parts(vec![
            Some(format!("Work only inside {worktree}.")),
            Some(format!("Create code changes for {key} on branch {branch}.")),
            Some("When running build/unit/E2E test gates, only fix failures that your own code changes caused. Treat any other failure (port-in-use, server-startup/URL mismatches, missing browsers or drivers, absent services or databases, flaky harness configuration, pre-existing broken tests on the base branch) as a pre-existing infrastructure issue: record it under failureReason in the completion contract as a BLOCKED result and stop that gate. Do not edit appsettings, launch profiles, test harness code, ServerManager/fixture plumbing, CI scripts, or unrelated projects to chase infra fixes.".to_owned()),
            Some("Time-box any single diagnostic loop to at most three consecutive investigative actions (read/search/re-run). If after that the root cause still looks like environment or harness, stop and return a failure/blocked completion — do not continue investigating.".to_owned()),
            description_block(issue, 4000),
        ]),
        "definitionOfDone": ([
            format!("All implementation changes for {key} are complete and validated."),
            format!("The branch {branch} is committed and pushed."),
            format!("The worktree-scoped MSI publish command succeeds: {}.", options.publish_command),
            format!("You identify the MSI artifact path(s) matching {}.", options.artifact_pattern),
            "Your final message ends with the structured DELIVERY_RESULT JSON block as described in the completion contract — this is mandatory.".to_owned(),
        ].join(" ")),
        "nonGoals": [
            "Do not post Jira comments or transcripts yourself.",
            "Do not work outside the prepared worktree.",
            "Do not skip commit, push, or MSI publish steps.",
            "Do not attempt to fix pre-existing test-harness or environment failures (port collisions, server URL or Kestrel config mismatches, missing browsers/drivers, absent services, broken fixtures, tests that already fail on the base branch). Record them as blockers in the completion contract and stop that gate instead of editing harness or infrastructure code.",
            "Do not modify test infrastructure, CI scripts, appsettings, launch profiles, or unrelated projects to work around environment problems.",
        ],
        "completionContract": delivery_result_contract(false),
        "timeoutMs": 6u64 * 60 * 60 * 1000,
        "maxSteps": 700,
    });
    with_workflow(task, options.workflow)
}

/// A feature sub-task only implements, tests, commits and pushes; publishing happens once at the
/// parent feature after every sub-task merge request is merged.
pub fn build_sub_task_delivery_task(issue: &Value, options: &DeliveryOptions<'_>) -> Value {
    let key = issue["key"].as_str().unwrap_or_default();
    let summary = issue["summary"].as_str().unwrap_or_default();
    let (branch, worktree) = (options.branch_name, options.worktree_path);
    let task = json!({
        "kind": "jira-delivery",
        "goal": format!("Implement {key}: {summary} from base branch {} in the dedicated worktree at {worktree}.", options.base_branch),
        "scope": join_parts(vec![
            Some(format!("Work only inside {worktree}.")),
            Some(format!("Create code changes for {key} on branch {branch}.")),
            Some("This is a sub-task of a larger feature. Focus only on the scope described in this ticket.".to_owned()),
            Some("When running build or unit test gates, only fix failures that your own code changes caused. Treat any other failure as a pre-existing issue: record it under failureReason in the completion contract as a BLOCKED result and stop.".to_owned()),
            Some("Time-box any single diagnostic loop to at most three consecutive investigative actions (read/search/re-run). If after that the root cause still looks like environment or harness, stop and return a failure/blocked completion.".to_owned()),
            description_block(issue, 4000),
        ]),
        "definitionOfDone": ([
            format!("All implementation changes for {key} are complete and validated."),
            format!("The branch {branch} is committed and pushed."),
            "Unit tests pass for the changed code.".to_owned(),
            "Do NOT run publish, MSI build, or artifact generation steps — those will be done at the feature level after all sub-tasks are merged.".to_owned(),
            "Your final message ends with the structured DELIVERY_RESULT JSON block as described in the completion contract — this is mandatory.".to_owned(),
        ].join(" ")),
        "nonGoals": [
            "Do not post Jira comments or transcripts yourself.",
            "Do not work outside the prepared worktree.",
            "Do not skip commit or push steps.",
            "Do not run publish commands, MSI builds, or artifact generation.",
            "Do not attempt to fix pre-existing test-harness or environment failures.",
            "Do not modify test infrastructure, CI scripts, appsettings, launch profiles, or unrelated projects.",
        ],
        "completionContract": delivery_result_contract(true),
        "timeoutMs": 4u64 * 60 * 60 * 1000,
        "maxSteps": 500,
    });
    with_workflow(task, options.workflow)
}

/// Whether the ticket should go through decomposition rather than single-task delivery.
pub fn is_feature_request_ticket(issue: &Value) -> bool {
    issue["description"].as_str().unwrap_or_default().trim().to_lowercase().contains("feature request")
}

pub fn build_feature_decomposition_task(issue: &Value, base_branch: &str, worktree_path: &str, available_workflows: &[Value], workflow: Option<&Value>) -> Value {
    let key = issue["key"].as_str().unwrap_or_default();
    let summary = issue["summary"].as_str().unwrap_or_default();
    let workflow_list = if available_workflows.is_empty() {
        "(no workflow packs available)".to_owned()
    } else {
        available_workflows.iter().map(|w| format!("- {} ({}): {}", w["name"].as_str().unwrap_or_default(), w["id"].as_str().unwrap_or_default(), w["description"].as_str().unwrap_or("no description"))).collect::<Vec<_>>().join("\n")
    };
    let task = json!({
        "kind": "jira-delivery",
        "goal": format!("Comprehensively analyse the feature request {key}: {summary} and break it down into small, manageable, independently deliverable sub-tasks."),
        "scope": join_parts(vec![
            Some(format!("Work inside the worktree at {worktree_path}.")),
            Some("This is a feature request ticket. Your job is to deeply understand the feature, explore the codebase to understand the architecture, and decompose the work into concrete sub-tasks that can each be independently implemented and tested.".to_owned()),
            Some(format!("Base branch for the feature: {base_branch}")),
            non_empty(&issue["description"]).map(|d| format!("Ticket description:\n{}", truncate(d, 6000))),
            Some(format!("\nAvailable workflow packs that can be assigned to sub-tasks:\n{workflow_list}")),
            Some("\nEach sub-task should:".to_owned()),
            Some("- Be small enough to implement in a single focused session".to_owned()),
            Some("- Have a clear, specific summary and detailed description".to_owned()),
            Some("- Include acceptance criteria in the description".to_owned()),
            Some("- Specify which workflow pack (if any) would be most appropriate".to_owned()),
            Some("- Be ordered by dependency (tasks that others depend on should come first)".to_owned()),
            Some(format!("\nThe feature branch name should follow the pattern: feature/{}-<short-slug>", key.to_lowercase())),
        ]),
        "definitionOfDone": ([
            format!("You produce a comprehensive breakdown of {key} into sub-tasks."),
            "Each sub-task is specific, actionable, and independently implementable.".to_owned(),
            "Sub-tasks are ordered by dependency — prerequisite work comes first.".to_owned(),
            "You suggest a feature branch name for the overall feature.".to_owned(),
        ].join(" ")),
        "nonGoals": [
            "Do not modify files or create commits.",
            "Do not run build or test commands.",
            "Do not post Jira comments yourself.",
            "Do not begin implementation of any sub-task.",
        ],
        "completionContract": ([
            format!("When the decomposition is complete, end your final response with {FEATURE_DECOMPOSITION_RESULT_MARKER} followed by exactly one JSON code block."),
            "Use this schema:".to_owned(),
            "```json".to_owned(),
            "{".to_owned(),
            "  \"status\": \"decomposed\" | \"blocked\",".to_owned(),
            "  \"summary\": \"concise summary of the feature decomposition\",".to_owned(),
            "  \"featureBranch\": \"feature/ISSUE-KEY-short-slug\",".to_owned(),
            "  \"subTasks\": [".to_owned(),
            "    {".to_owned(),
            "      \"summary\": \"concise sub-task title\",".to_owned(),
            "      \"description\": \"detailed description with acceptance criteria\",".to_owned(),
            "      \"issueType\": \"Task\",".to_owned(),
            "      \"suggestedWorkflow\": \"workflow-pack-id or empty string\",".to_owned(),
            "      \"order\": 1".to_owned(),
            "    }".to_owned(),
            "  ],".to_owned(),
            "  \"blockers\": [\"only when status is blocked\"]".to_owned(),
            "}".to_owned(),
            "```".to_owned(),
            "If status is decomposed, subTasks must contain at least one entry.".to_owned(),
            "If status is blocked, blockers must list the concrete issues preventing decomposition.".to_owned(),
        ].join("\n")),
        "timeoutMs": 2u64 * 60 * 60 * 1000,
        "maxSteps": 300,
    });
    with_workflow(task, workflow)
}

pub struct FeedbackNote {
    pub author: String,
    pub body: String,
    pub updated_at: String,
}

pub fn build_merge_request_feedback_task(issue: &Value, branch_name: &str, worktree_path: &str, merge_request_url: &str, source_branch: &str, target_branch: &str, notes: &[FeedbackNote], workflow: Option<&Value>) -> Value {
    let key = issue["key"].as_str().unwrap_or_default();
    let summary = issue["summary"].as_str().unwrap_or_default();
    let note_summary = notes.iter().enumerate().map(|(i, n)| format!("{}. {} ({}): {}", i + 1, n.author, n.updated_at, n.body)).collect::<Vec<_>>().join("\n\n");
    let task = json!({
        "kind": "jira-delivery",
        "goal": format!("Address the latest merge request feedback for {key}: {summary} on branch {branch_name}."),
        "scope": join_parts(vec![
            Some(format!("Work only inside {worktree_path}.")),
            Some(format!("Review merge request feedback on {merge_request_url}.")),
            Some(format!("The source branch is {source_branch} and the target branch is {target_branch}.")),
            description_block(issue, 4000),
            Some(format!("Latest merge request notes to address:\n{note_summary}")),
            Some("IMPORTANT: If the reviewer is asking a question or requesting an explanation (not requesting a code change), reply with a clear answer in the replyComment field and set didEditCode to false. Only modify code when the reviewer explicitly requests a change.".to_owned()),
        ]),
        "definitionOfDone": ([
            format!("The latest merge request feedback for {key} is addressed."),
            "If the feedback is a question, provide a clear and concise answer without making unnecessary code changes.".to_owned(),
            "If the feedback requests code changes, make only the requested changes, commit, and push.".to_owned(),
            "A concise reply comment is prepared for posting back to the merge request.".to_owned(),
        ].join(" ")),
        "nonGoals": [
            "Do not post merge request comments yourself.",
            "Do not work outside the prepared worktree.",
            "Do not create a new branch or a new merge request.",
        ],
        "completionContract": ([
            format!("When the work is complete, end your final response with {MERGE_REQUEST_FEEDBACK_RESULT_MARKER} followed by exactly one JSON code block."),
            "Use this schema:".to_owned(),
            "```json".to_owned(),
            "{".to_owned(),
            "  \"status\": \"success\" | \"failure\",".to_owned(),
            "  \"summary\": \"concise summary of what was addressed\",".to_owned(),
            "  \"branch\": \"branch name that now contains the changes\",".to_owned(),
            "  \"replyComment\": \"required when status is success; concise merge request reply\",".to_owned(),
            "  \"commitHash\": \"git commit hash or empty string\",".to_owned(),
            "  \"pushedRef\": \"remote ref or empty string\",".to_owned(),
            "  \"didEditCode\": true | false,".to_owned(),
            "  \"failureReason\": \"required when status is failure\"".to_owned(),
            "}".to_owned(),
            "```".to_owned(),
        ].join("\n")),
        "timeoutMs": 3u64 * 60 * 60 * 1000,
        "maxSteps": 500,
    });
    with_workflow(task, workflow)
}

// ── result parsers ───────────────────────────────────────────────────────

/// The JSON object in the first fenced block after the last `marker`, if the text has one.
fn result_block(text: &str, marker: &str) -> Option<serde_json::Map<String, Value>> {
    static FENCE: OnceLock<Regex> = OnceLock::new();
    if text.trim().is_empty() {
        return None;
    }
    let normalized = text.replace("\r\n", "\n");
    let search = normalized.rfind(marker).map_or(normalized.as_str(), |index| &normalized[index..]);
    let fence = FENCE.get_or_init(|| re(r"(?is)```json\s*(.*?)```"));
    let json_text = fence.captures(search)?.get(1)?.as_str().trim().to_owned();
    if json_text.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(&json_text).ok()? {
        Value::Object(object) => Some(object),
        _ => None,
    }
}

fn trimmed_field(object: &serde_json::Map<String, Value>, name: &str) -> Option<String> {
    object.get(name).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned)
}

/// `DELIVERY_RESULT` from an implementation run's final message.
pub fn parse_delivery_task_result(text: Option<&str>) -> Option<Value> {
    let candidate = result_block(text?, DELIVERY_RESULT_MARKER)?;
    let status = candidate.get("status").and_then(Value::as_str).filter(|s| matches!(*s, "success" | "failure"))?;
    let summary = trimmed_field(&candidate, "summary")?;
    let branch = sanitize_branch_candidate(candidate.get("branch").and_then(Value::as_str).unwrap_or_default())?;
    let artifact_paths: Vec<Value> = candidate.get("artifactPaths").and_then(Value::as_array).into_iter().flatten().filter(|p| p.as_str().is_some_and(|s| !s.trim().is_empty())).cloned().collect();
    let failure_reason = trimmed_field(&candidate, "failureReason");
    if status == "success" && artifact_paths.is_empty() {
        return None;
    }
    if status == "failure" && failure_reason.is_none() {
        return None;
    }
    let mut result = json!({ "status": status, "summary": summary, "branch": branch, "artifactPaths": artifact_paths });
    for (field, name) in [("commitHash", "commitHash"), ("pushedRef", "pushedRef"), ("buildIdentifier", "buildIdentifier")] {
        if let Some(value) = trimmed_field(&candidate, name) {
            result[field] = json!(value);
        }
    }
    if let Some(reason) = failure_reason {
        result["failureReason"] = json!(reason);
    }
    Some(result)
}

/// `FEATURE_DECOMPOSITION_RESULT`: `decomposed` with ordered sub-tasks, or `blocked` with reasons.
pub fn parse_feature_decomposition_result(text: Option<&str>) -> Option<Value> {
    let candidate = result_block(text?, FEATURE_DECOMPOSITION_RESULT_MARKER)?;
    let status = candidate.get("status").and_then(Value::as_str).filter(|s| matches!(*s, "decomposed" | "blocked"))?;
    let summary = trimmed_field(&candidate, "summary")?;
    let feature_branch = trimmed_field(&candidate, "featureBranch").unwrap_or_default();
    if status == "blocked" {
        let blockers: Vec<Value> = candidate.get("blockers").and_then(Value::as_array).into_iter().flatten().filter(|b| b.as_str().is_some_and(|s| !s.trim().is_empty())).cloned().collect();
        if blockers.is_empty() {
            return None;
        }
        return Some(json!({ "status": status, "summary": summary, "featureBranch": feature_branch, "subTasks": [], "blockers": blockers }));
    }
    if feature_branch.is_empty() {
        return None;
    }
    let raw = candidate.get("subTasks").and_then(Value::as_array).filter(|a| !a.is_empty())?;
    let mut sub_tasks: Vec<Value> = Vec::new();
    for entry in raw.iter().filter(|e| e.is_object()) {
        let Some(entry_summary) = non_empty(&entry["summary"]) else { continue };
        let issue_type = non_empty(&entry["issueType"]).unwrap_or("Task");
        let order = entry["order"].as_f64().unwrap_or((sub_tasks.len() + 1) as f64);
        let mut sub_task = json!({ "summary": entry_summary, "description": non_empty(&entry["description"]).unwrap_or_default(), "issueType": issue_type, "order": order });
        if let Some(workflow) = non_empty(&entry["suggestedWorkflow"]) {
            sub_task["suggestedWorkflow"] = json!(workflow);
        }
        sub_tasks.push(sub_task);
    }
    if sub_tasks.is_empty() {
        return None;
    }
    sub_tasks.sort_by(|a, b| a["order"].as_f64().partial_cmp(&b["order"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
    Some(json!({ "status": status, "summary": summary, "featureBranch": feature_branch, "subTasks": sub_tasks }))
}

/// `MERGE_REQUEST_FEEDBACK_RESULT`.
pub fn parse_merge_request_feedback_result(text: Option<&str>) -> Option<Value> {
    let candidate = result_block(text?, MERGE_REQUEST_FEEDBACK_RESULT_MARKER)?;
    let status = candidate.get("status").and_then(Value::as_str).filter(|s| matches!(*s, "success" | "failure"))?;
    let summary = trimmed_field(&candidate, "summary")?;
    let branch = sanitize_branch_candidate(candidate.get("branch").and_then(Value::as_str).unwrap_or_default())?;
    let reply = trimmed_field(&candidate, "replyComment");
    let failure_reason = trimmed_field(&candidate, "failureReason");
    if (status == "success" && reply.is_none()) || (status == "failure" && failure_reason.is_none()) {
        return None;
    }
    let mut result = json!({ "status": status, "summary": summary, "branch": branch, "didEditCode": candidate.get("didEditCode") == Some(&json!(true)) });
    for (field, value) in [("replyComment", reply), ("commitHash", trimmed_field(&candidate, "commitHash")), ("pushedRef", trimmed_field(&candidate, "pushedRef")), ("failureReason", failure_reason)] {
        if let Some(value) = value {
            result[field] = json!(value);
        }
    }
    Some(result)
}

// ── workflow pack references ─────────────────────────────────────────────

fn normalize_for_matching(value: &str) -> String {
    let spaced = value.to_lowercase().replace(".net", " dotnet ").replace("asp.net", " aspnet ");
    let squashed: String = spaced.chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { ' ' }).collect();
    squashed.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Finds the pack a free-text reference names: an exact id/name match, else a single partial one.
pub fn resolve_workflow_reference(reference: Option<&str>, workflows: &[Value]) -> Option<Value> {
    let reference = normalize_for_matching(reference.map(str::trim).filter(|r| !r.is_empty())?);
    let candidates = |workflow: &Value| -> Vec<String> { ["id", "name", "instructionsPath", "link"].iter().filter_map(|f| non_empty(&workflow[*f])).map(normalize_for_matching).collect() };
    let exact: Vec<&Value> = workflows.iter().filter(|w| candidates(w).iter().any(|c| *c == reference)).collect();
    if let [only] = exact.as_slice() {
        return Some((*only).clone());
    }
    let partial: Vec<&Value> = workflows.iter().filter(|w| candidates(w).iter().any(|c| reference.contains(c.as_str()) || c.contains(reference.as_str()))).collect();
    if let [only] = partial.as_slice() {
        return Some((*only).clone());
    }
    None
}

// ── host plumbing ────────────────────────────────────────────────────────

fn host_call(host: &HostContext, channel: &str, args: Vec<Value>) -> Result<Value> {
    let response = host.dispatch_rpc(RustRpcRequest { id: "ai-workflow".into(), channel: channel.into(), args });
    if response.ok { Ok(response.result.unwrap_or(Value::Null)) } else { Err(response.error.unwrap_or_else(|| failure("The host returned no error."))) }
}

fn get_issue(host: &HostContext, issue_key: &str, connection_id: Option<&str>) -> Result<Value> {
    host_call(host, "issue:get", vec![json!(issue_key), connection_id.map_or(Value::Null, |c| json!(c))])
}

fn optional_text(args: &[Value], index: usize) -> Option<String> {
    args.get(index).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned)
}

struct Gateway {
    working_directory: String,
}

fn require_gateway_and_working_directory(host: &HostContext) -> Result<Gateway> {
    let (connection, _) = super::ai_providers::api_connection(host, "vercel-gateway")?;
    if connection.options.api_key.as_deref().is_none_or(|k| k.trim().is_empty()) {
        return Err(failure("No Vercel AI Gateway API key configured. Add one under Settings → AI Provider."));
    }
    let working_directory = host.settings().read().ai.working_directory.trim().to_owned();
    if working_directory.is_empty() {
        return Err(failure("Set the AI working directory under Settings → AI Provider first."));
    }
    Ok(Gateway { working_directory })
}

fn require_confirmed_analysis(host: &HostContext, dir: &Path, issue_key: &str) -> Result<()> {
    if host.settings().read().ai.analysis_gate_enabled && !super::ai::is_analysis_confirmed(dir, issue_key)? {
        return Err(failure(format!("Analysis for {issue_key} must be confirmed before starting delivery (the analysis gate is enabled in Settings → AI Provider).")));
    }
    Ok(())
}

fn resolve_base_branch(host: &HostContext, issue: &Value) -> Result<String> {
    let base = extract_delivery_base_branch(issue).unwrap_or_else(|| host.settings().read().delivery.default_base_branch.trim().to_owned());
    if base.is_empty() {
        return Err(failure("No base branch: add one to the issue (e.g. \"Base branch: main\") or set a default under Settings → Delivery."));
    }
    Ok(base)
}

fn assigned_workflow(host: &HostContext, issue_key: &str) -> Option<Value> {
    Some(super::workflow_packs::assignment(host, issue_key)["workflow"].clone()).filter(Value::is_object)
}

/// Merges `patch` into the session's `delivery` metadata and tells the renderer.
fn update_delivery(host: &HostContext, dir: &Path, issue_key: &str, patch: Value) {
    let updated = store(dir).mutate(issue_key, true, |record| {
        let mut delivery = record["delivery"].as_object().cloned().unwrap_or_default();
        for (field, value) in patch.as_object().into_iter().flatten() {
            delivery.insert(field.clone(), value.clone());
        }
        record["delivery"] = Value::Object(delivery);
    });
    if let Ok(Some(record)) = updated {
        host.events().emit("ai:sessionChanged", Some(record));
    }
}

fn update_sub_task_record(host: &HostContext, dir: &Path, parent_key: &str, sub_task_key: &str, patch: &Value) {
    let Ok(Some(parent)) = store(dir).get(parent_key) else { return };
    let decomposition = parent["delivery"]["featureDecomposition"].clone();
    if !decomposition.is_object() {
        return;
    }
    let mut next = decomposition.clone();
    if let Some(records) = next["subTasks"].as_array_mut() {
        for record in records.iter_mut().filter(|r| r["issueKey"] == sub_task_key) {
            for (field, value) in patch.as_object().into_iter().flatten() {
                record[field] = value.clone();
            }
        }
    }
    update_delivery(host, dir, parent_key, json!({ "featureDecomposition": next }));
}

/// Starts the workflow's agent session through `ai:delegate` and records its delivery metadata.
fn launch(host: &HostContext, dir: &Path, issue_key: &str, connection_id: Option<&str>, task: Value, working_directory: &str, delivery: Value) -> Result<Value> {
    let mut input = json!({
        "issueKey": issue_key, "provider": "vercel-gateway", "mode": "chat", "taskDefinition": task,
        "workingDirectory": working_directory, "toolMode": "full", "permissionMode": "bypass",
    });
    if let Some(connection_id) = connection_id {
        input["connectionId"] = json!(connection_id);
    }
    super::ai_delegate::delegate_channel(host, dir, &[input])?;
    let mut delivery = delivery;
    delivery["source"] = json!("jira-polling");
    delivery["finalizationState"] = json!("pending");
    if let Some(connection_id) = connection_id {
        delivery["connectionId"] = json!(connection_id);
    }
    update_delivery(host, dir, issue_key, delivery);
    spawn_watcher(host, dir, issue_key);
    store(dir)
        .get(issue_key)?
        .map(super::session_store::stamp_reasoning)
        .ok_or_else(|| failure(format!("The session for {issue_key} did not start.")))
}

// ── channels ─────────────────────────────────────────────────────────────

fn start_delivery(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let issue_key = text(args, 0)?;
    let connection_id = optional_text(args, 1);
    let settings = host.settings().read().clone();
    let errors = validate_delivery_settings(settings.delivery.enabled, &settings.delivery.publish_command, &settings.delivery.artifact_pattern);
    if !errors.is_empty() {
        return Err(failure(errors.join("\n")));
    }
    let gateway = require_gateway_and_working_directory(host)?;
    require_confirmed_analysis(host, dir, issue_key)?;
    let issue = get_issue(host, issue_key, connection_id.as_deref())?;
    let base_branch = resolve_base_branch(host, &issue)?;
    let branch_name = non_empty(&issue["branch"]).map_or_else(|| format!("feature/{}", issue_key.to_lowercase()), str::to_owned);
    let workflow = assigned_workflow(host, issue_key);
    let publish_command = resolve_delivery_publish_command(&settings.delivery.publish_command, &gateway.working_directory);
    let task = build_delivery_task(&issue, &DeliveryOptions {
        base_branch: &base_branch, branch_name: &branch_name, worktree_path: &gateway.working_directory,
        publish_command: &publish_command, artifact_pattern: &settings.delivery.artifact_pattern, workflow: workflow.as_ref(),
    });
    launch(host, dir, issue_key, connection_id.as_deref(), task, &gateway.working_directory, json!({
        "phase": "implementation", "baseBranch": base_branch, "worktreeName": branch_name, "worktreePath": gateway.working_directory,
        "createdBranch": branch_name, "publishCommand": publish_command, "artifactPattern": settings.delivery.artifact_pattern,
    }))
}

fn decompose_feature(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let issue_key = text(args, 0)?;
    let connection_id = optional_text(args, 1);
    let gateway = require_gateway_and_working_directory(host)?;
    require_confirmed_analysis(host, dir, issue_key)?;
    let issue = get_issue(host, issue_key, connection_id.as_deref())?;
    if !is_feature_request_ticket(&issue) {
        return Err(failure(format!("{issue_key} is not marked as a feature request (its description must mention \"feature request\").")));
    }
    let base_branch = resolve_base_branch(host, &issue)?;
    let available = super::workflow_packs::discover(Some(Path::new(&gateway.working_directory)));
    let workflow = assigned_workflow(host, issue_key);
    let task = build_feature_decomposition_task(&issue, &base_branch, &gateway.working_directory, &available, workflow.as_ref());
    launch(host, dir, issue_key, connection_id.as_deref(), task, &gateway.working_directory, json!({
        "phase": "feature-decomposition", "baseBranch": base_branch, "worktreeName": "", "worktreePath": gateway.working_directory,
        "createdBranch": "", "publishCommand": "", "artifactPattern": "",
    }))
}

fn start_sub_task_delivery(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let parent_key = text(args, 0)?;
    let sub_task_key = text(args, 1)?;
    let connection_id = optional_text(args, 2);
    let gateway = require_gateway_and_working_directory(host)?;
    let parent = store(dir).get(parent_key)?.unwrap_or(Value::Null);
    let decomposition = parent["delivery"]["featureDecomposition"].clone();
    if !decomposition.is_object() {
        return Err(failure(format!("{parent_key} has no recorded feature decomposition.")));
    }
    let record = decomposition["subTasks"].as_array().into_iter().flatten().find(|r| r["issueKey"] == sub_task_key).cloned().ok_or_else(|| failure(format!("{sub_task_key} is not a recorded sub-task of {parent_key}.")))?;
    let issue = get_issue(host, sub_task_key, connection_id.as_deref())?;
    let branch_name = non_empty(&issue["branch"]).map_or_else(|| format!("feature/{}", sub_task_key.to_lowercase()), str::to_owned);
    let feature_branch = decomposition["featureBranch"].as_str().unwrap_or_default().to_owned();
    let workflow = assigned_workflow(host, sub_task_key).or_else(|| Some(record["workflow"].clone()).filter(Value::is_object));
    let task = build_sub_task_delivery_task(&issue, &DeliveryOptions {
        base_branch: &feature_branch, branch_name: &branch_name, worktree_path: &gateway.working_directory, publish_command: "", artifact_pattern: "", workflow: workflow.as_ref(),
    });
    let session = launch(host, dir, sub_task_key, connection_id.as_deref(), task, &gateway.working_directory, json!({
        "phase": "implementation", "baseBranch": feature_branch, "worktreeName": branch_name, "worktreePath": gateway.working_directory,
        "createdBranch": branch_name, "publishCommand": "", "artifactPattern": "", "parentFeatureIssueKey": parent_key,
    }))?;
    update_sub_task_record(host, dir, parent_key, sub_task_key, &json!({ "deliveryState": "in-progress", "worktreeBranch": branch_name }));
    Ok(session)
}

// ── merge requests (GitLab) ──────────────────────────────────────────────

fn gitlab_api(host: &HostContext, connection_id: &str) -> Result<GitLabApiService> {
    let catalog = super::storage::Catalog::load_readonly(&host.config().user_data_dir, &host.config().settings_path)?;
    let connection = super::connections::require(&catalog, connection_id).map_err(|_| failure("Merge requests require a GitLab connection."))?;
    if connection["mode"] != "gitlab" {
        return Err(failure("Merge requests require a GitLab connection."));
    }
    let input = super::connections::tracker_input(host, &connection)?;
    let config = &input["gitlabConfig"];
    let (base_url, project_path, token) = (config["url"].as_str().unwrap_or_default().trim(), config["projectPath"].as_str().unwrap_or_default(), config["apiKey"].as_str().unwrap_or_default().trim());
    if base_url.is_empty() || project_path.is_empty() || token.is_empty() {
        return Err(failure("The GitLab connection is missing its URL, project path, or API key."));
    }
    Ok(GitLabApiService::new(GitLabApiConfig { base_url: base_url.to_owned(), project_path: project_path.to_owned(), token: token.to_owned() }))
}

fn api_failure(error: impl ToString) -> praxis_contracts::RustRpcError {
    failure(error)
}

fn merge_request_snapshot(mr: &Value, extra: Option<(&str, Value)>) -> Value {
    let mut snapshot = json!({
        "iid": mr["iid"], "webUrl": mr["webUrl"], "title": mr["title"], "sourceBranch": mr["sourceBranch"], "targetBranch": mr["targetBranch"],
        "state": mr["state"], "createdAt": mr["createdAt"], "updatedAt": mr["updatedAt"], "lastSeenAt": super::now(),
    });
    if let Some((field, value)) = extra {
        snapshot[field] = value;
    }
    snapshot
}

fn list_merge_requests(host: &HostContext, args: &[Value]) -> Result<Value> {
    let issue_key = text(args, 0)?;
    let api = gitlab_api(host, text(args, 1)?)?;
    let merge_requests = super::runtime::block_on(api.list_merge_requests_for_issue(issue_key)).map_err(api_failure)?;
    Ok(serde_json::to_value(merge_requests).unwrap_or(Value::Null))
}

fn create_merge_request(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let issue_key = text(args, 0)?;
    let connection_id = text(args, 1)?;
    let api = gitlab_api(host, connection_id)?;
    let issue = get_issue(host, issue_key, Some(connection_id))?;
    let session = store(dir).get(issue_key)?.unwrap_or(Value::Null);
    let delivery = &session["delivery"];
    let source_branch = non_empty(&delivery["createdBranch"]).or_else(|| non_empty(&issue["branch"])).unwrap_or_default().to_owned();
    if source_branch.is_empty() {
        return Err(failure(format!("No branch is recorded for {issue_key} — run a delivery first.")));
    }
    let existing = super::runtime::block_on(api.list_merge_requests_for_source_branch(&source_branch)).map_err(api_failure)?;
    if let Some(open) = existing.iter().find(|mr| mr.state == "opened") {
        return Ok(serde_json::to_value(open).unwrap_or(Value::Null));
    }
    let created = super::runtime::block_on(api.create_merge_request(&CreateGitLabMergeRequestInput {
        source_branch: source_branch.clone(),
        target_branch: non_empty(&delivery["baseBranch"]).unwrap_or("main").to_owned(),
        title: format!("{}: {}", issue["key"].as_str().unwrap_or(issue_key), issue["summary"].as_str().unwrap_or_default()),
        description: issue["description"].as_str().map(|d| truncate(d, 2000)),
        remove_source_branch: true,
    }))
    .map_err(api_failure)?;
    let value = serde_json::to_value(&created).unwrap_or(Value::Null);
    if delivery.is_object() {
        update_delivery(host, dir, issue_key, json!({ "mergeRequest": merge_request_snapshot(&value, None) }));
    }
    Ok(value)
}

fn check_merge_request_feedback(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let issue_key = text(args, 0)?;
    let connection_id = text(args, 1)?;
    let api = gitlab_api(host, connection_id)?;
    let none = json!({ "started": false, "noteCount": 0 });
    let merge_requests = super::runtime::block_on(api.list_merge_requests_for_issue(issue_key)).map_err(api_failure)?;
    let Some(open) = merge_requests.iter().find(|mr| mr.state == "opened") else { return Ok(none) };
    let notes = super::runtime::block_on(api.list_merge_request_discussions(open.iid)).map_err(api_failure)?;
    let handled = store(dir).get(issue_key)?.map(|s| s["delivery"]["mergeRequest"]["handledNotes"].clone()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    let fresh: Vec<_> = notes.iter().filter(|n| !n.system && !is_praxis_managed_merge_request_note(&n.body)).filter(|n| handled[n.id.as_str()].as_str() != Some(n.updated_at.as_str())).collect();
    if fresh.is_empty() {
        return Ok(none);
    }

    let gateway = require_gateway_and_working_directory(host)?;
    let issue = get_issue(host, issue_key, Some(connection_id))?;
    let workflow = assigned_workflow(host, issue_key);
    let notes_for_task: Vec<FeedbackNote> = fresh.iter().map(|n| FeedbackNote { author: n.author.clone(), body: n.body.clone(), updated_at: n.updated_at.clone() }).collect();
    let task = build_merge_request_feedback_task(&issue, &open.source_branch, &gateway.working_directory, &open.web_url, &open.source_branch, &open.target_branch, &notes_for_task, workflow.as_ref());
    // The addressed notes are marked handled up front; the completion watcher posts the reply.
    let mut handled_notes = handled.as_object().cloned().unwrap_or_default();
    for note in &fresh {
        handled_notes.insert(note.id.clone(), json!(note.updated_at));
    }
    let open_value = serde_json::to_value(open).unwrap_or(Value::Null);
    launch(host, dir, issue_key, Some(connection_id), task, &gateway.working_directory, json!({
        "phase": "merge-request-feedback", "baseBranch": open.target_branch, "worktreeName": open.source_branch, "worktreePath": gateway.working_directory,
        "createdBranch": open.source_branch, "publishCommand": "", "artifactPattern": "",
        "mergeRequest": merge_request_snapshot(&open_value, Some(("handledNotes", Value::Object(handled_notes)))),
    }))?;
    Ok(json!({ "started": true, "noteCount": fresh.len() }))
}

// ── the completion watcher ───────────────────────────────────────────────

fn is_settled(state: Option<&str>) -> bool {
    matches!(state, Some("completed" | "failed" | "aborted"))
}

/// Waits for the workflow session to settle, then finalizes it once. The `pending` finalization
/// state is the guard: every `update_delivery` below changes the record, and none of them may
/// re-enter finalization.
fn spawn_watcher(host: &HostContext, dir: &Path, issue_key: &str) {
    let (host, dir, key) = (host.clone(), dir.to_path_buf(), issue_key.to_owned());
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(8 * 60 * 60);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
            let Ok(Some(record)) = store(&dir).get(&key) else { return };
            if record["delivery"]["finalizationState"] != "pending" {
                return;
            }
            if is_settled(record["state"].as_str()) {
                if let Err(error) = finalize_workflow_session(&host, &dir, &record) {
                    eprintln!("[ai-workflows] finalization failed for {key}: {}", error.message);
                    update_delivery(&host, &dir, &key, json!({ "finalizationState": "failed", "finalizationMessage": error.message }));
                }
                return;
            }
        }
    });
}

fn finalize_workflow_session(host: &HostContext, dir: &Path, record: &Value) -> Result<()> {
    let issue_key = record["issueKey"].as_str().unwrap_or_default();
    let delivery = &record["delivery"];
    let parent = delivery["parentFeatureIssueKey"].as_str().map(str::to_owned);
    let fail = |message: String| update_delivery(host, dir, issue_key, json!({ "finalizationState": "failed", "finalizationMessage": message }));

    if record["state"] != "completed" {
        fail(format!("Agent session ended in state \"{}\".", record["state"].as_str().unwrap_or("unknown")));
        if let Some(parent) = &parent {
            update_sub_task_record(host, dir, parent, issue_key, &json!({ "deliveryState": "failed" }));
        }
        return Ok(());
    }
    let response = record["responseText"].as_str();
    match delivery["phase"].as_str().unwrap_or_default() {
        "implementation" => {
            let result = parse_delivery_task_result(response);
            match &result {
                None => fail("The agent finished without a parseable DELIVERY_RESULT block.".to_owned()),
                Some(result) => {
                    let success = result["status"] == "success";
                    let message = if success { result["summary"].clone() } else { result.get("failureReason").cloned().unwrap_or_else(|| result["summary"].clone()) };
                    update_delivery(host, dir, issue_key, json!({
                        "finalizationState": if success { "completed" } else { "failed" }, "finalizationMessage": message,
                        "result": result, "uploadedArtifactNames": result["artifactPaths"],
                    }));
                }
            }
            if let Some(parent) = &parent {
                let ok = result.as_ref().is_some_and(|r| r["status"] == "success");
                update_sub_task_record(host, dir, parent, issue_key, &json!({ "deliveryState": if ok { "completed" } else { "failed" } }));
            }
        }
        "feature-decomposition" => {
            let Some(result) = parse_feature_decomposition_result(response).filter(|r| r["status"] == "decomposed") else {
                let blockers = parse_feature_decomposition_result(response).and_then(|r| r["blockers"].as_array().map(|b| b.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; "))).filter(|b| !b.is_empty());
                fail(blockers.unwrap_or_else(|| "The agent finished without a parseable FEATURE_DECOMPOSITION_RESULT block.".to_owned()));
                return Ok(());
            };
            let connection_id = delivery["connectionId"].as_str();
            let available = super::workflow_packs::discover(delivery["worktreePath"].as_str().map(Path::new));
            let project_key = issue_key.split('-').next().unwrap_or(issue_key).to_owned();
            let mut sub_tasks: Vec<Value> = Vec::new();
            for sub_task in result["subTasks"].as_array().into_iter().flatten() {
                let created = super::activity::run_as_agent(|| {
                    host_call(host, "issue:create", vec![
                        json!({ "projectKey": project_key, "issueType": sub_task["issueType"].as_str().filter(|t| !t.is_empty()).unwrap_or("Task"), "summary": sub_task["summary"], "description": sub_task["description"], "parentKey": issue_key }),
                        connection_id.map_or(Value::Null, |c| json!(c)),
                    ])
                })?;
                let created_key = created["key"].as_str().unwrap_or_default().to_owned();
                let workflow = resolve_workflow_reference(sub_task["suggestedWorkflow"].as_str(), &available);
                if let Some(workflow) = &workflow {
                    let _ = super::workflow_packs::assign(host, &created_key, Some(workflow.clone()), "analysis");
                }
                let mut entry = json!({ "issueKey": created_key, "summary": created["summary"], "order": sub_task["order"], "deliveryState": "pending" });
                if let Some(workflow) = workflow {
                    entry["workflow"] = workflow;
                }
                sub_tasks.push(entry);
            }
            update_delivery(host, dir, issue_key, json!({
                "finalizationState": "completed", "finalizationMessage": result["summary"], "createdBranch": result["featureBranch"],
                "featureDecomposition": {
                    "parentIssueKey": issue_key, "featureBranch": result["featureBranch"], "baseBranch": delivery["baseBranch"],
                    "subTasks": sub_tasks, "decompositionSummary": result["summary"],
                },
            }));
        }
        "merge-request-feedback" => {
            let Some(result) = parse_merge_request_feedback_result(response).filter(|r| r["status"] == "success") else {
                let reason = parse_merge_request_feedback_result(response).and_then(|r| r["failureReason"].as_str().map(str::to_owned));
                fail(reason.unwrap_or_else(|| "The agent finished without a parseable MERGE_REQUEST_FEEDBACK_RESULT block.".to_owned()));
                return Ok(());
            };
            if let (Some(reply), Some(connection_id), Some(iid)) = (result["replyComment"].as_str(), delivery["connectionId"].as_str(), delivery["mergeRequest"]["iid"].as_u64()) {
                let api = gitlab_api(host, connection_id)?;
                super::runtime::block_on(api.add_merge_request_note(iid, &wrap_praxis_managed_merge_request_note(reply))).map_err(api_failure)?;
            }
            update_delivery(host, dir, issue_key, json!({ "finalizationState": "completed", "finalizationMessage": result["summary"] }));
        }
        // On desktop the analysis chat is the analysis surface; just close the finalization out.
        "analysis" => update_delivery(host, dir, issue_key, json!({ "finalizationState": "completed", "finalizationMessage": "Analysis session completed." })),
        _ => {}
    }
    Ok(())
}

// ── local peer review ────────────────────────────────────────────────────

const CODE_REVIEW_PROMPT: &str = "You are a senior software engineer. Review the implementation for correctness, maintainability, architecture, tests, and performance. Rate findings by severity.";
const SECURITY_REVIEW_PROMPT: &str = "You are a security engineer. Review for OWASP risks, authorization issues, data exposure, input validation, dependency concerns, and secrets handling. Rate findings by severity.";
const SUMMARY_PROMPT: &str = "You are a technical lead. Summarize the supplied code and security reviews with an overall Ready, Needs Changes, or Needs Major Rework verdict and concise next steps.";
const FOLLOW_UP_PROMPT: &str = "You are continuing a local peer review conversation. Answer the user's follow-up directly and concisely. Keep the discussion grounded in the reviewed local project and do not modify files.";

/// One ticket review on the selected API provider (`reviewIssueWithRuntime`).
fn review_issue(host: &HostContext, issue: &Value, provider: &str, model: Option<&str>, system_prompt: &str, user_prompt: Option<&str>) -> Result<String> {
    let (connection, default_model) = super::ai_providers::api_connection(host, provider)
        .map_err(|e| if e.message.contains("CLI-hosted") { failure("The local peer review needs an API provider; the selected provider is CLI-hosted. Choose an API provider in Settings → AI Provider.") } else { e })?;
    if connection.options.api_key.as_deref().is_none_or(|k| k.trim().is_empty()) && matches!(provider, "vercel-gateway" | "openai" | "anthropic" | "gemini" | "z-ai") {
        return Err(failure(format!("No {} API key configured. Add one under Settings → AI Provider.", connection.label)));
    }
    let model = model.map(str::trim).filter(|m| !m.is_empty()).map_or(default_model, str::to_owned);
    let agent_name = Some(host.settings().read().ai.agent_name.trim().to_owned()).filter(|n| !n.is_empty()).unwrap_or_else(|| connection.label.clone());
    let system = [Some(system_prompt.trim().to_owned()), user_prompt.map(str::trim).filter(|p| !p.is_empty()).map(|p| format!("User follow-up:\n{p}"))].into_iter().flatten().collect::<Vec<_>>().join("\n\n");
    let prompt = format!("Please review this ticket and provide feedback on its completeness and clarity:\n\n{}", super::ai_review::ticket_context(issue, 5, false, 600));
    let (content, _) = super::runtime::block_on(super::api_host::run_provider_prompt(&connection, &model, &system, &prompt, None, |_| {})).map_err(failure)?;
    Ok(format!("## AI Review by {agent_name}\n\n{}", content.trim()))
}

fn local_peer_review(host: &HostContext, args: &[Value]) -> Result<Value> {
    let issue_key = text(args, 0)?;
    let issue = get_issue(host, issue_key, optional_text(args, 1).as_deref())?;
    let provider = optional_text(args, 2).unwrap_or_else(|| host.settings().read().ai.active_provider.clone());
    let model = optional_text(args, 3);
    let code_review = review_issue(host, &issue, &provider, model.as_deref(), CODE_REVIEW_PROMPT, None)?;
    let security_review = review_issue(host, &issue, &provider, model.as_deref(), SECURITY_REVIEW_PROMPT, None)?;
    let mut for_summary = issue.clone();
    for_summary["description"] = json!(format!("{}\n\nCode review:\n{code_review}\n\nSecurity review:\n{security_review}", issue["description"].as_str().unwrap_or_default()));
    let summary = review_issue(host, &for_summary, &provider, model.as_deref(), SUMMARY_PROMPT, None)?;
    Ok(json!({ "codeReview": code_review, "securityReview": security_review, "summary": summary }))
}

fn local_peer_review_follow_up(host: &HostContext, args: &[Value]) -> Result<Value> {
    let issue_key = text(args, 0)?;
    let message = text(args, 1)?.trim().to_owned();
    if message.is_empty() {
        return Err(failure("Enter a follow-up question."));
    }
    let issue = get_issue(host, issue_key, optional_text(args, 2).as_deref())?;
    let provider = optional_text(args, 3).unwrap_or_else(|| host.settings().read().ai.active_provider.clone());
    Ok(json!(review_issue(host, &issue, &provider, optional_text(args, 4).as_deref(), FOLLOW_UP_PROMPT, Some(&message))?))
}

pub fn dispatch(host: &HostContext, dir: &Path, channel: &str, args: &[Value]) -> Option<Result<Value>> {
    Some(match channel {
        "ai:localPeerReview" => local_peer_review(host, args),
        "ai:localPeerReviewFollowUp" => local_peer_review_follow_up(host, args),
        "ai:startDelivery" => start_delivery(host, dir, args),
        "ai:decomposeFeature" => decompose_feature(host, dir, args),
        "ai:startSubTaskDelivery" => start_sub_task_delivery(host, dir, args),
        "ai:listMergeRequests" => list_merge_requests(host, args),
        "ai:createMergeRequest" => create_merge_request(host, dir, args),
        "ai:checkMergeRequestFeedback" => check_merge_request_feedback(host, dir, args),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_branch_prefers_the_newest_comment_over_the_description() {
        let issue = json!({
            "description": "Base branch: develop",
            "comments": [
                { "body": "Branch: release/1.0", "created": "2026-01-01T00:00:00Z" },
                { "body": "**Base branch:** `release/2.0`", "created": "2026-02-01T00:00:00Z" },
            ],
        });
        assert_eq!(extract_delivery_base_branch(&issue).as_deref(), Some("release/2.0"));
        assert_eq!(extract_delivery_base_branch(&json!({ "description": "Base branch: develop" })).as_deref(), Some("develop"));
        assert_eq!(extract_delivery_base_branch(&json!({ "description": "Branch: has spaces" })), None);
        assert_eq!(extract_delivery_base_branch(&json!({ "description": "nothing here" })), None);
    }

    #[test]
    fn delivery_settings_report_every_missing_piece() {
        assert!(validate_delivery_settings(true, "publish.ps1", "dist/*.msi").is_empty());
        assert_eq!(validate_delivery_settings(false, "", "").len(), 3);
    }

    #[test]
    fn a_powershell_file_command_runs_from_the_worktree() {
        let resolved = resolve_delivery_publish_command("pwsh -NoProfile -File .\\scripts\\publish.ps1 -Config Release", "C:\\work\\repo");
        assert_eq!(resolved, "pwsh -NoProfile -Command \"& { Set-Location -LiteralPath 'C:\\work\\repo'; & 'C:\\work\\repo\\scripts\\publish.ps1' -Config Release }\"");
        assert_eq!(resolve_delivery_publish_command("make publish", "/tmp/x"), "make publish");
        assert_eq!(resolve_delivery_publish_command("  ", "/tmp/x"), "");
        assert_eq!(win32_resolve("C:\\a\\b", "..\\c.ps1"), "C:\\a\\c.ps1");
    }

    #[test]
    fn delivery_result_needs_a_branch_artifacts_and_a_reason_on_failure() {
        let ok = "Done.\n\nDELIVERY_RESULT\n```json\n{\"status\":\"success\",\"summary\":\"Shipped\",\"branch\":\"feature/demo-1\",\"commitHash\":\"abc\",\"buildIdentifier\":\"01\",\"artifactPaths\":[\"dist/app.msi\"]}\n```";
        let result = parse_delivery_task_result(Some(ok)).expect("parses");
        assert_eq!((result["status"].as_str(), result["branch"].as_str(), result["artifactPaths"][0].as_str(), result["commitHash"].as_str()), (Some("success"), Some("feature/demo-1"), Some("dist/app.msi"), Some("abc")));
        let no_artifacts = ok.replace("\"dist/app.msi\"", "");
        assert!(parse_delivery_task_result(Some(&no_artifacts)).is_none());
        let failed = "DELIVERY_RESULT\n```json\n{\"status\":\"failure\",\"summary\":\"No\",\"branch\":\"b\"}\n```";
        assert!(parse_delivery_task_result(Some(failed)).is_none());
        let failed_ok = "DELIVERY_RESULT\n```json\n{\"status\":\"failure\",\"summary\":\"No\",\"branch\":\"b\",\"failureReason\":\"tests\"}\n```";
        assert_eq!(parse_delivery_task_result(Some(failed_ok)).expect("parses")["failureReason"], "tests");
        assert!(parse_delivery_task_result(Some("no block")).is_none() && parse_delivery_task_result(None).is_none());
        // The last marker wins, so an earlier example block in the transcript is ignored.
        let two = format!("DELIVERY_RESULT\n```json\n{{\"status\":\"x\"}}\n```\n{ok}");
        assert!(parse_delivery_task_result(Some(&two)).is_some());
    }

    #[test]
    fn decomposition_result_orders_sub_tasks_and_validates_blocks() {
        let reply = "FEATURE_DECOMPOSITION_RESULT\n```json\n{\"status\":\"decomposed\",\"summary\":\"Two\",\"featureBranch\":\"feature/x\",\"subTasks\":[{\"summary\":\"B\",\"order\":2},{\"summary\":\"A\",\"description\":\"d\",\"suggestedWorkflow\":\"dotnet\",\"order\":1},{\"summary\":\"\"}]}\n```";
        let result = parse_feature_decomposition_result(Some(reply)).expect("parses");
        let titles: Vec<_> = result["subTasks"].as_array().expect("array").iter().map(|t| t["summary"].as_str().unwrap_or_default()).collect();
        assert_eq!(titles, ["A", "B"]);
        assert_eq!((result["subTasks"][0]["issueType"].as_str(), result["subTasks"][0]["suggestedWorkflow"].as_str()), (Some("Task"), Some("dotnet")));
        let blocked = "```json\n{\"status\":\"blocked\",\"summary\":\"S\",\"blockers\":[\"unclear\"]}\n```";
        assert_eq!(parse_feature_decomposition_result(Some(blocked)).expect("parses")["blockers"][0], "unclear");
        let no_blockers = "```json\n{\"status\":\"blocked\",\"summary\":\"S\"}\n```";
        assert!(parse_feature_decomposition_result(Some(no_blockers)).is_none());
        let no_branch = "```json\n{\"status\":\"decomposed\",\"summary\":\"S\",\"subTasks\":[{\"summary\":\"A\"}]}\n```";
        assert!(parse_feature_decomposition_result(Some(no_branch)).is_none());
    }

    #[test]
    fn merge_request_feedback_result_needs_a_reply_when_successful() {
        let ok = "MERGE_REQUEST_FEEDBACK_RESULT\n```json\n{\"status\":\"success\",\"summary\":\"S\",\"branch\":\"b\",\"replyComment\":\"Done\",\"didEditCode\":true}\n```";
        let result = parse_merge_request_feedback_result(Some(ok)).expect("parses");
        assert_eq!((result["replyComment"].as_str(), result["didEditCode"].as_bool()), (Some("Done"), Some(true)));
        assert!(parse_merge_request_feedback_result(Some(&ok.replace(",\"replyComment\":\"Done\"", ""))).is_none());
    }

    #[test]
    fn feature_requests_are_recognised_by_their_description() {
        assert!(is_feature_request_ticket(&json!({ "description": "  This is a Feature Request: split me" })));
        assert!(!is_feature_request_ticket(&json!({ "description": "a bug" })) && !is_feature_request_ticket(&json!({})));
    }

    #[test]
    fn workflow_references_match_exactly_then_uniquely_by_part() {
        let packs = vec![json!({ "id": "dotnet-api", "name": "dotnet-api" }), json!({ "id": "react-ui", "name": "React UI" })];
        assert_eq!(resolve_workflow_reference(Some("React UI"), &packs).expect("exact")["id"], "react-ui");
        assert_eq!(resolve_workflow_reference(Some("use the .NET API pack"), &packs).expect("partial")["id"], "dotnet-api");
        assert!(resolve_workflow_reference(Some("go"), &packs).is_none());
        assert!(resolve_workflow_reference(Some("  "), &packs).is_none() && resolve_workflow_reference(None, &packs).is_none());
    }

    #[test]
    fn task_contracts_carry_the_result_marker_and_the_workflow() {
        let issue = json!({ "key": "DEMO-1", "summary": "Do it", "description": "Details" });
        let workflow = json!({ "id": "dotnet-api", "name": "dotnet-api" });
        let options = DeliveryOptions { base_branch: "main", branch_name: "feature/demo-1", worktree_path: "/w", publish_command: "publish.ps1", artifact_pattern: "dist/*.msi", workflow: Some(&workflow) };
        let delivery = build_delivery_task(&issue, &options);
        assert_eq!((delivery["kind"].as_str(), delivery["workflow"]["id"].as_str(), delivery["maxSteps"].as_u64()), (Some("jira-delivery"), Some("dotnet-api"), Some(700)));
        assert!(delivery["completionContract"].as_str().unwrap_or_default().contains("DELIVERY_RESULT") && delivery["definitionOfDone"].as_str().unwrap_or_default().contains("publish.ps1"));
        let sub = build_sub_task_delivery_task(&issue, &DeliveryOptions { workflow: None, ..options });
        assert!(sub.get("workflow").is_none() && sub["definitionOfDone"].as_str().unwrap_or_default().contains("Do NOT run publish"));
        let decomposition = build_feature_decomposition_task(&issue, "main", "/w", &[workflow], None);
        assert!(decomposition["scope"].as_str().unwrap_or_default().contains("- dotnet-api (dotnet-api): no description") && decomposition["scope"].as_str().unwrap_or_default().contains("feature/demo-1-<short-slug>"));
        let feedback = build_merge_request_feedback_task(&issue, "b", "/w", "http://mr", "b", "main", &[FeedbackNote { author: "ann".into(), body: "why?".into(), updated_at: "t".into() }], None);
        assert!(feedback["scope"].as_str().unwrap_or_default().contains("1. ann (t): why?"));
    }
}
