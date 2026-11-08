//! Folder-backed Markdown plan parser and dependency resolver
//! (`packages/core/src/folder/markdownPlanParser.ts`).

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use praxis_contracts::{IssueOrigin, ProjectWorkflowStage};
use serde::{Deserialize, Serialize};

use crate::folder::folder_fs::{FileKind, folder_read_directory, folder_read_file};
use crate::folder::path_utils::{
    SupportedPathPlatform, build_unreadable_path_error, normalize_configured_folder_path,
};
use crate::projects::project_workflow::{default_workflow, resolve_status};

// ── Shared types ────────────────────────────────────────────────────

/// Created and completed ISO 8601 timestamps extracted from a plan markdown file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPlanningDates {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<String>,
}

/// Parsed feature markdown document (`feature.md` or `type: Feature`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFeatureFolder {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_id: Option<String>,
    pub dir_name: String,
    pub feature_id: u32,
    pub title: String,
    pub plan_status: String,
    pub description: String,
    pub feature_md_path: String,
    pub dep_tokens: Vec<String>,
    pub planning_dates: ParsedPlanningDates,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<IssueOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complexity: Option<String>,
}

/// Parsed story markdown document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedStoryFile {
    pub feature_id: u32,
    pub story_seq: u32,
    pub filename: String,
    pub title: String,
    pub plan_status: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idea_transcript: Option<String>,
    pub relative_path: String,
    pub story_md_path: String,
    pub dep_tokens: Vec<String>,
    pub planning_dates: ParsedPlanningDates,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// Parsed child item markdown document (`Story`, `Task`, `Bug`, `Idea`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedChildFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature_id: Option<u32>,
    pub sequence: u32,
    pub filename: String,
    pub issue_type: String,
    pub title: String,
    pub plan_status: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idea_transcript: Option<String>,
    pub relative_path: String,
    pub file_path: String,
    pub dep_tokens: Vec<String>,
    pub planning_dates: ParsedPlanningDates,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<IssueOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complexity: Option<String>,
}

/// Complete parsed plans folder tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPlanFolder {
    pub features: Vec<ParsedFeatureFolder>,
    pub stories: Vec<ParsedStoryFile>,
    pub child_items: Vec<ParsedChildFile>,
    pub plans_root_path: String,
    pub features_root_path: String,
}

/// Parsed comment from a `## Comments` section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedComment {
    pub author: String,
    pub created: String,
    pub body: String,
}

/// Identified plans root folder and its features directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentifiedPlanFolder {
    pub plans_root_path: String,
    pub features_root_path: String,
    pub feature_entries: Vec<(String, FileKind)>,
}

// ── UTF-16 slice helper (matches JS String.prototype.slice) ─────────

fn slice_utf16_prefix(s: &str, max_utf16_units: usize) -> String {
    let mut units = 0usize;
    let mut byte_end = 0usize;
    for (idx, ch) in s.char_indices() {
        let ch_units = ch.len_utf16();
        if units + ch_units > max_utf16_units {
            break;
        }
        units += ch_units;
        byte_end = idx + ch.len_utf8();
    }
    s[..byte_end].to_string()
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Reads a UTF-8 file from disk.
pub fn read_utf8(file_path: &Path) -> std::io::Result<String> {
    folder_read_file(file_path)
}

fn match_bold_field_in_content(
    content: &str,
    field_name: &str,
    case_insensitive: bool,
) -> Option<String> {
    let prefix = format!("**{field_name}:**");
    let mut offset = 0usize;
    for raw_line in content.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let matched = if case_insensitive {
            line.as_bytes()
                .get(..prefix.len())
                .is_some_and(|b| b.eq_ignore_ascii_case(prefix.as_bytes()))
        } else {
            line.starts_with(&prefix)
        };
        if matched {
            let after_prefix = &content[offset + prefix.len()..];
            let trimmed_ws = after_prefix.trim_start_matches(char::is_whitespace);
            let value_line: String = trimmed_ws
                .chars()
                .take_while(|c| *c != '\r' && *c != '\n')
                .collect();
            let trimmed = value_line.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        offset += raw_line.len() + 1;
    }
    None
}

fn get_frontmatter_block(content: &str) -> Option<&str> {
    let rest = content.strip_prefix("---")?;
    let after_first_dash = rest.trim_start_matches([' ', '\t']);
    let after_first_nl = after_first_dash
        .strip_prefix("\r\n")
        .or_else(|| after_first_dash.strip_prefix('\n'))?;

    let mut pos = 0usize;
    for raw_line in after_first_nl.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(after_close) = line.strip_prefix("---")
            && after_close.trim_matches([' ', '\t']).is_empty()
        {
            let mut body_end = pos;
            if body_end > 0 && after_first_nl.as_bytes()[body_end - 1] == b'\n' {
                body_end -= 1;
                if body_end > 0 && after_first_nl.as_bytes()[body_end - 1] == b'\r' {
                    body_end -= 1;
                }
            }
            return Some(&after_first_nl[..body_end]);
        }
        pos += raw_line.len() + 1;
    }
    None
}

fn strip_optional_quotes(raw: &str) -> &str {
    let s = raw.trim();
    let s = s
        .strip_prefix('"')
        .or_else(|| s.strip_prefix('\''))
        .unwrap_or(s);
    let s = s
        .strip_suffix('"')
        .or_else(|| s.strip_suffix('\''))
        .unwrap_or(s);
    s.trim()
}

/// Extracts a key from YAML frontmatter (`^key:\s*["']?(.+?)["']?\s*$`).
#[must_use]
pub fn extract_front_matter_value(content: &str, key: &str) -> Option<String> {
    let block = get_frontmatter_block(content)?;
    let prefix = format!("{key}:");
    for raw_line in block.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(rest) = line.strip_prefix(&prefix) {
            let unquoted = strip_optional_quotes(rest);
            if !unquoted.is_empty() {
                return Some(unquoted.to_string());
            }
        }
    }
    None
}

fn extract_front_matter_dependency_tokens(content: &str) -> Vec<String> {
    let Some(block) = get_frontmatter_block(content) else {
        return Vec::new();
    };
    for raw_line in block.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(rest) = line.strip_prefix("dependencies:") {
            let trimmed = rest.trim();
            if let Some(inner) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                return inner
                    .split(',')
                    .map(strip_optional_quotes)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string)
                    .collect();
            }
        }
    }
    Vec::new()
}

/// Extracts the first `# Heading` title from markdown content, or `"Untitled"`.
#[must_use]
pub fn extract_main_heading(content: &str) -> String {
    let mut offset = 0usize;
    for raw_line in content.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(after_hash) = line.strip_prefix('#')
            && after_hash.starts_with(char::is_whitespace)
        {
            let slice_from = &content[offset + 1..];
            let trimmed_ws = slice_from.trim_start_matches(char::is_whitespace);
            let heading: String = trimmed_ws
                .chars()
                .take_while(|c| *c != '\r' && *c != '\n')
                .collect();
            let trimmed = heading.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        offset += raw_line.len() + 1;
    }
    "Untitled".to_string()
}

/// Extracts the raw status string from YAML frontmatter (`status:`) or `**Status:**`.
#[must_use]
pub fn extract_status_raw(content: &str) -> String {
    extract_front_matter_value(content, "status")
        .or_else(|| match_bold_field_in_content(content, "Status", false))
        .unwrap_or_default()
}

/// Extracts `**Branch:**`.
#[must_use]
pub fn extract_branch_raw(content: &str) -> Option<String> {
    match_bold_field_in_content(content, "Branch", false)
}

/// Extracts `**Priority:**`.
#[must_use]
pub fn extract_priority_raw(content: &str) -> Option<String> {
    match_bold_field_in_content(content, "Priority", false)
}

/// Extracts `**Severity:**`.
#[must_use]
pub fn extract_severity_raw(content: &str) -> Option<String> {
    match_bold_field_in_content(content, "Severity", false)
}

/// Only the literal `capture` is recognized; anything else reads as `None`.
#[must_use]
pub fn extract_origin_raw(content: &str) -> Option<IssueOrigin> {
    match_bold_field_in_content(content, "Origin", false)
        .filter(|v| v.eq_ignore_ascii_case("capture"))
        .map(|_| IssueOrigin::Capture)
}

/// Extracts `**Reported By:**`.
#[must_use]
pub fn extract_reported_by_raw(content: &str) -> Option<String> {
    match_bold_field_in_content(content, "Reported By", false)
}

/// Extracts `**Model:**`.
#[must_use]
pub fn extract_model_raw(content: &str) -> Option<String> {
    match_bold_field_in_content(content, "Model", false)
}

/// Extracts the raw type from YAML frontmatter (`type:`) or `**Type:**`.
#[must_use]
pub fn extract_type_raw(content: &str) -> Option<String> {
    extract_front_matter_value(content, "type")
        .or_else(|| match_bold_field_in_content(content, "Type", false))
}

/// Extracts `**Complexity:**`.
#[must_use]
pub fn extract_complexity_raw(content: &str) -> Option<String> {
    match_bold_field_in_content(content, "Complexity", false)
}

/// Extracts the body of a `## <heading>` section, capped at 6000 UTF-16 code units.
#[must_use]
pub fn extract_section_body(content: &str, heading: &str) -> Option<String> {
    let lines: Vec<&str> = content
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    let target = format!("## {heading}");
    let mut i = 0usize;
    while i < lines.len() {
        if lines[i].trim() == target {
            i += 1;
            let mut buf = Vec::new();
            while i < lines.len() && !lines[i].starts_with("## ") {
                buf.push(lines[i]);
                i += 1;
            }
            let body = buf.join("\n").trim().to_string();
            return if body.is_empty() {
                None
            } else {
                Some(slice_utf16_prefix(&body, 6000))
            };
        }
        i += 1;
    }
    None
}

fn parse_comment_header(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("**")?;
    let end_bold = rest.find("**")?;
    let author = rest[..end_bold].trim();
    if author.is_empty() {
        return None;
    }
    let after_bold = rest[end_bold + 2..].trim_start();
    let after_sep = after_bold
        .strip_prefix('—')
        .or_else(|| after_bold.strip_prefix("--"))
        .or_else(|| after_bold.strip_prefix('-'))?;
    let created = after_sep.trim();
    if created.is_empty() {
        return None;
    }
    Some((author.to_string(), created.to_string()))
}

/// Extracts comments from a `## Comments` section.
#[must_use]
pub fn extract_comments(content: &str) -> Vec<ParsedComment> {
    let Some(section_body) = extract_section_body(content, "Comments") else {
        return Vec::new();
    };
    let lines: Vec<&str> = section_body
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    let mut comments = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        if let Some((author, created)) = parse_comment_header(lines[i]) {
            i += 1;
            let mut body_lines = Vec::new();
            while i < lines.len() && parse_comment_header(lines[i]).is_none() {
                body_lines.push(lines[i]);
                i += 1;
            }
            let body = body_lines.join("\n").trim().to_string();
            if !body.is_empty() {
                comments.push(ParsedComment {
                    author,
                    created,
                    body,
                });
            }
        } else {
            i += 1;
        }
    }
    comments
}

/// Builds the issue description from `## Description` (or fallback sections / first 2000 units).
#[must_use]
pub fn build_description(content: &str) -> String {
    extract_section_body(content, "Description")
        .or_else(|| extract_section_body(content, "Summary"))
        .or_else(|| extract_section_body(content, "Deliverables (from master plan)"))
        .or_else(|| extract_section_body(content, "Deliverables"))
        .unwrap_or_else(|| slice_utf16_prefix(content, 2000).trim().to_string())
}

/// Maps free-text markdown status lines to the default 5-stage workflow.
#[must_use]
pub fn map_markdown_status_to_plan_status(raw: &str) -> String {
    let def = default_workflow();
    resolve_status(raw, Some(&def))
}

fn normalize_child_issue_type(raw: Option<&str>) -> Option<&'static str> {
    match raw?.trim().to_lowercase().as_str() {
        "story" => Some("Story"),
        "task" => Some("Task"),
        "bug" => Some("Bug"),
        "idea" => Some("Idea"),
        _ => None,
    }
}

fn is_search_skip_dir(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        ".git"
            | ".hg"
            | ".idea"
            | ".next"
            | ".svn"
            | ".turbo"
            | ".vscode"
            | "bin"
            | "build"
            | "coverage"
            | "dist"
            | "node_modules"
            | "out"
            | "target"
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedChildFileName {
    feature_id: Option<u32>,
    sequence: u32,
    issue_type: &'static str,
}

fn parse_child_file_name(name: &str) -> Option<ParsedChildFileName> {
    let stem = name
        .strip_suffix(".md")
        .or_else(|| name.strip_suffix(".MD"))?;
    let mut parts = stem.splitn(4, '-');
    let prefix = parts.next()?;
    let issue_type = normalize_child_issue_type(Some(prefix))?;
    let seg2 = parts.next()?;
    if seg2.is_empty() || !seg2.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let num2: u32 = seg2.parse().ok()?;
    let seg3 = parts.next()?;
    let seg4 = parts.next()?;
    if seg4.is_empty() {
        return None;
    }
    if !seg3.is_empty() && seg3.chars().all(|c| c.is_ascii_digit()) {
        let seq: u32 = seg3.parse().ok()?;
        return Some(ParsedChildFileName {
            feature_id: Some(num2),
            sequence: seq,
            issue_type,
        });
    }
    let mut seg3_chars = seg3.chars();
    if seg3_chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && seg3_chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Some(ParsedChildFileName {
            feature_id: None,
            sequence: num2,
            issue_type,
        });
    }
    None
}

fn extract_dependencies_section_body(content: &str) -> String {
    let lines: Vec<&str> = content
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    let mut i = 0usize;
    while i < lines.len() {
        if let Some(rest) = lines[i].strip_prefix("##")
            && rest.starts_with(char::is_whitespace)
        {
            let after_ws = rest.trim_start();
            if after_ws
                .as_bytes()
                .get(.."Dependencies".len())
                .is_some_and(|b| b.eq_ignore_ascii_case(b"Dependencies"))
            {
                let rem = &after_ws["Dependencies".len()..];
                if rem.is_empty()
                    || !rem
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    i += 1;
                    let mut buf = Vec::new();
                    while i < lines.len() {
                        let l = lines[i];
                        if let Some(r) = l.strip_prefix("##")
                            && r.starts_with(char::is_whitespace)
                        {
                            break;
                        }
                        buf.push(l);
                        i += 1;
                    }
                    return buf.join("\n");
                }
            }
        }
        i += 1;
    }
    String::new()
}

fn extract_depends_on_line(content: &str) -> String {
    match_bold_field_in_content(content, "Depends on", true)
        .or_else(|| match_bold_field_in_content(content, "Depends", true))
        .unwrap_or_default()
}

fn is_word_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Checks whether `token` matches `^[A-Z][A-Z0-9_]*(?:-[A-Z][A-Z0-9_]*)*-\d+$`.
#[must_use]
pub fn is_issue_key_token(token: &str) -> bool {
    let segments: Vec<&str> = token.split('-').collect();
    if segments.len() < 2 {
        return false;
    }
    let last = segments[segments.len() - 1];
    if last.is_empty() || !last.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    for seg in &segments[..segments.len() - 1] {
        let mut bytes = seg.bytes();
        let Some(first) = bytes.next() else {
            return false;
        };
        if !first.is_ascii_uppercase() {
            return false;
        }
        if !bytes.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') {
            return false;
        }
    }
    true
}

fn is_feature_dir_token(token: &str) -> bool {
    let segments: Vec<&str> = token.split('-').collect();
    if segments.len() < 3 || !segments[0].eq_ignore_ascii_case("feature") {
        return false;
    }
    if segments[1].is_empty() || !segments[1].bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    segments[2..]
        .iter()
        .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn is_child_ref_token(token: &str) -> bool {
    let segments: Vec<&str> = token.split('-').collect();
    if segments.len() < 3 {
        return false;
    }
    let p = segments[0].to_ascii_lowercase();
    if !matches!(p.as_str(), "story" | "task" | "bug" | "idea") {
        return false;
    }
    if segments[1].is_empty() || !segments[1].bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if segments[2].is_empty() || !segments[2].bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    segments[3..]
        .iter()
        .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn scan_dependency_tokens(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    // Tokenize maximal runs of `[A-Za-z0-9_-]` bounded by word boundaries
    let mut i = 0usize;
    let mut candidates = Vec::new();
    while i < bytes.len() {
        if is_word_char(bytes[i]) {
            let start = i;
            i += 1;
            while i < bytes.len() && (is_word_char(bytes[i]) || bytes[i] == b'-') {
                i += 1;
            }
            // Trim trailing hyphens so token ends on a word boundary
            let mut end = i;
            while end > start && bytes[end - 1] == b'-' {
                end -= 1;
            }
            if let Ok(tok) = std::str::from_utf8(&bytes[start..end]) {
                candidates.push(tok);
            }
        } else {
            i += 1;
        }
    }

    // Pass 1: ISSUE_KEY_SOURCE (`[A-Z][A-Z0-9_]*(?:-[A-Z][A-Z0-9_]*)*-\d+`)
    // A candidate might contain leading/trailing lowercase segments around an uppercase key,
    // so check hyphen-sub-slices that sit on word boundaries.
    for cand in &candidates {
        let segs: Vec<&str> = cand.split('-').collect();
        let mut s = 0usize;
        while s < segs.len() {
            let mut matched_end = None;
            for e in (s + 2..=segs.len()).rev() {
                let sub = segs[s..e].join("-");
                if is_issue_key_token(&sub) {
                    matched_end = Some((e, sub));
                    break;
                }
            }
            if let Some((e, sub)) = matched_end {
                if seen.insert(sub.clone()) {
                    out.push(sub);
                }
                s = e;
            } else {
                s += 1;
            }
        }
    }

    // Pass 2: featureDir
    for cand in &candidates {
        if is_feature_dir_token(cand) && seen.insert((*cand).to_string()) {
            out.push((*cand).to_string());
        }
    }

    // Pass 3: childRef
    for cand in &candidates {
        if is_child_ref_token(cand) && seen.insert((*cand).to_string()) {
            out.push((*cand).to_string());
        }
    }

    out
}

/// Collects dependency tokens from `## Dependencies`, `**Depends on:**`, and YAML frontmatter `dependencies: [...]`.
#[must_use]
pub fn collect_dependency_tokens(content: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let section = extract_dependencies_section_body(content);
    if !section.trim().is_empty() {
        parts.push(section);
    }
    let line = extract_depends_on_line(content);
    if !line.is_empty() {
        parts.push(line);
    }
    let mut tokens = scan_dependency_tokens(&parts.join("\n"));
    let mut seen: HashSet<String> = tokens.iter().cloned().collect();
    for fm_token in extract_front_matter_dependency_tokens(content) {
        if seen.insert(fm_token.clone()) {
            tokens.push(fm_token);
        }
    }
    tokens
}

fn parse_flexible_date(value: &str) -> Option<String> {
    let t = value.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(t) {
        return Some(
            dt.with_timezone(&Utc)
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string(),
        );
    }
    if let Ok(d) = NaiveDate::parse_from_str(t, "%Y-%m-%d")
        && let Some(dt) = d.and_hms_opt(0, 0, 0)
    {
        return Some(dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
    }
    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(ndt) = NaiveDateTime::parse_from_str(t, fmt) {
            return Some(ndt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
        }
    }
    None
}

/// Extracts `created` and `completed` ISO timestamps from markdown header lines.
#[must_use]
pub fn extract_planning_dates(content: &str) -> ParsedPlanningDates {
    let created = ["Created", "Start date"]
        .into_iter()
        .find_map(|field| match_bold_field_in_content(content, field, true))
        .and_then(|v| parse_flexible_date(&v));
    let completed = ["Completed", "Finished", "Done"]
        .into_iter()
        .find_map(|field| match_bold_field_in_content(content, field, true))
        .and_then(|v| parse_flexible_date(&v));
    ParsedPlanningDates { created, completed }
}

// ── Stable key generation ───────────────────────────────────────────

/// Generates a stable feature key (`{projectKey}-F{featureId:02}`).
#[must_use]
pub fn stable_feature_key(project_key: &str, feature_id: u32) -> String {
    format!("{project_key}-F{feature_id:02}")
}

/// Generates a stable story key (`{projectKey}-S{featureId:02}-{storySeq}`).
#[must_use]
pub fn stable_story_key(project_key: &str, feature_id: u32, story_seq: u32) -> String {
    format!("{project_key}-S{feature_id:02}-{story_seq}")
}

fn child_issue_type_key_prefix(issue_type: &str) -> &'static str {
    match issue_type.trim().to_lowercase().as_str() {
        "story" => "S",
        "task" => "T",
        "bug" => "B",
        _ => "I",
    }
}

/// Generates a stable child item key (`{projectKey}-{prefix}{featureId:02}-{sequence}`).
#[must_use]
pub fn stable_child_key(
    project_key: &str,
    issue_type: &str,
    feature_id: u32,
    sequence: u32,
) -> String {
    let prefix = child_issue_type_key_prefix(issue_type);
    format!("{project_key}-{prefix}{feature_id:02}-{sequence}")
}

// ── Discovery & Recursive Parser ────────────────────────────────────

fn read_directory_safe(dir_path: &Path) -> Option<Vec<(String, FileKind)>> {
    folder_read_directory(dir_path).ok()
}

fn has_feature_markdown(feature_dir_path: &Path) -> bool {
    read_directory_safe(feature_dir_path).is_some_and(|entries| {
        entries
            .iter()
            .any(|(name, kind)| *kind == FileKind::File && name.eq_ignore_ascii_case("feature.md"))
    })
}

fn contains_feature_plan_folders(root_path: &Path, entries: &[(String, FileKind)]) -> bool {
    for (name, kind) in entries {
        if *kind != FileKind::Directory {
            continue;
        }
        if has_feature_markdown(&root_path.join(name)) {
            return true;
        }
    }
    false
}

fn score_search_directory(name: &str) -> i32 {
    let lower = name.to_lowercase();
    if lower == "plans" || lower == "plan" {
        return 100;
    }
    if lower == "features" || lower == "feature" {
        return 90;
    }
    if lower.contains("plan") {
        return 80;
    }
    if lower.contains("feature") {
        return 70;
    }
    if lower == "docs" || lower == "doc" {
        return 60;
    }
    if lower.contains("ticket") || lower.contains("roadmap") {
        return 50;
    }
    0
}

fn locale_cmp_str(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

fn list_searchable_subdirectories(entries: &[(String, FileKind)]) -> Vec<String> {
    let mut dirs: Vec<String> = entries
        .iter()
        .filter(|(name, kind)| *kind == FileKind::Directory && !is_search_skip_dir(name))
        .map(|(name, _)| name.clone())
        .collect();
    dirs.sort_by(|a, b| {
        let score_diff = score_search_directory(b) - score_search_directory(a);
        if score_diff != 0 {
            score_diff.cmp(&0)
        } else {
            locale_cmp_str(a, b)
        }
    });
    dirs
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckoutKind {
    Clone,
    Worktree,
}

fn checkout_kind(entries: &[(String, FileKind)]) -> Option<CheckoutKind> {
    let (_, kind) = entries
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(".git"))?;
    Some(match kind {
        FileKind::Directory => CheckoutKind::Clone,
        FileKind::File => CheckoutKind::Worktree,
    })
}

fn canonical_plans_root_path(candidate_root: &Path, features_root_path: &Path) -> PathBuf {
    if candidate_root == features_root_path
        && features_root_path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("features"))
    {
        features_root_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| candidate_root.to_path_buf())
    } else {
        candidate_root.to_path_buf()
    }
}

fn to_directory_path(selected_root: &str) -> PathBuf {
    PathBuf::from(normalize_configured_folder_path(
        selected_root,
        SupportedPathPlatform::current(),
    ))
}

const CHILD_ITEM_SUBDIRS: &[&str] = &["bugs", "tasks", "stories"];

fn contains_child_item_dirs(root_path: &Path) -> bool {
    for subdir in CHILD_ITEM_SUBDIRS {
        let subdir_path = root_path.join(subdir);
        if let Some(entries) = read_directory_safe(&subdir_path)
            && entries
                .iter()
                .any(|(name, kind)| *kind == FileKind::File && name.to_lowercase().ends_with(".md"))
        {
            return true;
        }
    }
    false
}

fn contains_typed_markdown_files(root_path: &Path) -> bool {
    let Some(entries) = read_directory_safe(root_path) else {
        return false;
    };
    for (name, kind) in &entries {
        if *kind == FileKind::File
            && name.to_lowercase().ends_with(".md")
            && let Ok(content) = read_utf8(&root_path.join(name))
            && normalize_child_issue_type(extract_type_raw(&content).as_deref()).is_some()
        {
            return true;
        }
    }
    for (name, kind) in &entries {
        if *kind != FileKind::Directory || is_search_skip_dir(name) {
            continue;
        }
        let Some(sub_entries) = read_directory_safe(&root_path.join(name)) else {
            continue;
        };
        for (fname, fkind) in sub_entries {
            if fkind == FileKind::File
                && fname.to_lowercase().ends_with(".md")
                && let Ok(content) = read_utf8(&root_path.join(name).join(fname))
                && normalize_child_issue_type(extract_type_raw(&content).as_deref()).is_some()
            {
                return true;
            }
        }
    }
    false
}

/// Identifies whether `candidate_root` is directly a plans root.
#[must_use]
pub fn identify_plan_folder_at_root(
    candidate_root: &Path,
    root_entries: Option<&[(String, FileKind)]>,
    allow_standalone_child_items: bool,
) -> Option<IdentifiedPlanFolder> {
    let features_path = candidate_root.join("features");
    let feature_entries = read_directory_safe(&features_path);
    if let Some(ref fe) = feature_entries {
        if contains_feature_plan_folders(&features_path, fe) || fe.is_empty() {
            return Some(IdentifiedPlanFolder {
                plans_root_path: candidate_root.to_string_lossy().to_string(),
                features_root_path: features_path.to_string_lossy().to_string(),
                feature_entries: fe.clone(),
            });
        }
    }

    let owned_entries;
    let entries = match root_entries {
        Some(e) => Some(e),
        None => {
            owned_entries = read_directory_safe(candidate_root);
            owned_entries.as_deref()
        }
    };
    if let Some(e) = entries
        && contains_feature_plan_folders(candidate_root, e)
    {
        let canonical = canonical_plans_root_path(candidate_root, candidate_root);
        return Some(IdentifiedPlanFolder {
            plans_root_path: canonical.to_string_lossy().to_string(),
            features_root_path: candidate_root.to_string_lossy().to_string(),
            feature_entries: e.to_vec(),
        });
    }

    if !allow_standalone_child_items {
        return None;
    }

    if contains_child_item_dirs(candidate_root) || contains_typed_markdown_files(candidate_root) {
        let resolved_features = if feature_entries.is_some() {
            features_path
        } else {
            candidate_root.to_path_buf()
        };
        let resolved_entries = feature_entries
            .or_else(|| entries.map(<[(String, FileKind)]>::to_vec))
            .unwrap_or_default();
        return Some(IdentifiedPlanFolder {
            plans_root_path: candidate_root.to_string_lossy().to_string(),
            features_root_path: resolved_features.to_string_lossy().to_string(),
            feature_entries: resolved_entries,
        });
    }

    None
}

/// Discovers every plans root under `selected_root` (breadth-first).
pub fn discover_plan_folders(selected_root: &str) -> Result<Vec<IdentifiedPlanFolder>, String> {
    let selected_root_path = to_directory_path(selected_root);
    let direct_match = identify_plan_folder_at_root(&selected_root_path, None, true);
    let Some(root_entries) = read_directory_safe(&selected_root_path) else {
        return Err(build_unreadable_path_error(
            selected_root,
            SupportedPathPlatform::current(),
        ));
    };

    let mut matches = Vec::new();
    let mut seen = HashSet::new();
    seen.insert(selected_root_path.clone());
    let mut queue = VecDeque::new();
    for name in list_searchable_subdirectories(&root_entries) {
        let p = selected_root_path.join(name);
        seen.insert(p.clone());
        queue.push_back(p);
    }

    while let Some(current) = queue.pop_front() {
        let Some(current_entries) = read_directory_safe(&current) else {
            continue;
        };
        if checkout_kind(&current_entries).is_some() {
            continue;
        }
        if let Some(identified) =
            identify_plan_folder_at_root(&current, Some(&current_entries), false)
        {
            matches.push(identified);
            continue;
        }
        for name in list_searchable_subdirectories(&current_entries) {
            let child_path = current.join(name);
            if seen.insert(child_path.clone()) {
                queue.push_back(child_path);
            }
        }
    }

    if !matches.is_empty() {
        Ok(matches)
    } else if let Some(direct) = direct_match {
        Ok(vec![direct])
    } else {
        Ok(Vec::new())
    }
}

/// Discovers Git repository roots below `selected_root` (clones only, never worktrees).
pub fn discover_repository_folders(selected_root: &str) -> Result<Vec<String>, String> {
    let selected_root_path = to_directory_path(selected_root);
    let Some(root_entries) = read_directory_safe(&selected_root_path) else {
        return Err(build_unreadable_path_error(
            selected_root,
            SupportedPathPlatform::current(),
        ));
    };

    let mut repositories = Vec::new();
    let mut seen = HashSet::new();
    seen.insert(selected_root_path.clone());
    let mut queue = VecDeque::new();
    queue.push_back(selected_root_path.clone());

    while let Some(current) = queue.pop_front() {
        let entries = if current == selected_root_path {
            Some(root_entries.clone())
        } else {
            read_directory_safe(&current)
        };
        let Some(entries) = entries else {
            continue;
        };
        if checkout_kind(&entries) == Some(CheckoutKind::Clone) {
            repositories.push(current.to_string_lossy().to_string());
        }
        for name in list_searchable_subdirectories(&entries) {
            let child_path = current.join(name);
            if seen.insert(child_path.clone()) {
                queue.push_back(child_path);
            }
        }
    }

    Ok(repositories)
}

/// Resolves a selected folder to the actual plans root and features folder.
pub fn identify_plan_folder(selected_root: &str) -> Result<IdentifiedPlanFolder, String> {
    let selected_root_path = to_directory_path(selected_root);
    if let Some(direct) = identify_plan_folder_at_root(&selected_root_path, None, true) {
        return Ok(direct);
    }
    let matches = discover_plan_folders(selected_root)?;
    if let Some(first) = matches.into_iter().next() {
        return Ok(first);
    }
    if read_directory_safe(&selected_root_path).is_some() {
        return Ok(IdentifiedPlanFolder {
            plans_root_path: selected_root_path.to_string_lossy().to_string(),
            features_root_path: selected_root_path
                .join("features")
                .to_string_lossy()
                .to_string(),
            feature_entries: Vec::new(),
        });
    }
    Err(build_unreadable_path_error(
        &selected_root_path.to_string_lossy(),
        SupportedPathPlatform::current(),
    ))
}

#[derive(Debug, Clone)]
struct MarkdownPlanFile {
    file_path: PathBuf,
    relative_path: String,
    name: String,
    content: String,
}

fn read_markdown_plan_files(
    root_path: &Path,
    current_path: &Path,
    result: &mut Vec<MarkdownPlanFile>,
) {
    let Some(mut entries) = read_directory_safe(current_path) else {
        return;
    };
    entries.sort_by(|(l, _), (r, _)| locale_cmp_str(l, r));
    for (name, kind) in entries {
        if is_search_skip_dir(&name) {
            continue;
        }
        let file_path = current_path.join(&name);
        if kind == FileKind::Directory {
            read_markdown_plan_files(root_path, &file_path, result);
        } else if name.to_lowercase().ends_with(".md")
            && let Ok(content) = read_utf8(&file_path)
        {
            let rel = file_path
                .strip_prefix(root_path)
                .unwrap_or(&file_path)
                .to_string_lossy()
                .replace('\\', "/");
            result.push(MarkdownPlanFile {
                file_path,
                relative_path: rel,
                name,
                content,
            });
        }
    }
}

fn parse_digits_ignore_leading_zeros(digits: &str) -> Option<u32> {
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let trimmed = digits.trim_start_matches('0');
    if trimmed.is_empty() {
        Some(0)
    } else {
        trimmed.parse::<u32>().ok()
    }
}

fn planning_number(value: Option<&str>) -> Option<u32> {
    let v = value?;
    let upper = v.to_ascii_uppercase();
    // Match /(?:FX-(?:BF|BE)|TASK)-0*(\d+)/i
    for prefix in ["FX-BF-", "FX-BE-", "TASK-"] {
        let mut search_from = 0usize;
        while let Some(pos) = upper[search_from..].find(prefix) {
            let start = search_from + pos + prefix.len();
            let digits: String = upper[start..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Some(n) = parse_digits_ignore_leading_zeros(&digits) {
                return Some(n);
            }
            search_from = start;
        }
    }
    // Match /(?:^|[\\/-])feature-0*(\d+)(?:-|$)/i
    let lower = v.to_ascii_lowercase();
    let target = "feature-";
    let mut search_from = 0usize;
    while let Some(pos) = lower[search_from..].find(target) {
        let abs_pos = search_from + pos;
        let boundary_ok =
            abs_pos == 0 || matches!(lower.as_bytes()[abs_pos - 1], b'/' | b'\\' | b'-');
        let start = abs_pos + target.len();
        if boundary_ok {
            let digits: String = lower[start..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            let after_digits = start + digits.len();
            let end_ok = after_digits == lower.len() || lower.as_bytes()[after_digits] == b'-';
            if end_ok && let Some(n) = parse_digits_ignore_leading_zeros(&digits) {
                return Some(n);
            }
        }
        search_from = start;
    }
    None
}

fn planning_feature_id(
    file: &MarkdownPlanFile,
    feature_directories: &HashMap<PathBuf, u32>,
) -> Option<u32> {
    if let Some(explicit) = extract_front_matter_value(&file.content, "feature")
        .or_else(|| match_bold_field_in_content(&file.content, "Feature", true))
    {
        return planning_number(Some(&explicit));
    }
    let mut dir_opt = file.file_path.parent();
    while let Some(dir) = dir_opt {
        if let Some(&found) = feature_directories.get(dir) {
            return Some(found);
        }
        let parent = dir.parent();
        if parent == Some(dir) {
            break;
        }
        dir_opt = parent;
    }
    planning_number(Some(&file.name))
}

fn relative_posix_path(base: &Path, target: &Path) -> String {
    if base == target {
        return String::new();
    }
    if let Ok(stripped) = target.strip_prefix(base) {
        return stripped.to_string_lossy().replace('\\', "/");
    }
    let base_comps: Vec<_> = base.components().collect();
    let target_comps: Vec<_> = target.components().collect();
    let common = base_comps
        .iter()
        .zip(target_comps.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let mut parts: Vec<String> = Vec::new();
    for _ in common..base_comps.len() {
        parts.push("..".to_string());
    }
    for comp in &target_comps[common..] {
        parts.push(comp.as_os_str().to_string_lossy().to_string());
    }
    parts.join("/")
}

/// Scans a plans root folder and returns parsed features, stories, and child items.
pub fn parse_plan_folder(
    plans_root: &str,
    workflow: Option<&[ProjectWorkflowStage]>,
) -> Result<ParsedPlanFolder, String> {
    let identified = identify_plan_folder(plans_root)?;
    let effective_wf = workflow
        .filter(|w| !w.is_empty())
        .map(<[ProjectWorkflowStage]>::to_vec)
        .unwrap_or_else(default_workflow);

    let plans_root_path = PathBuf::from(&identified.plans_root_path);
    let features_root_path = PathBuf::from(&identified.features_root_path);

    let mut files = Vec::new();
    read_markdown_plan_files(&plans_root_path, &plans_root_path, &mut files);

    let mut feature_indices = HashSet::new();
    for (idx, file) in files.iter().enumerate() {
        let is_feature = file.name.eq_ignore_ascii_case("feature.md")
            || extract_type_raw(&file.content)
                .is_some_and(|t| t.trim().eq_ignore_ascii_case("feature"));
        if is_feature {
            feature_indices.insert(idx);
        }
    }

    let mut feature_directories: HashMap<PathBuf, u32> = HashMap::new();
    let mut used_feature_ids: HashSet<u32> = HashSet::new();
    let mut auto_feature_id: u32 = 9000;
    let mut features: Vec<ParsedFeatureFolder> = Vec::new();

    for (idx, file) in files.iter().enumerate() {
        if !feature_indices.contains(&idx) {
            continue;
        }
        let dir_path = file
            .file_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| plans_root_path.clone());
        let mut feature_id =
            planning_number(extract_front_matter_value(&file.content, "id").as_deref())
                .or_else(|| planning_number(Some(&dir_path.to_string_lossy())))
                .unwrap_or_else(|| {
                    let id = auto_feature_id;
                    auto_feature_id += 1;
                    id
                });
        while used_feature_ids.contains(&feature_id) {
            feature_id = auto_feature_id;
            auto_feature_id += 1;
        }
        used_feature_ids.insert(feature_id);
        feature_directories.insert(dir_path.clone(), feature_id);

        let rel_dir = relative_posix_path(&features_root_path, &dir_path);
        let dir_name = if rel_dir.is_empty() {
            dir_path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            rel_dir
        };

        features.push(ParsedFeatureFolder {
            planning_id: extract_front_matter_value(&file.content, "id"),
            dir_name,
            feature_id,
            title: extract_main_heading(&file.content),
            plan_status: resolve_status(&extract_status_raw(&file.content), Some(&effective_wf)),
            description: build_description(&file.content),
            feature_md_path: file.file_path.to_string_lossy().to_string(),
            dep_tokens: collect_dependency_tokens(&file.content),
            planning_dates: extract_planning_dates(&file.content),
            priority: extract_priority_raw(&file.content),
            origin: extract_origin_raw(&file.content),
            model: extract_model_raw(&file.content),
            complexity: extract_complexity_raw(&file.content),
        });
    }

    features.sort_by(|left, right| {
        left.feature_id
            .cmp(&right.feature_id)
            .then_with(|| locale_cmp_str(&left.dir_name, &right.dir_name))
    });

    let mut auto_sequence: u32 = 9000;
    let mut child_items: Vec<ParsedChildFile> = Vec::new();

    for (idx, file) in files.iter().enumerate() {
        if feature_indices.contains(&idx) {
            continue;
        }
        let parsed_name = parse_child_file_name(&file.name);
        let Some(issue_type) =
            normalize_child_issue_type(extract_type_raw(&file.content).as_deref())
                .or_else(|| parsed_name.as_ref().map(|p| p.issue_type))
        else {
            continue;
        };
        let feature_id = planning_feature_id(file, &feature_directories);
        let sequence = planning_number(extract_front_matter_value(&file.content, "id").as_deref())
            .or_else(|| parsed_name.as_ref().map(|p| p.sequence))
            .unwrap_or_else(|| {
                let s = auto_sequence;
                auto_sequence += 1;
                s
            });

        child_items.push(ParsedChildFile {
            planning_id: extract_front_matter_value(&file.content, "id"),
            feature_id,
            sequence,
            filename: file.name.clone(),
            issue_type: issue_type.to_string(),
            title: extract_main_heading(&file.content),
            plan_status: resolve_status(&extract_status_raw(&file.content), Some(&effective_wf)),
            description: build_description(&file.content),
            idea_transcript: extract_section_body(&file.content, "Research Transcript"),
            relative_path: file.relative_path.clone(),
            file_path: file.file_path.to_string_lossy().to_string(),
            dep_tokens: collect_dependency_tokens(&file.content),
            planning_dates: extract_planning_dates(&file.content),
            branch: extract_branch_raw(&file.content),
            priority: extract_priority_raw(&file.content),
            origin: extract_origin_raw(&file.content),
            severity: extract_severity_raw(&file.content),
            reported_by: extract_reported_by_raw(&file.content),
            model: extract_model_raw(&file.content),
            complexity: extract_complexity_raw(&file.content),
        });
    }

    child_items.sort_by(|left, right| {
        left.feature_id
            .unwrap_or(0)
            .cmp(&right.feature_id.unwrap_or(0))
            .then_with(|| locale_cmp_str(&left.issue_type, &right.issue_type))
            .then_with(|| left.sequence.cmp(&right.sequence))
            .then_with(|| locale_cmp_str(&left.relative_path, &right.relative_path))
    });

    let stories: Vec<ParsedStoryFile> = child_items
        .iter()
        .filter(|child| child.issue_type == "Story" && child.feature_id.is_some())
        .map(|child| ParsedStoryFile {
            feature_id: child.feature_id.unwrap_or(0),
            story_seq: child.sequence,
            filename: child.filename.clone(),
            title: child.title.clone(),
            plan_status: child.plan_status.clone(),
            description: child.description.clone(),
            idea_transcript: child.idea_transcript.clone(),
            relative_path: child.relative_path.clone(),
            story_md_path: child.file_path.clone(),
            dep_tokens: child.dep_tokens.clone(),
            planning_dates: child.planning_dates.clone(),
            branch: child.branch.clone(),
        })
        .collect();

    Ok(ParsedPlanFolder {
        features,
        stories,
        child_items,
        plans_root_path: identified.plans_root_path,
        features_root_path: identified.features_root_path,
    })
}

/// Resolves explicit local planning ids before interpreting tokens as tracker keys.
#[must_use]
pub fn resolve_plan_dependency_keys(
    parsed: &ParsedPlanFolder,
    project_key: &str,
) -> HashMap<String, Vec<String>> {
    struct DepRecord<'a> {
        key: String,
        id: Option<&'a str>,
        name: String,
        tokens: &'a [String],
    }

    let mut records: Vec<DepRecord<'_>> =
        Vec::with_capacity(parsed.features.len() + parsed.child_items.len());
    for feature in &parsed.features {
        records.push(DepRecord {
            key: stable_feature_key(project_key, feature.feature_id),
            id: feature.planning_id.as_deref(),
            name: feature.dir_name.clone(),
            tokens: &feature.dep_tokens,
        });
    }
    for child in &parsed.child_items {
        let fid = child.feature_id.unwrap_or(0);
        let key = if child.issue_type == "Story" {
            stable_story_key(project_key, fid, child.sequence)
        } else {
            stable_child_key(project_key, &child.issue_type, fid, child.sequence)
        };
        let lower_filename = child.filename.to_lowercase();
        let name = lower_filename
            .strip_suffix(".md")
            .unwrap_or(&lower_filename)
            .to_string();
        records.push(DepRecord {
            key,
            id: child.planning_id.as_deref(),
            name,
            tokens: &child.dep_tokens,
        });
    }

    let mut local_ids: HashMap<String, String> = HashMap::new();
    let mut ambiguous_ids: HashSet<String> = HashSet::new();
    for record in &records {
        let Some(id) = record.id else {
            continue;
        };
        if local_ids.contains_key(id) {
            ambiguous_ids.insert(id.to_string());
        } else {
            local_ids.insert(id.to_string(), record.key.clone());
        }
    }
    for id in &ambiguous_ids {
        local_ids.remove(id);
    }

    let mut names: HashMap<String, String> = HashMap::new();
    let mut ambiguous_names: HashSet<String> = HashSet::new();
    for record in &records {
        if names.contains_key(&record.name) {
            ambiguous_names.insert(record.name.clone());
        } else {
            names.insert(record.name.clone(), record.key.clone());
        }
    }
    for name in &ambiguous_names {
        names.remove(name);
    }

    let mut result: HashMap<String, Vec<String>> = HashMap::new();
    for record in &records {
        if record.tokens.is_empty() {
            continue;
        }
        let mut keys: Vec<String> = Vec::new();
        for token in record.tokens {
            if ambiguous_ids.contains(token) {
                continue;
            }
            let resolved = local_ids.get(token).cloned().or_else(|| {
                if is_issue_key_token(token) {
                    Some(token.clone())
                } else {
                    names
                        .get(token)
                        .cloned()
                        .or_else(|| names.get(&token.to_lowercase()).cloned())
                }
            });
            if let Some(key) = resolved
                && key != record.key
                && !keys.contains(&key)
            {
                keys.push(key);
            }
        }
        if !keys.is_empty() {
            result.insert(record.key.clone(), keys);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folder::markdown_template::{
        GenerateOptions, IssueType, ensure_front_matter, generate_issue_markdown,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("{prefix}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    fn write_feature(plans_root: &Path, title: &str) {
        let feature_dir = plans_root.join("features").join("feature-01-demo");
        std::fs::create_dir_all(&feature_dir).expect("mkdir feature");
        std::fs::write(
            feature_dir.join("feature.md"),
            format!("# {title}\n\n**Type:** Feature\n**Status:** Backlog\n"),
        )
        .expect("write feature.md");
    }

    #[test]
    fn recursively_discovers_nested_planning_documents_from_front_matter() {
        let root = temp_dir("praxis-plan-parser");
        let feature = root.join("features").join("arbitrary-feature-folder");
        let story = feature.join("stories").join("arbitrary-story-folder");
        let tasks = story.join("tasks");
        std::fs::create_dir_all(&tasks).expect("mkdir");
        std::fs::write(
            feature.join("feature.md"),
            "---\nid: FX-BF-042\ntype: Feature\nstatus: proposed\n---\n\n# Agent feature\n\n## Description\n\nFeature body.",
        )
        .expect("write");
        std::fs::write(
            story.join("story.md"),
            "---\nid: FX-BE-101\ntype: Story\nfeature: FX-BF-042\nstatus: in-progress\n---\n\n# Nested story\n\n## Description\n\nStory body.",
        )
        .expect("write");
        std::fs::write(
            tasks.join("implementation.md"),
            "---\nid: TASK-202\ntype: Task\nstatus: complete\n---\n\n# Nested task\n\n## Description\n\nTask body.",
        )
        .expect("write");

        let parsed = parse_plan_folder(&root.to_string_lossy(), None).expect("parse");
        assert_eq!(parsed.features.len(), 1);
        assert_eq!(parsed.features[0].feature_id, 42);
        assert_eq!(parsed.stories.len(), 1);
        assert_eq!(parsed.stories[0].title, "Nested story");
        assert_eq!(parsed.child_items.len(), 2);
        assert_eq!(
            parsed
                .child_items
                .iter()
                .map(|i| i.issue_type.as_str())
                .collect::<Vec<_>>(),
            vec!["Story", "Task"]
        );
        assert!(parsed.child_items.iter().all(|i| i.feature_id == Some(42)));
        assert_eq!(
            parsed
                .child_items
                .iter()
                .map(|i| i.plan_status.as_str())
                .collect::<Vec<_>>(),
            vec!["In Progress", "Done"]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discovery_stops_at_nested_git_checkouts() {
        let dir = temp_dir("praxis-worktree");
        std::fs::create_dir_all(dir.join(".git")).expect("mkdir .git");
        write_feature(&dir.join("docs").join("plans"), "Main plan");

        let worktree = dir.join(".worktrees").join("branch-x");
        std::fs::create_dir_all(&worktree).expect("mkdir worktree");
        std::fs::write(
            worktree.join(".git"),
            format!(
                "gitdir: {}\n",
                dir.join(".git/worktrees/branch-x").display()
            ),
        )
        .expect("write .git file");
        write_feature(&worktree.join("docs").join("plans"), "Main plan");

        let nested_clone = dir.join("vendor").join("other-repo");
        std::fs::create_dir_all(nested_clone.join(".git")).expect("mkdir clone .git");
        write_feature(&nested_clone.join("docs").join("plans"), "Vendor plan");

        let roots: Vec<String> = discover_plan_folders(&dir.to_string_lossy())
            .expect("discover")
            .into_iter()
            .map(|m| m.plans_root_path)
            .collect();
        assert_eq!(roots.len(), 1);
        assert!(roots[0].contains("docs"));
        assert!(!roots.iter().any(|r| r.contains(".worktrees")));
        assert!(!roots.iter().any(|r| r.contains("vendor")));

        let repos = discover_repository_folders(&dir.to_string_lossy()).expect("repos");
        assert!(repos.iter().any(|r| r.contains("vendor")));
        assert!(!repos.iter().any(|r| r.contains(".worktrees")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn canonical_and_frontmatter_dependencies_resolve_to_board_keys() {
        let root = temp_dir("praxis-plan-deps");
        let feature = root.join("features").join("delivery");
        let story = feature.join("stories").join("diagnose");
        let tasks = story.join("tasks");
        std::fs::create_dir_all(&tasks).expect("mkdir");
        std::fs::write(
            feature.join("feature.md"),
            "---\nid: FX-BF-042\ntype: Feature\n---\n# Delivery\n",
        )
        .expect("write");
        std::fs::write(
            story.join("story.md"),
            "---\nid: FX-BE-101\ntype: Story\ndependencies: [FX-BF-042]\n---\n# Diagnose\n\n## Dependencies\n\n",
        )
        .expect("write");
        std::fs::write(
            tasks.join("first.md"),
            "---\nid: TASK-202\ntype: Task\n---\n# Evidence\n\n## Dependencies\n- FX-BE-101\n",
        )
        .expect("write");
        std::fs::write(
            tasks.join("second.md"),
            "---\nid: TASK-203\ntype: Task\n---\n# Repair\n\n## Dependencies\n- TASK-202\n- KAMAI-4\n- TASK-203\n",
        )
        .expect("write");

        let parsed = parse_plan_folder(&root.to_string_lossy(), None).expect("parse");
        let resolved = resolve_plan_dependency_keys(&parsed, "PRAXIS");
        assert_eq!(
            resolved.get("PRAXIS-S42-101"),
            Some(&vec!["PRAXIS-F42".to_string()])
        );
        assert_eq!(
            resolved.get("PRAXIS-T42-202"),
            Some(&vec!["PRAXIS-S42-101".to_string()])
        );
        assert_eq!(
            resolved.get("PRAXIS-T42-203"),
            Some(&vec!["PRAXIS-T42-202".to_string(), "KAMAI-4".to_string()])
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn captured_item_round_trips_origin_line() {
        let root = temp_dir("praxis-plan-origin");
        let feature_dir = root.join("features").join("feature-01-demo");
        std::fs::create_dir_all(&feature_dir).expect("mkdir");
        let created_at = "2026-10-11T09:00:00.000Z".to_string();
        let captured = generate_issue_markdown(
            IssueType::Task,
            "Captured note",
            &GenerateOptions {
                created_at: Some(created_at.clone()),
                parent_key: Some("PRX-F01".to_string()),
                origin: Some("capture".to_string()),
                ..GenerateOptions::default()
            },
        );
        let plain = generate_issue_markdown(
            IssueType::Task,
            "Typed ticket",
            &GenerateOptions {
                created_at: Some(created_at.clone()),
                parent_key: Some("PRX-F01".to_string()),
                ..GenerateOptions::default()
            },
        );
        assert!(captured.contains("**Origin:** capture"));
        assert!(!plain.contains("Origin"));
        assert_eq!(ensure_front_matter(&captured, IssueType::Task), captured);
        assert!(!ensure_front_matter(&plain, IssueType::Task).contains("Origin"));

        std::fs::write(
            feature_dir.join("feature.md"),
            generate_issue_markdown(
                IssueType::Feature,
                "Demo",
                &GenerateOptions {
                    created_at: Some(created_at),
                    ..GenerateOptions::default()
                },
            ),
        )
        .expect("write");
        std::fs::write(feature_dir.join("task-01-1-captured-note.md"), &captured).expect("write");
        std::fs::write(feature_dir.join("task-01-2-typed-ticket.md"), &plain).expect("write");
        let forged = generate_issue_markdown(
            IssueType::Task,
            "Forged origin",
            &GenerateOptions {
                created_at: Some("2026-10-11T09:00:00.000Z".to_string()),
                parent_key: Some("PRX-F01".to_string()),
                ..GenerateOptions::default()
            },
        )
        .replace("**Priority:**", "**Origin:** <script>\n**Priority:**");
        std::fs::write(feature_dir.join("task-01-3-forged-origin.md"), &forged).expect("write");

        let parsed = parse_plan_folder(&root.to_string_lossy(), None).expect("parse");
        let origins: HashMap<String, Option<IssueOrigin>> = parsed
            .child_items
            .into_iter()
            .map(|item| (item.title, item.origin))
            .collect();
        assert_eq!(
            origins.get("Captured note"),
            Some(&Some(IssueOrigin::Capture))
        );
        assert_eq!(origins.get("Typed ticket"), Some(&None));
        assert_eq!(origins.get("Forged origin"), Some(&None));
        let _ = std::fs::remove_dir_all(&root);
    }
}
