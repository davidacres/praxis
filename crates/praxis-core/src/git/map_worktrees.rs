//! Map node fan-out worktrees and safe conflict-reverting merges (`mapWorktrees.ts`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::run_work::{preserve_uncommitted_work, run_worktree_key};

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

/// Resolves `HEAD` SHA in `cwd`.
pub async fn rev_parse_head(cwd: &Path) -> Option<String> {
    git_out(cwd, &["rev-parse", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Deterministic branch name for a map item (`wfitem-<run8>-<nodeId>-<index+1>`).
#[must_use]
pub fn map_item_branch(run_id: &str, node_id: &str, index: usize) -> String {
    let run_key = run_worktree_key(run_id);
    let stripped = run_key
        .strip_prefix("WF-")
        .unwrap_or(&run_key)
        .to_ascii_lowercase();
    let sanitized_node: String = node_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("wfitem-{stripped}-{sanitized_node}-{}", index + 1)
}

/// Creates a dedicated worktree and branch for a map item cut from `run_worktree`'s `HEAD`.
pub async fn create_item_worktree(run_worktree: &Path, branch: &str) -> Result<PathBuf, String> {
    let parent = run_worktree.parent().unwrap_or(run_worktree);
    let base_name = run_worktree
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("worktree");
    let item_path = parent.join(format!("{base_name}--{branch}"));
    let _ = std::fs::remove_dir_all(&item_path);
    let _ = git_out(run_worktree, &["worktree", "prune"]).await;
    let item_str = item_path.to_string_lossy().to_string();
    git_out(
        run_worktree,
        &["worktree", "add", "-B", branch, &item_str, "HEAD"],
    )
    .await?;
    Ok(item_path)
}

/// Preserves uncommitted work on a map item worktree and removes the worktree directory.
pub async fn release_item_worktree<F>(run_worktree: &Path, item_path: &Path, mut log: F)
where
    F: FnMut(&str),
{
    if let Err(err) =
        preserve_uncommitted_work(item_path, "WIP: changes left uncommitted by a map item").await
    {
        log(&format!(
            "Could not release map item worktree {}: {err}",
            item_path.display()
        ));
        return;
    }
    let item_str = item_path.to_string_lossy().to_string();
    if let Err(err) = git_out(run_worktree, &["worktree", "remove", "--force", &item_str]).await {
        log(&format!(
            "Could not release map item worktree {}: {err}",
            item_path.display()
        ));
    }
}

/// Result of merging a map item's branch back into the run's tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MergeItemBranchResult {
    Ok {
        ok: bool,
    },
    Conflict {
        ok: bool,
        conflicts: Vec<String>,
        detail: String,
    },
}

impl MergeItemBranchResult {
    #[must_use]
    pub fn success() -> Self {
        Self::Ok { ok: true }
    }

    #[must_use]
    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok { ok: true })
    }
}

/// Merges a map item's branch into `run_worktree`. On conflict, aborts the merge and returns conflicted paths.
pub async fn merge_item_branch(
    run_worktree: &Path,
    branch: &str,
    label: &str,
) -> Result<MergeItemBranchResult, String> {
    let range = format!("HEAD..{branch}");
    let ahead = git_out(run_worktree, &["rev-list", "--count", &range])
        .await?
        .trim()
        .to_string();
    if ahead == "0" {
        return Ok(MergeItemBranchResult::success());
    }

    let msg = format!("Merge map item: {label}");
    match git_out(
        run_worktree,
        &[
            "-c",
            "user.name=Praxis",
            "-c",
            "user.email=praxis@localhost",
            "-c",
            "commit.gpgsign=false",
            "merge",
            "--no-ff",
            "--no-edit",
            "-m",
            &msg,
            branch,
        ],
    )
    .await
    {
        Ok(_) => Ok(MergeItemBranchResult::success()),
        Err(err) => {
            let conflicts: Vec<String> =
                git_out(run_worktree, &["diff", "--name-only", "--diff-filter=U"])
                    .await
                    .unwrap_or_default()
                    .lines()
                    .filter(|l| !l.is_empty())
                    .map(ToString::to_string)
                    .collect();
            let _ = git_out(run_worktree, &["merge", "--abort"]).await;
            let detail = err.lines().next().unwrap_or(&err).to_string();
            Ok(MergeItemBranchResult::Conflict {
                ok: false,
                conflicts,
                detail,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::run_work::find_run_branch;
    use std::process::Command as StdCommand;
    use std::time::{SystemTime, UNIX_EPOCH};

    const RUN_ID: &str = "5a1e2b3c-0000-4000-8000-000000000001";

    fn git_sync(cwd: &Path, args: &[&str]) -> String {
        let out = StdCommand::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn commit_all(cwd: &Path, message: &str) {
        git_sync(cwd, &["add", "-A"]);
        git_sync(
            cwd,
            &[
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@example.com",
                "commit",
                "-m",
                message,
            ],
        );
    }

    #[tokio::test]
    async fn three_items_in_their_own_worktrees_merge_back_in_order_and_conflicting_one_is_backed_out()
     {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        // Parallel test threads can read the same timestamp; the counter keeps paths distinct.
        static NEXT_TEMP: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let sequence = NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "praxis-map-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("mkdir");

        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).expect("mkdir repo");
        git_sync(&repo, &["init", "--initial-branch=main"]);
        std::fs::write(repo.join("a.ts"), "export const a = 1;\n").expect("write a");
        std::fs::write(repo.join("b.ts"), "export const b = 1;\n").expect("write b");
        commit_all(&repo, "initial");

        let run_worktree = root.join("wt");
        let wt_str = run_worktree.to_string_lossy().to_string();
        git_sync(
            &repo,
            &["worktree", "add", "-b", "WF-5A1E2B3C-fan", &wt_str, "main"],
        );

        let branches: Vec<String> = (0..3)
            .map(|idx| map_item_branch(RUN_ID, "fix", idx))
            .collect();
        let mut paths = Vec::new();
        for branch in &branches {
            paths.push(
                create_item_worktree(&run_worktree, branch)
                    .await
                    .expect("create item wt"),
            );
        }

        std::fs::write(paths[0].join("a.ts"), "export const a = 2;\n").expect("write a0");
        commit_all(&paths[0], "fix a");
        std::fs::write(paths[1].join("b.ts"), "export const b = 2;\n").expect("write b1");
        commit_all(&paths[1], "fix b");
        std::fs::write(paths[2].join("a.ts"), "export const a = 3;\n").expect("write a2");
        commit_all(&paths[2], "also fix a");

        std::fs::write(paths[1].join("notes.txt"), "left behind\n").expect("write notes");
        for item_path in &paths {
            release_item_worktree(&run_worktree, item_path, |_| {}).await;
        }
        assert!(paths.iter().all(|p| !p.exists()));
        let b1_log = git_sync(&run_worktree, &["log", "--format=%s", "-1", &branches[1]]);
        assert!(b1_log.contains("WIP: changes left uncommitted by a map item"));

        assert!(
            merge_item_branch(&run_worktree, &branches[0], "A")
                .await
                .expect("merge 0")
                .is_ok()
        );
        assert!(
            merge_item_branch(&run_worktree, &branches[1], "B")
                .await
                .expect("merge 1")
                .is_ok()
        );
        let conflict = merge_item_branch(&run_worktree, &branches[2], "A again")
            .await
            .expect("merge 2");
        match conflict {
            MergeItemBranchResult::Conflict { ok, conflicts, .. } => {
                assert!(!ok);
                assert_eq!(conflicts, vec!["a.ts".to_string()]);
            }
            MergeItemBranchResult::Ok { .. } => panic!("expected conflict"),
        }

        assert_eq!(
            git_sync(&run_worktree, &["status", "--porcelain"]).trim(),
            ""
        );
        assert_eq!(
            std::fs::read_to_string(run_worktree.join("a.ts")).expect("read a"),
            "export const a = 2;\n"
        );
        assert_eq!(
            std::fs::read_to_string(run_worktree.join("b.ts")).expect("read b"),
            "export const b = 2;\n"
        );
        assert_eq!(
            find_run_branch(&repo, RUN_ID).await,
            Some("WF-5A1E2B3C-fan".to_string())
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
