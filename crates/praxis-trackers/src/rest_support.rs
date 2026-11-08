//! Helpers shared by the REST-backed trackers (`github/`, `gitlab/`) and their CI evidence
//! providers: JSON field coercion, URI encoding, error-detail truncation, the
//! `localeCompare` approximation, in-memory issue filtering and paging, and token
//! resolution.

use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use praxis_contracts::{
    Board, BoardFilters, FilterMetadata, IssueFilters, IssueSummary, PagedIssues, UpdateIssueInput,
};
use serde_json::Value;

use crate::issue_tracker_service::TrackerResult;

const MAX_ERROR_DETAIL_CHARS: usize = 200;

/// `String(value)` for a string, number or boolean; `None` for anything else.
pub(crate) fn as_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// `Number(value ?? 0)` for an id: a non-negative integer or numeric string, else 0.
pub(crate) fn as_u64(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// `encodeURIComponent`: escapes everything but `A–Z a–z 0–9 - _ . ! ~ * ' ( )`.
#[must_use]
pub fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Collapses whitespace and caps an error detail at 200 characters (ellipsis included), so
/// a raw response body never floods the UI.
pub(crate) fn truncate_error_detail(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() > MAX_ERROR_DETAIL_CHARS {
        let head: String = normalized
            .chars()
            .take(MAX_ERROR_DETAIL_CHARS - 1)
            .collect();
        format!("{head}…")
    } else {
        normalized
    }
}

/// `localeCompare` approximated as case-insensitive first, then lowercase before uppercase
/// on a case-only tie, as ICU orders them.
pub(crate) fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        .then_with(|| right.cmp(left))
}

/// Most recently updated first, then by key (`board/boardColumns.ts`'s `sortIssuesByUpdated`).
pub(crate) fn sort_issues_by_updated(issues: &mut [IssueSummary]) {
    issues.sort_by(|left, right| {
        locale_compare(
            right.updated.as_deref().unwrap_or_default(),
            left.updated.as_deref().unwrap_or_default(),
        )
        .then_with(|| locale_compare(&left.key, &right.key))
    });
}

/// The status, issue-type and search-text part of an in-memory `getIssues` filter.
pub(crate) fn matches_issue_filters(issue: &IssueSummary, filters: &IssueFilters) -> bool {
    if !filters.statuses.is_empty() && !filters.statuses.contains(&issue.status) {
        return false;
    }
    if !filters.issue_types.is_empty() && !filters.issue_types.contains(&issue.issue_type) {
        return false;
    }
    let query = filters.search_text.trim().to_lowercase();
    if query.is_empty() {
        return true;
    }
    format!(
        "{} {} {}",
        issue.key,
        issue.summary,
        issue.description.as_deref().unwrap_or_default()
    )
    .to_lowercase()
    .contains(&query)
}

/// Sorts the matching issues by most recently updated and returns one page of them.
pub(crate) fn page_sorted_issues(
    mut matching: Vec<IssueSummary>,
    start_at: usize,
    page_size: usize,
) -> PagedIssues {
    sort_issues_by_updated(&mut matching);
    let total = matching.len();
    let end = start_at.saturating_add(page_size);
    PagedIssues {
        issues: matching
            .into_iter()
            .skip(start_at)
            .take(page_size)
            .collect(),
        total: Some(u32::try_from(total).unwrap_or(u32::MAX)),
        has_more: end < total,
    }
}

/// The distinct statuses and issue types of a page, each sorted.
pub(crate) fn filter_metadata_of(issues: &[IssueSummary]) -> FilterMetadata {
    let sorted_unique = |values: BTreeSet<String>| {
        let mut list: Vec<String> = values.into_iter().collect();
        list.sort_by(|left, right| locale_compare(left, right));
        list
    };
    FilterMetadata {
        statuses: sorted_unique(issues.iter().map(|i| i.status.clone()).collect()),
        issue_types: sorted_unique(issues.iter().map(|i| i.issue_type.clone()).collect()),
    }
}

pub(crate) fn matches_board_filters(board: &Board, filters: &BoardFilters) -> bool {
    if !filters.types.is_empty() && !filters.types.contains(&board.board_type) {
        return false;
    }
    if !filters.project_keys.is_empty() {
        let board_project_key = board
            .project_key
            .as_deref()
            .map(str::trim)
            .unwrap_or_default();
        if board_project_key.is_empty()
            || !filters
                .project_keys
                .iter()
                .any(|key| key == board_project_key)
        {
            return false;
        }
    }
    let search_text = filters.search_text.trim().to_lowercase();
    if search_text.is_empty() {
        return true;
    }
    format!(
        "{} {} {} {}",
        board.name,
        board.project_key.as_deref().unwrap_or_default(),
        board.project_name.as_deref().unwrap_or_default(),
        board.location_name.as_deref().unwrap_or_default()
    )
    .to_lowercase()
    .contains(&search_text)
}

/// The `UpdateIssueInput` fields a REST tracker cannot edit (it takes summary, description
/// and assignee only), in the TypeScript's order.
pub(crate) fn unsupported_issue_edit_fields(input: &UpdateIssueInput) -> Vec<&'static str> {
    let mut unsupported = Vec::new();
    if input.parent_key.is_some() {
        unsupported.push("parentKey");
    }
    if input.priority.is_some() {
        unsupported.push("priority");
    }
    if input.severity.is_some() {
        unsupported.push("severity");
    }
    if input.reported_by.is_some() {
        unsupported.push("reportedBy");
    }
    if input.model.is_some() {
        unsupported.push("model");
    }
    if input.issue_type.is_some() {
        unsupported.push("issueType");
    }
    if input.idea_transcript.is_some() {
        unsupported.push("ideaTranscript");
    }
    unsupported
}

/// Resolves an API token from the host's secret store.
#[async_trait]
pub trait TrackerSecretSource: Send + Sync {
    async fn get_api_key(&self) -> TrackerResult<String>;
}

/// The secret-store token when a store is wired (else the inline one), falling back to the
/// environment lookup; all trimmed, empty when none is set.
pub(crate) async fn resolve_api_token(
    secrets: Option<&Arc<dyn TrackerSecretSource>>,
    inline_token: impl FnOnce() -> String,
    environment_token: fn() -> Option<String>,
) -> TrackerResult<String> {
    let primary = match secrets {
        Some(secrets) => secrets.get_api_key().await?,
        None => inline_token(),
    };
    let primary = primary.trim();
    if !primary.is_empty() {
        return Ok(primary.to_string());
    }
    Ok(environment_token()
        .map(|token| token.trim().to_string())
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use serde_json::json;

    use super::{as_string, as_u64, encode_uri_component, locale_compare, truncate_error_detail};

    #[test]
    fn uri_components_are_encoded_like_javascript() {
        assert_eq!(encode_uri_component("octo cat/x"), "octo%20cat%2Fx");
        assert_eq!(encode_uri_component("a-b_c.d!~*'()"), "a-b_c.d!~*'()");
        assert_eq!(encode_uri_component("é"), "%C3%A9");
    }

    #[test]
    fn json_fields_coerce_like_the_typescript() {
        assert_eq!(as_string(Some(&json!(7))).as_deref(), Some("7"));
        assert_eq!(as_string(Some(&json!(true))).as_deref(), Some("true"));
        assert_eq!(as_string(Some(&json!({}))), None);
        assert_eq!(as_u64(Some(&json!(" 12 "))), 12);
        assert_eq!(as_u64(Some(&json!(null))), 0);
    }

    #[test]
    fn locale_compare_is_case_insensitive_with_lowercase_first() {
        assert_eq!(locale_compare("apple", "Banana"), Ordering::Less);
        assert_eq!(locale_compare("a", "A"), Ordering::Less);
        assert_eq!(locale_compare("x", "x"), Ordering::Equal);
    }

    #[test]
    fn error_details_collapse_whitespace_and_cap_at_200_chars() {
        assert_eq!(truncate_error_detail(" a \n b "), "a b");
        let long = truncate_error_detail(&"x".repeat(300));
        assert_eq!(long.chars().count(), 200);
        assert!(long.ends_with('…'));
    }
}
