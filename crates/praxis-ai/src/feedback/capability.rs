//! Skill and agent-profile alignment (port of `capabilityAlignment.ts`).

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use super::types::{DimensionScore, Finding, Remediation, Signal, StepRef, js_round, signal};
use crate::session::skill_usage::detect_skill_uses;

struct Heuristic {
    name: &'static str,
    description: &'static str,
    prompt: &'static str,
    path: Option<&'static str>,
}

const HEURISTICS: [Heuristic; 4] = [
    Heuristic {
        name: "plan-authoring",
        description: "Write markdown plan items (features, stories, tasks, bugs) that a folder-backed Praxis board can parse.",
        prompt: r"(?i)\b(feature\s+plan|story\s+plan|plan\s+file|plan\s+items?|docs/plans|plan-authoring|create\s+a\s+plan|board\s+items?|task-\d+|fx-bf-\d+|fx-be-\d+)\b",
        path: Some(r"(?i)(?:^|/)docs/plans/"),
    },
    Heuristic {
        name: "praxis-addon-builder",
        description: "Build, validate, package, and publish Praxis add-ons for themes, surface packs, agents, and workflow templates.",
        prompt: r"(?i)\b(add-?on|marketplace\s+package|surface\s+pack\s+add-?on|praxis-addon-builder|addon\.praxis\.json)\b",
        path: Some(r"(?i)addon\.praxis\.json|packages/core/src/marketplace"),
    },
    Heuristic {
        name: "human-review",
        description: "Conduct an interactive human review of completed work.",
        prompt: r"(?i)\b(human\s+review|interactive\s+review\s+walkthrough|human-review)\b",
        path: None,
    },
    Heuristic {
        name: "praxis-scheduled-runs",
        description: "Author or update scheduled workflow run request files under .praxis/scheduled-runs/.",
        prompt: r"(?i)\b(scheduled\s+run|schedule\s+workflow|\.praxis/scheduled-runs)\b",
        path: Some(r"(?i)\.praxis/scheduled-runs/"),
    },
];

fn rx(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern")
}

fn heuristic_regexes() -> &'static Vec<(Regex, Option<Regex>)> {
    static CELL: OnceLock<Vec<(Regex, Option<Regex>)>> = OnceLock::new();
    CELL.get_or_init(|| {
        HEURISTICS
            .iter()
            .map(|h| (rx(h.prompt), h.path.map(rx)))
            .collect()
    })
}

fn recommend_agent(
    mode: &str,
    prompt: &str,
    current: Option<&str>,
    agents: &[Value],
) -> Option<(String, String)> {
    let lower = prompt.to_lowercase();
    let is_planning = mode == "analysis"
        || rx(r"\b(create\s+a\s+plan|feature\s+plan|decompose|architecture\s+plan)\b")
            .is_match(&lower);
    let is_review = mode == "review"
        || rx(r"\b(code\s+review|security\s+review|audit\s+changes)\b").is_match(&lower);
    let current = current?;
    let current_lower = current.to_lowercase();
    let find = |pattern: &str, fallback: &str| {
        agents
            .iter()
            .filter_map(|a| a["id"].as_str())
            .find(|id| rx(pattern).is_match(id))
            .unwrap_or(fallback)
            .to_owned()
    };
    if is_review && rx(r"implementer|coder|builder").is_match(&current_lower) {
        return Some((
            find(r"(?i)review", "praxis-reviewer"),
            format!(
                "Agent profile `{current}` is tuned for implementation, while this session is in `{mode}` / review mode."
            ),
        ));
    }
    if is_planning && mode == "analysis" && current_lower.contains("implementer") {
        return Some((
            find(r"(?i)plan|architect", "praxis-planner"),
            format!(
                "Agent profile `{current}` is tuned for code edits, while this session is in `analysis` mode."
            ),
        ));
    }
    if mode == "chat"
        && !is_planning
        && !is_review
        && current_lower.contains("reviewer")
        && rx(r"(?i)\b(implement|build|write|fix)\b").is_match(&lower)
    {
        return Some((
            find(r"(?i)implement", "praxis-implementer"),
            format!(
                "Agent profile `{current}` is a read-only reviewer, while the prompt asks to implement changes."
            ),
        ));
    }
    None
}

#[derive(Debug, Clone)]
pub struct CapabilityAnalysis {
    pub dimension: DimensionScore,
    pub findings: Vec<Finding>,
    pub skills_attached: Vec<String>,
    pub skills_detected: Vec<String>,
    pub skills_recommended: Vec<String>,
    pub agent_profile_id: Option<String>,
    pub recommended_agent_profile_id: Option<String>,
}

pub struct CapabilityInput<'a> {
    pub prompt_text: &'a str,
    pub session_mode: Option<&'a str>,
    pub profile_id: Option<&'a str>,
    pub active_skills: Option<&'a [String]>,
    pub session: Option<&'a Value>,
    pub touched_paths: &'a [String],
    pub path_write_steps: &'a BTreeMap<String, StepRef>,
    pub available_skills: &'a [Value],
    pub available_agents: &'a [Value],
    pub user_feedback: Option<&'a Value>,
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !value.is_empty() && !list.contains(&value) {
        list.push(value);
    }
}

struct Recommendation {
    name: String,
    reason: String,
    matched_by_path: bool,
    matching_path: Option<String>,
}

pub fn analyze(input: &CapabilityInput<'_>) -> CapabilityAnalysis {
    let max = 20;
    let mut earned = max;
    let mut findings = Vec::new();

    let mut attached: Vec<String> = Vec::new();
    let session_skills: Vec<String> = input
        .session
        .map(|s| {
            s["activeSkills"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    for skill in input
        .active_skills
        .unwrap_or_default()
        .iter()
        .chain(session_skills.iter())
    {
        push_unique(&mut attached, skill.trim().to_owned());
    }
    let mut detected: Vec<String> = Vec::new();
    if let Some(session) = input.session {
        for d in session["detectedSkills"].as_array().into_iter().flatten() {
            push_unique(
                &mut detected,
                d["skillId"].as_str().unwrap_or_default().trim().to_owned(),
            );
        }
        let events: Vec<Value> = session["events"].as_array().cloned().unwrap_or_default();
        for signal in detect_skill_uses(&events) {
            push_unique(&mut detected, signal.skill_id.trim().to_owned());
        }
    }
    let mut used: Vec<String> = attached.clone();
    for skill in &detected {
        push_unique(&mut used, skill.clone());
    }

    let prompt = input.prompt_text.trim();
    let catalog_names: Vec<&str> = input
        .available_skills
        .iter()
        .filter_map(|s| s["name"].as_str())
        .collect();
    let mut recommended: Vec<Recommendation> = Vec::new();

    for (index, heuristic) in HEURISTICS.iter().enumerate() {
        let available =
            input.available_skills.is_empty() || catalog_names.contains(&heuristic.name);
        if !available || used.iter().any(|u| u == heuristic.name) {
            continue;
        }
        let (prompt_re, path_re) = &heuristic_regexes()[index];
        let matching_path = path_re
            .as_ref()
            .and_then(|r| input.touched_paths.iter().find(|p| r.is_match(p)));
        if let Some(path) = matching_path {
            recommended.push(Recommendation {
                name: heuristic.name.to_owned(),
                reason: format!("Touched `{path}` without loading the `{}` skill, so its rules for these files were never applied.", heuristic.name),
                matched_by_path: true,
                matching_path: Some(path.clone()),
            });
        } else if prompt_re.is_match(prompt) {
            recommended.push(Recommendation {
                name: heuristic.name.to_owned(),
                reason: format!(
                    "Prompt goals match the `{}` skill ({})",
                    heuristic.name, heuristic.description
                ),
                matched_by_path: false,
                matching_path: None,
            });
        }
    }

    for skill in input.available_skills {
        let name = skill["name"].as_str().unwrap_or_default().trim();
        if name.is_empty()
            || used.iter().any(|u| u == name)
            || recommended.iter().any(|r| r.name == name)
        {
            continue;
        }
        let trigger = skill["triggers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .find(|trigger| {
                let clean = trigger.trim().to_lowercase();
                clean.chars().count() >= 3
                    && Regex::new(&format!(r"(?i)\b{}\b", regex::escape(&clean)))
                        .is_ok_and(|r| r.is_match(prompt))
            });
        if let Some(trigger) = trigger {
            recommended.push(Recommendation {
                name: name.to_owned(),
                reason: format!(
                    "Prompt matched trigger \"{trigger}\" for skill `{name}` ({}).",
                    skill["description"].as_str().unwrap_or_default()
                ),
                matched_by_path: false,
                matching_path: None,
            });
        }
    }

    for rec in &recommended {
        let deduction = if rec.matched_by_path { 8 } else { 6 };
        earned -= deduction;
        let step = rec
            .matching_path
            .as_ref()
            .and_then(|p| input.path_write_steps.get(p));
        let name = &rec.name;
        let mut finding = Finding::new(
            format!("skill-missed-{name}"),
            "skill-agent-alignment",
            if rec.matched_by_path {
                "critical"
            } else {
                "warning"
            },
            -deduction,
            rec.matching_path.as_ref().map_or_else(
                || format!("Prompt matches the `{name}` skill, which isn't attached"),
                |p| format!("Edited `{p}` without the `{name}` skill"),
            ),
            rec.reason.clone(),
            Remediation::new(
                "attach-skill",
                format!("+ Attach {name}"),
                format!(
                    "Attach the `{name}` skill so the agent follows its specialized instructions."
                ),
            )
            .target(name.clone())
            .snippet(format!("Follow the `{name}` skill guidelines.")),
        );
        if let Some(step) = step {
            finding = finding.with_steps(vec![step.clone()]);
        }
        findings.push(finding);
    }

    let mode = input
        .session_mode
        .or_else(|| {
            input.session.and_then(|s| {
                s["mode"]
                    .as_str()
                    .or_else(|| s["taskDefinition"]["sessionMode"].as_str())
            })
        })
        .unwrap_or("chat");
    let profile = input.profile_id.map(str::to_owned).or_else(|| {
        input.session.and_then(|s| {
            s["profileId"]
                .as_str()
                .or_else(|| s["agentId"].as_str())
                .map(str::to_owned)
        })
    });
    let agent_check = recommend_agent(mode, prompt, profile.as_deref(), input.available_agents);
    if let Some((recommended_id, reason)) = &agent_check {
        earned -= 5;
        findings.push(Finding::new(
            "agent-profile-mode-mismatch",
            "skill-agent-alignment",
            "warning",
            -5,
            format!(
                "Agent profile `{}` mismatches session mode/intent",
                profile.clone().unwrap_or_default()
            ),
            reason.clone(),
            Remediation::new(
                "select-agent",
                format!("Switch to {recommended_id}"),
                format!("Select `{recommended_id}` to match the session's {mode} workflow."),
            )
            .target(recommended_id.clone()),
        ));
    }

    let tags: Vec<&str> = input
        .user_feedback
        .map(|f| {
            f["frictionTags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect()
        })
        .unwrap_or_default();
    let note = input
        .user_feedback
        .and_then(|f| f["notes"].as_str())
        .map(str::trim)
        .filter(|n| !n.is_empty());
    if tags.contains(&"missed-skill") && recommended.is_empty() {
        earned -= 5;
        findings.push(Finding::new(
            "user-flagged-missed-skill",
            "skill-agent-alignment",
            "warning",
            -5,
            "User feedback flagged a missed skill",
            note.map_or_else(
                || "User marked `missed-skill` in session feedback.".to_owned(),
                |n| format!("User note: \"{n}\""),
            ),
            Remediation::new(
                "attach-skill",
                "Attach Relevant Workspace Skill",
                "Attach the domain skill from the Agent Hub before running the next turn.",
            ),
        ));
    }
    if tags.contains(&"wrong-agent-or-mode") && agent_check.is_none() {
        earned -= 4;
        findings.push(Finding::new(
            "user-flagged-wrong-agent-mode", "skill-agent-alignment", "warning", -4,
            "User feedback flagged agent profile or mode selection",
            "User marked `wrong-agent-or-mode` in session feedback.",
            Remediation::new("select-agent", "Review Agent Profile & Mode", "Align the composer mode (Chat / Analysis / Review) and selected Agent Hub profile."),
        ));
    }

    let earned = earned.clamp(0, max);
    let mut sorted_used = used.clone();
    sorted_used.sort();
    let mut recommended_names: Vec<String> = recommended.iter().map(|r| r.name.clone()).collect();
    recommended_names.sort();
    let mut signals: Vec<Signal> = Vec::new();
    if let Some(p) = &profile {
        signals.push(signal(
            format!(
                "{} Agent: {p}",
                if agent_check.is_some() { "!" } else { "✓" }
            ),
            if agent_check.is_some() {
                "warn"
            } else {
                "good"
            },
        ));
    }
    signals.extend(sorted_used.iter().map(|s| signal(format!("✓ {s}"), "good")));
    signals.extend(
        recommended_names
            .iter()
            .map(|s| signal(format!("! Missed skill: {s}"), "bad")),
    );
    let summary = if earned == max {
        if used.is_empty() {
            "Agent profile and skills are aligned with the prompt.".to_owned()
        } else {
            format!("Aligned ({}).", used.join(", "))
        }
    } else {
        findings
            .iter()
            .map(|f| f.title.clone())
            .collect::<Vec<_>>()
            .join("; ")
    };
    let mut skills_attached = attached;
    skills_attached.sort();
    let mut skills_detected = detected;
    skills_detected.sort();
    CapabilityAnalysis {
        dimension: DimensionScore {
            dimension: "skill-agent-alignment".into(),
            label: "Skill & Agent Alignment".into(),
            earned_points: earned,
            max_points: max,
            normalized_score: js_round(earned as f64 / max as f64 * 100.0),
            summary,
            signals: Some(signals),
        },
        findings,
        skills_attached,
        skills_detected,
        skills_recommended: recommended_names,
        agent_profile_id: profile,
        recommended_agent_profile_id: agent_check.map(|(id, _)| id),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recommends_the_missing_skill_for_a_touched_plan_file() {
        let steps = BTreeMap::new();
        let skills =
            vec![json!({ "name": "plan-authoring", "description": "plans", "triggers": [] })];
        let result = analyze(&CapabilityInput {
            prompt_text: "update docs/plans/feature.md",
            session_mode: None,
            profile_id: None,
            active_skills: None,
            session: None,
            touched_paths: &["docs/plans/feature.md".to_owned()],
            path_write_steps: &steps,
            available_skills: &skills,
            available_agents: &[],
            user_feedback: None,
        });
        assert_eq!(result.findings[0].id, "skill-missed-plan-authoring");
        assert_eq!(result.findings[0].delta_points, -8);
        assert!(
            result
                .dimension
                .signals
                .unwrap()
                .iter()
                .any(|s| s.label == "! Missed skill: plan-authoring")
        );
    }

    #[test]
    fn attached_skills_are_not_recommended() {
        let steps = BTreeMap::new();
        let active = vec!["plan-authoring".to_owned()];
        let result = analyze(&CapabilityInput {
            prompt_text: "write the feature plan",
            session_mode: None,
            profile_id: None,
            active_skills: Some(&active),
            session: None,
            touched_paths: &[],
            path_write_steps: &steps,
            available_skills: &[],
            available_agents: &[],
            user_feedback: None,
        });
        assert!(result.findings.is_empty());
    }

    #[test]
    fn flags_an_implementer_in_review_mode() {
        let steps = BTreeMap::new();
        let result = analyze(&CapabilityInput {
            prompt_text: "code review please",
            session_mode: Some("review"),
            profile_id: Some("praxis-implementer"),
            active_skills: None,
            session: None,
            touched_paths: &[],
            path_write_steps: &steps,
            available_skills: &[],
            available_agents: &[],
            user_feedback: None,
        });
        assert_eq!(
            result.recommended_agent_profile_id.as_deref(),
            Some("praxis-reviewer")
        );
    }
}
