//! Git CLI parsers, topological commit graph layout, repository service, and worktree management.

pub mod git_graph;
pub mod git_parsing;
pub mod git_service;
pub mod git_worktree_manager;
pub mod map_worktrees;
pub mod run_work;
pub mod worktree_dependency_links;

pub use git_graph::{
    GitBlameLine, GitBranchInfo, GitChangedFile, GitCommitChangedFile, GitCommitDetails,
    GitCommitInput, GitCommitNode, GitComparisonKind, GitConflictFile, GitConflictResolution,
    GitDiffDocument, GitDiffFile, GitDiffFileStatus, GitDiffHunk, GitDiffLine, GitDiffLineKind,
    GitDiffRequest, GitDiffResult, GitFileContent, GitFileHistoryEntry, GitHunkAction,
    GitHunkActionRequest, GitRepositoryOperation, GitRepositoryPreflight,
    GitRepositoryPreflightStatus, GitRepositorySnapshot, GitStatusSnapshot, build_commit_graph,
};
pub use git_parsing::{
    GitLogRecord, GitTagRef, build_partial_hunk_patch, parse_git_branches, parse_git_diff,
    parse_git_log, parse_git_status, parse_git_tags,
};
pub use git_service::GitService;
pub use git_worktree_manager::{
    BufferingWorktreeLogger, GitWorktreeManager, PRAXIS_METADATA_EXCLUDES, PrepareWorktreeOptions,
    PreparedWorktree, RemoveWorktreeOptions, SilentWorktreeLogger, WorktreeError,
    WorktreeIssueInput, WorktreeLogger, WorktreeTarget, build_worktree_name,
    ensure_worktrees_excluded, ensure_worktrees_excluded_sync, resolve_repo_worktree_root,
};
pub use map_worktrees::{
    MergeItemBranchResult, create_item_worktree, map_item_branch, merge_item_branch,
    release_item_worktree, rev_parse_head,
};
pub use run_work::{
    DeleteRunWorkResult, delete_run_work, delete_run_work_sync, find_run_branch, inspect_run_work,
    inspect_run_work_sync, preserve_uncommitted_work, repository_root, restore_worktree_to,
    run_worktree_key,
};
pub use worktree_dependency_links::{
    RemovedDependencyLink, remove_escaping_dependency_links, remove_escaping_dependency_links_sync,
};
