//! Canonical template definitions for markdown issue files (`packages/core/src/folder/markdownTemplate.ts`).

use std::collections::HashMap;

use chrono::Utc;

/// Canonical issue types supported by folder markdown templates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum IssueType {
    Feature,
    Idea,
    Story,
    Task,
    Bug,
}

impl IssueType {
    /// Returns the canonical title-case string (`"Feature"`, `"Idea"`, `"Story"`, `"Task"`, `"Bug"`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Feature => "Feature",
            Self::Idea => "Idea",
            Self::Story => "Story",
            Self::Task => "Task",
            Self::Bug => "Bug",
        }
    }

    /// Parses an issue type name case-insensitively.
    #[must_use]
    pub fn parse_loose(raw: &str) -> Option<Self> {
        match raw.trim().to_lowercase().as_str() {
            "epic" | "feature" => Some(Self::Feature),
            "idea" => Some(Self::Idea),
            "story" => Some(Self::Story),
            "task" => Some(Self::Task),
            "bug" => Some(Self::Bug),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldPosition {
    Core,
    Tail,
}

struct FieldRule {
    name: &'static str,
    default_value: Option<&'static str>,
    applies_to: Option<&'static [IssueType]>,
    position: FieldPosition,
    on_create: bool,
    on_upgrade: bool,
}

struct SectionRule {
    name: &'static str,
    default_body: &'static [&'static str],
    applies_to: Option<&'static [IssueType]>,
    aliases: &'static [&'static str],
    on_create: bool,
    on_upgrade: bool,
    rename_alias_on_upgrade: bool,
}

const FIELD_RULES: &[FieldRule] = &[
    FieldRule {
        name: "Status",
        default_value: Some("📋 Proposed"),
        applies_to: None,
        position: FieldPosition::Core,
        on_create: true,
        on_upgrade: true,
    },
    FieldRule {
        name: "Created",
        default_value: None,
        applies_to: None,
        position: FieldPosition::Core,
        on_create: true,
        on_upgrade: true,
    },
    FieldRule {
        name: "Type",
        default_value: None,
        applies_to: None,
        position: FieldPosition::Core,
        on_create: true,
        on_upgrade: true,
    },
    FieldRule {
        name: "Priority",
        default_value: Some("Medium"),
        applies_to: None,
        position: FieldPosition::Core,
        on_create: true,
        on_upgrade: true,
    },
    FieldRule {
        name: "Model",
        default_value: None,
        applies_to: None,
        position: FieldPosition::Core,
        on_create: true,
        on_upgrade: false,
    },
    FieldRule {
        name: "Severity",
        default_value: Some("Medium"),
        applies_to: Some(&[IssueType::Bug]),
        position: FieldPosition::Tail,
        on_create: true,
        on_upgrade: true,
    },
    FieldRule {
        name: "Reported By",
        default_value: Some(""),
        applies_to: Some(&[IssueType::Bug]),
        position: FieldPosition::Tail,
        on_create: true,
        on_upgrade: true,
    },
];

const SECTION_RULES: &[SectionRule] = &[
    SectionRule {
        name: "Description",
        default_body: &[""],
        applies_to: None,
        aliases: &["Summary", "Deliverables"],
        on_create: true,
        on_upgrade: true,
        rename_alias_on_upgrade: true,
    },
    SectionRule {
        name: "Items",
        default_body: &[
            "",
            "| Ref | Type | Name | Status |",
            "| --- | --- | --- | --- |",
            "",
        ],
        applies_to: Some(&[IssueType::Feature]),
        aliases: &["Stories"],
        on_create: true,
        on_upgrade: true,
        rename_alias_on_upgrade: false,
    },
    SectionRule {
        name: "Research Transcript",
        default_body: &[""],
        applies_to: Some(&[IssueType::Idea]),
        aliases: &[],
        on_create: true,
        on_upgrade: true,
        rename_alias_on_upgrade: false,
    },
    SectionRule {
        name: "Steps to Reproduce",
        default_body: &["1. ", ""],
        applies_to: Some(&[IssueType::Bug]),
        aliases: &[],
        on_create: true,
        on_upgrade: true,
        rename_alias_on_upgrade: false,
    },
    SectionRule {
        name: "Expected Behavior",
        default_body: &["", ""],
        applies_to: Some(&[IssueType::Bug]),
        aliases: &[],
        on_create: true,
        on_upgrade: true,
        rename_alias_on_upgrade: false,
    },
    SectionRule {
        name: "Actual Behavior",
        default_body: &["", ""],
        applies_to: Some(&[IssueType::Bug]),
        aliases: &[],
        on_create: true,
        on_upgrade: true,
        rename_alias_on_upgrade: false,
    },
    SectionRule {
        name: "Dependencies",
        default_body: &["", ""],
        applies_to: None,
        aliases: &[],
        on_create: true,
        on_upgrade: true,
        rename_alias_on_upgrade: false,
    },
    SectionRule {
        name: "Comments",
        default_body: &["", ""],
        applies_to: None,
        aliases: &[],
        on_create: true,
        on_upgrade: true,
        rename_alias_on_upgrade: false,
    },
];

fn field_applies(rule: &FieldRule, issue_type: IssueType) -> bool {
    rule.applies_to
        .is_none_or(|types| types.contains(&issue_type))
}

fn section_applies(rule: &SectionRule, issue_type: IssueType) -> bool {
    rule.applies_to
        .is_none_or(|types| types.contains(&issue_type))
}

/// Options for [`generate_issue_markdown`].
#[derive(Debug, Clone, Default)]
pub struct GenerateOptions {
    pub description: Option<String>,
    pub idea_transcript: Option<String>,
    pub created_at: Option<String>,
    pub parent_key: Option<String>,
    pub model: Option<String>,
    pub field_values: HashMap<String, String>,
    pub section_bodies: HashMap<String, String>,
    pub origin: Option<String>,
}

fn build_default_description(issue_type: IssueType) -> &'static str {
    match issue_type {
        IssueType::Feature => "Describe the feature goals and scope.",
        IssueType::Idea => "Describe the idea, opportunity, and research context.",
        IssueType::Story => "Describe the user story and acceptance criteria.",
        IssueType::Task => "Describe what needs to be done.",
        IssueType::Bug => "",
    }
}

fn now_iso_millis() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Generates a full markdown file for a new issue from the canonical template rules.
#[must_use]
pub fn generate_issue_markdown(
    issue_type: IssueType,
    title: &str,
    opts: &GenerateOptions,
) -> String {
    let created_at = opts.created_at.clone().unwrap_or_else(now_iso_millis);
    let mut lines = vec![format!("# {title}"), String::new()];

    for rule in FIELD_RULES {
        if !field_applies(rule, issue_type) || !rule.on_create {
            continue;
        }
        let value: String = match rule.name {
            "Created" => created_at.clone(),
            "Type" => issue_type.as_str().to_string(),
            "Model" => {
                let Some(ref m) = opts.model else {
                    continue;
                };
                if m.is_empty() {
                    continue;
                }
                m.clone()
            }
            _ => opts
                .field_values
                .get(rule.name)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| rule.default_value.unwrap_or("").to_string()),
        };

        if value.is_empty() {
            lines.push(format!("**{}:**", rule.name));
        } else {
            lines.push(format!("**{}:** {value}", rule.name));
        }
    }

    if let Some(ref parent_key) = opts.parent_key
        && !parent_key.is_empty()
    {
        lines.push(format!("**Parent:** {parent_key}"));
    }
    if let Some(ref origin) = opts.origin
        && !origin.is_empty()
    {
        lines.push(format!("**Origin:** {origin}"));
    }

    lines.push(String::new());

    let mut is_first_section = true;
    for rule in SECTION_RULES {
        if !section_applies(rule, issue_type) || !rule.on_create {
            continue;
        }
        if !is_first_section && lines.last().map(String::as_str) != Some("") {
            lines.push(String::new());
        }
        is_first_section = false;

        lines.push(format!("## {}", rule.name));
        if rule.name == "Description" {
            let desc = opts
                .description
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| build_default_description(issue_type));
            lines.push(desc.to_string());
        } else if rule.name == "Research Transcript" {
            lines.push(
                opts.idea_transcript
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .to_string(),
            );
        } else if let Some(body) = opts
            .section_bodies
            .get(rule.name)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            lines.push(body.to_string());
            lines.push(String::new());
        } else {
            for default_line in rule.default_body {
                lines.push((*default_line).to_string());
            }
        }
    }

    if lines.last().map(String::as_str) != Some("") {
        lines.push(String::new());
    }

    lines.join("\n")
}

fn line_matches_section_heading(line: &str, section_name: &str) -> bool {
    let Some(rest) = line.strip_prefix("##") else {
        return false;
    };
    if !rest.starts_with(char::is_whitespace) {
        return false;
    }
    let after_ws = rest.trim_start();
    if !after_ws
        .as_bytes()
        .get(..section_name.len())
        .is_some_and(|b| b.eq_ignore_ascii_case(section_name.as_bytes()))
    {
        return false;
    }
    let remainder = &after_ws[section_name.len()..];
    remainder.is_empty()
        || !remainder
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Adds any missing front-matter fields and sections without disturbing existing content.
#[must_use]
pub fn ensure_front_matter(content: &str, issue_type: IssueType) -> String {
    let normalized = content.replace("\r\n", "\n");
    let mut lines: Vec<String> = normalized.split('\n').map(ToString::to_string).collect();
    let mut modified = false;

    let find_header_end = |lines: &[String]| -> usize {
        lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, l)| l.starts_with("## "))
            .map_or(lines.len(), |(idx, _)| idx)
    };

    let mut header_end = find_header_end(&lines);
    let has_field = |lines: &[String], header_end: usize, field: &str| -> bool {
        let prefix = format!("**{field}:**");
        lines[..header_end].iter().any(|l| l.starts_with(&prefix))
    };

    let mut core_insert_idx = 1;
    while core_insert_idx < header_end && lines[core_insert_idx].trim().is_empty() {
        core_insert_idx += 1;
    }

    let mut core_fields = Vec::new();
    for rule in FIELD_RULES {
        if rule.position != FieldPosition::Core
            || !field_applies(rule, issue_type)
            || !rule.on_upgrade
            || has_field(&lines, header_end, rule.name)
        {
            continue;
        }
        let value = match rule.name {
            "Created" => now_iso_millis(),
            "Type" => issue_type.as_str().to_string(),
            _ => rule.default_value.unwrap_or("").to_string(),
        };
        if value.is_empty() {
            core_fields.push(format!("**{}:**", rule.name));
        } else {
            core_fields.push(format!("**{}:** {value}", rule.name));
        }
    }

    if !core_fields.is_empty() {
        let idx = core_insert_idx.min(lines.len());
        lines.splice(idx..idx, core_fields);
        modified = true;
        header_end = find_header_end(&lines);
    }

    let mut tail_insert_idx = header_end;
    while tail_insert_idx > 0 && lines[tail_insert_idx - 1].trim().is_empty() {
        tail_insert_idx -= 1;
    }

    let mut tail_fields = Vec::new();
    for rule in FIELD_RULES {
        if rule.position != FieldPosition::Tail
            || !field_applies(rule, issue_type)
            || !rule.on_upgrade
            || has_field(&lines, header_end, rule.name)
        {
            continue;
        }
        let value = rule.default_value.unwrap_or("");
        if value.is_empty() {
            tail_fields.push(format!("**{}:**", rule.name));
        } else {
            tail_fields.push(format!("**{}:** {value}", rule.name));
        }
    }

    if !tail_fields.is_empty() {
        let idx = tail_insert_idx.min(lines.len());
        lines.splice(idx..idx, tail_fields);
        modified = true;
    }

    let has_section = |lines: &[String], name: &str| -> bool {
        lines.iter().any(|l| line_matches_section_heading(l, name))
    };

    for rule in SECTION_RULES {
        if !section_applies(rule, issue_type)
            || !rule.rename_alias_on_upgrade
            || has_section(&lines, rule.name)
        {
            continue;
        }
        for alias in rule.aliases {
            if let Some(alias_idx) = lines
                .iter()
                .position(|l| line_matches_section_heading(l, alias))
            {
                lines[alias_idx] = format!("## {}", rule.name);
                modified = true;
                break;
            }
        }
    }

    let mut sections_to_add: Vec<Vec<String>> = Vec::new();
    for rule in SECTION_RULES {
        if !section_applies(rule, issue_type) || !rule.on_upgrade || has_section(&lines, rule.name)
        {
            continue;
        }
        if rule.aliases.iter().any(|alias| has_section(&lines, alias)) {
            continue;
        }
        let mut sec = vec![format!("## {}", rule.name)];
        sec.extend(rule.default_body.iter().map(|s| (*s).to_string()));
        sections_to_add.push(sec);
    }

    if !sections_to_add.is_empty() {
        while lines.last().is_some_and(|l| l.trim().is_empty()) {
            lines.pop();
        }
        for sec in sections_to_add {
            lines.push(String::new());
            lines.extend(sec);
        }
        lines.push(String::new());
        modified = true;
    }

    if !modified {
        return content.to_string();
    }
    lines.join("\n")
}
