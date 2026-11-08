//! Governed workflow run branch/worktree inspection, preservation, and restoration (`runWork.ts`).

use std::path::Path;

use praxis_contracts::{WorkflowRunCommitSummary, WorkflowRunWorkInfo};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::git_worktree_manager::block_on_git;

async fn git_out(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {:?} exited with {}", args, output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Stable per-run key: `WF-` + the first 8 characters of the run id, upper-cased.
#[must_use]
pub fn run_worktree_key(run_id: &str) -> String {
    let prefix: String = run_id.chars().take(8).collect();
    format!("WF-{}", prefix.to_ascii_uppercase())
}

/// Resolves the repository's top-level directory for any path inside it, or `None` when not a repo.
pub async fn repository_root(folder: &Path) -> Option<String> {
    git_out(folder, &["rev-parse", "--show-toplevel"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Finds the branch created for `run_id` by its deterministic `WF-<run8>` prefix.
pub async fn find_run_branch(repo_root: &Path, run_id: &str) -> Option<String> {
    let key = run_worktree_key(run_id);
    let exact = format!("refs/heads/{key}");
    let pattern = format!("refs/heads/{key}-*");
    let out = git_out(
        repo_root,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            &exact,
            &pattern,
        ],
    )
    .await
    .ok()?;
    out.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

fn only_on_branch_args(branch: &str) -> Vec<String> {
    vec![
        branch.to_string(),
        "--not".to_string(),
        format!("--exclude={branch}"),
        "--branches".to_string(),
        "--remotes".to_string(),
    ]
}

/// Describes the work a run would leave behind if its record were deleted now.
pub async fn inspect_run_work(
    repo_root: &Path,
    run_id: &str,
    worktree_path: Option<&Path>,
) -> WorkflowRunWorkInfo {
    let branch = find_run_branch(repo_root, run_id).await;
    let mut info = WorkflowRunWorkInfo {
        branch: branch.clone(),
        commit_count: 0,
        commits: Vec::new(),
        worktree_path: None,
        uncommitted_files: 0,
        has_work: false,
    };

    if let Some(ref br) = branch {
        let branch_args = only_on_branch_args(br);
        let mut count_args = vec!["rev-list", "--count"];
        for arg in &branch_args {
            count_args.push(arg.as_str());
        }
        if let Ok(count_raw) = git_out(repo_root, &count_args).await {
            info.commit_count = count_raw.trim().parse::<u32>().unwrap_or(0);
        }

        let mut log_args = vec!["log", "--format=%h%x09%s", "--max-count=5"];
        for arg in &branch_args {
            log_args.push(arg.as_str());
        }
        if let Ok(log_raw) = git_out(repo_root, &log_args).await {
            info.commits = log_raw
                .lines()
                .filter(|line| !line.is_empty())
                .map(|line| {
                    let (sha, subject) = line.split_once('\t').unwrap_or((line, ""));
                    WorkflowRunCommitSummary {
                        sha: sha.to_string(),
                        subject: subject.to_string(),
                    }
                })
                .collect();
        }
    }

    if let Some(wt) = worktree_path {
        if wt.exists() {
            info.worktree_path = Some(wt.to_string_lossy().to_string());
            if let Ok(status_raw) = git_out(wt, &["status", "--porcelain"]).await {
                info.uncommitted_files =
                    status_raw.lines().filter(|l| !l.is_empty()).count() as u32;
            }
        }
    }

    info.has_work = info.commit_count > 0 || info.uncommitted_files > 0;
    info
}

/// Commits whatever a worktree has uncommitted so removing the checkout cannot throw it away.
pub async fn preserve_uncommitted_work(
    worktree_path: &Path,
    message: &str,
) -> Result<bool, String> {
    if !worktree_path.exists() {
        return Ok(false);
    }
    let status = git_out(worktree_path, &["status", "--porcelain"]).await?;
    if status.trim().is_empty() {
        return Ok(false);
    }
    git_out(worktree_path, &["add", "-A"]).await?;
    git_out(
        worktree_path,
        &[
            "-c",
            "user.name=Praxis",
            "-c",
            "user.email=praxis@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--no-verify",
            "-m",
            message,
        ],
    )
    .await?;
    Ok(true)
}

/// Restores a run's worktree back to an earlier commit's content as a new commit on top.
pub async fn restore_worktree_to(
    worktree_path: &Path,
    ref_sha: &str,
    message: &str,
) -> Result<bool, String> {
    let valid_sha =
        (7..=40).contains(&ref_sha.len()) && ref_sha.chars().all(|c| c.is_ascii_hexdigit());
    if !valid_sha {
        return Err(format!(
            "Refusing to restore to \"{ref_sha}\": not a commit id."
        ));
    }
    preserve_uncommitted_work(
        worktree_path,
        "WIP: changes left uncommitted before restoring the best iteration",
    )
    .await?;
    let commit_spec = format!("{ref_sha}^{{commit}}");
    git_out(worktree_path, &["cat-file", "-e", &commit_spec]).await?;
    let source_arg = format!("--source={ref_sha}");
    git_out(
        worktree_path,
        &["restore", &source_arg, "--staged", "--worktree", "--", ":/"],
    )
    .await?;
    let status = git_out(worktree_path, &["status", "--porcelain"]).await?;
    if status.trim().is_empty() {
        return Ok(false);
    }
    git_out(worktree_path, &["add", "-A"]).await?;
    git_out(
        worktree_path,
        &[
            "-c",
            "user.name=Praxis",
            "-c",
            "user.email=praxis@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--no-verify",
            "-m",
            message,
        ],
    )
    .await?;
    Ok(true)
}

/// Result of deleting a run's worktree and branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRunWorkResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_deleted: Option<String>,
    pub worktree_removed: bool,
}

/// Deletes the run's worktree and branch (`deleteRunWork` in `runWork.ts`).
pub async fn delete_run_work(
    repo_root: &Path,
    run_id: &str,
    worktree_path: Option<&Path>,
) -> Result<DeleteRunWorkResult, String> {
    let mut result = DeleteRunWorkResult {
        branch_deleted: None,
        worktree_removed: false,
    };

    if let Some(wt) = worktree_path {
        if wt.exists() {
            let wt_str = wt.to_string_lossy().to_string();
            if git_out(repo_root, &["worktree", "remove", "--force", &wt_str])
                .await
                .is_err()
            {
                let _ = std::fs::remove_dir_all(wt);
                let _ = git_out(repo_root, &["worktree", "prune"]).await;
            }
            result.worktree_removed = true;
        }
    }

    let Some(branch) = find_run_branch(repo_root, run_id).await else {
        return Ok(result);
    };

    let current = git_out(repo_root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .unwrap_or_default()
        .trim()
        .to_string();
    if current == branch {
        return Err(format!(
            "Branch {branch} is checked out in the main working tree, so it was not deleted."
        ));
    }

    git_out(repo_root, &["branch", "-D", &branch]).await?;
    result.branch_deleted = Some(branch);
    Ok(result)
}

/// Synchronous wrapper for [`inspect_run_work`].
pub fn inspect_run_work_sync(
    repo_root: &Path,
    run_id: &str,
    worktree_path: Option<&Path>,
) -> WorkflowRunWorkInfo {
    block_on_git(inspect_run_work(repo_root, run_id, worktree_path))
}

/// Synchronous wrapper for [`delete_run_work`].
pub fn delete_run_work_sync(
    repo_root: &Path,
    run_id: &str,
    worktree_path: Option<&Path>,
) -> Result<DeleteRunWorkResult, String> {
    block_on_git(delete_run_work(repo_root, run_id, worktree_path))
}
