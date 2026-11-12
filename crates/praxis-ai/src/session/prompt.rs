//! The prompt a session starts with. Ports `agentPrompt.ts` (`buildSystemPrompt`) and the tool-
//! mode / launch composition from `AcpAgentHost.startTask`. The long constant texts are generated
//! from the TypeScript source into `agent_prompts.json` (see `scripts/generate-agent-prompts.mjs`).

use std::sync::OnceLock;

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

fn prompts() -> &'static Value {
    static PROMPTS: OnceLock<Value> = OnceLock::new();
    PROMPTS.get_or_init(|| {
        serde_json::from_str(include_str!("agent_prompts.json")).unwrap_or(Value::Null)
    })
}

/// One of the generated prompt constants by its TypeScript name.
#[must_use]
pub fn prompt(name: &str) -> &'static str {
    prompts()[name].as_str().unwrap_or_default()
}

/// Name the desktop gives the per-session code-intelligence MCP server.
#[must_use]
pub fn code_intelligence_server_name() -> &'static str {
    prompt("CODE_INTELLIGENCE_SERVER_NAME")
}

fn slugify_naming_segment(value: &str) -> String {
    let ascii: String = value
        .nfkd()
        .filter(char::is_ascii)
        .collect::<String>()
        .to_lowercase();
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in ascii.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch);
        } else {
            pending_dash = true;
        }
    }
    out
}

fn strip_issue_key_prefix(value: &str, issue_key: &str) -> String {
    let key = slugify_naming_segment(issue_key);
    if value.is_empty() || key.is_empty() {
        return value.to_owned();
    }
    if value == key {
        return String::new();
    }
    value
        .strip_prefix(&format!("{key}-"))
        .map_or_else(|| value.to_owned(), str::to_owned)
}

/// `<KEY>-<summary slug>`, the worktree name an agent is told to use.
#[must_use]
pub fn build_worktree_name(issue: &Value) -> String {
    let key = issue["key"].as_str().unwrap_or_default();
    let source = issue["summary"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            issue["branch"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or(key);
    let normalized = strip_issue_key_prefix(&slugify_naming_segment(source), key);
    let suffix: String = normalized
        .chars()
        .take(48)
        .collect::<String>()
        .trim_end_matches('-')
        .to_owned();
    format!(
        "{key}-{}",
        if suffix.is_empty() {
            "work-item"
        } else {
            &suffix
        }
    )
}

#[must_use]
pub fn build_msi_version_example(issue_key: &str) -> String {
    format!("1.0.0.1-{issue_key}-buildx")
}

/// The key of the ticket under review, for a `review~KEY` session key.
#[must_use]
pub fn reviewed_issue_key(session_key: &str) -> Option<String> {
    session_key
        .strip_prefix("review~")
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn task_prompt(task: &Value, issue: &Value) -> String {
    let session_prompt = if task["sessionMode"] == "chat" {
        prompt("CHAT_SESSION_SYSTEM_PROMPT")
    } else {
        match text(task, "kind") {
            "analysis" => prompt("ANALYSIS_SESSION_SYSTEM_PROMPT"),
            "ticket-review" => prompt("TICKET_REVIEW_SESSION_PROMPT"),
            "human-review" => prompt("HUMAN_REVIEW_SESSION_PROMPT"),
            "implementation" => prompt("IMPLEMENTATION_SYSTEM_PROMPT"),
            _ => prompt("PLANNING_SYSTEM_PROMPT"),
        }
    };
    let non_goals = task["nonGoals"]
        .as_array()
        .filter(|goals| !goals.is_empty())
        .map(|goals| {
            format!(
                "\n## Non-Goals (do NOT touch)\n{}",
                goals
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|g| format!("- {g}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        })
        .unwrap_or_default();
    let completion = Some(text(task, "completionContract").trim())
        .filter(|c| !c.is_empty())
        .map(|c| format!("\n## Completion Contract\n{c}"))
        .unwrap_or_default();
    let surfaces = prompt("INTERACTIVE_RESPONSE_SURFACES_PROMPT");
    let evidence = prompt("VERIFICATION_EVIDENCE_PROMPT");

    if task["sessionMode"] == "chat" {
        let ticket = task["ticketContext"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map(|t| format!("\n{t}\n"))
            .unwrap_or_default();
        return format!(
            "{session_prompt}\n{surfaces}\n{evidence}\n## User Request\n{}\n## Scope\n{}\n{ticket}{non_goals}{completion}",
            text(task, "goal"),
            text(task, "scope")
        );
    }

    let key = text(issue, "key");
    if task["kind"] == "ticket-review" {
        // A review is not delivery work; the ticket is named by its real key, not the internal
        // review session key the issue object carries.
        let shown = reviewed_issue_key(key).unwrap_or_else(|| key.to_owned());
        return format!(
            "{session_prompt}\n## Task\n**Goal:** {}\n**Scope:** {}\n**Definition of Done:** {}\n{non_goals}\n{completion}\n\n## Issue Context\n- Key: {shown}\n- Summary: {}\n- Type: {}\n- Status: {}\n",
            text(task, "goal"),
            text(task, "scope"),
            text(task, "definitionOfDone"),
            text(issue, "summary"),
            text(issue, "issueType"),
            text(issue, "status")
        );
    }

    let workflow = if task["workflow"].is_object() {
        let w = &task["workflow"];
        let mut lines = vec![
            "\n## Assigned Workflow Pack".to_owned(),
            format!("- Name: {}", text(w, "name")),
            format!("- Instructions file: {}", text(w, "instructionsPath")),
        ];
        if let Some(description) = w["description"].as_str().filter(|d| !d.is_empty()) {
            lines.push(format!("- Description: {description}"));
        }
        if let Some(link) = w["link"].as_str().filter(|l| !l.is_empty()) {
            lines.push(format!("- Reference link: {link}"));
        }
        lines.extend([
            "- Treat this workflow pack as the execution playbook for this task.".to_owned(),
            "- Read the instructions file before taking implementation actions.".to_owned(),
            "- Follow the workflow ordering, sub-agent choices, and review gates unless they conflict with explicit user instructions or this task contract.".to_owned(),
        ]);
        lines.join("\n")
    } else {
        String::new()
    };
    let attachments = task["attachments"].as_array().filter(|a| !a.is_empty()).map(|items| {
        let mut lines = vec![
            "\n## Issue Attachments".to_owned(),
            "- The following issue attachments were downloaded locally before execution.".to_owned(),
            "- Review any relevant screenshots, mockups, specs, or supporting files before implementation.".to_owned(),
        ];
        for a in items {
            let mut entry = vec![format!("- {}: {}", text(a, "fileName"), text(a, "localPath"))];
            if let Some(media) = a["mediaType"].as_str() {
                entry.push(format!("  media type: {media}"));
            }
            if let Some(size) = a["sizeBytes"].as_u64() {
                entry.push(format!("  size bytes: {size}"));
            }
            if let Some(source) = a["sourceUrl"].as_str() {
                entry.push(format!("  source: {source}"));
            }
            lines.push(entry.join("\n"));
        }
        lines.join("\n")
    });
    let issue_context = match task["ticketContext"]
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        Some(context) => format!("\n{context}\n"),
        None => {
            let description = issue["description"]
                .as_str()
                .filter(|d| !d.is_empty())
                .map(|d| {
                    format!(
                        "- Description:\n{}",
                        d.chars().take(4000).collect::<String>()
                    )
                })
                .unwrap_or_default();
            format!(
                "\n## Issue Context\n- Key: {key}\n- Summary: {}\n- Type: {}\n- Status: {}\n{description}\n",
                text(issue, "summary"),
                text(issue, "issueType"),
                text(issue, "status")
            )
        }
    };
    format!(
        "{session_prompt}\n{surfaces}\n{evidence}\n## Task\n**Goal:** {}\n**Scope:** {}\n**Definition of Done:** {}\n{workflow}\n{}\n{non_goals}\n{completion}\n{issue_context}\n## Execution Conventions\n- If you create a git worktree, its name MUST start with {key}.\n- Use a worktree name like: {}\n- If you publish a new MSI, keep the base version and append -{key}-<build-id>.\n- Return that same <build-id> in DELIVERY_RESULT.buildIdentifier so the Jira upload name can match the MSI build.\n- Use an MSI version like: {}\n- Do not publish a generic MSI artifact name or version that omits the Jira issue key.\n",
        text(task, "goal"),
        text(task, "scope"),
        text(task, "definitionOfDone"),
        attachments.unwrap_or_default(),
        build_worktree_name(issue),
        build_msi_version_example(key)
    )
}

/// The task prompt plus the working style and project instructions the task carries.
#[must_use]
pub fn build_system_prompt(task: &Value, issue: &Value) -> String {
    let style = text(task, "workingStyle").trim();
    let style_block = (!style.is_empty()).then(|| {
        format!("## Working style\nFollow these habits whichever tools you have:\n{style}")
    });
    let instructions =
        Some(text(task, "projectInstructions").trim().to_owned()).filter(|i| !i.is_empty());
    [Some(task_prompt(task, issue)), style_block, instructions]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[must_use]
pub fn tool_mode_prompt(tool_mode: &str) -> &'static str {
    match tool_mode {
        "read-only" => {
            "READ ONLY. You may inspect files using file tools or read-only shell commands (git status, log, diff and show; ls, cat, head, wc, rg; sed -n). Do not edit files, run builds or tests, execute commands that change state, or mutate external systems. Permission checks still apply to every tool call. If tools are exposed through functions.exec, discover readers with text(ALL_TOOLS.filter(t => /read_file|exec_command/.test(t.name))) there and call the discovered tools through tools; for example, text(await tools.exec_command({cmd: \"pwd\"})). Use only APIs exposed in this session. Try the available read-only inspection path before declaring file access unavailable."
        }
        "project-only" => {
            "PROJECT ONLY. Do not edit files, execute commands, or read local repository files."
        }
        _ => "FULL. Use tools as needed; honor every permission request.",
    }
}

/// What the first ACP prompt carries: the system prompt with the tool-mode line and any
/// capability notes, then the instruction to act.
#[must_use]
pub fn acp_launch_prompt(
    task: &Value,
    issue: &Value,
    tool_mode: &str,
    has_browser: bool,
    has_code_intelligence: bool,
    autopilot: bool,
) -> String {
    let mut system = format!(
        "{}\n\nTool mode: {}",
        build_system_prompt(task, issue),
        tool_mode_prompt(tool_mode)
    );
    if has_browser {
        system.push_str(&format!("\n\n{}", prompt("BROWSER_TOOLS_PROMPT")));
    }
    if has_code_intelligence {
        system.push_str(&format!("\n\n{}", prompt("CODE_INTELLIGENCE_PROMPT")));
    }
    if autopilot {
        system.push_str(&format!("\n\n{}", prompt("AUTOPILOT_SESSION_PROMPT")));
    }
    if task["sessionMode"] == "chat" {
        return format!(
            "{system}\n\nRespond directly to the user's request. Do not start a ticket analysis or inspect a ticket unless explicitly asked."
        );
    }
    let key = text(issue, "key");
    let shown = reviewed_issue_key(key).unwrap_or_else(|| key.to_owned());
    format!(
        "{system}\n\nExecute the task described above.\n\nIssue: {shown} — {}",
        text(issue, "summary")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn worktree_names_slug_the_summary_and_drop_a_leading_key() {
        assert_eq!(
            build_worktree_name(&json!({"key":"APP-101","summary":"Fix the Café login — now!"})),
            "APP-101-fix-the-cafe-login-now"
        );
        assert_eq!(
            build_worktree_name(&json!({"key":"APP-101","summary":"APP-101 Add a router"})),
            "APP-101-add-a-router"
        );
        assert_eq!(
            build_worktree_name(&json!({"key":"X-1","summary":""})),
            "X-1-work-item",
            "a key-only source strips to nothing and falls back"
        );
    }

    /// Byte-for-byte parity with the TypeScript builder on representative tasks.
    #[test]
    fn matches_the_typescript_builder_exactly() {
        let golden: Value =
            serde_json::from_str(include_str!("prompt_golden.json")).expect("golden");
        for case in golden["worktree"].as_array().expect("worktree cases") {
            assert_eq!(
                build_worktree_name(&case["issue"]),
                case["name"].as_str().unwrap_or_default(),
                "{}",
                case["issue"]
            );
        }
        for case in golden["system"].as_array().expect("system cases") {
            let got = build_system_prompt(&case["task"], &case["issue"]);
            let want = case["prompt"].as_str().unwrap_or_default();
            assert_eq!(
                got,
                want,
                "prompt case '{}' differs from the TypeScript output",
                case["name"].as_str().unwrap_or_default()
            );
        }
    }

    #[test]
    fn the_generated_prompts_are_all_present() {
        for name in [
            "IMPLEMENTATION_SYSTEM_PROMPT",
            "PLANNING_SYSTEM_PROMPT",
            "ANALYSIS_SESSION_SYSTEM_PROMPT",
            "CHAT_SESSION_SYSTEM_PROMPT",
            "INTERACTIVE_RESPONSE_SURFACES_PROMPT",
            "VERIFICATION_EVIDENCE_PROMPT",
            "BROWSER_TOOLS_PROMPT",
            "CODE_INTELLIGENCE_PROMPT",
            "AUTOPILOT_SESSION_PROMPT",
            "TICKET_REVIEW_SESSION_PROMPT",
            "HUMAN_REVIEW_SESSION_PROMPT",
        ] {
            assert!(prompt(name).len() > 40, "{name}");
        }
        assert_eq!(code_intelligence_server_name(), "code_intelligence");
    }

    #[test]
    fn a_chat_launch_carries_the_request_the_tool_mode_and_the_chat_instruction() {
        let task = json!({"kind":"general","sessionMode":"chat","goal":"Say hello via ACP","scope":"This issue and related files","definitionOfDone":"done"});
        let issue = json!({"key":"SESSION-ab12cd34","summary":"Say hello via ACP","issueType":"Task","status":"New","projectKey":"SESSION"});
        let launch = acp_launch_prompt(&task, &issue, "full", false, false, false);
        assert!(launch.contains("## User Request\nSay hello via ACP"));
        assert!(launch.contains("Tool mode: FULL."));
        assert!(launch.ends_with(
            "Do not start a ticket analysis or inspect a ticket unless explicitly asked."
        ));
        assert!(!launch.contains("## In-app browser"));
        let read_only = acp_launch_prompt(&task, &issue, "read-only", true, true, true);
        assert!(
            read_only.contains("Tool mode: READ ONLY.")
                && read_only.contains("## In-app browser")
                && read_only.contains("## Code intelligence")
                && read_only.contains("## Autopilot")
        );
    }

    #[test]
    fn a_delivery_launch_names_the_issue_and_its_conventions_and_a_review_names_the_real_ticket() {
        let task = json!({"kind":"general","goal":"Build it","scope":"s","definitionOfDone":"d","nonGoals":["touch auth"],"workingStyle":"small commits"});
        let issue = json!({"key":"APP-101","summary":"Router","issueType":"Story","status":"To Do","description":"Details"});
        let launch = acp_launch_prompt(&task, &issue, "full", false, false, false);
        assert!(
            launch.contains("- If you create a git worktree, its name MUST start with APP-101.")
        );
        assert!(
            launch.contains("## Non-Goals (do NOT touch)\n- touch auth")
                && launch.contains("## Working style")
        );
        assert!(launch.ends_with("Issue: APP-101 — Router"));
        let review = acp_launch_prompt(
            &json!({"kind":"ticket-review","goal":"g","scope":"s","definitionOfDone":"d"}),
            &json!({"key":"review~APP-101","summary":"Router"}),
            "read-only",
            false,
            false,
            false,
        );
        assert!(review.contains("- Key: APP-101") && !review.contains("review~APP-101"));
    }
}
