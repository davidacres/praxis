//! What a session changed on disk, for the phone (`apps/praxis-desktop/main/src/main/mobileSessionChanges.ts`
//! port): the working-tree view the desktop's Changes tab reads, reduced to relative paths and a
//! bounded diff. The repository path itself never leaves the desktop.
//!
//! Git is reached through [`MobileSessionChangesGit`] (the host's git service), using
//! `praxis-core`'s status and diff types.

use std::collections::HashSet;

use async_trait::async_trait;
use praxis_core::git::{
    GitChangedFile, GitComparisonKind, GitDiffDocument, GitDiffLineKind, GitDiffRequest,
    GitStatusSnapshot,
};
use serde::{Deserialize, Serialize};

use super::session_record::{MobileSessionEventRecord, MobileSessionRecord};

/// A phone reads a diff, it does not page through a generated file.
pub const MAX_MOBILE_DIFF_LINES: usize = 600;

#[async_trait]
pub trait MobileSessionChangesGit: Send + Sync {
    async fn status(&self, repository_path: &str) -> Result<GitStatusSnapshot, String>;
    async fn comparison(
        &self,
        repository_path: &str,
        request: GitDiffRequest,
    ) -> Result<GitDiffDocument, String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileChangedFile {
    pub path: String,
    /// `added` | `modified` | `deleted` | `renamed` | `conflicted`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
    /// The session's own tools reported editing it; other changes were already in the tree.
    pub reported_by_session: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSessionChanges {
    pub session_id: String,
    /// False when the session's folder is not a git repository — nothing to compare.
    pub repository: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub files: Vec<MobileChangedFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDiffLine {
    /// `context` | `add` | `delete`.
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_line: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_line: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MobileDiffHunk {
    pub header: String,
    pub lines: Vec<MobileDiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MobileFileDiff {
    pub path: String,
    pub binary: bool,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<MobileDiffHunk>,
    /// Lines were dropped to stay within the phone's bound.
    pub truncated: bool,
}

/// The session's own repository: its worktree when it ran in one, otherwise its working folder.
pub fn session_repository_path(record: &MobileSessionRecord) -> Option<String> {
    [&record.worktree_path, &record.working_directory]
        .into_iter()
        .filter_map(|path| path.as_deref().map(str::trim))
        .find(|path| !path.is_empty())
        .map(str::to_owned)
}

/// Repo-relative paths this session's tools reported writing (`reportedSessionPaths` in
/// `packages/core/src/ai/agentEventUtils.ts`). A path that cannot be mapped into the repository
/// is left out rather than guessed at.
pub fn reported_session_paths(
    events: &[MobileSessionEventRecord],
    repository_path: &str,
) -> HashSet<String> {
    let to_posix = |value: &str| value.replace('\\', "/");
    let is_absolute = |value: &str| {
        value.starts_with('/') || {
            let bytes = value.as_bytes();
            bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && bytes[2] == b'/'
        }
    };
    let root = to_posix(repository_path).trim_end_matches('/').to_owned();
    let mut paths = HashSet::new();
    for event in events.iter().filter(|e| e.kind == "tool_complete") {
        let changes = event
            .data
            .as_ref()
            .and_then(|data| data.get("fileChanges"))
            .and_then(|changes| changes.as_array());
        for change in changes.into_iter().flatten() {
            let reported = to_posix(change.get("path").and_then(|p| p.as_str()).unwrap_or(""));
            let reported = reported.trim();
            if reported.is_empty() {
                continue;
            }
            if let Some(relative) = (!root.is_empty())
                .then(|| reported.strip_prefix(&format!("{root}/")))
                .flatten()
            {
                paths.insert(relative.to_owned());
            } else if !is_absolute(reported) {
                paths.insert(reported.strip_prefix("./").unwrap_or(reported).to_owned());
            }
        }
    }
    paths
}

fn file_status(file: &GitChangedFile) -> &'static str {
    if file.conflicted == Some(true) {
        return "conflicted";
    }
    let code = if file.worktree_status.is_empty() {
        file.index_status.trim()
    } else {
        file.worktree_status.trim()
    };
    match code {
        "?" | "??" | "A" => "added",
        "D" => "deleted",
        "R" => "renamed",
        _ => "modified",
    }
}

pub async fn read_mobile_session_changes(
    record: &MobileSessionRecord,
    git: &dyn MobileSessionChangesGit,
) -> MobileSessionChanges {
    let nothing = || MobileSessionChanges {
        session_id: record.session_id.clone(),
        repository: false,
        branch: None,
        files: Vec::new(),
    };
    let Some(repository_path) = session_repository_path(record) else {
        return nothing();
    };
    // Not a git repository is an ordinary case, not an error worth failing the read.
    let Ok(status) = git.status(&repository_path).await else {
        return nothing();
    };
    let reported = reported_session_paths(&record.events, &repository_path);
    let mut files: Vec<MobileChangedFile> = status
        .files
        .iter()
        .map(|file| MobileChangedFile {
            path: file.path.clone(),
            status: file_status(file).to_owned(),
            additions: file.additions,
            deletions: file.deletions,
            reported_by_session: reported.contains(&file.path),
        })
        .collect();
    // The session's own edits first, then anything else that was already in the tree.
    files.sort_by(|left, right| {
        right
            .reported_by_session
            .cmp(&left.reported_by_session)
            // An approximation of `localeCompare`: case-insensitive first.
            .then_with(|| left.path.to_lowercase().cmp(&right.path.to_lowercase()))
            .then_with(|| left.path.cmp(&right.path))
    });
    MobileSessionChanges {
        session_id: record.session_id.clone(),
        repository: true,
        branch: status.branch.filter(|b| !b.is_empty()),
        files,
    }
}

/// One file's diff. The path must be one `git status` reports for the session's repository: a
/// phone can ask to see a change, never to read an arbitrary file.
pub async fn read_mobile_session_file_diff(
    record: &MobileSessionRecord,
    path: &str,
    git: &dyn MobileSessionChangesGit,
    max_lines: usize,
) -> Result<MobileFileDiff, String> {
    let Some(repository_path) = session_repository_path(record) else {
        return Err("This session’s folder is not a git repository.".to_owned());
    };
    let status = git.status(&repository_path).await?;
    let Some(file) = status.files.iter().find(|candidate| candidate.path == path) else {
        return Err(format!(
            "{path} has no uncommitted change in this session’s working tree."
        ));
    };
    let request = GitDiffRequest {
        kind: if file.staged {
            GitComparisonKind::Staged
        } else {
            GitComparisonKind::Working
        },
        left: None,
        right: None,
        path: Some(path.to_owned()),
        context_lines: None,
        ignore_whitespace: None,
    };
    let document = git.comparison(&repository_path, request).await?;
    let Some(diff) = document
        .files
        .iter()
        .find(|entry| entry.display_path == path)
        .or_else(|| document.files.first())
    else {
        return Ok(MobileFileDiff {
            path: path.to_owned(),
            binary: false,
            additions: file.additions.unwrap_or(0),
            deletions: file.deletions.unwrap_or(0),
            hunks: Vec::new(),
            truncated: false,
        });
    };
    let mut budget = max_lines;
    let mut truncated = false;
    let mut hunks = Vec::new();
    for hunk in &diff.hunks {
        if budget == 0 {
            truncated = true;
            break;
        }
        let mut lines = Vec::new();
        for line in &hunk.lines {
            let kind = match line.kind {
                GitDiffLineKind::Notice => continue,
                GitDiffLineKind::Addition => "add",
                GitDiffLineKind::Deletion => "delete",
                GitDiffLineKind::Context => "context",
            };
            if budget == 0 {
                truncated = true;
                break;
            }
            budget -= 1;
            lines.push(MobileDiffLine {
                kind: kind.to_owned(),
                text: line.content.clone(),
                old_line: line.old_line_number,
                new_line: line.new_line_number,
            });
        }
        hunks.push(MobileDiffHunk {
            header: hunk.header.clone(),
            lines,
        });
    }
    Ok(MobileFileDiff {
        path: path.to_owned(),
        binary: diff.is_binary,
        additions: diff.additions,
        deletions: diff.deletions,
        hunks,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::session_record::MobileTaskDefinition;
    use praxis_core::git::{GitDiffFile, GitDiffFileStatus, GitDiffHunk, GitDiffLine};
    use serde_json::json;
    use std::sync::Mutex;

    fn record() -> MobileSessionRecord {
        let mut edit =
            MobileSessionEventRecord::new("2026-09-22T09:00:00.000Z", "tool_complete", "edit");
        edit.data = Some(json!({ "fileChanges": [{ "path": "/repo/src/b.ts" }] }));
        MobileSessionRecord {
            issue_key: "S-1".into(),
            session_id: "s1".into(),
            state: "completed".into(),
            task_definition: MobileTaskDefinition { goal: "x".into() },
            working_directory: Some("/repo".into()),
            events: vec![edit],
            ..MobileSessionRecord::default()
        }
    }

    fn changed(
        path: &str,
        worktree: &str,
        additions: Option<usize>,
        deletions: Option<usize>,
    ) -> GitChangedFile {
        GitChangedFile {
            path: path.into(),
            index_status: if worktree == "?" {
                "?".into()
            } else {
                " ".into()
            },
            worktree_status: worktree.into(),
            staged: false,
            conflicted: None,
            additions,
            deletions,
        }
    }

    struct FakeGit {
        lines: usize,
        requested: Mutex<Vec<String>>,
        broken: bool,
    }

    impl FakeGit {
        fn new(lines: usize) -> Self {
            Self {
                lines,
                requested: Mutex::new(Vec::new()),
                broken: false,
            }
        }
    }

    #[async_trait]
    impl MobileSessionChangesGit for FakeGit {
        async fn status(&self, _: &str) -> Result<GitStatusSnapshot, String> {
            if self.broken {
                return Err("not a git repository".into());
            }
            Ok(GitStatusSnapshot {
                repository_path: "/repo".into(),
                branch: Some("main".into()),
                ahead: 0,
                behind: 0,
                files: vec![
                    changed("README.md", "M", Some(1), Some(1)),
                    changed("src/b.ts", "M", Some(3), Some(0)),
                    changed("src/new.ts", "?", None, None),
                ],
                operation: None,
            })
        }

        async fn comparison(
            &self,
            _: &str,
            request: GitDiffRequest,
        ) -> Result<GitDiffDocument, String> {
            let path = request.path.clone().unwrap_or_default();
            self.requested.lock().expect("requested").push(path.clone());
            Ok(GitDiffDocument {
                title: String::new(),
                subtitle: String::new(),
                generated_at: "2026-09-22T09:00:00.000Z".into(),
                additions: self.lines,
                deletions: 0,
                files: vec![GitDiffFile {
                    id: "f".into(),
                    old_path: None,
                    new_path: None,
                    display_path: path,
                    status: GitDiffFileStatus::Modified,
                    additions: self.lines,
                    deletions: 0,
                    is_binary: false,
                    hunks: vec![GitDiffHunk {
                        id: "h".into(),
                        header: "@@ -1 +1,3 @@".into(),
                        old_start: 1,
                        old_lines: 1,
                        new_start: 1,
                        new_lines: self.lines,
                        patch: String::new(),
                        lines: (0..self.lines)
                            .map(|index| GitDiffLine {
                                kind: GitDiffLineKind::Addition,
                                content: format!("line {index}"),
                                old_line_number: None,
                                new_line_number: Some(index + 1),
                            })
                            .collect(),
                    }],
                }],
                request,
            })
        }
    }

    #[tokio::test]
    async fn lists_relative_paths_with_the_sessions_own_edits_first() {
        let changes = read_mobile_session_changes(&record(), &FakeGit::new(3)).await;
        assert!(changes.repository);
        let shape: Vec<(String, String, bool)> = changes
            .files
            .iter()
            .map(|f| (f.path.clone(), f.status.clone(), f.reported_by_session))
            .collect();
        assert_eq!(
            shape,
            vec![
                ("src/b.ts".into(), "modified".into(), true),
                ("README.md".into(), "modified".into(), false),
                ("src/new.ts".into(), "added".into(), false),
            ]
        );
    }

    #[tokio::test]
    async fn a_folder_that_is_not_a_repository_reads_as_nothing_to_compare() {
        let git = FakeGit {
            broken: true,
            ..FakeGit::new(0)
        };
        let changes = read_mobile_session_changes(&record(), &git).await;
        assert_eq!(
            serde_json::to_value(&changes).expect("json"),
            json!({ "sessionId": "s1", "repository": false, "files": [] })
        );
    }

    #[tokio::test]
    async fn a_diff_is_served_only_for_a_listed_path_and_bounded() {
        let git = FakeGit::new(10);
        let refused = read_mobile_session_file_diff(&record(), "../../etc/passwd", &git, 600).await;
        assert!(
            refused
                .expect_err("refused")
                .contains("no uncommitted change")
        );
        assert!(git.requested.lock().expect("requested").is_empty());
        let diff = read_mobile_session_file_diff(&record(), "src/b.ts", &git, 4)
            .await
            .expect("diff");
        assert!(diff.truncated);
        assert_eq!(diff.hunks[0].lines.len(), 4);
        assert_eq!(
            serde_json::to_value(&diff.hunks[0].lines[0]).expect("json"),
            json!({ "kind": "add", "text": "line 0", "newLine": 1 })
        );
    }

    #[test]
    fn reported_paths_map_into_the_repository_or_are_dropped() {
        let mut event = MobileSessionEventRecord::new("t", "tool_complete", "edit");
        event.data = Some(json!({ "fileChanges": [
            { "path": "/repo/a.ts" }, { "path": "./b.ts" }, { "path": "c\\d.ts" },
            { "path": "/elsewhere/e.ts" }, { "path": "C:/x.ts" }, { "path": "  " }
        ] }));
        let mut paths: Vec<String> = reported_session_paths(&[event], "/repo/")
            .into_iter()
            .collect();
        paths.sort();
        assert_eq!(paths, vec!["a.ts", "b.ts", "c/d.ts"]);
    }
}
