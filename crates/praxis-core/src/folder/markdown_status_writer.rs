//! Markdown status, field, table, and comment writers (`packages/core/src/folder/markdownStatusWriter.ts`).

use std::path::Path;

use chrono::Utc;

use crate::folder::folder_fs::folder_write_file;
use crate::folder::markdown_plan_parser::read_utf8;
use crate::folder::markdown_template::{IssueType, ensure_front_matter};
use crate::issues::idea_transcript::compose_idea_content;

/// Reverse-maps plan statuses back to the emoji-prefixed markdown format.
#[must_use]
pub fn plan_status_to_markdown(plan_status: &str) -> String {
    match plan_status {
        "Done" => "✅ Complete".to_string(),
        "In Progress" => "🔄 In Progress".to_string(),
        "Blocked" => "⛔ Blocked".to_string(),
        "To Do" => "📋 To Do".to_string(),
        "Backlog" => "📋 Proposed".to_string(),
        other => other.to_string(),
    }
}

fn replace_first_bold_line(content: &str, field_name: &str, new_value: &str) -> Option<String> {
    let prefix = format!("**{field_name}:**");
    let mut offset = 0usize;
    for raw_line in content.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(after) = line.strip_prefix(&prefix) {
            let ws_len = after.len() - after.trim_start().len();
            let sep = if ws_len > 0 { &after[..ws_len] } else { " " };
            let line_start = offset;
            let line_end = offset + line.len();
            let mut out = String::with_capacity(content.len() + new_value.len());
            out.push_str(&content[..line_start]);
            out.push_str(&prefix);
            out.push_str(sep);
            out.push_str(new_value);
            out.push_str(&content[line_end..]);
            return Some(out);
        }
        offset += raw_line.len() + 1;
    }
    None
}

fn write_front_matter_status(content: &str, new_plan_status: &str) -> String {
    let Some(rest) = content.strip_prefix("---") else {
        return content.to_string();
    };
    let ws1_len = rest.len() - rest.trim_start_matches([' ', '\t']).len();
    let after_ws1 = &rest[ws1_len..];
    let nl1_len = if after_ws1.starts_with("\r\n") {
        2
    } else if after_ws1.starts_with('\n') {
        1
    } else {
        return content.to_string();
    };
    let header_len = 3 + ws1_len + nl1_len;
    let body_and_rest = &content[header_len..];

    let mut pos = 0usize;
    let mut close_span: Option<(usize, usize)> = None;
    for raw_line in body_and_rest.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(after_dash) = line.strip_prefix("---")
            && after_dash.trim_matches([' ', '\t']).is_empty()
        {
            let mut body_end = pos;
            if body_end > 0 && body_and_rest.as_bytes()[body_end - 1] == b'\n' {
                body_end -= 1;
                if body_end > 0 && body_and_rest.as_bytes()[body_end - 1] == b'\r' {
                    body_end -= 1;
                }
            }
            let close_end = (pos + raw_line.len() + 1).min(body_and_rest.len());
            close_span = Some((body_end, close_end));
            break;
        }
        pos += raw_line.len() + 1;
    }

    let Some((body_end, close_end)) = close_span else {
        return content.to_string();
    };
    let fm_body = &body_and_rest[..body_end];
    let fm_close = &body_and_rest[body_end..close_end];
    let tail = &body_and_rest[close_end..];

    let mut line_offset = 0usize;
    for raw_line in fm_body.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(after_key) = line.strip_prefix("status:") {
            let ws_len = after_key.len() - after_key.trim_start_matches([' ', '\t']).len();
            let ws = &after_key[..ws_len];
            let val_trimmed = after_key[ws_len..].trim_end_matches([' ', '\t']);
            let quote = if (val_trimmed.starts_with('"') && val_trimmed.ends_with('"'))
                || (val_trimmed.starts_with('\'') && val_trimmed.ends_with('\''))
            {
                &val_trimmed[..1]
            } else {
                ""
            };
            let new_line = format!("status:{ws}{quote}{new_plan_status}{quote}");
            let mut updated_fm = String::with_capacity(fm_body.len() + new_line.len());
            updated_fm.push_str(&fm_body[..line_offset]);
            updated_fm.push_str(&new_line);
            updated_fm.push_str(&fm_body[line_offset + line.len()..]);
            return format!(
                "{}{}{}{}",
                &content[..header_len],
                updated_fm,
                fm_close,
                tail
            );
        }
        line_offset += raw_line.len() + 1;
    }

    content.to_string()
}

/// Updates the `**Status:**` line and YAML frontmatter `status:` in a markdown file.
pub fn write_status_to_markdown_file(
    file_path: &Path,
    new_plan_status: &str,
) -> std::io::Result<bool> {
    let content = read_utf8(file_path)?;
    let md_status = plan_status_to_markdown(new_plan_status);

    let mut updated =
        if let Some(replaced) = replace_first_bold_line(&content, "Status", &md_status) {
            replaced
        } else {
            let normalized = content.replace("\r\n", "\n");
            let mut lines: Vec<String> = normalized.split('\n').map(ToString::to_string).collect();
            let mut insert_idx = 1usize;
            while insert_idx < lines.len() && lines[insert_idx].trim().is_empty() {
                insert_idx += 1;
            }
            let idx = insert_idx.min(lines.len());
            lines.insert(idx, format!("**Status:** {md_status}"));
            lines.join("\n")
        };

    updated = write_front_matter_status(&updated, new_plan_status);
    if updated == content {
        return Ok(false);
    }
    folder_write_file(file_path, &updated)?;
    Ok(true)
}

fn contains_words_in_order_case_insensitive(haystack: &str, words: &[&str]) -> bool {
    if words.is_empty() {
        return true;
    }
    let lower_haystack = haystack.to_lowercase();
    let mut pos = 0usize;
    for word in words {
        let lower_word = word.to_lowercase();
        let Some(found) = lower_haystack[pos..].find(&lower_word) else {
            return false;
        };
        pos += found + lower_word.len();
    }
    true
}

fn is_table_status_cell(cell: &str) -> bool {
    cell.contains('✅')
        || cell.contains('🔄')
        || cell.contains('📋')
        || cell.contains('⛔')
        || matches!(
            cell,
            "Done" | "In Progress" | "Blocked" | "Proposed" | "Complete" | "Backlog" | "To Do"
        )
}

/// Updates a story's status row inside the parent `feature.md` story/item table.
pub fn update_feature_story_table(
    feature_md_path: &Path,
    story_seq: u32,
    story_name: &str,
    new_plan_status: &str,
) -> std::io::Result<bool> {
    let Ok(content) = read_utf8(feature_md_path) else {
        return Ok(false);
    };

    let md_status = plan_status_to_markdown(new_plan_status);
    let mut lines: Vec<String> = content
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();
    let mut modified = false;
    let story_seq_str = story_seq.to_string();
    let name_words: Vec<&str> = story_name.split_whitespace().take(3).collect();

    for line in &mut lines {
        if !line.starts_with('|') {
            continue;
        }
        let mut cells: Vec<String> = line.split('|').map(|c| c.trim().to_string()).collect();
        let ref_cell = cells.get(1).map(String::as_str).unwrap_or("");
        if !ref_cell.contains(&story_seq_str) {
            continue;
        }
        let name_cell = cells.get(2).map(String::as_str).unwrap_or("");
        if !name_words.is_empty()
            && !contains_words_in_order_case_insensitive(name_cell, &name_words)
            && !contains_words_in_order_case_insensitive(line, &name_words)
        {
            continue;
        }
        let Some(status_idx) = cells
            .iter()
            .enumerate()
            .skip(3)
            .find(|(_, c)| is_table_status_cell(c))
            .map(|(idx, _)| idx)
        else {
            continue;
        };
        cells[status_idx] = md_status;
        let inner = cells[1..cells.len().saturating_sub(1)].join(" | ");
        *line = format!("| {inner} |");
        modified = true;
        break;
    }

    if !modified {
        return Ok(false);
    }

    let updated = lines.join("\n");
    folder_write_file(feature_md_path, &updated)?;
    Ok(true)
}

fn is_items_or_stories_heading(trimmed: &str) -> bool {
    let Some(rest) = trimmed.strip_prefix("##") else {
        return false;
    };
    if !rest.starts_with(char::is_whitespace) {
        return false;
    }
    let after_ws = rest.trim_start();
    for kw in ["Items", "Stories"] {
        if after_ws
            .as_bytes()
            .get(..kw.len())
            .is_some_and(|b| b.eq_ignore_ascii_case(kw.as_bytes()))
        {
            let rem = &after_ws[kw.len()..];
            if rem.is_empty()
                || !rem
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                return true;
            }
        }
    }
    false
}

fn is_ref_type_name_status_header(trimmed: &str) -> bool {
    if !trimmed.starts_with('|') || !trimmed.ends_with('|') {
        return false;
    }
    let cells: Vec<&str> = trimmed.split('|').map(str::trim).collect();
    cells.len() == 6
        && cells[1].eq_ignore_ascii_case("Ref")
        && cells[2].eq_ignore_ascii_case("Type")
        && cells[3].eq_ignore_ascii_case("Name")
        && cells[4].eq_ignore_ascii_case("Status")
}

/// Appends a child row to a feature's `## Items` (or `## Stories`) table.
pub fn append_feature_item_table_row(
    feature_md_path: &Path,
    item_reference: &str,
    item_type: &str,
    item_name: &str,
    plan_status: &str,
) -> std::io::Result<bool> {
    let Ok(content) = read_utf8(feature_md_path) else {
        return Ok(false);
    };

    let normalized = content.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    for line in &lines {
        if line.trim_start().starts_with('|') {
            let cells: Vec<&str> = line.split('|').map(str::trim).collect();
            if cells.len() >= 3
                && cells[1].eq_ignore_ascii_case(item_reference.trim())
                && cells[2].eq_ignore_ascii_case(item_type.trim())
            {
                return Ok(false);
            }
        }
    }

    let md_status = plan_status_to_markdown(plan_status);
    let row = format!("| {item_reference} | {item_type} | {item_name} | {md_status} |");

    if let Some(section_idx) = lines
        .iter()
        .position(|l| is_items_or_stories_heading(l.trim()))
    {
        let mut insert_idx = section_idx + 1;
        let mut has_header = false;
        while insert_idx < lines.len() {
            let trimmed = lines[insert_idx].trim();
            if trimmed.starts_with("## ") {
                break;
            }
            if is_ref_type_name_status_header(trimmed) {
                has_header = true;
            }
            insert_idx += 1;
        }

        let mut next_lines: Vec<String> = lines.iter().map(|s| (*s).to_string()).collect();
        if !has_header {
            next_lines.splice(
                insert_idx..insert_idx,
                [
                    String::new(),
                    "| Ref | Type | Name | Status |".to_string(),
                    "| --- | --- | --- | --- |".to_string(),
                    row,
                ],
            );
        } else {
            next_lines.insert(insert_idx, row);
        }
        folder_write_file(feature_md_path, &next_lines.join("\n"))?;
        return Ok(true);
    }

    let updated = format!(
        "{}\n\n## Items\n\n| Ref | Type | Name | Status |\n| --- | --- | --- | --- |\n{row}\n",
        normalized.trim_end()
    );
    folder_write_file(feature_md_path, &updated)?;
    Ok(true)
}

/// Removes a child row from a feature's `## Items` / `## Stories` table.
pub fn remove_feature_item_table_row(
    feature_md_path: &Path,
    item_reference: &str,
    item_type: &str,
) -> std::io::Result<bool> {
    let Ok(content) = read_utf8(feature_md_path) else {
        return Ok(false);
    };

    let reference = item_reference.trim().to_lowercase();
    let kind = item_type.trim().to_lowercase();
    let mut lines: Vec<String> = content
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();
    let Some(row_index) = lines.iter().position(|line| {
        if !line.trim().starts_with('|') {
            return false;
        }
        let cells: Vec<String> = line.split('|').map(|c| c.trim().to_lowercase()).collect();
        cells.get(1).map(String::as_str) == Some(reference.as_str())
            && cells.get(2).map(String::as_str) == Some(kind.as_str())
    }) else {
        return Ok(false);
    };

    lines.remove(row_index);
    folder_write_file(feature_md_path, &lines.join("\n"))?;
    Ok(true)
}

/// Updates or inserts `**Parent:** <parentKey>` in a child markdown file.
pub fn write_parent_to_markdown_file(file_path: &Path, parent_key: &str) -> std::io::Result<bool> {
    let content = read_utf8(file_path)?;
    let updated = if let Some(replaced) = replace_first_bold_line(&content, "Parent", parent_key) {
        replaced
    } else {
        let normalized = content.replace("\r\n", "\n");
        let mut lines: Vec<String> = normalized.split('\n').map(ToString::to_string).collect();
        let type_idx = lines
            .iter()
            .position(|l| l.trim().to_lowercase().starts_with("**type:**"));
        let insert_idx = type_idx.map_or(1, |idx| idx + 1).min(lines.len());
        lines.insert(insert_idx, format!("**Parent:** {parent_key}"));
        lines.join("\n")
    };

    if updated == content {
        return Ok(false);
    }
    folder_write_file(file_path, &updated)?;
    Ok(true)
}

/// Computes the parent feature rollup status from its sibling story statuses.
#[must_use]
pub fn compute_feature_rollup_status(story_statuses: &[String]) -> Option<String> {
    if story_statuses.is_empty() {
        return None;
    }
    if story_statuses.iter().all(|s| s == "Done") {
        return Some("Done".to_string());
    }
    if story_statuses
        .iter()
        .any(|s| s == "In Progress" || s == "Blocked")
    {
        return Some("In Progress".to_string());
    }
    if story_statuses.iter().any(|s| s == "To Do") {
        return Some("To Do".to_string());
    }
    None
}

/// Appends a comment to the `## Comments` section of a markdown file.
pub fn append_comment_to_markdown_file(
    file_path: &Path,
    author: &str,
    body: &str,
) -> std::io::Result<()> {
    let content = read_utf8(file_path)?;
    let normalized = content.replace("\r\n", "\n");
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let comment_block = format!("**{author}** — {now}\n{body}");

    let lines: Vec<&str> = normalized.split('\n').collect();
    let section_idx = lines.iter().position(|line| {
        let trimmed = line.trim();
        trimmed.eq_ignore_ascii_case("## Comments")
            || trimmed
                .strip_prefix("##")
                .is_some_and(|r| r.trim_start().eq_ignore_ascii_case("Comments"))
    });

    let updated = if let Some(sec_idx) = section_idx {
        let mut end_idx = sec_idx + 1;
        while end_idx < lines.len() && !lines[end_idx].starts_with("## ") {
            end_idx += 1;
        }
        let mut next_lines: Vec<String> = lines.iter().map(|s| (*s).to_string()).collect();
        next_lines.splice(end_idx..end_idx, [String::new(), comment_block]);
        next_lines.join("\n")
    } else {
        format!(
            "{}\n\n## Comments\n\n{comment_block}\n",
            normalized.trim_end()
        )
    };

    folder_write_file(file_path, &updated)
}

/// Replaces the body of `## Description` (or `## Summary`) in a markdown file.
pub fn write_description_to_markdown_file(
    file_path: &Path,
    new_description: &str,
) -> std::io::Result<bool> {
    let content = read_utf8(file_path)?;
    let normalized = content.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    let Some(heading_idx) = lines.iter().position(|line| {
        let t = line.trim();
        t.eq_ignore_ascii_case("## Description") || t.eq_ignore_ascii_case("## Summary")
    }) else {
        return Ok(false);
    };

    let mut end_idx = heading_idx + 1;
    while end_idx < lines.len() && !lines[end_idx].starts_with("## ") {
        end_idx += 1;
    }

    let mut next_lines: Vec<String> = Vec::new();
    next_lines.extend(lines[..=heading_idx].iter().map(|s| (*s).to_string()));
    next_lines.push(String::new());
    next_lines.push(new_description.trim().to_string());
    next_lines.push(String::new());
    next_lines.extend(lines[end_idx..].iter().map(|s| (*s).to_string()));
    let updated = next_lines.join("\n");

    if updated == normalized {
        return Ok(false);
    }
    folder_write_file(file_path, &updated)?;
    Ok(true)
}

/// Updates the first `# Title` heading line in a markdown file.
pub fn write_summary_to_markdown_file(
    file_path: &Path,
    new_summary: &str,
) -> std::io::Result<bool> {
    let trimmed = new_summary.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let content = read_utf8(file_path)?;
    let mut offset = 0usize;
    let mut updated = None;
    for raw_line in content.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(after_hash) = line.strip_prefix('#')
            && after_hash.starts_with([' ', '\t'])
        {
            let line_start = offset;
            let line_end = offset + line.len();
            let mut next = String::with_capacity(content.len() + trimmed.len());
            next.push_str(&content[..line_start]);
            next.push_str("# ");
            next.push_str(trimmed);
            next.push_str(&content[line_end..]);
            updated = Some(next);
            break;
        }
        offset += raw_line.len() + 1;
    }

    let Some(updated) = updated else {
        return Ok(false);
    };
    if updated == content {
        return Ok(false);
    }
    folder_write_file(file_path, &updated)?;
    Ok(true)
}

/// Updates `## Description` and `## Research Transcript` in an `Idea` markdown file.
pub fn write_idea_transcript_to_markdown_file(
    file_path: &Path,
    new_description: &str,
    new_idea_transcript: &str,
) -> std::io::Result<bool> {
    let content = read_utf8(file_path)?;
    let Some(composed) = compose_idea_content(Some(new_description), Some(new_idea_transcript))
    else {
        return Ok(false);
    };

    let normalized = content.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let desc_idx = lines.iter().position(|line| {
        let t = line.trim();
        t.eq_ignore_ascii_case("## Description") || t.eq_ignore_ascii_case("## Idea Details")
    });
    let transcript_idx = lines.iter().position(|line| {
        let t = line.trim();
        t.eq_ignore_ascii_case("## Research Transcript")
            || t.eq_ignore_ascii_case("## AI Research Transcript")
    });

    if desc_idx.is_none() && transcript_idx.is_none() {
        return Ok(false);
    }

    let mut next_lines: Vec<String> = lines.iter().map(|s| (*s).to_string()).collect();
    let composed_lines: Vec<String> = composed.split('\n').map(ToString::to_string).collect();

    if let (Some(d_idx), Some(t_idx)) = (desc_idx, transcript_idx)
        && t_idx > d_idx
    {
        next_lines.splice(d_idx..t_idx, composed_lines);
    } else if let Some(d_idx) = desc_idx {
        let mut end_idx = d_idx + 1;
        while end_idx < next_lines.len() && !next_lines[end_idx].starts_with("## ") {
            end_idx += 1;
        }
        next_lines.splice(d_idx..end_idx, composed_lines);
    } else if let Some(t_idx) = transcript_idx {
        let mut end_idx = t_idx + 1;
        while end_idx < next_lines.len() && !next_lines[end_idx].starts_with("## ") {
            end_idx += 1;
        }
        next_lines.splice(t_idx..end_idx, composed_lines);
    }

    let updated = next_lines.join("\n");
    if updated == content {
        return Ok(false);
    }
    folder_write_file(file_path, &updated)?;
    Ok(true)
}

/// Updates `**Priority:**` in a markdown file.
pub fn write_priority_to_markdown_file(
    file_path: &Path,
    new_priority: &str,
) -> std::io::Result<bool> {
    let content = read_utf8(file_path)?;
    let Some(updated) = replace_first_bold_line(&content, "Priority", new_priority) else {
        return Ok(false);
    };
    if updated == content {
        return Ok(false);
    }
    folder_write_file(file_path, &updated)?;
    Ok(true)
}

/// Updates or inserts `**Model:**` in a markdown file.
pub fn write_model_to_markdown_file(file_path: &Path, model: &str) -> std::io::Result<bool> {
    let content = read_utf8(file_path)?;
    let updated = if let Some(replaced) = replace_first_bold_line(&content, "Model", model) {
        replaced
    } else {
        let normalized = content.replace("\r\n", "\n");
        let mut lines: Vec<String> = normalized.split('\n').map(ToString::to_string).collect();
        let mut insert_idx = 1usize;
        while insert_idx < lines.len() && lines[insert_idx].trim().is_empty() {
            insert_idx += 1;
        }
        if let Some(status_idx) = lines.iter().position(|l| l.starts_with("**Status:**")) {
            insert_idx = status_idx + 1;
        }
        let idx = insert_idx.min(lines.len());
        lines.insert(idx, format!("**Model:** {model}"));
        lines.join("\n")
    };
    if updated == content {
        return Ok(false);
    }
    folder_write_file(file_path, &updated)?;
    Ok(true)
}

/// Updates `**Severity:**` in a markdown file.
pub fn write_severity_to_markdown_file(
    file_path: &Path,
    new_severity: &str,
) -> std::io::Result<bool> {
    let content = read_utf8(file_path)?;
    let Some(updated) = replace_first_bold_line(&content, "Severity", new_severity) else {
        return Ok(false);
    };
    if updated == content {
        return Ok(false);
    }
    folder_write_file(file_path, &updated)?;
    Ok(true)
}

/// Updates `**Reported By:**` in a markdown file.
pub fn write_reported_by_to_markdown_file(
    file_path: &Path,
    new_reported_by: &str,
) -> std::io::Result<bool> {
    let content = read_utf8(file_path)?;
    let Some(updated) = replace_first_bold_line(&content, "Reported By", new_reported_by) else {
        return Ok(false);
    };
    if updated == content {
        return Ok(false);
    }
    folder_write_file(file_path, &updated)?;
    Ok(true)
}

/// Upgrades a markdown issue file to the current template format (`ensure_front_matter`).
pub fn upgrade_markdown_file(file_path: &Path, issue_type_raw: &str) -> std::io::Result<bool> {
    let Some(issue_type) = IssueType::parse_loose(issue_type_raw) else {
        return Ok(false);
    };
    let raw = read_utf8(file_path)?;
    let updated = ensure_front_matter(&raw, issue_type);
    if updated == raw {
        return Ok(false);
    }
    folder_write_file(file_path, &updated)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folder::markdown_plan_parser::extract_status_raw;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn with_feature_file<F: FnOnce(&Path)>(content: &str, run: F) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir: PathBuf = std::env::temp_dir().join(format!("praxis-status-writer-{nanos}"));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let file = dir.join("feature.md");
        std::fs::write(&file, content).expect("write");
        run(&file);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_feature_story_table_matches_story_name_with_regex_chars_literally() {
        let table = [
            "| Story | Name | Status |",
            "| --- | --- | --- |",
            "| 01.2 | Fix (legacy) parser+ | 📋 Proposed |",
            "",
        ]
        .join("\n");
        with_feature_file(&table, |file| {
            assert!(
                update_feature_story_table(file, 2, "Fix (legacy) parser+", "Done")
                    .expect("update")
            );
            let updated = std::fs::read_to_string(file).expect("read");
            assert!(updated.contains("| 01.2 | Fix (legacy) parser+ | ✅ Complete |"));
        });
    }

    #[test]
    fn update_feature_story_table_leaves_row_alone_when_name_only_matches_as_pattern() {
        let table = [
            "| Story | Name | Status |",
            "| --- | --- | --- |",
            "| 01.2 | abc | 📋 Proposed |",
            "",
        ]
        .join("\n");
        with_feature_file(&table, |file| {
            assert!(!update_feature_story_table(file, 2, "a.c", "Done").expect("update"));
            let updated = std::fs::read_to_string(file).expect("read");
            assert!(updated.contains("📋 Proposed"));
        });
    }

    #[test]
    fn write_status_to_markdown_file_moves_front_matter_status_and_bold_line() {
        let doc = [
            "---",
            "**Status:** 🔄 In Progress",
            "**Type:** Story",
            "id: FX-BE-184",
            "status: To Do",
            "priority: High",
            "---",
            "",
            "# FX-BE-184: Release proof",
            "",
            "status: prose that is not front matter",
            "",
        ]
        .join("\n");
        with_feature_file(&doc, |file| {
            assert!(write_status_to_markdown_file(file, "Done").expect("write status"));
            let written = std::fs::read_to_string(file).expect("read");
            assert!(written.contains("**Status:** ✅ Complete"));
            assert!(written.contains("\nstatus: Done\n"));
            assert!(written.contains("\nstatus: prose that is not front matter\n"));
            assert_eq!(extract_status_raw(&written), "Done");
        });
    }

    #[test]
    fn write_status_keeps_quoted_front_matter_status_quoted() {
        let doc = [
            "---",
            "status: \"To Do\"",
            "---",
            "**Status:** 📋 To Do",
            "",
        ]
        .join("\n");
        with_feature_file(&doc, |file| {
            assert!(write_status_to_markdown_file(file, "In Progress").expect("write"));
            let written = std::fs::read_to_string(file).expect("read");
            assert!(written.contains("status: \"In Progress\""));
        });
    }
}
