//! The pure scoring engine (port of `sessionFeedbackScorer.ts` and `feedbackCoaching.ts`).
//! Identical input always yields an identical report and `inputDigest`.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Value, json};

use super::clarity::Answers;
use super::grounding::{pick_test_command, rank_file_candidates};
use super::types::{
    DimensionScore, EvaluationInput, FEEDBACK_SCHEMA_VERSION, Finding, SCORING_RUBRIC_VERSION,
    Signal, bounded_messages, grade, input_digest, js_round, locale_cmp, signal,
};
use super::{capability, execution, prompt_signals};

pub const PRE_SEND_WEIGHTS: [(&str, f64); 3] = [
    ("prompt-clarity", 60.0),
    ("skill-agent-alignment", 25.0),
    ("mcp-leverage", 15.0),
];

fn weight_of(dimension: &str) -> Option<f64> {
    PRE_SEND_WEIGHTS
        .iter()
        .find(|(d, _)| *d == dimension)
        .map(|(_, w)| *w)
}

/// A fix the composer can apply for the user: a setting, or a concrete clause to insert.
pub fn is_one_click_fix(finding: &Finding) -> bool {
    let r = &finding.remediation;
    match r.kind.as_str() {
        "change-tool-mode" | "attach-skill" | "select-agent" => {
            r.target_id.as_ref().is_some_and(|t| !t.is_empty())
        }
        _ => r
            .suggested_prompt_snippet
            .as_ref()
            .is_some_and(|t| !t.is_empty()),
    }
}

fn severity_rank(severity: &str) -> u8 {
    match severity {
        "critical" => 0,
        "warning" => 1,
        _ => 2,
    }
}

fn count_prompt_turns(events: &[Value], has_goal: bool) -> usize {
    let user = events
        .iter()
        .filter(|e| e["type"] == "user_input_completed")
        .count();
    if user == 0 {
        usize::from(has_goal)
    } else if has_goal {
        user + 1
    } else {
        user
    }
}

/// A copy-ready improved prompt built from the findings without calling a model.
pub fn build_suggested_prompt(original: &str, findings: &[Finding], kind: &str) -> String {
    let base = original.trim();
    let mut snippets: Vec<(String, String)> = Vec::new();
    for finding in findings {
        let r = &finding.remediation;
        if matches!(
            r.kind.as_str(),
            "attach-skill" | "change-tool-mode" | "select-agent"
        ) {
            continue;
        }
        let Some(text) = r
            .suggested_prompt_snippet
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        else {
            continue;
        };
        if base.to_lowercase().contains(&text.to_lowercase())
            || snippets.iter().any(|(_, t)| t == text)
        {
            continue;
        }
        snippets.push((r.kind.clone(), text.to_owned()));
    }
    if kind == "session-execution" {
        if snippets.is_empty() {
            return String::new();
        }
        return format!(
            "Follow up on the previous turn:\n{}",
            snippets
                .iter()
                .map(|(_, t)| format!("- {t}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
    if base.is_empty() {
        return String::new();
    }
    let is_inline =
        |kind: &str| matches!(kind, "pin-file" | "add-test-command" | "add-verification");
    let inline: Vec<&(String, String)> = snippets.iter().filter(|(k, _)| is_inline(k)).collect();
    let sentences: Vec<&str> = snippets
        .iter()
        .filter(|(k, _)| !is_inline(k))
        .map(|(_, t)| t.as_str())
        .collect();
    if inline.is_empty() && sentences.is_empty() {
        return base.to_owned();
    }
    let pins: Vec<&str> = inline
        .iter()
        .filter(|(k, _)| k == "pin-file")
        .map(|(_, t)| t.as_str())
        .collect();
    let checks: Vec<&str> = inline
        .iter()
        .filter(|(k, _)| k != "pin-file")
        .map(|(_, t)| t.as_str())
        .collect();
    static TRAILING: OnceLock<Regex> = OnceLock::new();
    let mut sentence = TRAILING
        .get_or_init(|| Regex::new(r"[.!\s]+$").expect("static"))
        .replace(base, "")
        .into_owned();
    if !pins.is_empty() {
        sentence.push(' ');
        sentence.push_str(&pins.join(" and ").replace(" and in @", " and @"));
    }
    if let Some(check) = checks.first() {
        sentence.push(' ');
        sentence.push_str(check);
    }
    sentence.push('.');
    if sentences.is_empty() {
        sentence
    } else {
        format!("{sentence}\n\n{}", sentences.join(" "))
    }
}

fn diagnosis_phrase(id: &str) -> Option<&'static str> {
    if [
        "tool-blind-edit-loop",
        "tool-edit-retry-loop",
        "tool-retry-loop",
        "tool-file-thrash",
    ]
    .iter()
    .any(|p| id.starts_with(p))
    {
        Some("avoidable tool thrashing")
    } else if id == "outcome-unresolved-failure" {
        Some("an unresolved test failure")
    } else if id == "outcome-unverified-writes" {
        Some("unverified edits")
    } else if id == "tool-blind-edits" {
        Some("edits made without reading")
    } else if id.starts_with("skill-missed-") {
        Some("a missed skill")
    } else if id.starts_with("mcp-shell") || id == "mcp-partial-shell-search" {
        Some("shell search instead of code_intelligence")
    } else if id == "tool-failed-calls" {
        Some("failing tool calls")
    } else if id == "agent-profile-mode-mismatch" {
        Some("the wrong agent profile")
    } else {
        None
    }
}

fn join_with_and(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_owned(),
        _ => format!(
            "{} & {}",
            items[..items.len() - 1].join(", "),
            items[items.len() - 1]
        ),
    }
}

pub fn build_diagnosis(kind: &str, findings: &[Finding], session_state: Option<&str>) -> Value {
    let system: Vec<&Finding> = findings
        .iter()
        .filter(|f| !f.id.starts_with("user-"))
        .collect();
    if kind == "prompt-readiness" {
        return system.first().map_or_else(
            || json!({ "headline": "Prompt is ready", "detail": "Scope, tool access, and verification are all in place." }),
            |top| json!({ "headline": top.title, "detail": top.evidence }),
        );
    }
    let outcome = match session_state {
        Some("failed") => "Failed",
        Some("aborted") => "Stopped early",
        _ => "Completed",
    };
    if system.is_empty() {
        return json!({ "headline": format!("{outcome} cleanly"), "detail": "No wasted steps, missed capabilities, or unverified edits were detected." });
    }
    let mut phrases: Vec<&str> = Vec::new();
    for finding in &system {
        if let Some(phrase) = diagnosis_phrase(&finding.id)
            && !phrases.contains(&phrase)
        {
            phrases.push(phrase);
        }
    }
    let headline = if phrases.is_empty() {
        format!(
            "{outcome} with {} {}",
            system.len(),
            if system.len() == 1 { "issue" } else { "issues" }
        )
    } else {
        format!(
            "{outcome} with {}",
            join_with_and(&phrases[..phrases.len().min(2)])
        )
    };
    json!({ "headline": headline, "detail": format!("{}.", system.iter().take(3).map(|f| f.title.clone()).collect::<Vec<_>>().join("; ")) })
}

fn answers_of(clarity: Option<&Value>) -> Option<Answers> {
    clarity.and_then(|c| serde_json::from_value(c["answers"].clone()).ok())
}

/// A dry-run of what the agent would do, without executing anything (`buildFeedbackRehearsal`).
pub fn build_rehearsal(input: &EvaluationInput, prompt: &str) -> Value {
    let answers = answers_of(input.clarity.as_ref());
    let interpretation = answers.as_ref().and_then(|a| a.interpretation.as_ref());
    let slot_text = |key: &str| -> String {
        interpretation
            .map(|i| match key {
                "target" => i.target.text.clone(),
                "change" => i.change.text.clone(),
                _ => i.result.text.clone(),
            })
            .unwrap_or_default()
    };
    let answer_is_no = |id: &str| {
        answers
            .as_ref()
            .and_then(|a| a.checks.get(id))
            .is_some_and(|c| c.answer == "no")
    };
    let unresolved: Vec<&str> = ["target", "change", "result"]
        .into_iter()
        .filter(|key| {
            slot_text(key).is_empty()
                || (*key == "target" && answer_is_no("target"))
                || (*key == "change" && answer_is_no("outcome"))
        })
        .collect();
    let tool_mode = input
        .tool_mode
        .clone()
        .or_else(|| {
            input
                .session
                .as_ref()
                .and_then(|s| s["toolMode"].as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| "full".into());
    let mut capabilities: Vec<String> = vec![if input.code_intelligence_available == Some(true) {
        "code_intelligence: symbol lookup and source reading".into()
    } else {
        "Repository file reading".into()
    }];
    if input.tracker_tools_available {
        capabilities.push("Tracker context".into());
    }
    if tool_mode == "project-only" {
        capabilities = vec!["Project context only; file access is unavailable".into()];
    }
    let mut skills: Vec<String> = input
        .active_skills
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    skills.sort();
    let files: Vec<String> = rank_file_candidates(prompt, input.workspace_hints.as_ref(), 2)
        .into_iter()
        .take(3)
        .map(|f| f.path)
        .collect();
    let test = pick_test_command(prompt, input.workspace_hints.as_ref(), &files);
    if !unresolved.is_empty() {
        return json!({ "files": files, "capabilities": capabilities, "skills": skills, "checks": [], "unresolved": unresolved, "steps": [format!("Clarify {} before choosing an execution plan.", unresolved.join(", "))] });
    }
    if tool_mode != "full" {
        let step = if tool_mode == "project-only" {
            "Choose a working folder and explicitly enable file access before inspecting files or proposing edits."
        } else {
            "Full access would be required before applying edits or running verification. This preview does not change permissions."
        };
        return json!({ "files": files, "capabilities": capabilities, "skills": skills, "checks": [], "unresolved": ["tool-access"], "steps": [step] });
    }
    let change = slot_text("change");
    let mut change_chars = change.chars();
    let lowered_change = change_chars
        .next()
        .map(|c| c.to_lowercase().collect::<String>() + change_chars.as_str())
        .unwrap_or_default();
    let target = if files.is_empty() {
        slot_text("target")
    } else {
        files.join(", ")
    };
    json!({
        "files": files, "capabilities": capabilities, "skills": skills,
        "checks": test.iter().map(|t| t.command.clone()).collect::<Vec<_>>(), "unresolved": [],
        "steps": [
            format!("Inspect {target} and relevant workspace instructions."),
            format!("Confirm the current behaviour, then {lowered_change}."),
            format!("Check the result: {}{}", slot_text("result"), test.as_ref().map_or_else(|| " Agree on a verification method first.".to_owned(), |t| format!(" Run {}.", t.command))),
        ],
    })
}

/// The first loop, thrash or unresolved failure in the findings, with a proposed better sequence.
pub fn build_turning_point(findings: &[Finding]) -> Option<Value> {
    static KIND: OnceLock<Regex> = OnceLock::new();
    let pattern = KIND.get_or_init(|| Regex::new(r"loop|unresolved|thrash|blind").expect("static"));
    let mut candidates: Vec<&Finding> = findings
        .iter()
        .filter(|f| f.steps.as_ref().is_some_and(|s| !s.is_empty()) && pattern.is_match(&f.id))
        .collect();
    candidates.sort_by(|a, b| {
        a.steps
            .as_ref()
            .map(|s| s[0].step)
            .cmp(&b.steps.as_ref().map(|s| s[0].step))
            .then_with(|| locale_cmp(&a.id, &b.id))
    });
    let candidate = candidates.first()?;
    let actual: Vec<_> = candidate.steps.as_ref()?.iter().take(5).collect();
    Some(json!({
        "findingId": candidate.id, "title": candidate.title, "actual": actual,
        "proposed": [
            "Pause before another attempt and inspect the current state and any error.",
            candidate.remediation.description,
            "Make one targeted change, then rerun the relevant verification before continuing.",
        ],
    }))
}

/// `${rubric}/${checklist}/${model}/${findingId before ':'}` — the key a finding's reviews roll up under.
pub fn finding_rule_key(report: &Value, finding_id: &str) -> String {
    let clarity = &report["clarity"];
    format!(
        "{}/{}/{}/{}",
        report["rubricVersion"],
        clarity["checklistVersion"]
            .as_u64()
            .map_or_else(|| "facts".to_owned(), |v| v.to_string()),
        clarity["model"].as_str().unwrap_or("facts"),
        finding_id.split(':').next().unwrap_or_default()
    )
}

fn with_signals(mut dimension: DimensionScore, signals: Vec<Signal>) -> DimensionScore {
    if !signals.is_empty() {
        dimension
            .signals
            .get_or_insert_with(Vec::new)
            .extend(signals);
    }
    dimension
}

#[allow(clippy::too_many_lines)]
pub fn evaluate(input: &EvaluationInput) -> Value {
    let session = input.session.as_ref();
    let events: Vec<Value> = session
        .and_then(|s| s["events"].as_array().cloned())
        .unwrap_or_default();
    let turn_events = if session.is_some() {
        execution::select_turn_events(&events, input.turn_index)
    } else {
        Vec::new()
    };
    let turn_prompt_event = input.turn_index.and_then(|_| {
        turn_events
            .iter()
            .find(|e| e["type"] == "user_input_completed")
    });
    let non_empty = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let effective_prompt = non_empty(Some(&input.prompt_text))
        .or_else(|| non_empty(turn_prompt_event.and_then(|e| e["detail"].as_str())))
        .or_else(|| non_empty(turn_prompt_event.and_then(|e| e["summary"].as_str())))
        .or_else(|| non_empty(session.and_then(|s| s["taskDefinition"]["goal"].as_str())))
        .unwrap_or_default();
    let tool_mode = input
        .tool_mode
        .clone()
        .or_else(|| session.and_then(|s| s["toolMode"].as_str().map(str::to_owned)))
        .unwrap_or_else(|| "full".into());
    let session_mode = input
        .session_mode
        .clone()
        .or_else(|| {
            session.and_then(|s| {
                s["mode"]
                    .as_str()
                    .or_else(|| s["taskDefinition"]["sessionMode"].as_str())
                    .map(str::to_owned)
            })
        })
        .unwrap_or_else(|| "chat".into());
    let profile_id = input.profile_id.clone().or_else(|| {
        session.and_then(|s| {
            s["profileId"]
                .as_str()
                .or_else(|| s["agentId"].as_str())
                .map(str::to_owned)
        })
    });
    let issue_key = input
        .issue_key
        .clone()
        .or_else(|| session.and_then(|s| s["issueKey"].as_str().map(str::to_owned)))
        .filter(|k| !k.is_empty());
    let context_tokens = input
        .context_tokens
        .or_else(|| session.and_then(|s| s["contextTokens"].as_f64()));
    let context_limit = input
        .context_limit
        .or_else(|| session.and_then(|s| s["contextLimit"].as_f64()));

    let mut canonical = input.clone();
    canonical.prompt_text = effective_prompt.clone();
    canonical.tool_mode = Some(tool_mode.clone());
    canonical.session_mode = Some(session_mode.clone());
    canonical.profile_id = profile_id.clone();
    canonical.issue_key = issue_key.clone();
    canonical.context_tokens = context_tokens;
    canonical.context_limit = context_limit;
    let digest = input_digest(&canonical);

    let prompt_analysis = prompt_signals::analyze(&prompt_signals::PromptSignalInput {
        prompt_text: &effective_prompt,
        tool_mode: Some(&tool_mode),
        session_mode: Some(&session_mode),
        context_tokens,
        context_limit,
        prior_context: input.prior_context.as_ref(),
        workspace_hints: input.workspace_hints.as_ref(),
        clarity: input.clarity.as_ref(),
    });
    let exec = execution::analyze(&execution::ExecutionInput {
        kind: &input.kind,
        prompt_text: &effective_prompt,
        session,
        turn_index: input.turn_index,
        configured_mcp_servers: &input.configured_mcp_servers,
        code_intelligence_available: input.code_intelligence_available,
        tracker_tools_available: input.tracker_tools_available,
        user_feedback: input.user_feedback.as_ref(),
        workspace_hints: input.workspace_hints.as_ref(),
    });
    let capability = capability::analyze(&capability::CapabilityInput {
        prompt_text: &effective_prompt,
        session_mode: Some(&session_mode),
        profile_id: profile_id.as_deref(),
        active_skills: input.active_skills.as_deref(),
        session,
        touched_paths: &exec.touched_paths,
        path_write_steps: &exec.path_write_steps,
        available_skills: &input.available_skills,
        available_agents: &input.available_agents,
        user_feedback: input.user_feedback.as_ref(),
    });

    let is_session = input.kind == "session-execution" && session.is_some();
    let (mut tool_signals, mut mcp_signals, mut outcome_signals): (
        Vec<Signal>,
        Vec<Signal>,
        Vec<Signal>,
    ) = (Vec::new(), Vec::new(), Vec::new());
    if is_session {
        tool_signals.push(signal(
            format!("{} calls", exec.total_tool_calls),
            "neutral",
        ));
        if exec.failed_edit_count > 0 {
            tool_signals.push(signal(
                format!("{} failed edits", exec.failed_edit_count),
                "bad",
            ));
        } else if exec.failed_tool_calls > 0 {
            tool_signals.push(signal(format!("{} failed", exec.failed_tool_calls), "bad"));
        }
        if exec.blind_edit_count > 0 {
            tool_signals.push(signal(
                format!(
                    "{} blind {} before read",
                    exec.blind_edit_count,
                    if exec.blind_edit_count == 1 {
                        "edit"
                    } else {
                        "edits"
                    }
                ),
                "warn",
            ));
        }
        mcp_signals.push(signal(
            format!(
                "{} MCP {}",
                exec.mcp_tools_used.len(),
                if exec.mcp_tools_used.len() == 1 {
                    "tool"
                } else {
                    "tools"
                }
            ),
            if exec.mcp_tools_used.is_empty() {
                "neutral"
            } else {
                "good"
            },
        ));
        if exec.shell_search_fallback_count > 0 {
            mcp_signals.push(signal(
                format!(
                    "{} shell grep vs code_intelligence",
                    exec.shell_search_fallback_count
                ),
                "warn",
            ));
        }
        if let Some(step) = exec.last_write_step {
            outcome_signals.push(if exec.has_post_edit_verification {
                signal("✓ Verified after final edit", "good")
            } else {
                signal(format!("! No test/build after step #{step}"), "bad")
            });
        }
        if let Some(state) = session
            .and_then(|s| s["state"].as_str())
            .filter(|s| *s == "failed" || *s == "aborted")
        {
            outcome_signals.push(signal(format!("State: {state}"), "bad"));
        }
        if let Some(verdict) = input
            .user_feedback
            .as_ref()
            .and_then(|f| f["verdict"].as_str())
        {
            let label = match verdict {
                "helpful" => "Helpful",
                "needs-work" => "Needs Work",
                _ => "Failed Goal",
            };
            outcome_signals.push(signal(
                format!("Verdict: {label}"),
                if verdict == "helpful" { "good" } else { "warn" },
            ));
        }
    } else {
        let names = std::iter::once(if input.code_intelligence_available != Some(false) {
            "code_intelligence".to_owned()
        } else {
            String::new()
        })
        .chain(input.configured_mcp_servers.iter().cloned())
        .filter(|s| !s.is_empty());
        mcp_signals.extend(names.take(3).map(|n| signal(format!("✓ {n}"), "good")));
    }

    let dimensions: Vec<DimensionScore> = vec![
        prompt_analysis.dimension.clone(),
        with_signals(exec.tool_dimension.clone(), tool_signals),
        capability.dimension.clone(),
        with_signals(exec.mcp_dimension.clone(), mcp_signals),
        with_signals(exec.outcome_dimension.clone(), outcome_signals),
    ];

    let mut findings: Vec<Finding> = prompt_analysis
        .findings
        .iter()
        .chain(&exec.findings)
        .chain(&capability.findings)
        .cloned()
        .collect();
    findings.sort_by(|a, b| {
        a.delta_points
            .cmp(&b.delta_points)
            .then_with(|| severity_rank(&a.severity).cmp(&severity_rank(&b.severity)))
            .then_with(|| locale_cmp(&a.id, &b.id))
    });

    let (overall, scored): (i64, Vec<Finding>) = if input.kind == "prompt-readiness" {
        let score = js_round(
            prompt_analysis.dimension.earned_points as f64
                / prompt_analysis.dimension.max_points as f64
                * 60.0
                + capability.dimension.earned_points as f64
                    / capability.dimension.max_points as f64
                    * 25.0
                + exec.mcp_dimension.earned_points as f64 / exec.mcp_dimension.max_points as f64
                    * 15.0,
        )
        .clamp(0, 100);
        let scored = findings
            .iter()
            .map(|f| {
                let max = dimensions
                    .iter()
                    .find(|d| d.dimension == f.dimension)
                    .map(|d| d.max_points);
                match (weight_of(&f.dimension), max) {
                    (Some(weight), Some(max)) if max > 0 => Finding {
                        score_impact: Some(js_round(
                            f.delta_points.abs() as f64 / max as f64 * weight,
                        )),
                        ..f.clone()
                    },
                    _ => f.clone(),
                }
            })
            .collect();
        (score, scored)
    } else {
        let earned: i64 = dimensions.iter().map(|d| d.earned_points).sum();
        let max: i64 = dimensions.iter().map(|d| d.max_points).sum();
        (
            js_round(earned as f64 / max as f64 * 100.0).clamp(0, 100),
            findings
                .iter()
                .map(|f| Finding {
                    score_impact: Some(f.delta_points.abs()),
                    ..f.clone()
                })
                .collect(),
        )
    };

    let projected = if findings.is_empty() {
        overall
    } else if input.kind == "prompt-readiness" {
        (overall
            + scored
                .iter()
                .filter(|f| is_one_click_fix(f))
                .map(|f| f.score_impact.unwrap_or(0))
                .sum::<i64>())
        .min(100)
    } else {
        overall.max(
            (overall
                + js_round(
                    scored
                        .iter()
                        .map(|f| f.score_impact.unwrap_or(0))
                        .sum::<i64>() as f64
                        * 0.85,
                ))
            .min(96),
        )
    };

    let prompts_analyzed = if let Some(session) = session {
        if input.turn_index.is_some() {
            1
        } else {
            count_prompt_turns(
                &events,
                session["taskDefinition"]["goal"]
                    .as_str()
                    .is_some_and(|g| !g.is_empty()),
            )
        }
    } else {
        usize::from(!effective_prompt.is_empty())
    };

    let mut configured: Vec<String> = Vec::new();
    if input.code_intelligence_available != Some(false) {
        configured.push("code_intelligence".into());
    }
    if input.tracker_tools_available
        || session.is_some_and(|s| s["connectionId"].as_str().is_some_and(|c| !c.is_empty()))
    {
        configured.push("tracker".into());
    }
    if input.browser_tools_available {
        configured.push("browser".into());
    }
    configured.extend(input.configured_mcp_servers.iter().cloned());
    let unique_configured: Vec<String> = configured
        .iter()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    let suggested = build_suggested_prompt(&effective_prompt, &findings, &input.kind);
    let diagnosis = build_diagnosis(
        &input.kind,
        &findings,
        session.and_then(|s| s["state"].as_str()),
    );

    let mut inventory = json!({
        "promptsAnalyzed": prompts_analyzed, "toolsUsed": exec.tools_used, "totalToolCalls": exec.total_tool_calls,
        "successfulToolCalls": exec.successful_tool_calls, "failedToolCalls": exec.failed_tool_calls, "retryLoopCount": exec.retry_loop_count,
        "shellSearchFallbackCount": exec.shell_search_fallback_count, "mcpToolsUsed": exec.mcp_tools_used, "mcpServersConfigured": unique_configured,
        "skillsAttached": capability.skills_attached, "skillsDetected": capability.skills_detected, "skillsRecommended": capability.skills_recommended,
    });
    if let Some(profile) = &capability.agent_profile_id {
        inventory["agentProfileId"] = json!(profile);
    }
    if let Some(profile) = &capability.recommended_agent_profile_id {
        inventory["recommendedAgentProfileId"] = json!(profile);
    }

    let mut report = json!({
        "schemaVersion": FEEDBACK_SCHEMA_VERSION,
        "rubricVersion": SCORING_RUBRIC_VERSION,
        "reportId": format!("fb-{}", &digest[..12]),
        "evaluatedAt": input.evaluated_at.clone().unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into()),
        "kind": input.kind,
        "promptText": effective_prompt,
        "inputDigest": digest,
        "overallScore": overall,
        "projectedScore": projected,
        "grade": grade(overall),
        "projectedGrade": grade(projected),
        "dimensions": dimensions,
        "findings": scored,
        "inventory": inventory,
        "suggestedPrompt": suggested,
        "intent": prompt_analysis.intent,
        "diagnosis": diagnosis,
    });
    let session_id = session
        .and_then(|s| s["sessionId"].as_str().map(str::to_owned))
        .or_else(|| input.session_id.clone())
        .filter(|s| !s.is_empty());
    if let Some(id) = session_id {
        report["sessionId"] = json!(id);
    }
    if let Some(key) = &issue_key {
        report["issueKey"] = json!(key);
    }
    if let Some(turn) = input.turn_index {
        report["turnIndex"] = json!(turn);
    }
    if let Some(prior) = &input.prior_context {
        let mut review = json!({ "turnCount": prior.turn_count, "touchedPaths": prior.touched_paths, "recentMessages": bounded_messages(Some(prior)) });
        if let Some(key) = &prior.issue_key {
            review["issueKey"] = json!(key);
        }
        report["reviewContext"] = review;
    }
    report["rehearsal"] = build_rehearsal(input, &effective_prompt);
    if let Some(point) = build_turning_point(&scored) {
        report["turningPoint"] = point;
    }
    if prompt_analysis.inherits_context
        && let Some(prior) = &input.prior_context
    {
        report["contextInheritance"] = json!(prior);
    }
    if let Some(clarity) = &input.clarity {
        report["clarity"] = clarity.clone();
    }
    if let Some(feedback) = &input.user_feedback {
        report["userFeedback"] = feedback.clone();
    }
    report
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn clarity_checked(target: &str) -> Value {
        let check = |answer: &str, evidence: &str| json!({ "answer": answer, "evidence": evidence, "fix": "Fix it." });
        json!({ "status": "checked", "checklistVersion": 4, "model": "m/x", "cached": false, "answers": {
            "checklistVersion": 4, "kind": "instruction",
            "interpretation": { "target": { "text": "", "evidence": "", "source": "unknown" }, "change": { "text": "", "evidence": "", "source": "unknown" }, "result": { "text": "", "evidence": "", "source": "unknown" } },
            "checks": { "target": check(target, "the thing"), "outcome": check("no", "put"), "done": check("no", ""), "context-gap": check("no", ""), "ambiguity": check("yes", "the box") } } })
    }

    fn prompt_input(text: &str) -> EvaluationInput {
        EvaluationInput {
            kind: "prompt-readiness".into(),
            prompt_text: text.into(),
            code_intelligence_available: Some(true),
            browser_tools_available: true,
            evaluated_at: Some("2026-01-01T00:00:00.000Z".into()),
            ..EvaluationInput::default()
        }
    }

    #[test]
    fn a_placeholder_prompt_scores_forty() {
        let mut input = prompt_input("put the thing in the box");
        input.clarity = Some(clarity_checked("no"));
        let report = evaluate(&input);
        assert_eq!(report["overallScore"], 40);
        assert_eq!(report["grade"], "F");
        assert_eq!(
            report["rehearsal"]["steps"][0],
            "Clarify target, change, result before choosing an execution plan."
        );
        assert_eq!(report["findings"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn unchecked_prompts_report_facts_only_and_are_deterministic() {
        let input = prompt_input("how does this work?");
        let (a, b) = (evaluate(&input), evaluate(&input));
        assert_eq!(a, b);
        assert_eq!(a["overallScore"], 100);
        assert_eq!(a["diagnosis"]["headline"], "Prompt is ready");
        assert_eq!(a["inputDigest"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn read_only_edit_request_projects_a_one_click_fix() {
        let mut input = prompt_input("fix the truncated headline");
        input.tool_mode = Some("read-only".into());
        let report = evaluate(&input);
        assert_eq!(report["findings"][0]["id"], "prompt-tool-mode-conflict");
        assert_eq!(report["findings"][0]["scoreImpact"], 18);
        assert_eq!(report["overallScore"], 82);
        assert_eq!(report["projectedScore"], 100);
    }

    #[test]
    fn session_reports_name_root_causes() {
        let session = json!({ "issueKey": "S-1", "sessionId": "S-1", "state": "completed", "toolMode": "full", "stepCount": 3, "activeSkills": [],
            "taskDefinition": { "goal": "update docs/plans/feature.md" },
            "events": [
                { "type": "user_input_completed", "detail": "update docs/plans/feature.md" },
                { "type": "tool_complete", "data": { "toolName": "edit_file", "ok": false, "args": { "path": "docs/plans/feature.md" } } },
                { "type": "tool_complete", "data": { "toolName": "edit_file", "ok": false, "args": { "path": "docs/plans/feature.md" } } },
                { "type": "tool_complete", "data": { "toolName": "edit_file", "ok": true, "args": { "path": "docs/plans/feature.md" }, "fileChanges": [{ "path": "docs/plans/feature.md" }] } } ] });
        let input = EvaluationInput {
            kind: "session-execution".into(),
            session: Some(session),
            available_skills: vec![
                json!({ "name": "plan-authoring", "description": "d", "triggers": [] }),
            ],
            code_intelligence_available: Some(true),
            ..EvaluationInput::default()
        };
        let report = evaluate(&input);
        assert_eq!(
            report["diagnosis"]["headline"],
            "Completed with a missed skill & avoidable tool thrashing"
        );
        assert_eq!(
            report["turningPoint"]["findingId"],
            "tool-blind-edit-loop:feature.md"
        );
        assert!(report["suggestedPrompt"].as_str().unwrap().starts_with(
            "Follow up on the previous turn:\n- Read @docs/plans/feature.md before editing it."
        ));
        assert_eq!(report["sessionId"], "S-1");
        assert_eq!(
            report["inventory"]["skillsRecommended"][0],
            "plan-authoring"
        );
    }

    #[test]
    fn rule_keys_roll_up_per_checklist_and_model() {
        let report =
            json!({ "rubricVersion": 3, "clarity": { "checklistVersion": 4, "model": "a/b" } });
        assert_eq!(
            finding_rule_key(&report, "tool-blind-edit-loop:x.md"),
            "3/4/a/b/tool-blind-edit-loop"
        );
        assert_eq!(
            finding_rule_key(&json!({ "rubricVersion": 3 }), "clarity-target"),
            "3/facts/facts/clarity-target"
        );
    }

    #[test]
    fn suggested_prompt_weaves_pins_and_checks_into_one_sentence() {
        use super::super::types::Remediation;
        let pin = Finding::new(
            "a",
            "prompt-clarity",
            "warning",
            -1,
            "t",
            "e",
            Remediation::new("pin-file", "Pin", "d").snippet("in @src/A.tsx"),
        );
        let test = Finding::new(
            "b",
            "prompt-clarity",
            "warning",
            -1,
            "t",
            "e",
            Remediation::new("add-test-command", "Test", "d").snippet("and verify with `npm test`"),
        );
        assert_eq!(
            build_suggested_prompt("fix the bar.", &[pin, test], "prompt-readiness"),
            "fix the bar in @src/A.tsx and verify with `npm test`."
        );
    }
}
