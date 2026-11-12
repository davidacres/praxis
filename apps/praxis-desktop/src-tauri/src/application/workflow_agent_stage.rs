//! Agent stages as real, attributed sessions (`workflowAgentStage.ts`, `workflowStageTask.ts` port).
//!
//! A stage starts a session on whichever host its provider needs (an ACP CLI agent or an API
//! provider), keyed by the run and node so a replay re-attaches rather than forking. The brief is
//! closed: the stage's own instructions, the artifacts it was given and the ones it must produce.
//! When the session settles the worktree of a mutating stage is frozen as a commit and the outcome
//! is read from the session.

use std::path::{Path, PathBuf};
use std::time::Duration;

use praxis_ai::providers::registry::{DescriptorKind, built_in_descriptors};
use praxis_host::HostContext;
use praxis_workflows::orchestrator::{StageDispatchContext, StageOutcome};
use praxis_workflows::run::{DeclaredArtifact, WorkflowPauseReason, WorkflowRun, stage_provider};
use praxis_workflows::stage_model::{ModelTierMap, StageModelNode, choose_stage_model, named_model};
use praxis_workflows::stage_session::find_snapshot;
use praxis_workflows::types::{
    CheckFinding, CheckFindingSeverity, CheckFindings, FindingVerdict, WorkflowAgentTaskNode,
    WorkflowArtifactContract, WorkflowArtifactKind, compute_finding_fingerprint,
};
use serde_json::{Value, json};
use tokio::process::Command;

use super::acp_host::{self, StartTask, is_terminal};
use super::session_store::store;
use super::workflow_summary::stage_session_key;

const STAGE_STATUS_INSTRUCTIONS: &str = "If something outside your control stops you doing this stage (a missing tool, service, credential or dependency you may not provide), do not present a report of that as the stage's result. A test or check that is explicitly optional, or that has a documented skip path when a live service or credential is unavailable, is not a blocker: leave it skipped with the reason, do not request credentials for it, and continue the rest of the stage. Do not report blocked-environment for missing code, types, coordinators, IPC handlers, or features that are part of this ticket's work to build. Implementing missing parts is this stage's objective. Do not report blocked-environment due to shell output truncation: read files in smaller slices or use targeted searches instead. End your response with this line on its own only when a genuine environment blocker prevents execution: `Stage status: blocked-environment: <what is missing and what a person must do>`.";

const FINDINGS_BLOCK_INSTRUCTIONS: &str = "A findings output is delivered as the last fenced ```json block of your response, in this shape:\n```json\n{ \"summary\": \"One-paragraph assessment\", \"findings\": [ { \"file\": \"path/from/repo/root\", \"line\": 42, \"severity\": \"critical\" | \"high\" | \"medium\" | \"low\" | \"info\", \"category\": \"e.g. security\", \"message\": \"What is wrong and why it matters\", \"suggestion\": \"The concrete fix\" } ] }\n```\nUse an empty \"findings\" array when there are none. Prose alone does not count.";

const PLAN_STATUS_INSTRUCTIONS: &str = "Deliver the complete markdown plan in your final response. Praxis captures that response as the plan artifact; do not create or write a plan file, and no writable artifact tool is needed.\nConfirm a plan output with this line on its own, after the plan itself (and before any fenced block the response must end with): `Plan status: ready`.\nIf you could not produce the plan, do not present a partial one as finished: write `Plan status: blocked: <why>` in its place.";

const ROLE_RULE_IMPLEMENT: &str = "Implement the planned changes directly in this codebase. Even if surrounding components are missing, author the required types, interfaces, coordinators, adapters, or modules according to the plan. Never refuse or report blocked-environment because codebase components need to be created. You are running autonomously with full tool and edit permissions in an isolated git worktree. Do not end your turn with a preliminary summary or wait for approval. Execute the edits, run local verification, and commit your changes in git before finishing.";

// ── git helpers ──────────────────────────────────────────────────────────

async fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

async fn head_of(worktree: &Path) -> Option<String> {
    git(worktree, &["rev-parse", "HEAD"]).await.ok().filter(|s| !s.is_empty())
}

/// Commits whatever the stage changed and returns the sha: the stage's immutable snapshot.
async fn freeze_worktree(worktree: &Path, stage_name: &str) -> Option<String> {
    let status = git(worktree, &["status", "--porcelain"]).await.ok()?;
    if !status.trim().is_empty() {
        git(worktree, &["add", "-A"]).await.ok()?;
        git(
            worktree,
            &[
                "-c",
                "user.name=Praxis",
                "-c",
                "user.email=praxis@localhost",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--no-verify",
                "-m",
                &format!("{stage_name} (workflow stage)"),
            ],
        )
        .await
        .ok()?;
    }
    head_of(worktree).await
}

// ── the stage brief ──────────────────────────────────────────────────────

struct StageInput {
    node_id: String,
    contract_id: String,
    kind: String,
    path: Option<String>,
}

fn kind_name(kind: WorkflowArtifactKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn first_line(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or("");
    if line.chars().count() > 200 {
        format!("{}…", line.chars().take(200).collect::<String>())
    } else {
        line.to_string()
    }
}

/// The task contract for a stage (`buildStageTaskDefinition`).
fn build_task_definition(
    run: &WorkflowRun,
    node: &WorkflowAgentTaskNode,
    inputs: &[StageInput],
    snapshot: Option<(String, String)>,
) -> Value {
    let input_lines = if inputs.is_empty() {
        "- none".to_string()
    } else {
        inputs
            .iter()
            .map(|i| {
                format!(
                    "- {} \"{}\"{}",
                    i.kind,
                    i.contract_id,
                    i.path.as_ref().map(|p| format!(" at {p}")).unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let output_lines = if node.outputs.is_empty() {
        "- none".to_string()
    } else {
        node.outputs
            .iter()
            .map(|o| {
                format!(
                    "- {} \"{}\"{}",
                    kind_name(o.kind),
                    o.id,
                    if o.required { " (required)" } else { " (optional)" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut scope = vec![format!(
        "You are running the \"{}\" stage of a governed delivery workflow.",
        node.base.name
    )];
    if let Some((reference, produced_by)) = snapshot {
        scope.push(format!(
            "Inspect the frozen implementation snapshot {reference} (produced by \"{produced_by}\"), not the live branch."
        ));
    }
    scope.push(format!("Inputs available to you:\n{input_lines}"));

    let has = |kind: WorkflowArtifactKind| node.outputs.iter().any(|o| o.kind == kind);
    let publishes = node.outputs.iter().any(|o| o.publish_to.is_some());
    let mut done = vec![format!(
        "Produce every required artifact before finishing:\n{output_lines}"
    )];
    if has(WorkflowArtifactKind::Findings) {
        done.push(FINDINGS_BLOCK_INSTRUCTIONS.to_string());
    }
    if node
        .outputs
        .iter()
        .any(|o| o.kind == WorkflowArtifactKind::Plan && o.publish_to.is_none())
    {
        done.push(PLAN_STATUS_INSTRUCTIONS.to_string());
    }
    if has(WorkflowArtifactKind::Diff) {
        done.push(ROLE_RULE_IMPLEMENT.to_string());
    }
    done.push(STAGE_STATUS_INSTRUCTIONS.to_string());

    let instructions = node.instructions.trim();
    let mut goal = if instructions.is_empty() {
        format!("Complete the {} stage.", node.base.name)
    } else {
        instructions.to_string()
    };
    if run.scheduled_launch_token.is_some() {
        goal.push_str("\n\nScheduled-run policy: release-level full functional/theme suites, live API proofs, and manual theme passes are optional and must not block this run. Do not request live API credentials or pause for those checks. Record them as not run, complete the ticket’s implementation, and continue to downstream workflow stages. QA will run only ticket-changed test files.");
    }
    let kind = if has(WorkflowArtifactKind::Diff) {
        Some("implementation")
    } else if has(WorkflowArtifactKind::Findings) {
        Some("review")
    } else {
        None
    };
    let _ = publishes;
    let mut task = json!({
        "goal": goal,
        "scope": scope.join("\n\n"),
        "definitionOfDone": done.join("\n\n"),
        "nonGoals": [
            "Do not advance, approve, or skip any other stage of this workflow.",
            "Do not modify the workflow definition itself.",
            "Do not link, copy or install dependencies from outside this working directory (such as a symlink to another checkout's node_modules). If packages are missing, say so in your report; the workflow's install stage provides them.",
            "Put throwaway files (scratch scripts, one-off test specs, captures, logs) in the system temporary directory, not in this working directory, and never commit them."
        ],
    });
    if let Some(kind) = kind {
        task["kind"] = json!(kind);
    }
    if run.scheduled_launch_token.is_some() {
        task["scheduledRun"] = json!(true);
    }
    task
}

const REFUSAL_CONTINUATION: &str = "Your last command was refused because this stage is read-only, and that ended your turn before you finished. You can still read: use your file read and search tools, or shell commands that only read (git status, log, diff and show; ls, cat, head, grep, rg, find without -exec; sed -n). Do not run tests, builds, installs or scripts. Continue the stage from where you stopped and produce every required output.";

/// How many tools the stage's session has had refused for being read-only.
fn read_only_refusals(dir: &Path, key: &str) -> usize {
    store(dir)
        .get(key)
        .ok()
        .flatten()
        .and_then(|r| r["events"].as_array().cloned())
        .map_or(0, |events| {
            events
                .iter()
                .filter(|e| {
                    e["type"] == "warning"
                        && e["summary"]
                            .as_str()
                            .is_some_and(|s| s.starts_with("Blocked by read-only tools"))
                })
                .count()
        })
}

fn stage_name(run: &WorkflowRun, node_id: &str) -> String {
    run.definition
        .nodes
        .iter()
        .find(|n| n.base().id == node_id)
        .map_or_else(|| node_id.to_string(), |n| n.base().name.clone())
}

/// Upstream reports or logs inline, each capped to its head and tail (`formatUpstreamReports/Logs`).
fn format_upstream(
    heading: &str,
    items: &[(String, String, String)],
    max_chars: usize,
    fenced: bool,
) -> Option<String> {
    let blocks: Vec<String> = items
        .iter()
        .filter(|(_, _, text)| !text.trim().is_empty())
        .map(|(contract, stage, text)| {
            let text = text.trim();
            let chars: Vec<char> = text.chars().collect();
            let shown = if chars.len() <= max_chars {
                text.to_string()
            } else {
                let half = max_chars / 2;
                let head: String = chars[..half].iter().collect();
                let tail: String = chars[chars.len() - half..].iter().collect();
                format!(
                    "{}\n\n[… {} characters omitted …]\n\n{}",
                    head.trim_end(),
                    chars.len() - max_chars,
                    tail.trim_start()
                )
            };
            if fenced {
                format!("### \"{contract}\" from {stage}\n```text\n{shown}\n```")
            } else {
                format!("### \"{contract}\" from {stage}\n{shown}")
            }
        })
        .collect();
    (!blocks.is_empty()).then(|| format!("{heading}\n\n{}", blocks.join("\n\n")))
}

// ── reading the session ──────────────────────────────────────────────────

fn environment_block(response: &str) -> Option<String> {
    let pattern = regex::Regex::new(
        r"(?is)(?:^|[.!?])\s*[*`_]*\s*Stage status:\s*blocked-environment\s*:?\s*(.*?)\s*[*`_]*$",
    )
    .ok()?;
    let pseudo = regex::Regex::new(
        r"(?i)\b(incomplete|in progress|not finished|cannot report a commit ref|can't report a commit ref|have not inspected|in this turn)\b",
    )
    .ok()?;
    let last = response.lines().rev().find(|line| pattern.is_match(line))?;
    let reason = pattern
        .captures(last)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim_matches(['*', '`', '_', ' ']).to_string())
        .unwrap_or_default();
    if !reason.is_empty() && pseudo.is_match(&reason) {
        return None;
    }
    Some(if reason.is_empty() { "no reason given".to_string() } else { reason })
}

/// The plan's own verdict on itself: its last `Plan status:` line.
fn plan_status(response: &str) -> Result<(), String> {
    let line = response
        .lines()
        .map(|l| l.trim().trim_matches(['`', '*', '_']).to_string())
        .rev()
        .find(|l| l.to_lowercase().starts_with("plan status"));
    let Some(line) = line else {
        return Err("it did not confirm the plan was complete (no \"Plan status: ready\" line)".into());
    };
    let verdict = line
        .split_once(':')
        .map(|(_, v)| v.trim().to_string())
        .unwrap_or_default();
    if verdict.to_lowercase().starts_with("ready") {
        return Ok(());
    }
    let why = verdict
        .trim_start_matches(|c: char| c.is_alphabetic())
        .trim_start_matches([':', '-', '—', '–', ' '])
        .trim()
        .to_string();
    Err(if why.is_empty() {
        "it reported itself blocked".to_string()
    } else {
        format!("it reported itself blocked: {why}")
    })
}

/// `parseReviewFindings`: the last fenced JSON object with a `findings` array.
fn parse_review_findings(content: &str) -> Result<CheckFindings, String> {
    if content.trim().is_empty() {
        return Err("Reviewer output is empty; expected structured JSON findings.".into());
    }
    let fence = regex::Regex::new(r"```[^\n`]*\n([\s\S]*?)```").map_err(|e| e.to_string())?;
    let block = fence
        .captures_iter(content)
        .map(|c| c[1].trim().to_string())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .find(|b| {
            serde_json::from_str::<Value>(b)
                .ok()
                .is_some_and(|v| v.get("findings").is_some_and(Value::is_array))
        });
    let mut text = block.unwrap_or_else(|| content.trim().to_string());
    if !text.starts_with(['{', '[']) {
        if let (Some(start), Some(end)) = (content.find('{'), content.rfind('}')) {
            if end > start {
                text = content[start..=end].to_string();
            }
        }
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|e| {
        format!("Reviewer output did not contain a valid structured JSON findings block: {e}")
    })?;
    let list = parsed
        .get("findings")
        .and_then(Value::as_array)
        .ok_or("Reviewer JSON findings must contain a \"findings\" array.")?;
    let mut findings = Vec::new();
    for (index, item) in list.iter().enumerate() {
        if !item.is_object() {
            return Err(format!("Finding at index {index} is not an object."));
        }
        let text_of = |key: &str| {
            item.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let severity = match item
            .get("severity")
            .and_then(Value::as_str)
            .map(str::to_lowercase)
            .as_deref()
        {
            Some("critical") => CheckFindingSeverity::Critical,
            Some("high") => CheckFindingSeverity::High,
            Some("low") => CheckFindingSeverity::Low,
            Some("info") => CheckFindingSeverity::Info,
            _ => CheckFindingSeverity::Medium,
        };
        let message = text_of("message").unwrap_or_else(|| "Review finding".to_string());
        let file = text_of("file");
        let line = item.get("line").and_then(Value::as_f64).map(|l| l.floor() as i64);
        let rule_id = text_of("ruleId");
        findings.push(CheckFinding {
            fingerprint: compute_finding_fingerprint(
                rule_id.as_deref(),
                file.as_deref(),
                line,
                &message,
            ),
            rule_id,
            file,
            line,
            severity,
            category: text_of("category").unwrap_or_else(|| "quality".to_string()),
            message,
            suggestion: text_of("suggestion"),
            verdict: match item.get("verdict").and_then(Value::as_str) {
                Some("confirmed") => Some(FindingVerdict::Confirmed),
                Some("refuted") => Some(FindingVerdict::Refuted),
                _ => None,
            },
            verdict_reason: text_of("verdictReason"),
        });
    }
    let mut metrics = std::collections::BTreeMap::new();
    if let Some(given) = parsed.get("metrics").and_then(Value::as_object) {
        for (key, value) in given {
            if let Some(n) = value.as_f64().filter(|n| n.is_finite()) {
                metrics.insert(key.clone(), n);
            }
        }
    }
    metrics
        .entry("findingsCount".to_string())
        .or_insert(findings.len() as f64);
    Ok(CheckFindings { findings, metrics })
}

struct Finished {
    state: String,
    response: String,
    last_error: Option<String>,
    provider_limit: bool,
}

fn is_narrative(kind: WorkflowArtifactKind) -> bool {
    matches!(
        kind,
        WorkflowArtifactKind::Plan
            | WorkflowArtifactKind::Report
            | WorkflowArtifactKind::Note
            | WorkflowArtifactKind::Log
    )
}

/// Turns a finished session into the outcome the orchestrator applies (`stageOutcomeFromSession`).
fn outcome_from_session(
    node: &WorkflowAgentTaskNode,
    finished: &Finished,
    snapshot_ref: Option<&str>,
    start_ref: Option<&str>,
) -> StageOutcome {
    let name = &node.base.name;
    if finished.state != "completed" {
        let limit = finished
            .last_error
            .as_deref()
            .filter(|e| praxis_ai::providers::provider_limit_error::is_provider_limit_error(e))
            .or_else(|| {
                Some(finished.response.as_str()).filter(|r| {
                    praxis_ai::providers::provider_limit_error::is_provider_limit_error(r)
                })
            });
        if finished.provider_limit || limit.is_some() {
            let detail = limit.map(|l| {
                praxis_ai::providers::provider_limit_error::extract_provider_limit_message(l)
                    .unwrap_or_else(|| l.to_string())
            });
            let error = match detail {
                Some(d) if d.starts_with("The AI provider's") || d.starts_with("Provider limit reached") => d,
                Some(d) => format!("The AI provider's credits or usage limit were reached: {}", first_line(&d)),
                None => "The AI provider's credits or usage limit were reached.".to_string(),
            };
            return StageOutcome {
                error: Some(error),
                pause: Some(WorkflowPauseReason::ProviderLimit),
                ..StageOutcome::default()
            };
        }
        let detail = finished
            .last_error
            .clone()
            .or_else(|| (!finished.response.trim().is_empty()).then(|| first_line(&finished.response)));
        return StageOutcome {
            error: Some(if finished.state == "aborted" {
                "The stage session was aborted.".to_string()
            } else {
                format!(
                    "The stage session failed{}",
                    detail.map(|d| format!(": {d}")).unwrap_or_else(|| ".".to_string())
                )
            }),
            retryable: finished.state == "aborted",
            ..StageOutcome::default()
        };
    }

    if let Some(blocked) = environment_block(&finished.response) {
        return StageOutcome {
            error: Some(format!("{name} was blocked by its environment: {blocked}")),
            pause: Some(WorkflowPauseReason::Environment),
            ..StageOutcome::default()
        };
    }

    if let Some(diff) = node
        .outputs
        .iter()
        .find(|c| c.kind == WorkflowArtifactKind::Diff && c.required)
    {
        if let (Some(start), Some(snap)) = (start_ref, snapshot_ref) {
            if start == snap {
                let said = if finished.response.trim().is_empty() {
                    String::new()
                } else {
                    let last = finished
                        .response
                        .trim()
                        .rsplit("\n\n")
                        .next()
                        .unwrap_or("")
                        .to_string();
                    format!(" It said: {}", first_line(&last))
                };
                return StageOutcome::failure(format!(
                    "{name} made no changes: the branch is still at {}, so there is no \"{}\" to verify.{said}",
                    &start[..start.len().min(8)],
                    diff.id
                ));
            }
        }
    }

    if node
        .outputs
        .iter()
        .any(|c| c.kind == WorkflowArtifactKind::Plan && c.required && c.publish_to.is_none())
        && !finished.response.trim().is_empty()
    {
        if let Err(reason) = plan_status(&finished.response) {
            return StageOutcome::failure(format!("{name} did not produce a plan: {reason}."));
        }
    }

    let mut artifacts: Vec<DeclaredArtifact> = Vec::new();
    for contract in &node.outputs {
        if contract.kind == WorkflowArtifactKind::Diff {
            if let Some(snapshot) = snapshot_ref {
                artifacts.push(declared(contract, Some(snapshot.to_string())));
            }
            continue;
        }
        if is_narrative(contract.kind) && !finished.response.trim().is_empty() {
            artifacts.push(declared(contract, None));
        }
    }

    let mut findings = None;
    let finding_contracts: Vec<&WorkflowArtifactContract> = node
        .outputs
        .iter()
        .filter(|c| c.kind == WorkflowArtifactKind::Findings)
        .collect();
    if !finding_contracts.is_empty() && !finished.response.trim().is_empty() {
        if let Ok(parsed) = parse_review_findings(&finished.response) {
            findings = Some(parsed);
            for contract in finding_contracts {
                if !artifacts.iter().any(|a| a.contract_id == contract.id) {
                    artifacts.push(declared(contract, None));
                }
            }
        }
    }

    let missing: Vec<&str> = node
        .outputs
        .iter()
        .filter(|c| c.required && !artifacts.iter().any(|a| a.contract_id == c.id))
        .map(|c| c.id.as_str())
        .collect();
    if !missing.is_empty() {
        return StageOutcome {
            error: Some(format!(
                "{name} did not produce required artifacts: {}.",
                missing.join(", ")
            )),
            artifacts: Some(artifacts),
            findings,
            snapshot_ref: snapshot_ref.map(str::to_string),
            ..StageOutcome::default()
        };
    }
    if node
        .outputs
        .iter()
        .any(|c| c.required && c.kind == WorkflowArtifactKind::Findings)
        && findings.is_none()
    {
        return StageOutcome {
            error: Some(format!(
                "{name} declared required findings artifact but produced no structured findings."
            )),
            artifacts: Some(artifacts),
            snapshot_ref: snapshot_ref.map(str::to_string),
            ..StageOutcome::default()
        };
    }
    StageOutcome {
        succeeded: true,
        artifacts: Some(artifacts),
        findings,
        snapshot_ref: snapshot_ref.map(str::to_string),
        ..StageOutcome::default()
    }
}

fn declared(contract: &WorkflowArtifactContract, path: Option<String>) -> DeclaredArtifact {
    DeclaredArtifact {
        contract_id: contract.id.clone(),
        kind: contract.kind,
        path,
        artifact_id: None,
        reference: None,
    }
}

// ── launching ────────────────────────────────────────────────────────────

/// Whether the app can drive agent stages at all right now.
#[must_use]
pub fn can_dispatch(host: &HostContext) -> bool {
    !host.settings().read().ai.active_provider.trim().is_empty()
}

fn launch(
    host: &HostContext,
    key: &str,
    provider: &str,
    model: Option<String>,
    task: Value,
    worktree: &Path,
    tool_mode: &str,
    autopilot: bool,
) -> Result<String, String> {
    let dir = host.config().user_data_dir.clone();
    let issue = json!({
        "key": key, "summary": task["goal"].as_str().unwrap_or("").lines().next().unwrap_or(""),
        "issueType": "Task", "status": "In progress", "projectKey": "WORKFLOW"
    });
    let working = Some(worktree.to_string_lossy().into_owned());
    let permission = if autopilot { "autopilot" } else { "manual" }.to_string();
    let settings = host.settings().read();
    let reasoning = "medium".to_string();
    let descriptor = built_in_descriptors().into_iter().find(|d| d.id == provider);
    let api = match &descriptor {
        Some(d) => d.kind == DescriptorKind::Api,
        None => true,
    };
    if api {
        drop(settings);
        let (connection, default_model) = super::ai_providers::api_connection(host, provider)
            .map_err(|e| e.message)?;
        super::api_host::start_api_task(
            host,
            &dir,
            super::api_host::ApiStart {
                issue,
                task,
                model: model.unwrap_or(default_model),
                reasoning_effort: Some(reasoning),
                working_directory: working,
                tool_mode: tool_mode.to_string(),
                auto_approve: autopilot,
                permission_mode: Some(permission),
                images: Vec::new(),
                connection,
            },
        )
        .map_err(|e| e.message)?;
    } else {
        let descriptor = descriptor.ok_or("Unknown AI provider.")?;
        let override_path = settings
            .ai
            .providers
            .get(provider)
            .and_then(|c| c.cli_path.as_deref())
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_owned);
        let command = override_path
            .or(descriptor.default_command.clone())
            .ok_or("No command is configured for this provider.")?;
        drop(settings);
        acp_host::start_task(
            host,
            &dir,
            StartTask {
                issue,
                task,
                provider: provider.to_string(),
                model,
                reasoning_effort: Some(reasoning),
                working_directory: working,
                tool_mode: tool_mode.to_string(),
                auto_approve: autopilot,
                permission_mode: Some(permission),
                command,
                args: descriptor.default_args.clone(),
                mcp_servers: Vec::new(),
            },
        )
        .map_err(|e| e.message)?;
    }
    store(&dir)
        .get(key)
        .ok()
        .flatten()
        .and_then(|r| r["sessionId"].as_str().map(str::to_string))
        .ok_or_else(|| format!("Session for {key} did not start."))
}

fn tier_map(host: &HostContext) -> Option<ModelTierMap> {
    let settings = host.settings().read();
    let tiers = settings.ai.model_tiers.as_ref()?;
    let mut map = ModelTierMap::new();
    for (provider, config) in tiers {
        let mut entry = std::collections::BTreeMap::new();
        use praxis_workflows::types::WorkflowModelTier as Tier;
        for (tier, value) in [
            (Tier::Fast, &config.fast),
            (Tier::Standard, &config.standard),
            (Tier::Strong, &config.strong),
        ] {
            if let Some(model) = value {
                entry.insert(tier, model.clone());
            }
        }
        map.insert(provider.clone(), entry);
    }
    Some(map)
}

/// Waits for the stage's session to reach a terminal state, aborting it if the stage is cancelled.
async fn wait_for_session(
    host: &HostContext,
    key: &str,
    context: &StageDispatchContext,
    after: Option<&str>,
) -> Option<Finished> {
    let dir = host.config().user_data_dir.clone();
    let mut aborted = false;
    loop {
        let record = store(&dir).get(key).ok().flatten();
        if let Some(record) = &record {
            let state = record["state"].as_str().unwrap_or("");
            // A continued session still shows its previous turn until the next one starts.
            let previous_turn = after.is_some_and(|a| {
                state == "completed" && record["completedAt"].as_str() == Some(a)
            });
            if is_terminal(state) && !previous_turn && !acp_host::has_active_task(&dir, key) {
                return Some(Finished {
                    state: state.to_string(),
                    response: record["responseText"].as_str().unwrap_or("").to_string(),
                    last_error: record["lastError"].as_str().map(str::to_string),
                    provider_limit: record["providerLimitReached"] == json!(true),
                });
            }
        }
        if context.cancel.is_cancelled() && !aborted {
            aborted = true;
            acp_host::abort_task(host, &dir, key);
        }
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(150)) => {}
            () = context.cancel.cancelled() => {}
        }
    }
}

/// Runs one agent stage (`runWorkflowAgentStage`).
pub async fn run_agent_stage(
    host: &HostContext,
    node: &WorkflowAgentTaskNode,
    context: &StageDispatchContext,
) -> Result<StageOutcome, String> {
    let run = &context.run;
    let Some(worktree) = context.worktree_path.as_deref().map(PathBuf::from) else {
        return Ok(StageOutcome::failure(
            "This stage needs a run worktree; attach a git folder to the project.",
        ));
    };
    let key = stage_session_key(&run.run_id, &node.base.id);
    let settings_provider = host.settings().read().ai.active_provider.clone();
    let run_provider = run
        .ai_provider
        .clone()
        .filter(|p| !p.is_empty())
        .unwrap_or(settings_provider);
    let provider = stage_provider(run, &node.base.id, &run_provider);

    // Artifacts the stage was handed, and the frozen snapshot it should inspect.
    let mut produced: std::collections::BTreeMap<String, StageInput> = Default::default();
    for state in run.nodes.values() {
        for artifact in &state.artifacts {
            produced.insert(
                artifact.contract_id.clone(),
                StageInput {
                    node_id: artifact.node_id.clone(),
                    contract_id: artifact.contract_id.clone(),
                    kind: kind_name(artifact.kind),
                    path: artifact.path.clone(),
                },
            );
        }
    }
    let inputs: Vec<StageInput> = node
        .base
        .inputs
        .iter()
        .filter_map(|id| produced.remove(id))
        .collect();
    let snapshot = find_snapshot(run, &node.base.id).map(|s| (s.reference, s.produced_by_node_id));
    let mut task = build_task_definition(run, node, &inputs, snapshot);
    let dir = host.config().user_data_dir.clone();
    // What earlier stages concluded: a report's text lives on its session, a check's log in the
    // evidence store (outside the worktree an agent's file tools are confined to).
    let reports: Vec<(String, String, String)> = inputs
        .iter()
        .filter(|i| i.path.is_none())
        .map(|i| {
            let text = store(&dir)
                .get(&stage_session_key(&run.run_id, &i.node_id))
                .ok()
                .flatten()
                .and_then(|r| r["responseText"].as_str().map(str::to_string))
                .unwrap_or_default();
            (i.contract_id.clone(), stage_name(run, &i.node_id), text)
        })
        .collect();
    if let Some(block) = format_upstream(
        "Reports from earlier stages (use these rather than re-deriving them):",
        &reports,
        24_000,
        false,
    ) {
        task["scope"] = json!(format!("{}\n\n{block}", task["scope"].as_str().unwrap_or("")));
    }
    let logs: Vec<(String, String, String)> = inputs
        .iter()
        .filter(|i| i.kind == "log" && i.path.is_some())
        .map(|i| {
            let text = std::fs::read_to_string(i.path.as_deref().unwrap_or("")).unwrap_or_default();
            (i.contract_id.clone(), stage_name(run, &i.node_id), text)
        })
        .collect();
    if let Some(block) = format_upstream(
        "Output of earlier check stages (already captured — do not try to open their files):",
        &logs,
        12_000,
        true,
    ) {
        task["scope"] = json!(format!("{}\n\n{block}", task["scope"].as_str().unwrap_or("")));
    }

    let failed_attempts = run
        .nodes
        .get(&node.base.id)
        .map_or(0, |s| s.attempts.iter().filter(|a| a.outcome == praxis_workflows::types::WorkflowNodeOutcome::Failed && a.pause.is_none()).count());
    let switched = run
        .stage_providers
        .as_ref()
        .is_some_and(|m| m.contains_key(&node.base.id));
    let own = node.agent.provider_id.as_deref().map(str::trim).filter(|p| !p.is_empty());
    let switched_model = named_model(
        run.stage_models
            .as_ref()
            .and_then(|m| m.get(&node.base.id))
            .map(String::as_str),
    );
    let tiers = tier_map(host);
    let model = if let Some(model) = switched_model {
        Some(model)
    } else {
        let same_ai = !switched && own.is_none_or(|p| p == provider);
        choose_stage_model(
            StageModelNode {
                model: if same_ai { node.model.as_deref() } else { None },
                model_tier: node.model_tier,
                escalate_on_retry: node.escalate_on_retry,
            },
            &provider,
            tiers.as_ref(),
            if provider == run_provider { run.ai_model.as_deref() } else { None },
            failed_attempts as u32,
        )
        .model
    };

    let tool_mode = serde_json::to_value(node.agent.tool_mode)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "full".into());
    let start_ref = if node.mutates_worktree { head_of(&worktree).await } else { None };
    let autopilot = run.permission_mode.is_some_and(|m| serde_json::to_value(m).ok() == Some(json!("auto")));

    let launched = launch(host, &key, &provider, model.clone(), task, &worktree, &tool_mode, autopilot);
    let session_id = match launched {
        Ok(id) => id,
        Err(error) => {
            let limit = praxis_ai::providers::provider_limit_error::is_provider_limit_error(&error);
            return Ok(StageOutcome {
                error: Some(if limit {
                    praxis_ai::providers::provider_limit_error::extract_provider_limit_message(&error)
                        .unwrap_or(error)
                } else {
                    error
                }),
                provider: Some(provider),
                model,
                pause: limit.then_some(WorkflowPauseReason::ProviderLimit),
                ..StageOutcome::default()
            });
        }
    };
    context.reporter.report_session(&session_id);
    // Attribution: what makes this session traceable back to its run and node.
    let dir = host.config().user_data_dir.clone();
    let attribution = json!({
        "workingDirectory": worktree.to_string_lossy(), "worktreePath": worktree.to_string_lossy(),
        "toolMode": tool_mode, "workflowRunId": run.run_id, "workflowNodeId": node.base.id,
        "workflowId": run.workflow_id, "workflowVersion": run.workflow_version, "workflowRole": "stage",
        "parentSessionKey": run.controller_session_key,
    });
    let _ = store(&dir).mutate(&key, true, |record| {
        if let (Some(target), Some(source)) = (record.as_object_mut(), attribution.as_object()) {
            for (k, v) in source {
                if !v.is_null() {
                    target.insert(k.clone(), v.clone());
                }
            }
        }
    });

    let Some(mut finished) = wait_for_session(host, &key, context, None).await else {
        return Ok(StageOutcome::failure("The stage session never settled."));
    };
    // Some agents end their whole turn when a tool is refused, so a read-only stage that tried a
    // command which could write stopped there with nothing produced. Say why and let it carry on.
    let mut refusals_seen = 0;
    for _ in 0..2 {
        if tool_mode != "read-only"
            || finished.state != "completed"
            || context.cancel.is_cancelled()
        {
            break;
        }
        let refusals = read_only_refusals(&dir, &key);
        if refusals <= refusals_seen {
            break;
        }
        refusals_seen = refusals;
        if outcome_from_session(node, &finished, None, None).succeeded {
            break;
        }
        let after = store(&dir)
            .get(&key)
            .ok()
            .flatten()
            .and_then(|r| r["completedAt"].as_str().map(str::to_string));
        let (h, k) = (host.clone(), key.clone());
        let sent = tokio::task::spawn_blocking(move || {
            h.dispatch_rpc(praxis_contracts::RustRpcRequest {
                id: "stage-refusal".into(),
                channel: "ai:continueSession".into(),
                args: vec![json!(k), json!(REFUSAL_CONTINUATION)],
            })
        })
        .await;
        if !sent.is_ok_and(|r| r.ok) {
            break;
        }
        match wait_for_session(host, &key, context, after.as_deref()).await {
            Some(next) => finished = next,
            None => break,
        }
    }
    let snapshot_ref = if node.mutates_worktree
        && !context.cancel.is_cancelled()
        && finished.state == "completed"
    {
        freeze_worktree(&worktree, &node.base.name).await
    } else {
        None
    };
    let mut outcome = outcome_from_session(node, &finished, snapshot_ref.as_deref(), start_ref.as_deref());
    outcome.provider = Some(provider);
    outcome.model = model;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stage_blocked_by_its_environment_pauses_instead_of_failing() {
        let text = "I looked around.\nStage status: blocked-environment: the registry is unreachable";
        assert_eq!(
            environment_block(text).as_deref(),
            Some("the registry is unreachable")
        );
        assert_eq!(environment_block("All done."), None);
    }

    #[test]
    fn a_plan_must_confirm_itself() {
        assert!(plan_status("The plan.\nPlan status: ready").is_ok());
        assert!(plan_status("The plan.").unwrap_err().contains("no \"Plan status: ready\" line"));
        assert!(plan_status("Plan status: blocked: no repo")
            .unwrap_err()
            .contains("blocked: no repo"));
    }

    #[test]
    fn findings_come_from_the_last_fenced_json_block() {
        let text = "Report\n```ts\nconst a = 1;\n```\n```json\n{\"findings\":[{\"severity\":\"HIGH\",\"message\":\"bug\",\"file\":\"a.rs\",\"line\":3}]}\n```";
        let parsed = parse_review_findings(text).unwrap();
        assert_eq!(parsed.findings.len(), 1);
        assert_eq!(parsed.findings[0].severity, CheckFindingSeverity::High);
        assert_eq!(parsed.metrics["findingsCount"], 1.0);
        assert!(parse_review_findings("no json here").is_err());
    }
}
