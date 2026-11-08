//! Git worktree lifecycle management, uncommitted snapshot branching, and `.github` symlink replication (`gitWorktreeManager.ts`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::process::Command;

/// Praxis metadata files excluded when checking base checkout cleanliness or snapshotting uncommitted work.
pub const PRAXIS_METADATA_EXCLUDES: [&str; 4] = [
    ":(exclude).praxis/**",
    ":(exclude)project.praxis.md",
    ":(exclude)board.praxis.json",
    ":(exclude,glob)**/*.workspace.praxis.json",
];

const WORKTREES_EXCLUDE: &str = "/.worktrees/";

/// Minimal logger seam for worktree lifecycle operations.
pub trait WorktreeLogger: Send + Sync {
    fn append_line(&self, message: &str);
}

/// No-op logger implementation.
#[derive(Debug, Default, Clone, Copy)]
pub struct SilentWorktreeLogger;

impl WorktreeLogger for SilentWorktreeLogger {
    fn append_line(&self, _message: &str) {}
}

/// In-memory buffer logger for tests and RPC capture.
#[derive(Debug, Default, Clone)]
pub struct BufferingWorktreeLogger {
    lines: Arc<Mutex<Vec<String>>>,
}

impl BufferingWorktreeLogger {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn lines(&self) -> Vec<String> {
        self.lines
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
}

impl WorktreeLogger for BufferingWorktreeLogger {
    fn append_line(&self, message: &str) {
        if let Ok(mut guard) = self.lines.lock() {
            guard.push(message.to_string());
        }
    }
}

/// Error returned when preparing, removing, or merging a delivery worktree.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorktreeError {
    #[error("The delivery worktree path already exists: {worktree_path}")]
    Conflict {
        worktree_path: String,
        worktree_name: String,
    },
    #[error("{message}")]
    Failed { message: String },
}

impl WorktreeError {
    #[must_use]
    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed {
            message: message.into(),
        }
    }

    #[must_use]
    pub fn is_conflict(&self) -> bool {
        matches!(self, Self::Conflict { .. })
    }
}

/// Minimal issue descriptor used to derive a worktree/branch name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeIssueInput {
    pub key: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// Options for [`GitWorktreeManager::prepare_delivery_worktree`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrepareWorktreeOptions {
    pub force_clean: bool,
    pub require_clean_base: bool,
    /// Reuse one named branch/worktree across sequential scheduled ticket workflows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    /// Branch from a snapshot of the checkout's uncommitted work instead of committed HEAD alone.
    pub include_uncommitted: bool,
    /// Reuse an existing worktree directory if it is already checked out to the expected branch.
    pub reuse_existing: bool,
}

/// Options for [`GitWorktreeManager::remove_delivery_worktree`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoveWorktreeOptions {
    pub keep_branch: bool,
}

/// Result of preparing a delivery worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedWorktree {
    pub repo_root: String,
    pub worktree_root: String,
    pub worktree_path: String,
    pub worktree_name: String,
    pub branch_name: String,
    pub base_branch: String,
}

/// Target descriptor when removing a delivery worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeTarget {
    pub worktree_path: String,
    pub branch_name: String,
}

fn slugify_naming_segment(value: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in value.chars() {
        if !ch.is_ascii() {
            continue;
        }
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn strip_issue_key_prefix(value: &str, issue_key: &str) -> String {
    let normalized_key = slugify_naming_segment(issue_key);
    if value.is_empty() || normalized_key.is_empty() {
        return value.to_string();
    }
    if value == normalized_key {
        return String::new();
    }
    let prefix = format!("{normalized_key}-");
    if let Some(stripped) = value.strip_prefix(&prefix) {
        return stripped.to_string();
    }
    value.to_string()
}

/// Builds the canonical `<KEY>-<slug>` worktree/branch name for an issue (`buildWorktreeName` in `agentPrompt.ts`).
#[must_use]
pub fn build_worktree_name(issue: &WorktreeIssueInput) -> String {
    let branch_trimmed = issue.branch.as_deref().map(str::trim).unwrap_or("");
    let source = if !issue.summary.is_empty() {
        issue.summary.as_str()
    } else if !branch_trimmed.is_empty() {
        branch_trimmed
    } else {
        issue.key.as_str()
    };
    let normalized = strip_issue_key_prefix(&slugify_naming_segment(source), &issue.key);
    let truncated: String = normalized.chars().take(48).collect();
    let trimmed = truncated.trim_end_matches('-');
    let suffix = if trimmed.is_empty() {
        "work-item"
    } else {
        trimmed
    };
    format!("{}-{suffix}", issue.key)
}

/// Resolves the `.worktrees` directory inside `repo_root`.
#[must_use]
pub fn resolve_repo_worktree_root(repo_root: &Path) -> PathBuf {
    repo_root.join(".worktrees")
}

fn is_valid_worktree_branch_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() || name.contains("..") {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

async fn run_git_stdout(args: &[&str], cwd: &Path) -> Result<String, WorktreeError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|err| WorktreeError::failed(format!("Failed to spawn git: {err}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(WorktreeError::failed(if stderr.is_empty() {
            format!("git {:?} exited with {}", args, output.status)
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn run_git_optional_stdout(args: &[&str], cwd: &Path) -> Option<String> {
    run_git_stdout(args, cwd).await.ok()
}

/// Ensures `/.worktrees/` is present in the repository's shared `.git/info/exclude` file.
pub async fn ensure_worktrees_excluded(repo_root: &Path) -> Result<(), WorktreeError> {
    let common_dir = run_git_stdout(&["rev-parse", "--git-common-dir"], repo_root).await?;
    let resolved_common = repo_root.join(common_dir);
    let exclude_path = resolved_common.join("info").join("exclude");
    let current = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    if current.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == WORKTREES_EXCLUDE || trimmed == ".worktrees/" || trimmed == ".worktrees"
    }) {
        return Ok(());
    }
    if let Some(parent) = exclude_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| WorktreeError::failed(err.to_string()))?;
    }
    let prefix = if !current.is_empty() && !current.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    let next = format!("{current}{prefix}# Praxis run worktrees\n{WORKTREES_EXCLUDE}\n");
    std::fs::write(&exclude_path, next).map_err(|err| WorktreeError::failed(err.to_string()))?;
    Ok(())
}

/// Synchronous wrapper for [`ensure_worktrees_excluded`].
pub fn ensure_worktrees_excluded_sync(repo_root: &Path) -> Result<(), WorktreeError> {
    block_on_git(ensure_worktrees_excluded(repo_root))
}

pub(crate) fn block_on_git<F: std::future::Future>(future: F) -> F::Output {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        tokio::task::block_in_place(|| handle.block_on(future))
    } else {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio current_thread runtime");
        rt.block_on(future)
    }
}

/// Manages delivery worktrees for governed workflow runs and sessions.
pub struct GitWorktreeManager {
    output: Arc<dyn WorktreeLogger>,
}

impl GitWorktreeManager {
    #[must_use]
    pub fn new(output: Arc<dyn WorktreeLogger>) -> Self {
        Self { output }
    }

    #[must_use]
    pub fn silent() -> Self {
        Self {
            output: Arc::new(SilentWorktreeLogger),
        }
    }

    async fn ensure_symlink_support(&self, repo_root: &Path) -> Result<(), WorktreeError> {
        if !cfg!(windows) {
            return Ok(());
        }
        let current = run_git_optional_stdout(&["config", "--get", "core.symlinks"], repo_root)
            .await
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if current == "true" {
            return Ok(());
        }
        self.output
            .append_line("[Delivery] Enabling git core.symlinks=true for worktree checkouts.");
        run_git_stdout(&["config", "--local", "core.symlinks", "true"], repo_root).await?;
        Ok(())
    }

    async fn snapshot_uncommitted_work(
        &self,
        repo_root: &Path,
        label: &str,
    ) -> Result<Option<String>, WorktreeError> {
        let git_dir_raw = run_git_stdout(&["rev-parse", "--git-dir"], repo_root).await?;
        let git_dir = repo_root.join(git_dir_raw);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let temp_index = git_dir.join(format!(
            "praxis-snapshot-{}-{nanos}.index",
            std::process::id()
        ));
        let has_email = run_git_optional_stdout(&["config", "user.email"], repo_root)
            .await
            .is_some_and(|s| !s.is_empty());

        let run_with_index = |args: Vec<String>| {
            let temp_index_path = temp_index.clone();
            let cwd = repo_root.to_path_buf();
            async move {
                let mut cmd = Command::new("git");
                cmd.args(&args)
                    .current_dir(&cwd)
                    .env("GIT_INDEX_FILE", &temp_index_path);
                if !has_email {
                    cmd.env("GIT_AUTHOR_NAME", "Praxis")
                        .env("GIT_AUTHOR_EMAIL", "praxis@localhost")
                        .env("GIT_COMMITTER_NAME", "Praxis")
                        .env("GIT_COMMITTER_EMAIL", "praxis@localhost");
                }
                let out = cmd
                    .output()
                    .await
                    .map_err(|e| WorktreeError::failed(e.to_string()))?;
                if !out.status.success() {
                    return Err(WorktreeError::failed(
                        String::from_utf8_lossy(&out.stderr).trim().to_string(),
                    ));
                }
                Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
            }
        };

        let result = async {
            let head = run_with_index(vec!["rev-parse".into(), "HEAD".into()]).await?;
            run_with_index(vec!["read-tree".into(), head.clone()]).await?;
            let mut add_args = vec!["add".into(), "-A".into(), "--".into(), ".".into()];
            for ex in PRAXIS_METADATA_EXCLUDES {
                add_args.push(ex.to_string());
            }
            run_with_index(add_args).await?;
            let tree = run_with_index(vec!["write-tree".into()]).await?;
            let head_tree =
                run_with_index(vec!["rev-parse".into(), format!("{head}^{{tree}}")]).await?;
            if tree == head_tree {
                return Ok(None);
            }
            let commit = run_with_index(vec![
                "commit-tree".into(),
                tree,
                "-p".into(),
                head,
                "-m".into(),
                format!("WIP snapshot: uncommitted changes when {label} started"),
            ])
            .await?;
            Ok(Some(commit))
        }
        .await;

        let _ = std::fs::remove_file(&temp_index);
        result
    }

    /// Prepares a delivery worktree for `issue` branched from `base_branch`.
    pub async fn prepare_delivery_worktree(
        &self,
        issue: &WorktreeIssueInput,
        base_branch: &str,
        workspace_path: &Path,
        options: Option<&PrepareWorktreeOptions>,
    ) -> Result<PreparedWorktree, WorktreeError> {
        let default_opts = PrepareWorktreeOptions::default();
        let opts = options.unwrap_or(&default_opts);

        let repo_root_str =
            run_git_stdout(&["rev-parse", "--show-toplevel"], workspace_path).await?;
        if repo_root_str.is_empty() {
            return Err(WorktreeError::failed(
                "Could not resolve the git repository root for the active workspace.",
            ));
        }
        let repo_root = PathBuf::from(&repo_root_str);

        let worktree_name = opts
            .branch_name
            .clone()
            .unwrap_or_else(|| build_worktree_name(issue));
        if !is_valid_worktree_branch_name(&worktree_name) {
            return Err(WorktreeError::failed(
                "The requested delivery branch name is invalid.",
            ));
        }

        let worktree_root = resolve_repo_worktree_root(&repo_root);
        let worktree_path = worktree_root.join(&worktree_name);

        std::fs::create_dir_all(&worktree_root)
            .map_err(|err| WorktreeError::failed(err.to_string()))?;
        ensure_worktrees_excluded(&repo_root).await?;

        let mut reused = false;
        if worktree_path.exists() {
            if opts.reuse_existing {
                let current_branch =
                    run_git_optional_stdout(&["rev-parse", "--abbrev-ref", "HEAD"], &worktree_path)
                        .await
                        .unwrap_or_default();
                if current_branch == worktree_name {
                    reused = true;
                    self.output.append_line(&format!(
                        "[Delivery] Reusing existing worktree {worktree_name} at {}.",
                        worktree_path.display()
                    ));
                }
            }
            if !reused {
                if opts.force_clean {
                    self.output.append_line(&format!(
                        "[Delivery] Force-cleaning existing worktree {worktree_name}."
                    ));
                    self.remove_worktree(&repo_root, &worktree_path, &worktree_name, None)
                        .await;
                } else {
                    return Err(WorktreeError::Conflict {
                        worktree_path: worktree_path.to_string_lossy().to_string(),
                        worktree_name,
                    });
                }
            }
        }

        if reused {
            self.ensure_symlink_support(&repo_root).await?;
            self.replicate_github_symlinks(&repo_root, &worktree_path);
            return Ok(PreparedWorktree {
                repo_root: repo_root_str,
                worktree_root: worktree_root.to_string_lossy().to_string(),
                worktree_path: worktree_path.to_string_lossy().to_string(),
                worktree_name: worktree_name.clone(),
                branch_name: worktree_name,
                base_branch: base_branch.to_string(),
            });
        }

        let branch_ref_name = format!("refs/heads/{worktree_name}");
        let branch_exists = run_git_optional_stdout(
            &["rev-parse", "--verify", "--quiet", &branch_ref_name],
            &repo_root,
        )
        .await
        .is_some_and(|out| !out.is_empty());

        if branch_exists {
            self.ensure_symlink_support(&repo_root).await?;
            self.output.append_line(&format!(
                "[Delivery] Re-attaching worktree {worktree_name} to its existing branch."
            ));
            let wt_str = worktree_path.to_string_lossy().to_string();
            run_git_stdout(
                &[
                    "-c",
                    "core.symlinks=true",
                    "worktree",
                    "add",
                    &wt_str,
                    &worktree_name,
                ],
                &repo_root,
            )
            .await?;
            self.replicate_github_symlinks(&repo_root, &worktree_path);
            return Ok(PreparedWorktree {
                repo_root: repo_root_str,
                worktree_root: worktree_root.to_string_lossy().to_string(),
                worktree_path: wt_str,
                worktree_name: worktree_name.clone(),
                branch_name: worktree_name,
                base_branch: base_branch.to_string(),
            });
        }

        if opts.require_clean_base {
            let mut status_args = vec![
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--",
                ".",
            ];
            status_args.extend_from_slice(&PRAXIS_METADATA_EXCLUDES);
            let status_out = run_git_stdout(&status_args, &repo_root).await?;
            let changed_files = status_out.split('\0').filter(|s| !s.is_empty()).count();
            if changed_files > 0 {
                let noun = if changed_files == 1 { "file" } else { "files" };
                return Err(WorktreeError::failed(format!(
                    "Cannot start a governed workflow from a checkout with {changed_files} uncommitted {noun}. Workflow worktrees branch from committed HEAD, so those changes would be omitted from implementation and QA. Commit or stash them, then start the run again."
                )));
            }
        }

        let origin_ref = format!("origin/{base_branch}");
        let branch_ref =
            match run_git_stdout(&["rev-parse", "--verify", base_branch], &repo_root).await {
                Ok(r) if !r.is_empty() => r,
                _ => run_git_stdout(&["rev-parse", "--verify", &origin_ref], &repo_root)
                    .await
                    .map_err(|_| {
                        WorktreeError::failed(format!(
                            "Base branch {base_branch} was not found locally or on origin."
                        ))
                    })?,
            };

        let mut start_point = branch_ref;
        if opts.include_uncommitted {
            if let Some(snapshot) = self
                .snapshot_uncommitted_work(&repo_root, &worktree_name)
                .await?
            {
                let short: String = snapshot.chars().take(8).collect();
                self.output.append_line(&format!(
                    "[Delivery] Including uncommitted changes from the checkout as {short}."
                ));
                start_point = snapshot;
            }
        }

        self.ensure_symlink_support(&repo_root).await?;
        self.output.append_line(&format!(
            "[Delivery] Creating worktree {worktree_name} from {base_branch}."
        ));
        let wt_str = worktree_path.to_string_lossy().to_string();
        run_git_stdout(
            &[
                "-c",
                "core.symlinks=true",
                "worktree",
                "add",
                "-b",
                &worktree_name,
                &wt_str,
                &start_point,
            ],
            &repo_root,
        )
        .await?;

        self.replicate_github_symlinks(&repo_root, &worktree_path);

        Ok(PreparedWorktree {
            repo_root: repo_root_str,
            worktree_root: worktree_root.to_string_lossy().to_string(),
            worktree_path: wt_str,
            worktree_name: worktree_name.clone(),
            branch_name: worktree_name,
            base_branch: base_branch.to_string(),
        })
    }

    /// Synchronous wrapper for [`Self::prepare_delivery_worktree`].
    pub fn prepare_delivery_worktree_sync(
        &self,
        issue: &WorktreeIssueInput,
        base_branch: &str,
        workspace_path: &Path,
        options: Option<&PrepareWorktreeOptions>,
    ) -> Result<PreparedWorktree, WorktreeError> {
        block_on_git(self.prepare_delivery_worktree(issue, base_branch, workspace_path, options))
    }

    /// Removes the worktree checkout and optionally its branch.
    pub async fn remove_delivery_worktree(
        &self,
        context_path: &Path,
        worktree: &WorktreeTarget,
        options: Option<&RemoveWorktreeOptions>,
    ) -> Result<(), WorktreeError> {
        let common_dir = run_git_optional_stdout(
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            context_path,
        )
        .await
        .unwrap_or_default();

        let wt_path = PathBuf::from(&worktree.worktree_path);
        let main_root = if !common_dir.is_empty() {
            PathBuf::from(&common_dir)
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| context_path.to_path_buf())
        } else {
            wt_path
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .unwrap_or_else(|| context_path.to_path_buf())
        };

        self.remove_worktree(&main_root, &wt_path, &worktree.branch_name, options)
            .await;
        Ok(())
    }

    /// Synchronous wrapper for [`Self::remove_delivery_worktree`].
    pub fn remove_delivery_worktree_sync(
        &self,
        context_path: &Path,
        worktree: &WorktreeTarget,
        options: Option<&RemoveWorktreeOptions>,
    ) -> Result<(), WorktreeError> {
        block_on_git(self.remove_delivery_worktree(context_path, worktree, options))
    }

    /// Merges a sub-task branch into the feature branch from the main repo root (`--no-ff`),
    /// pushes the feature branch, and removes the sub-task worktree and branch.
    pub async fn merge_sub_task_branch(
        &self,
        workspace_path: &Path,
        sub_task_branch: &str,
        feature_branch: &str,
        sub_task_worktree_path: &Path,
        git_extra_args: Option<&[String]>,
    ) -> Result<String, WorktreeError> {
        let repo_root_str =
            run_git_stdout(&["rev-parse", "--show-toplevel"], workspace_path).await?;
        let repo_root = PathBuf::from(&repo_root_str);

        run_git_stdout(&["fetch", "origin"], &repo_root).await?;
        let current_branch =
            run_git_stdout(&["rev-parse", "--abbrev-ref", "HEAD"], &repo_root).await?;

        run_git_stdout(&["checkout", feature_branch], &repo_root).await?;

        let merge_result = async {
            let _ =
                run_git_stdout(&["pull", "--ff-only", "origin", feature_branch], &repo_root).await;
            let merge_msg = format!("Merge {sub_task_branch} into {feature_branch}");
            run_git_stdout(
                &["merge", "--no-ff", "-m", &merge_msg, sub_task_branch],
                &repo_root,
            )
            .await?;

            let merge_commit = run_git_stdout(&["rev-parse", "HEAD"], &repo_root).await?;

            let mut push_args: Vec<&str> = Vec::new();
            if let Some(extra) = git_extra_args {
                for item in extra {
                    push_args.push(item.as_str());
                }
            }
            push_args.extend_from_slice(&["push", "origin", feature_branch]);
            run_git_stdout(&push_args, &repo_root).await?;

            let short: String = merge_commit.chars().take(8).collect();
            self.output.append_line(&format!(
                "[Delivery] Merged {sub_task_branch} into {feature_branch} (commit: {short})."
            ));

            self.remove_worktree(&repo_root, sub_task_worktree_path, sub_task_branch, None)
                .await;
            Ok(merge_commit)
        }
        .await;

        if merge_result.is_err() {
            let _ = run_git_stdout(&["merge", "--abort"], &repo_root).await;
        }

        if !current_branch.is_empty() && current_branch != feature_branch {
            let _ = run_git_stdout(&["checkout", &current_branch], &repo_root).await;
        }

        merge_result
    }

    fn replicate_github_symlinks(&self, repo_root: &Path, worktree_path: &Path) {
        let source_root = repo_root.join(".github");
        match std::fs::metadata(&source_root) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
            Err(err) => {
                self.output.append_line(&format!(
                    "[Delivery] Could not inspect {}: {err}",
                    source_root.display()
                ));
                return;
            }
        }

        let symlinks = self.find_symlinks(&source_root);
        if symlinks.is_empty() {
            return;
        }

        let dest_root = worktree_path.join(".github");
        let mut restored = 0usize;
        for (link_path, absolute_target) in symlinks {
            let Ok(rel_path) = link_path.strip_prefix(&source_root) else {
                continue;
            };
            let dest_path = dest_root.join(rel_path);
            let rel_display = rel_path.to_string_lossy().replace('\\', "/");
            match self.materialize_symlink(&link_path, &absolute_target, &dest_path) {
                Ok(()) => {
                    restored += 1;
                    self.output.append_line(&format!(
                        "[Delivery] Replicated symlink .github/{rel_display} -> {}",
                        absolute_target.display()
                    ));
                }
                Err(err) => {
                    self.output.append_line(&format!(
                        "[Delivery] Failed to replicate symlink .github/{rel_display}: {err}"
                    ));
                }
            }
        }
        if restored > 0 {
            self.output.append_line(&format!(
                "[Delivery] Replicated {restored} .github symlink(s) into worktree."
            ));
        }
    }

    fn find_symlinks(&self, root: &Path) -> Vec<(PathBuf, PathBuf)> {
        let mut results = Vec::new();
        self.walk_symlinks(root, &mut results);
        results
    }

    fn walk_symlinks(&self, dir: &Path, results: &mut Vec<(PathBuf, PathBuf)>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(err) => {
                self.output.append_line(&format!(
                    "[Delivery] Could not read {}: {err}",
                    dir.display()
                ));
                return;
            }
        };

        for entry in entries.flatten() {
            let full = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                match std::fs::read_link(&full) {
                    Ok(raw_target) => {
                        let abs_target = if raw_target.is_absolute() {
                            raw_target
                        } else {
                            full.parent().unwrap_or(dir).join(raw_target)
                        };
                        results.push((full, abs_target));
                    }
                    Err(err) => {
                        self.output.append_line(&format!(
                            "[Delivery] Could not read symlink {}: {err}",
                            full.display()
                        ));
                    }
                }
                continue;
            }
            if file_type.is_dir() {
                self.walk_symlinks(&full, results);
            }
        }
    }

    fn materialize_symlink(
        &self,
        original_link_path: &Path,
        absolute_target: &Path,
        dest_path: &Path,
    ) -> Result<(), String> {
        if let Ok(meta) = std::fs::symlink_metadata(dest_path) {
            if meta.is_dir() && !meta.file_type().is_symlink() {
                std::fs::remove_dir_all(dest_path).map_err(|e| e.to_string())?;
            } else {
                std::fs::remove_file(dest_path).map_err(|e| e.to_string())?;
            }
        }

        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let exists = std::fs::metadata(original_link_path).is_ok();
        if !exists {
            self.output.append_line(&format!(
                "[Delivery] Warning: replicating dangling symlink to {}.",
                absolute_target.display()
            ));
        }

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(absolute_target, dest_path).map_err(|e| e.to_string())
        }
        #[cfg(windows)]
        {
            let is_dir = std::fs::metadata(original_link_path)
                .map(|m| m.is_dir())
                .unwrap_or(false);
            if is_dir {
                std::os::windows::fs::symlink_dir(absolute_target, dest_path)
                    .map_err(|e| e.to_string())
            } else {
                std::os::windows::fs::symlink_file(absolute_target, dest_path)
                    .map_err(|e| e.to_string())
            }
        }
    }

    async fn remove_worktree(
        &self,
        repo_root: &Path,
        worktree_path: &Path,
        branch_name: &str,
        options: Option<&RemoveWorktreeOptions>,
    ) {
        let wt_str = worktree_path.to_string_lossy().to_string();
        if run_git_stdout(&["worktree", "remove", &wt_str, "--force"], repo_root)
            .await
            .is_err()
        {
            let _ = std::fs::remove_dir_all(worktree_path);
            let _ = run_git_stdout(&["worktree", "prune"], repo_root).await;
        }
        if options.is_some_and(|o| o.keep_branch) {
            return;
        }
        let _ = run_git_stdout(&["branch", "-D", branch_name], repo_root).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn git_sync(cwd: &Path, args: &[&str]) -> String {
        let out = StdCommand::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git command");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn init_repo() -> PathBuf {
        // Tests run on parallel threads and macOS clocks tick in microseconds, so the
        // timestamp alone can repeat; the counter keeps every repository distinct.
        static NEXT_REPO: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let sequence = NEXT_REPO.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "praxis-worktree-{}-{sequence}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        git_sync(&dir, &["init", "-b", "main"]);
        git_sync(&dir, &["config", "user.email", "test@example.com"]);
        git_sync(&dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("README.md"), "# temp\n").expect("write");
        git_sync(&dir, &["add", "."]);
        git_sync(&dir, &["commit", "-m", "init"]);
        dir
    }

    #[test]
    fn resolve_repo_worktree_root_stores_worktrees_under_the_repository() {
        let repo_root = PathBuf::from("/dev/praxis");
        assert_eq!(
            resolve_repo_worktree_root(&repo_root),
            PathBuf::from("/dev/praxis/.worktrees")
        );
    }

    #[tokio::test]
    async fn prepare_delivery_worktree_creates_a_branch_and_checkout_then_removes_them() {
        let repo = init_repo();
        let res = async {
            let manager = GitWorktreeManager::silent();
            let issue = WorktreeIssueInput {
                key: "SESSION-abcd1234".to_string(),
                summary: "add a folder picker".to_string(),
                branch: None,
            };
            let prepared = manager
                .prepare_delivery_worktree(&issue, "main", &repo, None)
                .await
                .expect("prepare");

            assert_eq!(prepared.base_branch, "main");
            assert!(prepared.worktree_name.starts_with("SESSION-abcd1234"));
            assert!(Path::new(&prepared.worktree_path).is_dir());

            let conflict = manager
                .prepare_delivery_worktree(&issue, "main", &repo, None)
                .await
                .expect_err("expected conflict");
            assert!(conflict.is_conflict());

            let reused = manager
                .prepare_delivery_worktree(
                    &issue,
                    "main",
                    &repo,
                    Some(&PrepareWorktreeOptions {
                        reuse_existing: true,
                        ..Default::default()
                    }),
                )
                .await
                .expect("reuse");
            assert_eq!(reused.worktree_path, prepared.worktree_path);
            assert_eq!(reused.branch_name, prepared.branch_name);

            manager
                .remove_delivery_worktree(
                    &repo,
                    &WorktreeTarget {
                        worktree_path: prepared.worktree_path.clone(),
                        branch_name: prepared.branch_name.clone(),
                    },
                    None,
                )
                .await
                .expect("remove");
            assert!(!Path::new(&prepared.worktree_path).exists());
        }
        .await;
        let _ = std::fs::remove_dir_all(&repo);
        res
    }

    #[tokio::test]
    async fn prepare_delivery_worktree_reattaches_kept_branch_with_its_commits_even_over_dirty_base()
     {
        let repo = init_repo();
        let manager = GitWorktreeManager::silent();
        let issue = WorktreeIssueInput {
            key: "WF-abcd1234-verify".to_string(),
            summary: "verify".to_string(),
            branch: None,
        };
        let first = manager
            .prepare_delivery_worktree(&issue, "main", &repo, None)
            .await
            .expect("first prepare");
        let wt_path = PathBuf::from(&first.worktree_path);
        git_sync(&wt_path, &["config", "user.email", "test@example.com"]);
        git_sync(&wt_path, &["config", "user.name", "Test"]);
        std::fs::write(wt_path.join("work.txt"), "earlier work\n").expect("write");
        git_sync(&wt_path, &["add", "."]);
        git_sync(&wt_path, &["commit", "-m", "earlier work"]);

        manager
            .remove_delivery_worktree(
                &repo,
                &WorktreeTarget {
                    worktree_path: first.worktree_path.clone(),
                    branch_name: first.branch_name.clone(),
                },
                Some(&RemoveWorktreeOptions { keep_branch: true }),
            )
            .await
            .expect("remove keeping branch");

        std::fs::write(repo.join("stray.txt"), "dirty\n").expect("dirty write");
        let again = manager
            .prepare_delivery_worktree(
                &issue,
                "main",
                &repo,
                Some(&PrepareWorktreeOptions {
                    require_clean_base: true,
                    ..Default::default()
                }),
            )
            .await
            .expect("reattach");
        assert_eq!(again.worktree_path, first.worktree_path);
        assert_eq!(
            std::fs::read_to_string(Path::new(&again.worktree_path).join("work.txt"))
                .expect("read"),
            "earlier work\n"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn sequential_scheduled_tickets_can_reattach_to_same_named_delivery_branch() {
        let repo = init_repo();
        let manager = GitWorktreeManager::silent();
        let branch_name = "WF-SR-4D936945".to_string();
        let first = manager
            .prepare_delivery_worktree(
                &WorktreeIssueInput {
                    key: "T-1".to_string(),
                    summary: "first ticket".to_string(),
                    branch: None,
                },
                "main",
                &repo,
                Some(&PrepareWorktreeOptions {
                    branch_name: Some(branch_name.clone()),
                    ..Default::default()
                }),
            )
            .await
            .expect("first");
        let wt_path = PathBuf::from(&first.worktree_path);
        git_sync(&wt_path, &["config", "user.email", "test@example.com"]);
        git_sync(&wt_path, &["config", "user.name", "Test"]);
        std::fs::write(wt_path.join("first.txt"), "first ticket\n").expect("write");
        git_sync(&wt_path, &["add", "."]);
        git_sync(&wt_path, &["commit", "-m", "first ticket"]);
        manager
            .remove_delivery_worktree(
                &repo,
                &WorktreeTarget {
                    worktree_path: first.worktree_path.clone(),
                    branch_name: first.branch_name.clone(),
                },
                Some(&RemoveWorktreeOptions { keep_branch: true }),
            )
            .await
            .expect("remove");

        let second = manager
            .prepare_delivery_worktree(
                &WorktreeIssueInput {
                    key: "T-2".to_string(),
                    summary: "second ticket".to_string(),
                    branch: None,
                },
                "main",
                &repo,
                Some(&PrepareWorktreeOptions {
                    branch_name: Some(branch_name.clone()),
                    require_clean_base: true,
                    ..Default::default()
                }),
            )
            .await
            .expect("second");
        assert_eq!(second.branch_name, branch_name);
        assert_eq!(
            std::fs::read_to_string(Path::new(&second.worktree_path).join("first.txt"))
                .expect("read"),
            "first ticket\n"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn prepare_delivery_worktree_refuses_dirty_base_when_clean_snapshot_required() {
        let repo = init_repo();
        std::fs::write(repo.join("README.md"), "# uncommitted change\n").expect("write");
        let manager = GitWorktreeManager::silent();
        let err = manager
            .prepare_delivery_worktree(
                &WorktreeIssueInput {
                    key: "WF-DIRTY".to_string(),
                    summary: "governed delivery".to_string(),
                    branch: None,
                },
                "main",
                &repo,
                Some(&PrepareWorktreeOptions {
                    require_clean_base: true,
                    ..Default::default()
                }),
            )
            .await
            .expect_err("expected dirty error");
        assert!(
            err.to_string()
                .contains("Workflow worktrees branch from committed HEAD")
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn second_run_can_start_on_clean_base_while_first_run_has_worktree_and_exclude_is_respected()
     {
        let repo = init_repo();
        let manager = GitWorktreeManager::silent();
        manager
            .prepare_delivery_worktree(
                &WorktreeIssueInput {
                    key: "RUN-1".to_string(),
                    summary: "first".to_string(),
                    branch: None,
                },
                "main",
                &repo,
                Some(&PrepareWorktreeOptions {
                    require_clean_base: true,
                    ..Default::default()
                }),
            )
            .await
            .expect("run 1");
        let second = manager
            .prepare_delivery_worktree(
                &WorktreeIssueInput {
                    key: "RUN-2".to_string(),
                    summary: "second".to_string(),
                    branch: None,
                },
                "main",
                &repo,
                Some(&PrepareWorktreeOptions {
                    require_clean_base: true,
                    ..Default::default()
                }),
            )
            .await
            .expect("run 2");

        let status = git_sync(&repo, &["status", "--porcelain", "--untracked-files=all"]);
        assert_eq!(status, "");
        assert!(!repo.join(".gitignore").exists());
        let exclude_path = repo.join(".git").join("info").join("exclude");
        let exclude = std::fs::read_to_string(&exclude_path).expect("exclude");
        assert_eq!(
            exclude
                .lines()
                .filter(|line| *line == "/.worktrees/")
                .count(),
            1
        );

        std::fs::write(&exclude_path, "*.log\n.worktrees/").expect("write exclude");
        ensure_worktrees_excluded(&repo).await.expect("exclude");
        assert_eq!(
            std::fs::read_to_string(&exclude_path).expect("read"),
            "*.log\n.worktrees/"
        );

        std::fs::write(&exclude_path, "").expect("clear");
        ensure_worktrees_excluded(Path::new(&second.worktree_path))
            .await
            .expect("exclude from worktree");
        assert_eq!(
            std::fs::read_to_string(&exclude_path).expect("read"),
            "# Praxis run worktrees\n/.worktrees/\n"
        );

        let _ = std::fs::remove_dir_all(&repo);
    }
}
