//! Git commit graph models, diff/status snapshots, and topological lane layout (`gitGraph.ts`).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// Input commit record before topological graph layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitInput {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub date: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// Commit node enriched with lane assignment, children, refs, and branch hints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitNode {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub children: Vec<String>,
    pub author: String,
    pub date: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub branch_hints: Vec<String>,
    pub refs: Vec<String>,
    pub lane: usize,
    pub is_merge: bool,
    pub is_divergence: bool,
    pub is_convergence: bool,
}

/// Local or remote branch reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub name: String,
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub tip: String,
    pub is_remote: bool,
    pub is_current: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
}

/// Complete snapshot of a Git repository's commits, branches, and tags.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositorySnapshot {
    pub repository_path: String,
    pub repository_name: String,
    pub head: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_branch: Option<String>,
    pub branches: Vec<GitBranchInfo>,
    pub tags: Vec<String>,
    pub commits: Vec<GitCommitNode>,
    pub loaded_at: String,
}

/// Preflight inspection status of a potential Git workspace directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitRepositoryPreflightStatus {
    NoWorkspace,
    MissingFolder,
    InaccessibleFolder,
    NotARepository,
    Repository,
    Worktree,
    BareRepository,
}

/// Preflight inspection result for a workspace path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryPreflight {
    pub status: GitRepositoryPreflightStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_name: Option<String>,
    pub message: String,
}

/// File change summary inside a commit inspection payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitChangedFile {
    pub path: String,
    pub additions: usize,
    pub deletions: usize,
    pub status: String,
}

/// Detailed commit view including full body and per-file stats.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetails {
    #[serde(flatten)]
    pub node: GitCommitNode,
    pub body: String,
    pub changed_files: Vec<GitCommitChangedFile>,
}

/// Kind of Git diff comparison requested.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitComparisonKind {
    Working,
    Staged,
    Commit,
    Compare,
}

/// Parameters for generating a structured Git diff document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffRequest {
    pub kind: GitComparisonKind,
    /// Commit/ref for a commit diff, or the left side of a comparison.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<String>,
    /// Right side of a two-ref comparison.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_lines: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignore_whitespace: Option<bool>,
}

/// Change classification of a file in a diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitDiffFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Binary,
    Unknown,
}

/// Classification of a single line inside a diff hunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitDiffLineKind {
    Context,
    Addition,
    Deletion,
    Notice,
}

/// One line inside a parsed diff hunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffLine {
    pub kind: GitDiffLineKind,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_line_number: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_line_number: Option<usize>,
}

/// Parsed hunk from a unified diff along with a self-contained patch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffHunk {
    pub id: String,
    pub header: String,
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<GitDiffLine>,
    /// A self-contained patch used for safe hunk-level working-tree operations.
    pub patch: String,
}

/// Parsed file entry in a unified diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFile {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    pub display_path: String,
    pub status: GitDiffFileStatus,
    pub additions: usize,
    pub deletions: usize,
    pub is_binary: bool,
    pub hunks: Vec<GitDiffHunk>,
}

/// Renderer-ready structured diff document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffDocument {
    pub request: GitDiffRequest,
    pub title: String,
    pub subtitle: String,
    pub additions: usize,
    pub deletions: usize,
    pub files: Vec<GitDiffFile>,
    pub generated_at: String,
}

/// Legacy raw-patch contract retained for existing integrations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub commit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub patch: String,
}

/// Working-tree action to apply to a hunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitHunkAction {
    Stage,
    Unstage,
    Discard,
}

/// Request payload for staging, unstaging, or discarding a single diff hunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHunkActionRequest {
    pub action: GitHunkAction,
    pub path: String,
    pub patch: String,
}

/// File entry in `GitStatusSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflicted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
}

/// Three-way merge conflict content for a single file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictFile {
    pub path: String,
    pub base: String,
    pub current: String,
    pub incoming: String,
    pub result: String,
    pub is_binary: bool,
}

/// Resolution strategy when resolving a conflicted file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "strategy", rename_all = "lowercase")]
pub enum GitConflictResolution {
    Current,
    Incoming,
    Manual { content: String },
}

/// Read-only working-tree file content snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileContent {
    pub path: String,
    pub content: String,
    pub is_binary: bool,
    /// Byte size on disk.
    pub size: u64,
    /// True once `content` has been cut short.
    pub truncated: bool,
}

/// Entry in a single file's commit history (`git log --follow`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileHistoryEntry {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

/// Single line entry from `git blame --line-porcelain`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    pub line_number: usize,
    pub commit: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub content: String,
}

/// Active multi-step Git operation in progress in the working tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitRepositoryOperation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

/// Working tree and index status snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSnapshot {
    pub repository_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub files: Vec<GitChangedFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<GitRepositoryOperation>,
}

/// Builds the topological commit graph with lane assignments, child pointers, and branch hints.
#[must_use]
pub fn build_commit_graph(
    commits: &[GitCommitInput],
    refs: &HashMap<String, Vec<String>>,
    branches: &[GitBranchInfo],
) -> Vec<GitCommitNode> {
    let by_hash: HashMap<&str, &GitCommitInput> = commits
        .iter()
        .map(|commit| (commit.hash.as_str(), commit))
        .collect();

    let mut children: HashMap<&str, Vec<String>> = HashMap::new();
    for commit in commits {
        for parent in &commit.parents {
            children
                .entry(parent.as_str())
                .or_default()
                .push(commit.hash.clone());
        }
    }

    let mut branch_commits: HashMap<&str, HashSet<&str>> = HashMap::new();
    for branch in branches {
        let mut reachable: HashSet<&str> = HashSet::new();
        let mut cursor: Option<&str> = Some(branch.tip.as_str());
        while let Some(curr) = cursor {
            if !reachable.insert(curr) {
                break;
            }
            cursor = by_hash
                .get(curr)
                .and_then(|c| c.parents.first().map(String::as_str));
        }
        branch_commits.insert(branch.name.as_str(), reachable);
    }

    let mut nodes = Vec::with_capacity(commits.len());
    let mut active_lanes: Vec<String> = Vec::new();

    for commit in commits {
        let lane = if let Some(idx) = active_lanes.iter().position(|h| h == &commit.hash) {
            idx
        } else if let Some(empty_idx) = active_lanes.iter().position(String::is_empty) {
            active_lanes[empty_idx] = commit.hash.clone();
            empty_idx
        } else {
            let new_idx = active_lanes.len();
            active_lanes.push(commit.hash.clone());
            new_idx
        };

        let child_hashes = children
            .get(commit.hash.as_str())
            .cloned()
            .unwrap_or_default();

        let branch_hints: Vec<String> = branches
            .iter()
            .filter(|branch| {
                branch_commits
                    .get(branch.name.as_str())
                    .is_some_and(|set| set.contains(commit.hash.as_str()))
            })
            .map(|branch| branch.name.clone())
            .collect();

        let short_hash: String = commit.hash.chars().take(8).collect();
        let is_merge = commit.parents.len() > 1;
        let is_divergence = child_hashes.len() > 1;

        nodes.push(GitCommitNode {
            hash: commit.hash.clone(),
            short_hash,
            parents: commit.parents.clone(),
            children: child_hashes,
            author: commit.author.clone(),
            date: commit.date.clone(),
            message: commit.message.clone(),
            body: commit.body.clone(),
            branch_hints,
            refs: refs.get(&commit.hash).cloned().unwrap_or_default(),
            lane,
            is_merge,
            is_divergence,
            is_convergence: is_merge,
        });

        active_lanes[lane] = commit.parents.first().cloned().unwrap_or_default();
        for parent in commit.parents.iter().skip(1) {
            if !active_lanes.iter().any(|h| h == parent) {
                active_lanes.push(parent.clone());
            }
        }
    }

    nodes
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn marks_merge_and_divergence_topology_and_preserves_branch_hints() {
        let commits = vec![
            GitCommitInput {
                hash: "merge".to_string(),
                parents: vec!["feature".to_string(), "main".to_string()],
                author: "A".to_string(),
                date: "2026-01-03".to_string(),
                message: "merge".to_string(),
                body: None,
            },
            GitCommitInput {
                hash: "feature".to_string(),
                parents: vec!["base".to_string()],
                author: "A".to_string(),
                date: "2026-01-02".to_string(),
                message: "feature".to_string(),
                body: None,
            },
            GitCommitInput {
                hash: "main".to_string(),
                parents: vec!["base".to_string()],
                author: "A".to_string(),
                date: "2026-01-02".to_string(),
                message: "main".to_string(),
                body: None,
            },
            GitCommitInput {
                hash: "base".to_string(),
                parents: vec![],
                author: "A".to_string(),
                date: "2026-01-01".to_string(),
                message: "base".to_string(),
                body: None,
            },
        ];

        let mut refs = HashMap::new();
        refs.insert("merge".to_string(), vec!["main".to_string()]);
        refs.insert("feature".to_string(), vec!["feature/topic".to_string()]);

        let branches = vec![
            GitBranchInfo {
                name: "main".to_string(),
                ref_name: "refs/heads/main".to_string(),
                tip: "merge".to_string(),
                is_remote: false,
                is_current: true,
                upstream: None,
            },
            GitBranchInfo {
                name: "feature/topic".to_string(),
                ref_name: "refs/heads/feature/topic".to_string(),
                tip: "feature".to_string(),
                is_remote: false,
                is_current: false,
                upstream: None,
            },
        ];

        let graph = build_commit_graph(&commits, &refs, &branches);
        assert_eq!(
            graph.iter().find(|n| n.hash == "merge").map(|n| n.is_merge),
            Some(true)
        );
        assert_eq!(
            graph
                .iter()
                .find(|n| n.hash == "base")
                .map(|n| n.is_divergence),
            Some(true)
        );
        assert_eq!(
            graph
                .iter()
                .find(|n| n.hash == "feature")
                .map(|n| n.branch_hints.clone()),
            Some(vec!["main".to_string(), "feature/topic".to_string()])
        );
    }

    #[test]
    fn builds_a_5000_commit_linear_history_without_quadratic_ancestry_work() {
        let commits: Vec<GitCommitInput> = (0..5000)
            .map(|index| GitCommitInput {
                hash: format!("commit-{index}"),
                parents: if index == 0 {
                    vec![]
                } else {
                    vec![format!("commit-{}", index - 1)]
                },
                author: "A".to_string(),
                date: "2026-01-01".to_string(),
                message: format!("commit {index}"),
                body: None,
            })
            .rev()
            .collect();

        let mut refs = HashMap::new();
        refs.insert("commit-4999".to_string(), vec!["main".to_string()]);
        let branches = vec![GitBranchInfo {
            name: "main".to_string(),
            ref_name: "refs/heads/main".to_string(),
            tip: "commit-4999".to_string(),
            is_remote: false,
            is_current: true,
            upstream: None,
        }];

        let started = Instant::now();
        let graph = build_commit_graph(&commits, &refs, &branches);
        let elapsed = started.elapsed();

        assert_eq!(graph.len(), 5000);
        assert!(
            elapsed.as_millis() < 2000,
            "graph build took {}ms",
            elapsed.as_millis()
        );
    }

    #[test]
    fn handles_detached_histories_multiple_refs_and_criss_cross_merges() {
        let commits = vec![
            GitCommitInput {
                hash: "merge-2".to_string(),
                parents: vec!["merge-1".to_string(), "side-2".to_string()],
                author: "A".to_string(),
                date: "2026-01-04".to_string(),
                message: "merge two".to_string(),
                body: None,
            },
            GitCommitInput {
                hash: "merge-1".to_string(),
                parents: vec!["base".to_string(), "side-1".to_string()],
                author: "A".to_string(),
                date: "2026-01-03".to_string(),
                message: "merge one".to_string(),
                body: None,
            },
            GitCommitInput {
                hash: "side-2".to_string(),
                parents: vec!["side-1".to_string()],
                author: "A".to_string(),
                date: "2026-01-03".to_string(),
                message: "side two".to_string(),
                body: None,
            },
            GitCommitInput {
                hash: "side-1".to_string(),
                parents: vec!["base".to_string()],
                author: "A".to_string(),
                date: "2026-01-02".to_string(),
                message: "side one".to_string(),
                body: None,
            },
            GitCommitInput {
                hash: "base".to_string(),
                parents: vec![],
                author: "A".to_string(),
                date: "2026-01-01".to_string(),
                message: "base".to_string(),
                body: None,
            },
        ];

        let mut refs = HashMap::new();
        refs.insert(
            "merge-2".to_string(),
            vec!["HEAD".to_string(), "refs/tags/v1".to_string()],
        );

        let graph = build_commit_graph(&commits, &refs, &[]);
        assert_eq!(
            graph
                .iter()
                .find(|n| n.hash == "merge-2")
                .map(|n| n.is_merge),
            Some(true)
        );
        assert_eq!(
            graph
                .iter()
                .find(|n| n.hash == "merge-1")
                .map(|n| n.is_merge),
            Some(true)
        );
        assert_eq!(
            graph
                .iter()
                .find(|n| n.hash == "merge-2")
                .map(|n| n.refs.clone()),
            Some(vec!["HEAD".to_string(), "refs/tags/v1".to_string()])
        );
        assert_eq!(
            graph.iter().find(|n| n.hash == "base").map(|n| n.lane),
            Some(0)
        );
    }
}
