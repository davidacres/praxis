//! Detects skills an AI tool loads on its own during a session (port of `skillUsage.ts`).
//!
//! Praxis records the skills it attaches (`activeSkills`), but CLI agents also pick up skills
//! themselves: Claude Code calls its `Skill` tool, Codex and others read
//! `.../skills/<name>/SKILL.md`. This reads tool calls for those two signals. It is best-effort.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillUseSignal {
    pub skill_id: String,
    /// `skill-tool` or `skill-file`.
    pub via: &'static str,
    pub at: String,
    pub path: Option<String>,
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static pattern"))
}

fn skill_name(candidate: &str) -> bool {
    static CELL: OnceLock<Regex> = OnceLock::new();
    regex(&CELL, r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$").is_match(candidate)
}

fn skill_tool_name(tool_name: &str, args: &Value) -> Option<String> {
    static TOOL: OnceLock<Regex> = OnceLock::new();
    static TITLED: OnceLock<Regex> = OnceLock::new();
    let name = tool_name.trim();
    let is_skill_tool = regex(
        &TOOL,
        r"(?i)^(?:skill|use_skill|load_skill|activate_skill)$",
    )
    .is_match(name);
    let titled = regex(&TITLED, r"(?i)^skill\s*[:(]\s*([^\s)]+)\)?$")
        .captures(name)
        .map(|c| c[1].to_owned());
    if !is_skill_tool && titled.is_none() {
        return None;
    }
    let from_args = ["skill", "name", "command", "skill_name"]
        .iter()
        .find_map(|key| args[*key].as_str().filter(|v| !v.trim().is_empty()));
    let candidate = from_args.map(str::to_owned).or(titled).unwrap_or_default();
    let candidate = candidate.trim().trim_start_matches('/').to_owned();
    skill_name(&candidate).then_some(candidate)
}

/// The skill loads signalled by these events' tool calls. Only `tool_start` events are read.
#[must_use]
pub fn detect_skill_uses(events: &[Value]) -> Vec<SkillUseSignal> {
    static FILE: OnceLock<Regex> = OnceLock::new();
    static WRITE: OnceLock<Regex> = OnceLock::new();
    let file_pattern = regex(
        &FILE,
        r#"(?i)((?:[^\s'"`<>|;&()]*/)?skills/([A-Za-z0-9][A-Za-z0-9_.-]*)/SKILL\.md)(?:$|[^A-Za-z0-9_.])"#,
    );
    let write_pattern = regex(
        &WRITE,
        r"(?i)\b(write|edit|create|apply_patch|patch|str_replace|multiedit|editing files)\b",
    );
    let mut signals = Vec::new();
    for event in events {
        if event["type"] != "tool_start" {
            continue;
        }
        let data = &event["data"];
        let at = event["timestamp"].as_str().unwrap_or_default().to_owned();
        let tool_name = data["toolName"].as_str().unwrap_or_default();
        if let Some(skill_id) = skill_tool_name(tool_name, &data["args"]) {
            signals.push(SkillUseSignal {
                skill_id,
                via: "skill-tool",
                at,
                path: None,
            });
            continue;
        }
        if data["kind"] == "write" || write_pattern.is_match(tool_name) {
            continue;
        }
        let mut parts: Vec<String> = Vec::new();
        for part in [data["toolName"].as_str(), data["argsSummary"].as_str()]
            .into_iter()
            .flatten()
        {
            parts.push(part.to_owned());
        }
        if !data["args"].is_null() {
            parts.push(data["args"].to_string());
        }
        if let Some(summary) = event["summary"].as_str() {
            parts.push(summary.to_owned());
        }
        let text = parts.join("\n");
        let mut seen: HashSet<String> = HashSet::new();
        for captures in file_pattern.captures_iter(&text) {
            let (path, skill_id) = (captures[1].to_owned(), captures[2].to_owned());
            if seen.contains(&skill_id) || redirects_into(&text, &path) {
                continue;
            }
            seen.insert(skill_id.clone());
            signals.push(SkillUseSignal {
                skill_id,
                via: "skill-file",
                at: at.clone(),
                path: Some(path),
            });
        }
    }
    signals
}

/// True when `text` writes to `path` with a shell redirect, i.e. authors the skill rather than loads it.
fn redirects_into(text: &str, path: &str) -> bool {
    Regex::new(&format!(r#">>?\s*['"]?{}"#, regex::escape(path)))
        .is_ok_and(|pattern| pattern.is_match(text))
}

/// Folds new signals into a session's aggregated `detectedSkills`. `None` when there are none.
#[must_use]
pub fn merge_detected_skill_uses(
    existing: Option<&Value>,
    signals: &[SkillUseSignal],
) -> Option<Vec<Value>> {
    let mut uses: Vec<Value> = existing
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if signals.is_empty() {
        return existing.filter(|value| !value.is_null()).map(|_| uses);
    }
    for signal in signals {
        let Some(current) = uses
            .iter_mut()
            .find(|used| used["skillId"] == signal.skill_id.as_str())
        else {
            let mut created = json!({ "skillId": signal.skill_id, "via": signal.via, "firstAt": signal.at, "lastAt": signal.at, "count": 1 });
            if let Some(path) = &signal.path {
                created["path"] = json!(path);
            }
            uses.push(created);
            continue;
        };
        current["count"] = json!(current["count"].as_u64().unwrap_or(0) + 1);
        if signal.at.as_str() < current["firstAt"].as_str().unwrap_or(&signal.at) {
            current["firstAt"] = json!(signal.at);
        }
        if signal.at.as_str() > current["lastAt"].as_str().unwrap_or("") {
            current["lastAt"] = json!(signal.at);
        }
        // The skill tool is the stronger signal; keep it once seen.
        if signal.via == "skill-tool" {
            current["via"] = json!("skill-tool");
        }
        if current["path"].is_null()
            && let Some(path) = &signal.path
        {
            current["path"] = json!(path);
        }
    }
    Some(uses)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, args: Value, at: &str) -> Value {
        json!({ "type": "tool_start", "timestamp": at, "summary": format!("Running tool: {name}"), "data": { "toolName": name, "args": args } })
    }

    #[test]
    fn detects_the_skill_tool_and_skill_file_reads() {
        let events = vec![
            tool(
                "cat .agents/skills/plan-authoring/SKILL.md",
                Value::Null,
                "t1",
            ),
            tool("Skill", json!({ "skill": "praxis-scheduled-runs" }), "t2"),
            tool("Write", json!({ "file": "skills/x/SKILL.md" }), "t3"),
            tool("shell", json!("echo hi > skills/y/SKILL.md"), "t4"),
        ];
        let signals = detect_skill_uses(&events);
        let ids: Vec<(&str, &str)> = signals
            .iter()
            .map(|s| (s.skill_id.as_str(), s.via))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("plan-authoring", "skill-file"),
                ("praxis-scheduled-runs", "skill-tool")
            ]
        );
        assert_eq!(
            signals[0].path.as_deref(),
            Some(".agents/skills/plan-authoring/SKILL.md")
        );
    }

    #[test]
    fn merging_counts_and_prefers_the_skill_tool() {
        let first = detect_skill_uses(&[tool("cat skills/a/SKILL.md", Value::Null, "t2")]);
        let merged = merge_detected_skill_uses(None, &first).expect("uses");
        let again = detect_skill_uses(&[tool("Skill", json!({ "skill": "a" }), "t1")]);
        let merged = merge_detected_skill_uses(Some(&json!(merged)), &again).expect("uses");
        assert_eq!(merged[0]["count"], 2);
        assert_eq!(merged[0]["via"], "skill-tool");
        assert_eq!(
            (merged[0]["firstAt"].as_str(), merged[0]["lastAt"].as_str()),
            (Some("t1"), Some("t2"))
        );
        assert!(merge_detected_skill_uses(None, &[]).is_none());
    }
}
