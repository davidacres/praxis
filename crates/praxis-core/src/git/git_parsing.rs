//! Parsers for structured Git CLI output (`gitParsing.ts`).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::git_graph::{
    GitBranchInfo, GitChangedFile, GitCommitInput, GitDiffFile, GitDiffFileStatus, GitDiffHunk,
    GitDiffLine, GitDiffLineKind, GitStatusSnapshot,
};

/// Parsed tag reference (`{ name, tip }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTagRef {
    pub name: String,
    pub tip: String,
}

/// Parsed commit log record including commit body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogRecord {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub date: String,
    pub message: String,
    pub body: String,
}

impl From<&GitLogRecord> for GitCommitInput {
    fn from(record: &GitLogRecord) -> Self {
        Self {
            hash: record.hash.clone(),
            parents: record.parents.clone(),
            author: record.author.clone(),
            date: record.date.clone(),
            message: record.message.clone(),
            body: Some(record.body.clone()),
        }
    }
}

/// Parses `git for-each-ref` output for local (`refs/heads/*`) and remote (`refs/remotes/*`) branches.
#[must_use]
pub fn parse_git_branches(raw: &str) -> Vec<GitBranchInfo> {
    raw.split('\n')
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let ref_name = parts.next().unwrap_or("");
            let tip = parts.next().unwrap_or("");
            let head = parts.next().unwrap_or("");
            let upstream = parts.next().unwrap_or("");

            if ref_name.is_empty()
                || tip.is_empty()
                || (!ref_name.starts_with("refs/heads/") && !ref_name.starts_with("refs/remotes/"))
            {
                return None;
            }
            let is_remote = ref_name.starts_with("refs/remotes/");
            let name = ref_name
                .strip_prefix("refs/heads/")
                .or_else(|| ref_name.strip_prefix("refs/remotes/"))
                .unwrap_or(ref_name)
                .to_string();

            Some(GitBranchInfo {
                name,
                ref_name: ref_name.to_string(),
                tip: tip.to_string(),
                is_remote,
                is_current: head == "*",
                upstream: if upstream.is_empty() {
                    None
                } else {
                    Some(upstream.to_string())
                },
            })
        })
        .collect()
}

/// Parses `git for-each-ref` output for tags.
#[must_use]
pub fn parse_git_tags(raw: &str) -> Vec<GitTagRef> {
    raw.split('\n')
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let name = parts.next().unwrap_or("");
            let tip = parts.next().unwrap_or("");
            if name.is_empty() || tip.is_empty() {
                None
            } else {
                Some(GitTagRef {
                    name: name.to_string(),
                    tip: tip.to_string(),
                })
            }
        })
        .collect()
}

/// Parses `git log` records delimited by `\x1e` and fields delimited by `\0`.
#[must_use]
pub fn parse_git_log(raw: &str) -> Vec<GitLogRecord> {
    raw.split('\x1e')
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let trimmed = record.trim_start_matches(['\r', '\n']);
            let mut parts = trimmed.split('\0');
            let hash = parts.next().unwrap_or("");
            let parents_raw = parts.next().unwrap_or("");
            let author = parts.next().unwrap_or("");
            let date = parts.next().unwrap_or("");
            let message_raw = parts.next();
            let body_raw = parts.next();

            if hash.is_empty() || author.is_empty() || date.is_empty() {
                return None;
            }

            let parents: Vec<String> = if parents_raw.is_empty() {
                vec![]
            } else {
                parents_raw
                    .split(' ')
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string)
                    .collect()
            };

            let msg_trimmed = message_raw.map(str::trim).unwrap_or("");
            let body_trimmed = body_raw.map(str::trim).unwrap_or("");
            let message = if !msg_trimmed.is_empty() {
                msg_trimmed.to_string()
            } else if !body_trimmed.is_empty() {
                body_trimmed.to_string()
            } else {
                "(no message)".to_string()
            };

            Some(GitLogRecord {
                hash: hash.to_string(),
                parents,
                author: author.to_string(),
                date: date.to_string(),
                message,
                body: body_trimmed.to_string(),
            })
        })
        .collect()
}

/// Parses `git status --porcelain=v1 -z` output into a [`GitStatusSnapshot`].
#[must_use]
pub fn parse_git_status(
    raw: &str,
    repository_path: &str,
    branch: Option<String>,
) -> GitStatusSnapshot {
    let mut files = Vec::new();
    let records: Vec<&str> = raw.split('\0').filter(|r| !r.is_empty()).collect();
    let mut index = 0;

    while index < records.len() {
        let record = records[index];
        // Support both `XY path\0` and legacy split `XY\0path\0` test fixture shapes.
        let split_shape = record.chars().count() == 2 && index + 1 < records.len();
        let (status, file_path) = if split_shape {
            index += 1;
            (record, records[index])
        } else {
            let mut chars = record.char_indices();
            let _c0 = chars.next();
            let _c1 = chars.next();
            let c2 = chars.next();
            let status_slice = match c2 {
                Some((byte_idx, _)) => &record[..byte_idx],
                None => record,
            };
            let path_slice = match chars.next() {
                Some((byte_idx, _)) => &record[byte_idx..],
                None => "",
            };
            (status_slice, path_slice)
        };

        if file_path.is_empty() || status.chars().count() < 2 {
            index += 1;
            continue;
        }

        let mut status_chars = status.chars();
        let idx_char = status_chars.next().unwrap_or(' ');
        let wt_char = status_chars.next().unwrap_or(' ');

        let conflicted = matches!(status, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU");

        files.push(GitChangedFile {
            path: file_path.to_string(),
            index_status: idx_char.to_string(),
            worktree_status: wt_char.to_string(),
            staged: !conflicted && idx_char != ' ' && idx_char != '?',
            conflicted: Some(conflicted),
            additions: None,
            deletions: None,
        });

        // Rename/copy records include the original path as the following NUL record.
        if !split_shape && (idx_char == 'R' || idx_char == 'C') && index + 1 < records.len() {
            index += 1;
        }

        index += 1;
    }

    GitStatusSnapshot {
        repository_path: repository_path.to_string(),
        branch,
        ahead: 0,
        behind: 0,
        files,
        operation: None,
    }
}

fn normalize_diff_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let unquoted = trimmed
        .strip_prefix('"')
        .unwrap_or(trimmed)
        .strip_suffix('"')
        .unwrap_or_else(|| trimmed.strip_prefix('"').unwrap_or(trimmed));
    if unquoted.is_empty() || unquoted == "/dev/null" {
        return None;
    }
    let stripped = unquoted
        .strip_prefix("a/")
        .or_else(|| unquoted.strip_prefix("b/"))
        .unwrap_or(unquoted);
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_string())
    }
}

fn status_from_headers(
    headers: &[&str],
    old_path: Option<&str>,
    new_path: Option<&str>,
) -> GitDiffFileStatus {
    if headers
        .iter()
        .any(|line| line.starts_with("Binary files ") || line.starts_with("GIT binary patch"))
    {
        return GitDiffFileStatus::Binary;
    }
    if headers
        .iter()
        .any(|line| line.starts_with("new file mode "))
        || (old_path.is_none() && new_path.is_some())
    {
        return GitDiffFileStatus::Added;
    }
    if headers
        .iter()
        .any(|line| line.starts_with("deleted file mode "))
        || (old_path.is_some() && new_path.is_none())
    {
        return GitDiffFileStatus::Deleted;
    }
    if headers.iter().any(|line| line.starts_with("rename from ")) {
        return GitDiffFileStatus::Renamed;
    }
    if headers.iter().any(|line| line.starts_with("copy from ")) {
        return GitDiffFileStatus::Copied;
    }
    if old_path.is_some() || new_path.is_some() {
        GitDiffFileStatus::Modified
    } else {
        GitDiffFileStatus::Unknown
    }
}

fn parse_hunk_header_numbers(header: &str) -> Option<(usize, usize, usize, usize)> {
    let rest = header.strip_prefix("@@ -")?;
    let end_idx = rest.find(" @@")?;
    let coords = &rest[..end_idx];
    let (old_part, new_part) = coords.split_once(" +")?;

    let parse_range = |part: &str| -> Option<(usize, usize)> {
        if let Some((start_str, count_str)) = part.split_once(',') {
            Some((start_str.parse().ok()?, count_str.parse().ok()?))
        } else {
            Some((part.parse().ok()?, 1))
        }
    };

    let (old_start, old_lines) = parse_range(old_part)?;
    let (new_start, new_lines) = parse_range(new_part)?;
    Some((old_start, old_lines, new_start, new_lines))
}

fn parse_hunk(
    header: &str,
    body: &[&str],
    file_header: &str,
    file_index: usize,
    hunk_index: usize,
) -> Option<GitDiffHunk> {
    let (old_start, old_lines, new_start, new_lines) = parse_hunk_header_numbers(header)?;
    let mut old_line = old_start;
    let mut new_line = new_start;

    let lines: Vec<GitDiffLine> = body
        .iter()
        .map(|raw_line| {
            if let Some(content) = raw_line.strip_prefix('+') {
                let ln = new_line;
                new_line += 1;
                GitDiffLine {
                    kind: GitDiffLineKind::Addition,
                    content: content.to_string(),
                    old_line_number: None,
                    new_line_number: Some(ln),
                }
            } else if let Some(content) = raw_line.strip_prefix('-') {
                let ln = old_line;
                old_line += 1;
                GitDiffLine {
                    kind: GitDiffLineKind::Deletion,
                    content: content.to_string(),
                    old_line_number: Some(ln),
                    new_line_number: None,
                }
            } else if let Some(content) = raw_line.strip_prefix(' ') {
                let old_ln = old_line;
                let new_ln = new_line;
                old_line += 1;
                new_line += 1;
                GitDiffLine {
                    kind: GitDiffLineKind::Context,
                    content: content.to_string(),
                    old_line_number: Some(old_ln),
                    new_line_number: Some(new_ln),
                }
            } else {
                GitDiffLine {
                    kind: GitDiffLineKind::Notice,
                    content: (*raw_line).to_string(),
                    old_line_number: None,
                    new_line_number: None,
                }
            }
        })
        .collect();

    Some(GitDiffHunk {
        id: format!("file-{file_index}-hunk-{hunk_index}"),
        header: header.to_string(),
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines,
        patch: format!("{file_header}{header}\n{}\n", body.join("\n")),
    })
}

fn parse_diff_git_header_paths(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("diff --git ")?;
    if let Some(quoted) = rest.strip_prefix("\"a/") {
        let (a_path, tail) = quoted.split_once("\" ")?;
        let b_path = tail
            .strip_prefix("\"b/")
            .and_then(|s| s.strip_suffix('"'))
            .or_else(|| tail.strip_prefix("b/"))?;
        return Some((a_path.to_string(), b_path.to_string()));
    }
    let a_rest = rest.strip_prefix("a/")?;
    if let Some((a_path, b_path)) = a_rest.split_once(" \"b/") {
        let clean_b = b_path.strip_suffix('"').unwrap_or(b_path);
        return Some((a_path.to_string(), clean_b.to_string()));
    }
    let (a_path, b_path) = a_rest.split_once(" b/")?;
    Some((a_path.to_string(), b_path.to_string()))
}

/// Parses the unified patch emitted by Git into a renderer-safe document model.
#[must_use]
pub fn parse_git_diff(raw: &str) -> Vec<GitDiffFile> {
    if raw.trim().is_empty() {
        return vec![];
    }
    let normalized = raw.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let starts: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(idx, line)| {
            if line.starts_with("diff --git ") {
                Some(idx)
            } else {
                None
            }
        })
        .collect();

    starts
        .iter()
        .enumerate()
        .filter_map(|(file_index, &start)| {
            let end = starts.get(file_index + 1).copied().unwrap_or(lines.len());
            let section = &lines[start..end];
            let first_hunk = section.iter().position(|line| line.starts_with("@@ "));
            let header_end = first_hunk.unwrap_or(section.len());
            let headers = &section[..header_end];

            let minus_header = headers.iter().copied().find(|l| l.starts_with("--- "));
            let plus_header = headers.iter().copied().find(|l| l.starts_with("+++ "));
            let rename_from = headers
                .iter()
                .copied()
                .find(|l| l.starts_with("rename from "));
            let rename_to = headers
                .iter()
                .copied()
                .find(|l| l.starts_with("rename to "));
            let diff_paths = headers
                .first()
                .and_then(|first| parse_diff_git_header_paths(first));

            let old_raw = rename_from
                .and_then(|s| s.get(12..))
                .or_else(|| minus_header.and_then(|s| s.get(4..)))
                .or_else(|| diff_paths.as_ref().map(|(a, _)| a.as_str()))
                .unwrap_or("");
            let new_raw = rename_to
                .and_then(|s| s.get(10..))
                .or_else(|| plus_header.and_then(|s| s.get(4..)))
                .or_else(|| diff_paths.as_ref().map(|(_, b)| b.as_str()))
                .unwrap_or("");

            let old_path = normalize_diff_path(old_raw);
            let new_path = normalize_diff_path(new_raw);
            let display_path = new_path.clone().or_else(|| old_path.clone())?;

            let file_header = format!("{}\n", headers.join("\n"));
            let mut hunks = Vec::new();
            if let Some(mut cursor) = first_hunk {
                while cursor < section.len() {
                    let header = section[cursor];
                    if !header.starts_with("@@ ") {
                        cursor += 1;
                        continue;
                    }
                    let mut next = cursor + 1;
                    while next < section.len() && !section[next].starts_with("@@ ") {
                        next += 1;
                    }
                    let raw_body = &section[cursor + 1..next];
                    let body: Vec<&str> = raw_body
                        .iter()
                        .enumerate()
                        .filter_map(|(idx, &line)| {
                            if idx + 1 < raw_body.len() || !line.is_empty() {
                                Some(line)
                            } else {
                                None
                            }
                        })
                        .collect();

                    if let Some(hunk) =
                        parse_hunk(header, &body, &file_header, file_index, hunks.len())
                    {
                        hunks.push(hunk);
                    }
                    cursor = next;
                }
            }

            let additions: usize = hunks
                .iter()
                .map(|h| {
                    h.lines
                        .iter()
                        .filter(|l| l.kind == GitDiffLineKind::Addition)
                        .count()
                })
                .sum();
            let deletions: usize = hunks
                .iter()
                .map(|h| {
                    h.lines
                        .iter()
                        .filter(|l| l.kind == GitDiffLineKind::Deletion)
                        .count()
                })
                .sum();
            let status = status_from_headers(headers, old_path.as_deref(), new_path.as_deref());

            Some(GitDiffFile {
                id: format!("file-{file_index}"),
                old_path,
                new_path,
                display_path,
                status,
                additions,
                deletions,
                is_binary: status == GitDiffFileStatus::Binary,
                hunks,
            })
        })
        .collect()
}

/// Builds an applicable patch containing only selected added/removed lines from one parsed hunk.
#[must_use]
pub fn build_partial_hunk_patch(hunk: &GitDiffHunk, selected_indexes: &[usize]) -> String {
    let selected: HashSet<usize> = selected_indexes.iter().copied().collect();
    let file_header = hunk
        .patch
        .find(&hunk.header)
        .map_or("", |idx| &hunk.patch[..idx]);

    let mut body = Vec::new();
    for (index, line) in hunk.lines.iter().enumerate() {
        match line.kind {
            GitDiffLineKind::Context => body.push(format!(" {}", line.content)),
            GitDiffLineKind::Notice => body.push(line.content.clone()),
            GitDiffLineKind::Addition => {
                if selected.contains(&index) {
                    body.push(format!("+{}", line.content));
                }
            }
            GitDiffLineKind::Deletion => {
                if selected.contains(&index) {
                    body.push(format!("-{}", line.content));
                } else {
                    body.push(format!(" {}", line.content));
                }
            }
        }
    }

    let old_lines = body
        .iter()
        .filter(|line| line.starts_with(' ') || line.starts_with('-'))
        .count();
    let new_lines = body
        .iter()
        .filter(|line| line.starts_with(' ') || line.starts_with('+'))
        .count();

    let suffix = hunk
        .header
        .strip_prefix("@@")
        .and_then(|rest| rest.find("@@").map(|idx| &rest[idx + 2..]))
        .unwrap_or("");

    let header = format!(
        "@@ -{},{} +{},{} @@{}",
        hunk.old_start, old_lines, hunk.new_start, new_lines, suffix
    );
    format!("{file_header}{header}\n{}\n", body.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_structured_local_remote_and_tag_refs_while_ignoring_malformed_records() {
        let branches = parse_git_branches(
            "refs/heads/main\0abc\0*\0\nmalformed\nrefs/remotes/origin/main\0def\0\0refs/remotes/origin/main\n",
        );
        assert_eq!(branches.len(), 2);
        assert!(branches[0].is_current);
        assert!(branches[1].is_remote);
        assert_eq!(
            parse_git_tags("v1.0\0abc\ninvalid\n"),
            vec![GitTagRef {
                name: "v1.0".to_string(),
                tip: "abc".to_string()
            }]
        );
    }

    #[test]
    fn parses_status_paths_and_safely_skips_malformed_log_records() {
        let status = parse_git_status(
            " M src/file.ts\0A  new.ts\0R  src/new-name.ts\0src/old-name.ts\0",
            "/repo",
            Some("main".to_string()),
        );
        assert_eq!(status.files.len(), 3);
        assert!(!status.files[0].staged);
        assert!(status.files[1].staged);
        assert_eq!(status.files[2].path, "src/new-name.ts");

        let log = parse_git_log("bad\x1e\nabc\0base\0A\x002026-01-01T00:00:00Z\0message\0body\x1e");
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].parents, vec!["base".to_string()]);
    }

    #[test]
    fn parses_additions_deletions_context_renames_and_self_contained_hunk_patches() {
        let files = parse_git_diff(
            &[
                "diff --git a/src/old.ts b/src/new.ts",
                "similarity index 80%",
                "rename from src/old.ts",
                "rename to src/new.ts",
                "index 1111111..2222222 100644",
                "--- a/src/old.ts",
                "+++ b/src/new.ts",
                "@@ -1,3 +1,3 @@",
                " const stable = true;",
                "-const oldName = 1;",
                "+const newName = 2;",
                " export { stable };",
                "",
            ]
            .join("\n"),
        );

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, GitDiffFileStatus::Renamed);
        assert_eq!(files[0].display_path, "src/new.ts");
        assert_eq!(files[0].additions, 1);
        assert_eq!(files[0].deletions, 1);
        assert_eq!(
            files[0].hunks[0].lines[1],
            GitDiffLine {
                kind: GitDiffLineKind::Deletion,
                content: "const oldName = 1;".to_string(),
                old_line_number: Some(2),
                new_line_number: None,
            }
        );
        assert!(
            files[0].hunks[0]
                .patch
                .contains("diff --git a/src/old.ts b/src/new.ts")
        );
        assert!(files[0].hunks[0].patch.contains("@@ -1,3 +1,3 @@"));

        let partial = build_partial_hunk_patch(&files[0].hunks[0], &[2]);
        assert!(partial.contains("+const newName = 2;"));
        assert!(!partial.contains("-const oldName = 1;"));
        assert!(partial.contains(" const oldName = 1;"));
    }

    #[test]
    fn parses_added_deleted_and_binary_files_without_inventing_hunks() {
        let files = parse_git_diff(
            &[
                "diff --git a/new.txt b/new.txt",
                "new file mode 100644",
                "--- /dev/null",
                "+++ b/new.txt",
                "@@ -0,0 +1 @@",
                "+hello",
                "diff --git a/old.txt b/old.txt",
                "deleted file mode 100644",
                "--- a/old.txt",
                "+++ /dev/null",
                "@@ -1 +0,0 @@",
                "-gone",
                "diff --git a/logo.png b/logo.png",
                "index 1234567..abcdef0 100644",
                "Binary files a/logo.png and b/logo.png differ",
                "",
            ]
            .join("\n"),
        );

        let statuses: Vec<GitDiffFileStatus> = files.iter().map(|f| f.status).collect();
        assert_eq!(
            statuses,
            vec![
                GitDiffFileStatus::Added,
                GitDiffFileStatus::Deleted,
                GitDiffFileStatus::Binary
            ]
        );
        assert_eq!(files[2].hunks.len(), 0);
        assert!(files[2].is_binary);
    }
}
