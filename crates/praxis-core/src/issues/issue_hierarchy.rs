//! Issue parent/child hierarchy rules (`packages/core/src/issues/issueHierarchy.ts`).

use praxis_contracts::{BackendMode, ParentIssueReference};

fn normalize_loose(value: Option<&str>) -> String {
    value
        .unwrap_or("")
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
        .collect()
}

fn format_allowed_type_list(values: &[String]) -> String {
    match values.len() {
        0 => "parent item".to_string(),
        1 => values[0].clone(),
        n => format!("{} or {}", values[..n - 1].join(", "), values[n - 1]),
    }
}

/// Parent relationship rule for a given child issue type and backend mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParentRule {
    pub can_have_parent: bool,
    pub requires_parent: bool,
    pub allowed_parent_types: Vec<String>,
    pub default_label: String,
    pub helper_text: String,
    pub empty_text: String,
    pub placeholder: String,
}

/// Returns `true` if `issue_type` is an `Epic` or `Feature`.
#[must_use]
pub fn is_parent_issue_type(issue_type: Option<&str>) -> bool {
    let normalized = normalize_loose(issue_type);
    normalized == "epic" || normalized == "feature"
}

/// Returns `true` if `issue_type` is `Idea`.
#[must_use]
pub fn is_idea_issue_type(issue_type: Option<&str>) -> bool {
    normalize_loose(issue_type) == "idea"
}

/// Returns `true` if `issue_type` is `Subtask`.
#[must_use]
pub fn is_subtask_issue_type(issue_type: Option<&str>) -> bool {
    normalize_loose(issue_type) == "subtask"
}

/// Normalizes an issue type label, defaulting to `"Issue"`.
#[must_use]
pub fn normalize_issue_type_label(issue_type: Option<&str>) -> String {
    let trimmed = issue_type.unwrap_or("").trim();
    if trimmed.is_empty() {
        "Issue".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Computes the [`ParentRule`] for `issue_type` on `mode`.
#[must_use]
pub fn get_parent_rule(issue_type: Option<&str>, mode: BackendMode) -> ParentRule {
    if is_parent_issue_type(issue_type) {
        let label = normalize_issue_type_label(issue_type);
        return ParentRule {
            can_have_parent: false,
            requires_parent: false,
            allowed_parent_types: vec![],
            default_label: "Parent".to_string(),
            helper_text: format!("{label} items cannot have a parent."),
            empty_text: format!("{label} items do not use a parent."),
            placeholder: String::new(),
        };
    }

    if is_subtask_issue_type(issue_type) {
        return ParentRule {
            can_have_parent: true,
            requires_parent: true,
            allowed_parent_types: vec!["Story".to_string(), "Task".to_string(), "Bug".to_string()],
            default_label: "Parent".to_string(),
            helper_text: "Subtasks must belong to a story, task, or bug.".to_string(),
            empty_text: "No parent selected.".to_string(),
            placeholder: "Enter a parent issue key".to_string(),
        };
    }

    if mode == BackendMode::Folder {
        let label = normalize_issue_type_label(issue_type);
        return ParentRule {
            can_have_parent: true,
            requires_parent: true,
            allowed_parent_types: vec!["Feature".to_string()],
            default_label: "Feature".to_string(),
            helper_text: format!("{label} items in a plans folder must belong to a Feature."),
            empty_text: "No feature selected.".to_string(),
            placeholder: "Select a feature or type a new name".to_string(),
        };
    }

    let allowed_parent_types = if mode == BackendMode::Jiracloud {
        vec!["Epic".to_string()]
    } else {
        vec!["Epic".to_string(), "Feature".to_string()]
    };
    let label = normalize_issue_type_label(issue_type);
    let list = format_allowed_type_list(&allowed_parent_types);
    ParentRule {
        can_have_parent: true,
        requires_parent: false,
        allowed_parent_types,
        default_label: "Epic".to_string(),
        helper_text: format!("{label} items can only belong to {list}."),
        empty_text: "No epic selected.".to_string(),
        placeholder: "Leave blank to clear the epic".to_string(),
    }
}

/// Checks whether `parent_issue_type` is an allowed parent for `child_issue_type` on `mode`.
#[must_use]
pub fn is_allowed_parent_type(
    parent_issue_type: Option<&str>,
    child_issue_type: Option<&str>,
    mode: BackendMode,
) -> bool {
    let rule = get_parent_rule(child_issue_type, mode);
    if !rule.can_have_parent {
        return false;
    }
    let normalized_parent = normalize_loose(parent_issue_type);
    rule.allowed_parent_types
        .iter()
        .any(|t| normalize_loose(Some(t)) == normalized_parent)
}

/// Returns the resolved label for a parent issue reference.
#[must_use]
pub fn get_resolved_parent_label(
    issue_type: Option<&str>,
    mode: BackendMode,
    parent_issue: Option<&ParentIssueReference>,
) -> String {
    if let Some(current) = parent_issue
        .and_then(|p| p.issue_type.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return current.to_string();
    }
    get_parent_rule(issue_type, mode).default_label
}

/// Formats a [`ParentIssueReference`] as `"KEY Summary"`.
#[must_use]
pub fn format_parent_reference(parent_issue: Option<&ParentIssueReference>) -> String {
    let Some(parent) = parent_issue else {
        return String::new();
    };
    match parent.summary.as_deref().map(str::trim) {
        Some(summary) if !summary.is_empty() => {
            format!("{} {}", parent.key, summary).trim().to_string()
        }
        _ => parent.key.trim().to_string(),
    }
}

/// Builds a human-readable validation error message when an invalid parent is selected.
#[must_use]
pub fn build_parent_validation_message(
    issue_type: Option<&str>,
    mode: BackendMode,
    parent_issue_type: Option<&str>,
) -> String {
    let child_label = normalize_issue_type_label(issue_type);
    let parent_label = normalize_issue_type_label(parent_issue_type);
    let rule = get_parent_rule(issue_type, mode);
    if is_parent_issue_type(issue_type) {
        return format!("{child_label} items cannot have a parent.");
    }
    if is_subtask_issue_type(issue_type) {
        return format!(
            "{child_label} items must belong to a Story. \"{parent_label}\" is not allowed."
        );
    }
    format!(
        "{child_label} items can only belong to {}. \"{parent_label}\" is not allowed.",
        format_allowed_type_list(&rule.allowed_parent_types)
    )
}
