//! The desktop workflow run engine (`workflowOrchestratorInstance.ts`, `workflowWorkspace.ts`,
//! `workflowCheckRunner.ts` port): wires the core orchestrator loop to real execution.
//!
//! Runs live in `workflows.json`; every transition is persisted and announced with
//! `workflows:runChanged`. Deterministic check stages run as child processes inside the run's git
//! worktree, which this module creates, re-attaches after a restart, and releases when the run settles.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use praxis_core::git::run_work::{preserve_uncommitted_work, restore_worktree_to, run_worktree_key};
use praxis_host::HostContext;
use praxis_workflows::check_process::{check_environment, is_check_command_available, spawn_check};
use praxis_workflows::orchestrator::{
    StageDispatchContext, StageDispatcher, StageOutcome, WorkflowOrchestrator,
    WorkflowOrchestratorOptions, WorkflowRunPersistence, WorkflowWorkspaceProvider,
};
use praxis_workflows::run::{DeclaredArtifact, WorkflowPauseReason, WorkflowRun};
use praxis_workflows::run::is_run_settled;
use praxis_workflows::types::{WorkflowAgentTaskNode, WorkflowCheckNode, WorkflowNode};
use serde_json::json;
use tokio::process::Command;

use super::workflow_agent_stage;
use super::workflow_env_failure::{CheckEnvironmentInput, classify_check_environment_failure};
use super::workflows;

/// Metadata Praxis writes into a checkout; it is not product source and never blocks a run.
const PRAXIS_METADATA_EXCLUDES: [&str; 4] = [
    ":(exclude).praxis/**",
    ":(exclude)project.praxis.md",
    ":(exclude)board.praxis.json",
    ":(exclude,glob)**/*.workspace.praxis.json",
];

fn is_workflow_metadata_path(value: &str) -> bool {
    let path = value.replace('\\', "/");
    path == "project.praxis.md"
        || path == "board.praxis.json"
        || path.ends_with(".workspace.praxis.json")
        || path.starts_with(".praxis/")
}

// ── git ──────────────────────────────────────────────────────────────────

async fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    git_raw(cwd, args).await.map(|out| out.trim().to_string())
}

/// Like [`git`] but leaves the output as git wrote it (porcelain lines start with a space).
async fn git_raw(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| format!("git {}: {e}", args.first().copied().unwrap_or("")))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {} failed", args.first().copied().unwrap_or(""))
        } else {
            stderr
        })
    }
}

/// Paths a worktree would leave out because they are uncommitted, ignoring Praxis metadata.
pub async fn base_blocking_paths(folder: &Path) -> Result<Vec<String>, String> {
    let status = git_raw(
        folder,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await?;
    let mut paths = Vec::new();
    for entry in status.split('\0').filter(|e| e.len() > 3) {
        let path = entry[3..].to_string();
        // A rename lists "to\0from"; the target is the changed file.
        if !is_workflow_metadata_path(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

/// The base checkout is the one thing parallel runs share: writes to it and merges into it take turns.
pub async fn base_checkout_guard(folder: &Path) -> tokio::sync::OwnedMutexGuard<()> {
    static LOCKS: OnceLock<Mutex<std::collections::HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let key = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    let lock = {
        let mut all = LOCKS
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Arc::clone(all.entry(key).or_default())
    };
    lock.lock_owned().await
}

/// Every path git reports as changed or untracked (`changedPaths`).
pub async fn changed_paths(folder: &Path) -> Result<Vec<String>, String> {
    let status = git_raw(folder, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]).await?;
    Ok(status
        .split('\0')
        .filter(|e| e.len() > 3)
        .map(|e| e[3..].to_string())
        .collect())
}

/// Commits what a Praxis write (a ticket move, say) changed since `before`, so the checkout does not
/// read as dirty and the schedule's next ticket can start (`commitPraxisWrite`).
pub async fn commit_praxis_write(folder: &Path, before: &[String], message: &str) -> Result<(), String> {
    let after = changed_paths(folder).await?;
    let fresh: Vec<String> = after.into_iter().filter(|p| !before.contains(p)).collect();
    if fresh.is_empty() {
        return Ok(());
    }
    commit_paths(folder, &fresh, message).await
}

/// Commits exactly `paths` (the product files a run would otherwise leave out) on the base checkout.
pub async fn commit_paths(folder: &Path, paths: &[String], message: &str) -> Result<(), String> {
    let mut add = vec!["add", "--"];
    add.extend(paths.iter().map(String::as_str));
    git(folder, &add).await?;
    let mut commit = vec![
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
        "--",
    ];
    commit.extend(paths.iter().map(String::as_str));
    git(folder, &commit).await?;
    Ok(())
}

/// `.worktrees/` stays out of `git status` in the base checkout via the repository's shared exclude.
async fn ensure_worktrees_excluded(repo_root: &Path) -> Result<(), String> {
    let common = git(repo_root, &["rev-parse", "--git-common-dir"]).await?;
    let exclude = repo_root.join(&common).join("info").join("exclude");
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    if current
        .lines()
        .any(|l| matches!(l.trim(), "/.worktrees/" | ".worktrees/" | ".worktrees"))
    {
        return Ok(());
    }
    if let Some(parent) = exclude.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let prefix = if !current.is_empty() && !current.ends_with('\n') { "\n" } else { "" };
    std::fs::write(
        &exclude,
        format!("{current}{prefix}# Praxis run worktrees\n/.worktrees/\n"),
    )
    .map_err(|e| e.to_string())
}

/// Commits the checkout's uncommitted work on top of HEAD without touching the tree or index.
async fn snapshot_uncommitted_work(repo_root: &Path, label: &str) -> Result<Option<String>, String> {
    let git_dir = git(repo_root, &["rev-parse", "--git-dir"]).await?;
    let git_dir = repo_root.join(git_dir);
    let temp_index = git_dir.join(format!("praxis-snapshot-{}.index", uuid::Uuid::new_v4()));
    let env = |cmd: &mut Command| {
        cmd.env("GIT_INDEX_FILE", &temp_index)
            .env("GIT_AUTHOR_NAME", "Praxis")
            .env("GIT_AUTHOR_EMAIL", "praxis@localhost")
            .env("GIT_COMMITTER_NAME", "Praxis")
            .env("GIT_COMMITTER_EMAIL", "praxis@localhost");
    };
    let run = |args: Vec<String>| {
        let mut cmd = Command::new("git");
        cmd.args(&args).current_dir(repo_root);
        env(&mut cmd);
        async move {
            let out = cmd.output().await.map_err(|e| e.to_string())?;
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
            }
        }
    };
    let result = async {
        let head = run(vec!["rev-parse".into(), "HEAD".into()]).await?;
        run(vec!["read-tree".into(), head.clone()]).await?;
        let mut add = vec!["add".into(), "-A".into(), "--".into(), ".".into()];
        add.extend(PRAXIS_METADATA_EXCLUDES.iter().map(|s| (*s).to_string()));
        run(add).await?;
        let tree = run(vec!["write-tree".into()]).await?;
        if tree == run(vec!["rev-parse".into(), format!("{head}^{{tree}}")]).await? {
            return Ok(None);
        }
        let commit = run(vec![
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

// ── persistence ──────────────────────────────────────────────────────────

struct FileRuns {
    host: HostContext,
}

#[async_trait]
impl WorkflowRunPersistence for FileRuns {
    fn get(&self, run_id: &str) -> Option<WorkflowRun> {
        workflows::stored_run(&self.host, run_id)
    }

    async fn save(&self, run: WorkflowRun) -> Result<WorkflowRun, String> {
        workflows::save_run_record(&self.host, run).map_err(|e| e.message)
    }
}

// ── workspace ────────────────────────────────────────────────────────────

struct GitWorkspace {
    host: HostContext,
}

impl GitWorkspace {
    fn name_for(run: &WorkflowRun) -> String {
        run.shared_delivery_branch
            .clone()
            .unwrap_or_else(|| run_worktree_key(&run.run_id))
    }
}

#[async_trait]
impl WorkflowWorkspaceProvider for GitWorkspace {
    async fn acquire(&self, run: &WorkflowRun) -> Result<String, String> {
        let folder = workflows::project_folder(&self.host, &run.project_id).ok_or_else(|| {
            format!(
                "Project {} has no workspace folder. Attach one before running a workflow.",
                run.project_id
            )
        })?;
        let base_branch = git(&folder, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .await
            .ok()
            .filter(|b| !b.is_empty())
            .ok_or("Could not determine a base branch for this run (detached HEAD?).")?;
        let repo_root = PathBuf::from(git(&folder, &["rev-parse", "--show-toplevel"]).await?);
        let name = Self::name_for(run);
        if !name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
            || name.contains("..")
        {
            return Err("The requested delivery branch name is invalid.".into());
        }
        // Branched in turn with other writes to the base, so a ticket move being committed for another
        // run is never mistaken for the person's uncommitted work.
        let _base = base_checkout_guard(&folder).await;
        let worktree_root = repo_root.join(".worktrees");
        let worktree_path = worktree_root.join(&name);
        std::fs::create_dir_all(&worktree_root).map_err(|e| e.to_string())?;
        ensure_worktrees_excluded(&repo_root).await?;

        if worktree_path.exists() {
            let current = git(&worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"])
                .await
                .unwrap_or_default();
            if current == name {
                return Ok(worktree_path.to_string_lossy().into_owned());
            }
            return Err(format!(
                "The delivery worktree path already exists: {}",
                worktree_path.display()
            ));
        }

        let branch_ref = format!("refs/heads/{name}");
        let path_text = worktree_path.to_string_lossy().into_owned();
        if git(&repo_root, &["rev-parse", "--verify", "--quiet", &branch_ref])
            .await
            .is_ok_and(|out| !out.is_empty())
        {
            git(
                &repo_root,
                &["-c", "core.symlinks=true", "worktree", "add", &path_text, &name],
            )
            .await?;
            return Ok(path_text);
        }

        let include_uncommitted = run
            .uncommitted_changes
            .is_some_and(|u| serde_json::to_value(u).ok() == Some(json!("include")));
        if run.uncommitted_changes.is_none() {
            let changed = base_blocking_paths(&repo_root).await?.len();
            if changed > 0 {
                return Err(format!(
                    "Cannot start a governed workflow from a checkout with {changed} uncommitted {}. Workflow worktrees branch from committed HEAD, so those changes would be omitted from implementation and QA. Commit or stash them, then start the run again.",
                    if changed == 1 { "file" } else { "files" }
                ));
            }
        }
        let mut start = match git(&repo_root, &["rev-parse", "--verify", &base_branch]).await {
            Ok(r) => r,
            Err(_) => git(
                &repo_root,
                &["rev-parse", "--verify", &format!("origin/{base_branch}")],
            )
            .await
            .map_err(|_| format!("Base branch {base_branch} was not found locally or on origin."))?,
        };
        if include_uncommitted {
            if let Some(snapshot) = snapshot_uncommitted_work(&repo_root, &name).await? {
                start = snapshot;
            }
        }
        git(
            &repo_root,
            &[
                "-c",
                "core.symlinks=true",
                "worktree",
                "add",
                "-b",
                &name,
                &path_text,
                &start,
            ],
        )
        .await?;
        Ok(path_text)
    }

    async fn base_ref(
        &self,
        _run: &WorkflowRun,
        worktree_path: &str,
    ) -> Result<Option<String>, String> {
        Ok(git(Path::new(worktree_path), &["rev-parse", "HEAD"])
            .await
            .ok()
            .filter(|sha| sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit())))
    }

    async fn release(&self, run: &WorkflowRun) -> Result<(), String> {
        let Some(worktree) = run.worktree_path.as_deref() else {
            return Ok(());
        };
        let Some(folder) = workflows::project_folder(&self.host, &run.project_id) else {
            return Ok(());
        };
        // Removing a checkout with `--force` discards anything uncommitted, so keep it first.
        preserve_uncommitted_work(
            Path::new(worktree),
            &format!(
                "WIP: changes left uncommitted when the run ended ({})",
                serde_json::to_value(run.status)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default()
            ),
        )
        .await?;
        // The branch is where the run's work lives; only the checkout goes.
        git(&folder, &["worktree", "remove", "--force", worktree]).await?;
        Ok(())
    }

    fn can_restore(&self) -> bool {
        true
    }

    async fn restore(&self, run: &WorkflowRun, reference: &str) -> Result<(), String> {
        let worktree = run
            .worktree_path
            .as_deref()
            .ok_or("The run has no worktree to restore.")?;
        restore_worktree_to(
            Path::new(worktree),
            reference,
            &format!("Restore {} (best so far)", &reference[..reference.len().min(7)]),
        )
        .await?;
        Ok(())
    }
}

// ── dispatcher ───────────────────────────────────────────────────────────

struct HostDispatcher {
    host: HostContext,
}

const OUTPUT_TAIL_LIMIT: usize = 8000;

/// The last part of a failing log, starting at a recognisable failure marker when there is one.
fn tail(output: &str) -> String {
    for marker in ["\n  1) ", "\n✖ failing tests:", "\nFAIL ", "\nFAILED "] {
        if let Some(idx) = output.rfind(marker) {
            if output.len() - idx <= 12000 {
                return format!("…{}", &output[idx..]);
            }
        }
    }
    if output.len() > OUTPUT_TAIL_LIMIT {
        let mut start = output.len() - OUTPUT_TAIL_LIMIT;
        while !output.is_char_boundary(start) {
            start += 1;
        }
        format!("…{}", &output[start..])
    } else {
        output.to_string()
    }
}

async fn head_sha(cwd: &Path) -> Option<String> {
    let sha = git(cwd, &["rev-parse", "HEAD"]).await.ok()?;
    (sha.len() >= 7 && sha.chars().all(|c| c.is_ascii_hexdigit())).then_some(sha)
}

fn evidence_root(host: &HostContext) -> PathBuf {
    host.config().user_data_dir.join("workflow-evidence")
}

fn evidence_attempt(run: &WorkflowRun, node_id: &str) -> usize {
    run.nodes.get(node_id).map_or(1, |n| n.attempts.len().max(1))
}

/// Retains a node attempt's combined log as an evidence bundle; the stored file when there is one.
fn retain_evidence(
    host: &HostContext,
    run: &WorkflowRun,
    node_id: &str,
    source_sha: Option<&str>,
    captured: &super::workflow_evidence::Captured,
) -> Result<Option<PathBuf>, String> {
    super::workflow_evidence::write_log_bundle(
        &evidence_root(host),
        &super::workflow_evidence::EvidenceKey {
            project_id: &run.project_id,
            run_id: &run.run_id,
            node_id,
            attempt: evidence_attempt(run, node_id),
        },
        source_sha,
        captured,
    )
}

const PACKAGE_MANAGERS: [&str; 4] = ["npm", "pnpm", "yarn", "bun"];

fn program_of(command: &str) -> String {
    let base = Path::new(command)
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let lower = base.to_lowercase();
    lower
        .strip_suffix(".cmd")
        .or_else(|| lower.strip_suffix(".exe"))
        .unwrap_or(&lower)
        .to_string()
}

/// The workflow's install stage: a check that runs a package manager's `ci` or `install`.
pub fn install_stage_of(nodes: &[WorkflowNode]) -> Option<&WorkflowCheckNode> {
    nodes.iter().find_map(|node| match node {
        WorkflowNode::Check(check)
            if PACKAGE_MANAGERS.contains(&program_of(&check.command).as_str())
                && check
                    .args
                    .as_ref()
                    .and_then(|a| a.first())
                    .is_some_and(|a| matches!(a.as_str(), "ci" | "install" | "i")) =>
        {
            Some(check)
        }
        _ => None,
    })
}

/// The workflow's build stage: a check that runs a package manager's `build` script.
pub fn build_stage_of(nodes: &[WorkflowNode]) -> Option<&WorkflowCheckNode> {
    nodes.iter().find_map(|node| match node {
        WorkflowNode::Check(check)
            if PACKAGE_MANAGERS.contains(&program_of(&check.command).as_str())
                && check.args.as_ref().is_some_and(|a| {
                    a.first().is_some_and(|x| x == "run") && a.get(1).is_some_and(|x| x == "build")
                }) =>
        {
            Some(check)
        }
        _ => None,
    })
}

/// A package-manager project whose worktree has no completed install yet.
fn needs_install(worktree: &Path) -> bool {
    if !worktree.join("package.json").exists() {
        return false;
    }
    ![
        "node_modules/.package-lock.json",
        "node_modules/.modules.yaml",
        "node_modules/.yarn-state.yml",
        "node_modules/.yarn-integrity",
    ]
    .iter()
    .any(|marker| worktree.join(marker).exists())
}

fn describe_failure(result: &praxis_workflows::check_process::CheckProcessResult) -> String {
    let why = if result.timed_out {
        "it timed out".to_string()
    } else if let Some(code) = result.code {
        format!("it exited with code {code}")
    } else {
        result.error.clone().unwrap_or_else(|| "it did not start".to_string())
    };
    let lines: Vec<&str> = result.output.trim().lines().collect();
    let tail = lines[lines.len().saturating_sub(15)..].join("\n");
    if tail.is_empty() { format!("{why}.") } else { format!("{why}.\n{tail}") }
}

impl HostDispatcher {
    /// Merges the run's branch into the target branch of the base checkout (`runWorkflowMerge`).
    async fn merge_into_base(
        &self,
        node: &praxis_workflows::types::WorkflowMergeNode,
        context: &StageDispatchContext,
        folder: &Path,
    ) -> Result<StageOutcome, String> {
        let run = &context.run;
        let Some(root) = praxis_core::git::run_work::repository_root(folder).await else {
            return Ok(StageOutcome::failure("No Git repository found for this project."));
        };
        let root = PathBuf::from(root);
        // Whatever the run's worktree left uncommitted is kept before the branch is merged.
        if let Some(worktree) = &context.worktree_path {
            let _ = preserve_uncommitted_work(Path::new(worktree), "WIP: preserve changes for merge").await;
        }
        let source = match &run.shared_delivery_branch {
            Some(branch) => branch.clone(),
            None => praxis_core::git::run_work::find_run_branch(&root, &run.run_id)
                .await
                .unwrap_or_else(|| run_worktree_key(&run.run_id)),
        };
        let target = match node.target_branch.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            Some(t) => t.to_string(),
            None => git(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await.ok().filter(|b| !b.is_empty()).unwrap_or_else(|| "main".to_string()),
        };
        let mut log = format!("Initiating merge of branch {source} into {target}...\n");
        let evidence = |log: &str| {
            let (content, redacted) = super::workflow_evidence::redact(log);
            let _ = retain_evidence(
                &self.host,
                run,
                &node.base.id,
                None,
                &super::workflow_evidence::Captured { content: Some(content), missing_reason: None, redacted },
            );
        };
        if git(&root, &["rev-parse", "--verify", &source]).await.is_err() {
            log.push_str(&format!("Source branch {source} was not found in the repository.\n"));
            evidence(&log);
            return Ok(StageOutcome::failure(format!("Source branch {source} was not found.")));
        }
        // Praxis's own metadata is not work the merge could lose, the same rule the start-of-run check uses.
        let dirty = base_blocking_paths(&root).await?;
        if !dirty.is_empty() {
            log.push_str(&format!("Target checkout has uncommitted changes:\n{}\nCannot safely merge into dirty checkout.\n", dirty.join("\n")));
            evidence(&log);
            return Ok(StageOutcome::failure(
                "Target checkout contains uncommitted changes. Please commit or stash them before merging.",
            ));
        }
        let current = git(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await.unwrap_or_default();
        if current != target {
            log.push_str(&format!("Switching checkout to {target}...\n"));
            if git(&root, &["checkout", &target]).await.is_err() {
                evidence(&log);
                return Ok(StageOutcome::failure(format!("Could not switch to target branch {target}.")));
            }
        }
        let message = format!(
            "Merge delivery run {}: {}",
            &run.run_id[..run.run_id.len().min(8)],
            run.definition.name
        );
        let mut args = vec!["-c", "user.name=Praxis", "-c", "user.email=praxis@localhost", "-c", "commit.gpgsign=false", "merge"];
        if node.no_fast_forward != Some(false) {
            args.push("--no-ff");
        }
        args.extend(["-m", &message, &source]);
        log.push_str(&format!("$ git {}\n", args.join(" ")));
        match git(&root, &args).await {
            Ok(output) => {
                log.push_str(&output);
                log.push_str(&format!("\nMerge succeeded cleanly into {target}.\n"));
                evidence(&log);
                Ok(StageOutcome { succeeded: true, exit_code: Some(0), ..StageOutcome::default() })
            }
            Err(error) => {
                log.push_str(&error);
                let conflicted: Vec<String> = git(&root, &["diff", "--name-only", "--diff-filter=U"])
                    .await
                    .unwrap_or_default()
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
                log.push_str("\nMerge conflict encountered!\n");
                let _ = git(&root, &["merge", "--abort"]).await;
                log.push_str("Merge aborted cleanly.\n");
                evidence(&log);
                Ok(StageOutcome {
                    error: Some(format!(
                        "Merge conflict in {} file(s): {}. Nothing was merged. Choose \"Let AI resolve the conflicts\" on the run, or resolve them yourself and retry.",
                        conflicted.len(),
                        conflicted.join(", ")
                    )),
                    exit_code: Some(1),
                    conflict_files: Some(conflicted),
                    ..StageOutcome::default()
                })
            }
        }
    }

    /// Gives a run's worktree its dependencies, and its build output, before its first stage works
    /// in it (`ensureRunDependencies`). Resolves to an error message when the install failed.
    async fn ensure_run_dependencies(
        &self,
        context: &StageDispatchContext,
        stage_name: &str,
    ) -> Option<String> {
        let nodes = &context.run.definition.nodes;
        let worktree = PathBuf::from(context.worktree_path.as_deref()?);
        let node = install_stage_of(nodes)?;
        if !needs_install(&worktree) {
            return None;
        }
        // `npm ci` empties whatever a node_modules link points at, so a link out of the worktree goes first.
        let _ = praxis_core::git::worktree_dependency_links::remove_escaping_dependency_links(&worktree).await;
        let vars: Vec<(String, String)> = std::env::vars().collect();
        let env = |id: &str| {
            check_environment(id, vars.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        };
        let command_of = |n: &WorkflowCheckNode| {
            let mut parts = vec![n.command.clone()];
            parts.extend(n.args.clone().unwrap_or_default());
            parts.join(" ")
        };
        let log = |message: &str| {
            context.reporter.report_progress(message);
            eprintln!("[workflow {}] {stage_name}: {message}", context.run.run_id);
        };
        let command = command_of(node);
        log(&format!("Installing dependencies in this run's worktree first ({command})."));
        let result = spawn_check(node, &worktree, &env(&node.base.id), Some(&context.cancel), None).await;
        if context.cancel.is_cancelled() {
            return None;
        }
        let ok = result.code.is_some_and(|c| {
            node.success_exit_codes
                .clone()
                .filter(|codes| !codes.is_empty())
                .unwrap_or_else(|| vec![0])
                .contains(&c)
        });
        if !ok {
            return Some(format!(
                "Could not install this run's dependencies ({command}): {}",
                describe_failure(&result)
            ));
        }
        log("Dependencies installed.");
        let build = build_stage_of(nodes)?;
        let build_command = command_of(build);
        log(&format!("Building this run's worktree ({build_command})."));
        let built = spawn_check(build, &worktree, &env(&build.base.id), Some(&context.cancel), None).await;
        if context.cancel.is_cancelled() {
            return None;
        }
        let built_ok = built.code.is_some_and(|c| {
            build
                .success_exit_codes
                .clone()
                .filter(|codes| !codes.is_empty())
                .unwrap_or_else(|| vec![0])
                .contains(&c)
        });
        log(&if built_ok {
            "Build finished.".to_string()
        } else {
            format!(
                "The build failed ({build_command}): {} Stages start without its output; the workflow's Build stage runs it again later.",
                describe_failure(&built)
            )
        });
        None
    }

    async fn run_check_node(
        &self,
        node: &WorkflowCheckNode,
        context: &StageDispatchContext,
    ) -> Result<StageOutcome, String> {
        let fallback = workflows::project_folder(&self.host, &context.run.project_id);
        let Some(cwd) = context
            .worktree_path
            .as_ref()
            .map(PathBuf::from)
            .or(fallback)
        else {
            return Ok(StageOutcome::failure(
                "This check has no working directory; attach a folder to the project.",
            ));
        };
        if node.command.trim().is_empty() {
            return Ok(StageOutcome::failure("This check has no command."));
        }
        if context.worktree_path.is_some()
            && install_stage_of(&context.run.definition.nodes).is_none_or(|n| n.base.id != node.base.id)
        {
            if let Some(error) = self.ensure_run_dependencies(context, &node.base.name).await {
                return Ok(StageOutcome::failure(error));
            }
        }
        let success_codes: Vec<i32> = node
            .success_exit_codes
            .clone()
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| vec![0]);
        let vars: Vec<(String, String)> = std::env::vars().collect();
        let env = check_environment(
            &node.base.id,
            vars.iter().map(|(k, v)| (k.as_str(), v.as_str())),
        );
        let reporter = context.reporter.clone();
        let mut on_line = move |line: &str| {
            let trimmed = line.trim();
            if trimmed.starts_with(['✓', '✔', '✘', '✗', '×']) {
                reporter.report_progress(&format!("QA test: {trimmed}"));
            }
        };
        let result = spawn_check(
            node,
            &cwd,
            &env,
            Some(&context.cancel),
            Some(&mut on_line),
        )
        .await;

        // Whatever the check emitted is evidence, even when it was stopped or timed out.
        let spawn_failed = result.code.is_none() && !result.timed_out && !context.cancel.is_cancelled();
        // Redact before this becomes evidence at all, and before the tail below can land raw in a
        // run's own error text: a check's output can echo a secret from the environment.
        let (redacted_output, redacted) = super::workflow_evidence::redact(&result.output);
        let source_sha = head_sha(&cwd).await;
        let captured = if spawn_failed {
            super::workflow_evidence::Captured {
                content: None,
                missing_reason: Some(
                    result.error.clone().unwrap_or_else(|| format!("Could not start {}.", node.command)),
                ),
                redacted: false,
            }
        } else {
            super::workflow_evidence::Captured {
                content: Some(redacted_output.clone()),
                missing_reason: None,
                redacted,
            }
        };
        let stored = retain_evidence(&self.host, &context.run, &node.base.id, source_sha.as_deref(), &captured);
        let log_path = stored.as_ref().ok().cloned().flatten();
        let artifacts: Vec<DeclaredArtifact> = match &log_path {
            Some(log_path) => node
                .outputs
                .iter()
                .map(|contract| DeclaredArtifact {
                    contract_id: contract.id.clone(),
                    kind: contract.kind,
                    path: Some(log_path.to_string_lossy().into_owned()),
                    artifact_id: None,
                    reference: None,
                })
                .collect(),
            None => Vec::new(),
        };

        let mut outcome = StageOutcome::default();
        if result.timed_out {
            outcome.error = Some(format!(
                "Check timed out after {}ms.",
                node.timeout_ms.unwrap_or(0)
            ));
            outcome.artifacts = Some(artifacts);
            return Ok(outcome);
        }
        let args_list: Vec<String> = node.args.clone().unwrap_or_default();
        if spawn_failed {
            let message = result.error.clone().unwrap_or_default();
            let missing_reason = if message.is_empty() {
                format!("Could not start {}.", node.command)
            } else {
                message.clone()
            };
            let env_failure = classify_check_environment_failure(&CheckEnvironmentInput {
                command: &node.command,
                args: &args_list,
                exit_code: None,
                output: "",
                spawn_error: &format!("{message} {missing_reason}"),
            });
            outcome.error = Some(match &env_failure {
                Some(f) => format!("{missing_reason} {}", f.hint),
                None => missing_reason,
            });
            outcome.pause = env_failure.map(|_| WorkflowPauseReason::Environment);
            outcome.artifacts = Some(Vec::new());
            return Ok(outcome);
        }
        if let Some(error) = &result.error {
            outcome.error = Some(error.clone());
            outcome.artifacts = Some(artifacts);
            return Ok(outcome);
        }
        if result.code.is_some_and(|c| success_codes.contains(&c)) {
            outcome.succeeded = true;
            outcome.exit_code = result.code.map(i64::from);
            outcome.artifacts = Some(artifacts);
            return Ok(outcome);
        }
        let code = result
            .code
            .map_or("without a code".to_string(), |c| c.to_string());
        let body = if redacted_output.trim().is_empty() {
            ".".to_string()
        } else {
            format!(":\n{}", tail(&redacted_output))
        };
        // A non-zero exit is usually the check's verdict. When the output shows the tool itself could
        // not do its job it is not: pause the run instead of failing it and spending the attempt.
        let env_failure = classify_check_environment_failure(&CheckEnvironmentInput {
            command: &node.command,
            args: &args_list,
            exit_code: result.code,
            output: &redacted_output,
            spawn_error: "",
        });
        let prefix = env_failure
            .as_ref()
            .map(|f| format!("{} {}\n\n", f.reason, f.hint))
            .unwrap_or_default();
        outcome.pause = env_failure.map(|_| WorkflowPauseReason::Environment);
        outcome.error = Some(format!("{prefix}{} exited {code}{body}", node.command));
        outcome.exit_code = result.code.map(i64::from);
        outcome.artifacts = Some(artifacts);
        Ok(outcome)
    }
}

#[async_trait]
impl StageDispatcher for HostDispatcher {
    fn can_dispatch(&self, node: &WorkflowNode, run: &WorkflowRun) -> bool {
        // Everything needs somewhere to run; a stage this declines stays `ready` for the monitor.
        if workflows::project_folder(&self.host, &run.project_id).is_none() {
            return false;
        }
        match node {
            WorkflowNode::Check(_) => true,
            WorkflowNode::AgentTask(_) => workflow_agent_stage::can_dispatch(&self.host),
            WorkflowNode::Merge(_) => true,
            _ => false,
        }
    }

    async fn run_check(
        &self,
        node: &WorkflowCheckNode,
        context: &StageDispatchContext,
    ) -> Result<StageOutcome, String> {
        self.run_check_node(node, context).await
    }

    async fn run_agent_stage(
        &self,
        node: &WorkflowAgentTaskNode,
        context: &StageDispatchContext,
    ) -> Result<StageOutcome, String> {
        if context.worktree_path.is_some() {
            if let Some(error) = self.ensure_run_dependencies(context, &node.base.name).await {
                return Ok(StageOutcome::failure(error));
            }
        }
        workflow_agent_stage::run_agent_stage(&self.host, node, context).await
    }

    async fn run_merge(
        &self,
        node: &praxis_workflows::types::WorkflowMergeNode,
        context: &StageDispatchContext,
    ) -> Result<StageOutcome, String> {
        let Some(folder) = workflows::project_folder(&self.host, &context.run.project_id) else {
            return Ok(StageOutcome::failure("No Git repository found for this project."));
        };
        // Merges into one base checkout never overlap, whichever runs (or parallel lanes) start them.
        let _base = base_checkout_guard(&folder).await;
        let outcome = self.merge_into_base(node, context, &folder).await;
        // E2E only: hold the checkout a little longer, so a spec can tell turns from overlap.
        if let Some(ms) = std::env::var("PRAXIS_E2E_MERGE_HOLD_MS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|ms| *ms > 0) {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        }
        outcome
    }

    async fn cancel_stage(&self, node_id: &str, run: &WorkflowRun) -> Result<(), String> {
        let key = super::workflow_summary::stage_session_key(&run.run_id, node_id);
        super::acp_host::abort_task(&self.host, &self.host.config().user_data_dir, &key);
        Ok(())
    }
}

/// For the `switch` policy: the next usable AI for a stage, skipping the one that ran out, every
/// AI that ran out in this run and, for an independent reviewer, the AI that wrote the work it judges
/// (`fallbackProviderForStage`).
struct HostFallbackProvider {
    host: HostContext,
}

#[async_trait]
impl praxis_workflows::orchestrator::FallbackProviderChooser for HostFallbackProvider {
    async fn choose(&self, run: &WorkflowRun, node_id: &str) -> Option<String> {
        use praxis_workflows::run::{exhausted_providers, provider_can_run_stage, stage_provider};
        let active = self.host.settings().read().ai.active_provider.clone();
        let current = stage_provider(
            run,
            node_id,
            run.ai_provider.as_deref().filter(|p| !p.is_empty()).unwrap_or(&active),
        );
        let mut exclude = vec![current];
        exclude.extend(exhausted_providers(run));
        if let Some(WorkflowNode::AgentTask(task)) = run.definition.nodes.iter().find(|n| n.base().id == node_id)
            && let Some(author) = task.independent_of.as_deref()
            && let Some(latest) = run
                .nodes
                .get(author)
                .and_then(|state| state.attempts.iter().rev().find(|a| a.provider.is_some() && a.pause.is_none()))
            && let Some(provider) = &latest.provider
        {
            exclude.push(provider.clone());
        }
        let mut order: Vec<String> = run.ai_provider.iter().filter(|p| !p.is_empty()).cloned().collect();
        order.push(active);
        let usable = super::scheduled_runner_host::usable_providers(&self.host);
        order.extend(usable.iter().cloned());
        let mut seen = std::collections::HashSet::new();
        order
            .into_iter()
            .filter(|id| seen.insert(id.clone()) && usable.contains(id))
            .find(|id| !exclude.contains(id) && provider_can_run_stage(run, node_id, id))
    }
}

// ── engine ───────────────────────────────────────────────────────────────

pub struct Engine {
    orchestrator: WorkflowOrchestrator,
}

impl Engine {
    pub fn orchestrator(&self) -> &WorkflowOrchestrator {
        &self.orchestrator
    }
}

/// The process-wide orchestrator, created on first use.
pub fn engine(host: &HostContext) -> &'static Engine {
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    ENGINE.get_or_init(|| {
        let events_host = host.clone();
        Engine {
            orchestrator: WorkflowOrchestrator::new(WorkflowOrchestratorOptions {
                runs: Arc::new(FileRuns { host: host.clone() }),
                dispatcher: Arc::new(HostDispatcher { host: host.clone() }),
                workspace: Some(Arc::new(GitWorkspace { host: host.clone() })),
                on_run_changed: Some(Arc::new(move |run: &WorkflowRun| {
                    super::task_notifications::run_changed(run);
                    events_host
                        .events()
                        .emit("workflows:runChanged", Some(json!(run.run_id)));
                    // A schedule that launched this run reacts to what it did.
                    if run.scheduled_launch_token.is_some() {
                        super::scheduled_runner_host::workflow_changed(&events_host, &run.run_id);
                    }
                    if is_run_settled(run) {
                        super::workflow_write_back::write_back(&events_host, run);
                    }
                })),
                choose_fallback_provider: Some(Arc::new(HostFallbackProvider { host: host.clone() })),
                now: None,
            }),
        }
    })
}

/// Advances a run in the background (the TS `void orchestrator.step(runId)`).
pub fn step_in_background(host: &HostContext, run_id: &str) {
    let orchestrator = engine(host).orchestrator.clone();
    let run_id = run_id.to_string();
    super::runtime::runtime().spawn(async move { orchestrator.step(&run_id).await });
}

/// Checks that each check stage's command exists, naming those that do not (`missingCheckTools`).
pub fn missing_check_tools_message(definition_nodes: &[WorkflowNode]) -> Option<String> {
    let path = std::env::var("PATH").ok();
    let path_ext = std::env::var("PATHEXT").ok();
    let mut missing: Vec<(String, Vec<String>)> = Vec::new();
    let mut checked: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    for node in definition_nodes {
        let WorkflowNode::Check(check) = node else { continue };
        let command = check.command.trim().to_string();
        if command.is_empty() {
            continue;
        }
        let absolute = command.starts_with('/')
            || command.starts_with("\\\\")
            || (command.len() > 2
                && command.as_bytes()[0].is_ascii_alphabetic()
                && command.as_bytes()[1] == b':'
                && matches!(command.as_bytes()[2], b'/' | b'\\'));
        if !absolute && (command.contains('/') || command.contains('\\')) {
            continue;
        }
        let available = *checked.entry(command.clone()).or_insert_with(|| {
            is_check_command_available(&command, path.as_deref(), path_ext.as_deref())
        });
        if available {
            continue;
        }
        let stage = if check.base.name.is_empty() {
            check.base.id.clone()
        } else {
            check.base.name.clone()
        };
        match missing.iter_mut().find(|(c, _)| *c == command) {
            Some((_, stages)) => stages.push(stage),
            None => missing.push((command, vec![stage])),
        }
    }
    if missing.is_empty() {
        return None;
    }
    let lines: Vec<String> = missing
        .iter()
        .map(|(command, stages)| {
            format!(
                "{command} (needed by {}): {}.",
                stages.join(", "),
                install_hint(command)
            )
        })
        .collect();
    let noun = if missing.len() == 1 { "a tool that is" } else { "tools that are" };
    Some(format!(
        "Cannot start this workflow: its check stages need {noun} not installed. {} Then try again, or change or remove those stages in the workflow.",
        lines.join(" ")
    ))
}

fn install_hint(command: &str) -> String {
    let mac = cfg!(target_os = "macos");
    let win = cfg!(windows);
    let hint = match command {
        "semgrep" => Some(if mac { "brew install semgrep" } else { "pipx install semgrep (or pip install semgrep)" }),
        "gitleaks" => Some(if mac { "brew install gitleaks" } else if win { "scoop install gitleaks" } else { "download a release from https://github.com/gitleaks/gitleaks/releases" }),
        "osv-scanner" => Some(if mac { "brew install osv-scanner" } else { "go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest" }),
        "trivy" => Some(if mac { "brew install trivy" } else { "see https://trivy.dev/latest/getting-started/installation/" }),
        "license-checker" => Some("npm install -g license-checker"),
        "ruff" => Some(if mac { "brew install ruff" } else { "pipx install ruff" }),
        "mypy" => Some("pipx install mypy"),
        "pytest" => Some("pip install pytest pytest-cov"),
        "behave" => Some("pip install behave"),
        "dotnet" => Some("install the .NET SDK from https://dotnet.microsoft.com/download"),
        _ => None,
    };
    hint.map_or_else(
        || format!("install {command} and make sure it is on your PATH"),
        str::to_string,
    )
}

/// Serialises read-modify-write of the runs document across handlers and the engine.
pub fn runs_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_paths_never_block_a_run() {
        assert!(is_workflow_metadata_path(".praxis/workflows/a.json"));
        assert!(is_workflow_metadata_path("project.praxis.md"));
        assert!(is_workflow_metadata_path("x/y.workspace.praxis.json"));
        assert!(!is_workflow_metadata_path("build.js"));
    }

    #[test]
    fn a_failing_log_is_trimmed_to_its_failure_marker() {
        let log = format!("{}\n  1) the broken test\nstack", "noise\n".repeat(5000));
        let shown = tail(&log);
        assert!(shown.starts_with("…\n  1) the broken test"));
    }

    #[test]
    fn unknown_tools_get_a_generic_install_hint() {
        assert_eq!(
            install_hint("frobnicate"),
            "install frobnicate and make sure it is on your PATH"
        );
    }
}
