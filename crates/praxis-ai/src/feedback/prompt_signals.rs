//! Dimension 1: prompt clarity and context readiness (port of `promptSignals.ts`).

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use super::clarity::{Answers, CHECKLIST, score_answers};
use super::grounding::{pick_test_command, rank_file_candidates, unknown_identifiers};
use super::types::{DimensionScore, Finding, PriorContext, Remediation, Signal, WorkspaceHints, group_digits, js_round, signal};

macro_rules! lazy_re {
    ($name:ident, $pattern:expr) => {
        fn $name() -> &'static Regex {
            static CELL: OnceLock<Regex> = OnceLock::new();
            CELL.get_or_init(|| Regex::new($pattern).expect("static pattern"))
        }
    };
}

lazy_re!(edit_intent, r"(?i)\b(implement|create|write|edit|modify|update|refactor|fix|add|remove|delete|rename|build|patch|scaffold|wire)\b");
lazy_re!(imperative_start, r"(?i)^(?:please\s+)?(put|move|make|do|change|set|replace|swap|convert|migrate|clean|tidy|improve|handle|sort|get|turn|use|hook|connect|finish|apply|bump|upgrade|tweak|adjust|align|place|insert|drop|stick|wrap|merge|split|deploy|run)\b");
lazy_re!(read_only_intent, r"(?i)\b(do not edit|don't edit|read[- ]only|without modifying|only analyze|just explain|investigate only)\b");
lazy_re!(file_anchor, r"(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+|\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|go|rs|cs|dart)\b|`[^`]{2,80}`|@[A-Za-z0-9_./-]{3,})");
lazy_re!(ticket_anchor, r"\b(?:FX-[A-Z]+-\d+|TASK-\d+|[A-Z]{2,10}-\d+|#\d+)\b");
lazy_re!(verification, r"(?i)\b(test|tests|unit test|e2e|playwright|verify|verification|check-types|typecheck|compile|build|lint|assert|npm run|node --test)\b");
lazy_re!(question_lead, r"(?i)^(how|what|why|where|which|who|when|does|is|are|should|(?:can|could) you (?:explain|tell me|describe)|explain|tell me|describe)\b");
lazy_re!(follow_up_ref, r"(?i)\b(it|that|this|those|these|again|same|above|previous|earlier|remaining|rest|commit|push|continue|retry|rerun|re-run|also|instead|too)\b");
lazy_re!(review_pattern, r"(?i)\b(review|audit|critique)\b");
lazy_re!(plan_pattern, r"(?i)\b(plan|roadmap|decompose|stories|feature plan|break (?:it|this) down)\b");
lazy_re!(plan_verbs, r"(?i)\b(create|write|draft|make)\b");
lazy_re!(bugfix_pattern, r"(?i)\b(fix|bug|broken|regression|crash|failing|fails|error|truncated|misaligned|wrong)\b");
lazy_re!(question_mark_end, r"\?\s*$");

pub fn intent_label(intent: &str) -> &'static str {
    match intent {
        "question" => "Question",
        "follow-up" => "Follow-up",
        "bugfix" => "Bugfix / Edit",
        "feature" => "Feature / Edit",
        "plan" => "Plan",
        "review" => "Review",
        _ => "General",
    }
}

fn has_action_intent(text: &str) -> bool {
    (edit_intent().is_match(text) || imperative_start().is_match(text)) && !read_only_intent().is_match(text)
}

pub fn classify_intent(prompt: &str, has_prior_turns: bool) -> &'static str {
    let text = prompt.trim();
    let has_edit = has_action_intent(text);
    if question_lead().is_match(text) || (question_mark_end().is_match(text) && !has_edit) {
        return "question";
    }
    if has_prior_turns && follow_up_ref().is_match(text) {
        return "follow-up";
    }
    if review_pattern().is_match(text) && !has_edit {
        return "review";
    }
    if plan_pattern().is_match(text) && plan_verbs().is_match(text) {
        return "plan";
    }
    if bugfix_pattern().is_match(text) && has_edit {
        return "bugfix";
    }
    if has_edit { "feature" } else { "general" }
}

pub struct PromptSignalInput<'a> {
    pub prompt_text: &'a str,
    pub tool_mode: Option<&'a str>,
    pub session_mode: Option<&'a str>,
    pub context_tokens: Option<f64>,
    pub context_limit: Option<f64>,
    pub prior_context: Option<&'a PriorContext>,
    pub workspace_hints: Option<&'a WorkspaceHints>,
    pub clarity: Option<&'a Value>,
}

pub struct PromptAnalysis {
    pub dimension: DimensionScore,
    pub findings: Vec<Finding>,
    pub intent: &'static str,
    pub inherits_context: bool,
}

pub fn analyze(input: &PromptSignalInput<'_>) -> PromptAnalysis {
    let max = 20;
    let mut earned = max;
    let mut findings: Vec<Finding> = Vec::new();
    let text = input.prompt_text.trim();
    let has_prior = input.prior_context.is_some_and(|p| p.turn_count > 0);
    let answers: Option<Answers> = input
        .clarity
        .filter(|c| c["status"] == "checked")
        .and_then(|c| serde_json::from_value(c["answers"].clone()).ok());
    let heuristic = classify_intent(text, has_prior);
    let has_edit = has_action_intent(text);
    let intent = match &answers {
        Some(a) if a.kind == "question" => "question",
        Some(a) if a.kind == "conversation" => "follow-up",
        Some(_) => {
            if matches!(heuristic, "question" | "follow-up" | "general") {
                if has_edit && bugfix_pattern().is_match(text) { "bugfix" } else { "feature" }
            } else {
                heuristic
            }
        }
        None => heuristic,
    };
    let inherits_context = has_prior && (intent == "follow-up" || answers.as_ref().is_some_and(|a| a.kind == "conversation"));
    let question_like = intent == "question" || intent == "review";
    let tool_mode = input.tool_mode.unwrap_or("full");
    let session_mode = input.session_mode.unwrap_or("chat");

    if let Some(answers) = &answers {
        let candidates = rank_file_candidates(text, input.workspace_hints, 2);
        let related: Vec<String> = candidates.iter().map(|c| c.path.clone()).collect();
        let test = pick_test_command(text, input.workspace_hints, &related);
        let pin = |path: &str| {
            Remediation::new("pin-file", format!("Pin @{}", path.rsplit('/').next().unwrap_or(path)), format!("Anchor the prompt to `{path}` so the agent starts in the right file."))
                .target(path)
                .snippet(format!("in @{path}"))
        };
        let target_fix = candidates.first().map(|first| {
            let mut fix = pin(&first.path);
            fix.alternatives = Some(candidates[1..].iter().map(|c| pin(&c.path)).collect());
            fix
        });
        let answer_of = |id: &str| answers.checks.get(id).map(|c| c.answer.as_str());
        let done_fix = test.filter(|_| answer_of("target") != Some("no") && answer_of("outcome") != Some("no")).map(|t| {
            Remediation::new("add-test-command", format!("Test: {}", t.label), format!("Ask the agent to run `{}` before finishing.", t.command))
                .target(t.command.clone())
                .snippet(format!("and verify with `{}`", t.command))
        });
        let scored = score_answers(answers, target_fix.as_ref(), done_fix.as_ref());
        earned -= scored.deduction;
        findings.extend(scored.findings);
    }

    let unknown = unknown_identifiers(input.workspace_hints, text);
    if !unknown.is_empty() {
        earned -= 4;
        let list = unknown.iter().map(|n| format!("`{n}`")).collect::<Vec<_>>().join(", ");
        findings.push(Finding::new(
            "prompt-unknown-symbol", "prompt-clarity", "warning", -4,
            format!("{list} {} in the code index", if unknown.len() == 1 { "isn't" } else { "aren't" }),
            format!("The code index has no symbol or file named {list}, so the agent will search for something that doesn't exist."),
            Remediation::new("refine-prompt", "Check the name", format!("Check the spelling of {list}, or name the file it lives in.")),
        ));
    }

    if has_edit && !question_like && session_mode == "chat" && tool_mode != "full" {
        earned -= 6;
        findings.push(Finding::new(
            "prompt-tool-mode-conflict", "prompt-clarity", "critical", -6,
            format!("Session is `{tool_mode}` but the prompt asks for edits"),
            format!("Prompt requests file changes while tool access is `{tool_mode}`, so the agent cannot write."),
            Remediation::new("change-tool-mode", "Switch to Full Access", "Switch tool access to Full so the agent can write files and run verification commands.").target("full"),
        ));
    }

    if let (Some(tokens), Some(limit)) = (input.context_tokens, input.context_limit)
        && limit > 0.0
    {
        let ratio = tokens / limit;
        if ratio >= 0.85 {
            let pct = js_round(ratio * 100.0);
            earned -= 4;
            findings.push(Finding::new(
                "prompt-context-pressure", "prompt-clarity", "warning", -4,
                format!("Context window is {pct}% full"),
                format!("Context window is at {} / {} tokens ({pct}% >= 85%), increasing truncation and instruction-drift risk.", group_digits(tokens), group_digits(limit)),
                Remediation::new("refine-prompt", "Start Fresh or Hand Over", "Start a fresh session or hand over with a compact brief so the model has full context headroom."),
            ));
        }
    }

    let earned = earned.clamp(0, max);
    let mut signals: Vec<Signal> = vec![signal(format!("Intent: {}", intent_label(intent)), "neutral")];
    if let Some(answers) = &answers {
        for item in &CHECKLIST {
            if item.instruction_only && answers.kind != "instruction" {
                continue;
            }
            let Some(check) = answers.checks.get(item.id) else { continue };
            let good = if item.bad_answer == "no" { check.answer == "yes" } else { check.answer == "no" };
            signals.push(signal(format!("{} {}", if good { "✓" } else { "!" }, item.id), if good { "good" } else if check.answer == "partial" { "warn" } else { "bad" }));
        }
    } else {
        signals.push(signal(if input.clarity.is_some_and(|c| c["status"] == "pending") { "Clarity: checking…" } else { "Clarity: not checked" }, "neutral"));
    }
    for symbol in input.workspace_hints.iter().flat_map(|h| h.symbols.iter().filter(|s| s.found).take(2)) {
        signals.push(signal(format!("✓ {} found", symbol.name), "good"));
    }
    let summary = if answers.is_none() {
        "Clarity not checked — facts only.".to_owned()
    } else if earned == max {
        "Clear target, outcome, and finish line.".to_owned()
    } else {
        findings.iter().map(|f| f.title.clone()).collect::<Vec<_>>().join("; ")
    };
    PromptAnalysis {
        dimension: DimensionScore {
            dimension: "prompt-clarity".into(),
            label: "Prompt Clarity & Context".into(),
            earned_points: earned,
            max_points: max,
            normalized_score: js_round(earned as f64 / max as f64 * 100.0),
            summary,
            signals: Some(signals),
        },
        findings,
        intent,
        inherits_context,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_intents() {
        assert_eq!(classify_intent("how does this work?", false), "question");
        assert_eq!(classify_intent("fix the truncated headline", false), "bugfix");
        assert_eq!(classify_intent("add a toggle", false), "feature");
        assert_eq!(classify_intent("commit it", true), "follow-up");
        assert_eq!(classify_intent("review the diff", false), "review");
    }

    #[test]
    fn read_only_edit_request_is_a_critical_blocker() {
        let result = analyze(&PromptSignalInput {
            prompt_text: "fix the truncated headline in the prompt score bar", tool_mode: Some("read-only"), session_mode: None,
            context_tokens: None, context_limit: None, prior_context: None, workspace_hints: None, clarity: None,
        });
        assert_eq!(result.findings[0].id, "prompt-tool-mode-conflict");
        assert_eq!(result.dimension.earned_points, 14);
        assert_eq!(result.dimension.summary, "Clarity not checked — facts only.");
    }

    #[test]
    fn context_pressure_formats_tokens() {
        let result = analyze(&PromptSignalInput {
            prompt_text: "how?", tool_mode: None, session_mode: None, context_tokens: Some(90_000.0), context_limit: Some(100_000.0),
            prior_context: None, workspace_hints: None, clarity: None,
        });
        assert!(result.findings[0].evidence.contains("90,000 / 100,000"));
    }
}
