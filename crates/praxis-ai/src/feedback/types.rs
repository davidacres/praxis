//! Shared shapes for prompt/session feedback scoring (port of `feedbackTypes.ts`).

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

pub const SCORING_RUBRIC_VERSION: u32 = 3;
pub const FEEDBACK_SCHEMA_VERSION: u32 = 1;
pub const CLARITY_CHECKLIST_VERSION: u32 = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub label: String,
    pub tone: String,
}

pub fn signal(label: impl Into<String>, tone: &str) -> Signal {
    Signal {
        label: label.into(),
        tone: tone.to_owned(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StepRef {
    pub step: usize,
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Remediation {
    pub kind: String,
    pub label: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_prompt_snippet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternatives: Option<Vec<Remediation>>,
}

impl Remediation {
    pub fn new(kind: &str, label: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            kind: kind.to_owned(),
            label: label.into(),
            description: description.into(),
            ..Self::default()
        }
    }
    #[must_use]
    pub fn target(mut self, id: impl Into<String>) -> Self {
        self.target_id = Some(id.into());
        self
    }
    #[must_use]
    pub fn snippet(mut self, text: impl Into<String>) -> Self {
        self.suggested_prompt_snippet = Some(text.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub dimension: String,
    pub severity: String,
    pub delta_points: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score_impact: Option<i64>,
    pub title: String,
    pub evidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_indices: Option<Vec<usize>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<StepRef>>,
    pub remediation: Remediation,
}

impl Finding {
    pub fn new(
        id: impl Into<String>,
        dimension: &str,
        severity: &str,
        delta: i64,
        title: impl Into<String>,
        evidence: impl Into<String>,
        remediation: Remediation,
    ) -> Self {
        Self {
            id: id.into(),
            dimension: dimension.to_owned(),
            severity: severity.to_owned(),
            delta_points: delta,
            score_impact: None,
            title: title.into(),
            evidence: evidence.into(),
            step_indices: None,
            steps: None,
            remediation,
        }
    }
    #[must_use]
    pub fn with_steps(mut self, steps: Vec<StepRef>) -> Self {
        self.step_indices = Some(steps.iter().map(|s| s.step).collect());
        self.steps = Some(steps);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DimensionScore {
    pub dimension: String,
    pub label: String,
    pub earned_points: i64,
    pub max_points: i64,
    pub normalized_score: i64,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signals: Option<Vec<Signal>>,
}

#[derive(Debug, Clone, Default)]
pub struct Symbol {
    pub name: String,
    pub found: bool,
    pub location: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkspaceHints {
    pub changed_files: Vec<String>,
    pub test_files: Vec<String>,
    pub package_scripts: Vec<String>,
    pub tracked_files: Vec<String>,
    pub symbols: Vec<Symbol>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PriorContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recent_messages: Option<Vec<Message>>,
    pub turn_count: usize,
    pub touched_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_key: Option<String>,
}

/// Everything the pure engine reads. `session` and `user_feedback` stay JSON: they are the stored shapes.
#[derive(Debug, Clone, Default)]
pub struct EvaluationInput {
    pub kind: String,
    pub prompt_text: String,
    pub tool_mode: Option<String>,
    pub session_mode: Option<String>,
    pub profile_id: Option<String>,
    pub active_skills: Option<Vec<String>>,
    pub issue_key: Option<String>,
    pub session_id: Option<String>,
    pub turn_index: Option<usize>,
    pub context_tokens: Option<f64>,
    pub context_limit: Option<f64>,
    pub session: Option<Value>,
    pub available_skills: Vec<Value>,
    pub available_agents: Vec<Value>,
    pub configured_mcp_servers: Vec<String>,
    pub code_intelligence_available: Option<bool>,
    pub tracker_tools_available: bool,
    pub browser_tools_available: bool,
    pub user_feedback: Option<Value>,
    pub prior_context: Option<PriorContext>,
    pub workspace_hints: Option<WorkspaceHints>,
    pub clarity: Option<Value>,
    pub evaluated_at: Option<String>,
}

pub fn grade(score: i64) -> &'static str {
    match score.clamp(0, 100) {
        90.. => "A",
        80..=89 => "B",
        70..=79 => "C",
        60..=69 => "D",
        _ => "F",
    }
}

/// JavaScript's `Math.round` (half rounds up).
pub fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// An approximation of `String.prototype.localeCompare` for ASCII-heavy ids: punctuation sorts
/// before digits before letters, letters compare case-insensitively first, lowercase wins ties.
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    fn class(c: char) -> u8 {
        if c.is_alphabetic() {
            2
        } else if c.is_numeric() {
            1
        } else {
            0
        }
    }
    let primary = |s: &str| {
        s.chars()
            .map(|c| (class(c), c.to_lowercase().next().unwrap_or(c)))
            .collect::<Vec<_>>()
    };
    primary(a).cmp(&primary(b)).then_with(|| {
        a.chars()
            .zip(b.chars())
            .find(|(x, y)| x != y)
            .map_or(Ordering::Equal, |(x, _)| {
                if x.is_lowercase() {
                    Ordering::Less
                } else {
                    Ordering::Greater
                }
            })
    })
}

/// `Number.prototype.toLocaleString('en-US')` for integers.
pub fn group_digits(value: f64) -> String {
    let rounded = format!("{}", value.round() as i64);
    let (sign, digits) = rounded
        .strip_prefix('-')
        .map_or(("", rounded.as_str()), |d| ("-", d));
    let mut out = String::new();
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    format!("{sign}{out}")
}

/// Sorted-key canonical form used for digests.
pub fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| locale_cmp(a, b));
            let mut out = Map::new();
            for key in keys {
                out.insert(key.clone(), canonicalize(&map[key]));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

pub fn bounded_messages(context: Option<&PriorContext>) -> Vec<Message> {
    let all: Vec<Message> = context
        .and_then(|c| c.recent_messages.as_ref())
        .map(|messages| {
            messages
                .iter()
                .filter(|m| {
                    (m.role == "user" || m.role == "assistant") && !m.text.trim().is_empty()
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let start = all.len().saturating_sub(6);
    all[start..]
        .iter()
        .map(|m| Message {
            role: m.role.clone(),
            text: m.text.trim().chars().take(1200).collect(),
        })
        .collect()
}

fn sorted_unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut v: Vec<String> = items.into_iter().filter(|s| !s.is_empty()).collect();
    v.sort();
    v.dedup();
    v
}

fn strs(value: &Value) -> impl Iterator<Item = String> + '_ {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
}

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

pub fn input_digest(input: &EvaluationInput) -> String {
    let mut skills: Vec<Value> = input
        .available_skills
        .iter()
        .map(|skill| {
            let triggers = sorted_unique(strs(&skill["triggers"]).map(|t| t.trim().to_lowercase()));
            json!({ "name": field(skill, "name").trim(), "description": field(skill, "description").trim(), "triggers": triggers })
        })
        .collect();
    skills.sort_by(|a, b| locale_cmp(field(a, "name"), field(b, "name")));
    let mut agents: Vec<Value> = input
        .available_agents
        .iter()
        .map(|agent| {
            let preferred = sorted_unique(strs(&agent["preferredSkills"]).map(|t| t.trim().to_owned()));
            json!({ "id": field(agent, "id").trim(), "name": field(agent, "name").trim(), "description": field(agent, "description").trim(), "preferredSkills": preferred })
        })
        .collect();
    agents.sort_by(|a, b| locale_cmp(field(a, "id"), field(b, "id")));
    let session = input.session.as_ref();
    let active = sorted_unique(
        input
            .active_skills
            .clone()
            .unwrap_or_else(|| {
                session
                    .map(|r| strs(&r["activeSkills"]).collect())
                    .unwrap_or_default()
            })
            .into_iter()
            .map(|s| s.trim().to_owned()),
    );
    let mcp = sorted_unique(
        input
            .configured_mcp_servers
            .iter()
            .map(|s| s.trim().to_owned()),
    );
    let tags = sorted_unique(input.user_feedback.iter().flat_map(|f| {
        strs(&f["frictionTags"])
            .map(|t| t.trim().to_owned())
            .collect::<Vec<_>>()
    }));
    let session_snapshot = session.map_or(Value::Null, |r| {
        let events: Vec<Value> = r["events"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|ev| {
                let data = &ev["data"];
                json!({
                    "timestamp": ev["timestamp"], "type": ev["type"], "summary": ev["summary"], "detail": ev["detail"].as_str().unwrap_or(""),
                    "data": if data.is_object() { json!({
                        "toolName": data["toolName"].as_str().unwrap_or(""), "kind": data["kind"].as_str().unwrap_or(""),
                        "argsSummary": data["argsSummary"].as_str().unwrap_or(""), "args": data["args"].clone(), "ok": data["ok"].clone(),
                        "fileChanges": data["fileChanges"].as_array().into_iter().flatten().map(|f| json!({ "path": f["path"] })).collect::<Vec<_>>(),
                    }) } else { Value::Null },
                })
            })
            .collect();
        let mut detected: Vec<Value> = r["detectedSkills"].as_array().into_iter().flatten().map(|d| json!({ "skillId": d["skillId"], "via": d["via"], "count": d["count"] })).collect();
        detected.sort_by(|a, b| locale_cmp(field(a, "skillId"), field(b, "skillId")));
        json!({
            "sessionId": r["sessionId"], "issueKey": r["issueKey"], "state": r["state"],
            "mode": r["mode"].as_str().or_else(|| r["taskDefinition"]["sessionMode"].as_str()).unwrap_or("chat"),
            "toolMode": r["toolMode"].as_str().unwrap_or("full"),
            "profileId": r["profileId"].as_str().or_else(|| r["agentId"].as_str()).unwrap_or(""),
            "stepCount": r["stepCount"], "maxSteps": r["taskDefinition"]["maxSteps"].clone(),
            "contextTokens": r["contextTokens"].clone(), "contextLimit": r["contextLimit"].clone(),
            "activeSkills": sorted_unique(strs(&r["activeSkills"]).map(|s| s.trim().to_owned())),
            "detectedSkills": detected, "events": events,
        })
    });
    let hints = input.workspace_hints.as_ref().map_or(Value::Null, |h| {
        let mut symbols: Vec<Value> = h.symbols.iter().map(|y| json!({ "name": y.name, "found": y.found, "location": y.location.clone().unwrap_or_default() })).collect();
        symbols.sort_by(|a, b| locale_cmp(field(a, "name"), field(b, "name")));
        json!({
            "changedFiles": sorted_unique(h.changed_files.clone()), "testFiles": sorted_unique(h.test_files.clone()),
            "packageScripts": sorted_unique(h.package_scripts.clone()), "trackedFiles": sorted_unique(h.tracked_files.clone()), "symbols": symbols,
        })
    });
    let prior = input.prior_context.as_ref().map_or(Value::Null, |p| {
        let mut touched = p.touched_paths.clone();
        touched.sort();
        json!({ "turnCount": p.turn_count, "recentMessages": bounded_messages(Some(p)), "touchedPaths": touched, "issueKey": p.issue_key.clone().unwrap_or_default() })
    });
    let clarity = input.clarity.as_ref().map_or(Value::Null, |c| {
        json!({ "status": c["status"], "checklistVersion": c["checklistVersion"], "model": c["model"].as_str().unwrap_or(""), "answers": c["answers"].clone() })
    });
    let user_feedback = input.user_feedback.as_ref().map_or(Value::Null, |f| {
        json!({ "targetKind": f["targetKind"], "verdict": f["verdict"].clone(), "frictionTags": tags, "notes": f["notes"].as_str().unwrap_or("").trim() })
    });
    let num = |v: Option<f64>, fallback: Value| v.map_or(fallback, |n| json!(n));
    let payload = canonicalize(&json!({
        "rubricVersion": SCORING_RUBRIC_VERSION,
        "kind": input.kind,
        "promptText": input.prompt_text.trim(),
        "toolMode": input.tool_mode.clone().or_else(|| session.and_then(|r| r["toolMode"].as_str().map(str::to_owned))).unwrap_or_else(|| "full".into()),
        "sessionMode": input.session_mode.clone().or_else(|| session.and_then(|r| r["mode"].as_str().map(str::to_owned))).unwrap_or_else(|| "chat".into()),
        "profileId": input.profile_id.clone().or_else(|| session.and_then(|r| r["profileId"].as_str().or_else(|| r["agentId"].as_str()).map(str::to_owned))).unwrap_or_default(),
        "activeSkills": active,
        "issueKey": input.issue_key.clone().or_else(|| session.and_then(|r| r["issueKey"].as_str().map(str::to_owned))).unwrap_or_default(),
        "turnIndex": input.turn_index.map_or(Value::Null, |t| json!(t)),
        "contextTokens": num(input.context_tokens, session.map_or(Value::Null, |r| r["contextTokens"].clone())),
        "contextLimit": num(input.context_limit, session.map_or(Value::Null, |r| r["contextLimit"].clone())),
        "codeIntelligenceAvailable": input.code_intelligence_available.unwrap_or(false),
        "trackerToolsAvailable": input.tracker_tools_available,
        "browserToolsAvailable": input.browser_tools_available,
        "configuredMcpServers": mcp, "availableSkills": skills, "availableAgents": agents,
        "session": session_snapshot, "priorContext": prior, "clarity": clarity, "workspaceHints": hints, "userFeedback": user_feedback,
    }));
    let bytes = serde_json::to_string(&payload).unwrap_or_default();
    Sha256::digest(bytes.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grades_and_rounding() {
        assert_eq!(grade(90), "A");
        assert_eq!(grade(59), "F");
        assert_eq!(js_round(2.5), 3);
        assert_eq!(group_digits(1_234_567.0), "1,234,567");
    }

    #[test]
    fn digest_is_order_independent_for_catalogs() {
        let mut a = EvaluationInput {
            kind: "prompt-readiness".into(),
            prompt_text: "x".into(),
            ..EvaluationInput::default()
        };
        a.configured_mcp_servers = vec!["b".into(), "a".into()];
        let mut b = a.clone();
        b.configured_mcp_servers = vec!["a".into(), "b".into()];
        assert_eq!(input_digest(&a), input_digest(&b));
    }

    #[test]
    fn locale_order_puts_punctuation_before_letters() {
        assert_eq!(locale_cmp("clarity-a", "clarity-b"), Ordering::Less);
        assert_eq!(locale_cmp("a-b", "ab"), Ordering::Less);
        assert_eq!(locale_cmp("a", "B"), Ordering::Less);
    }
}
