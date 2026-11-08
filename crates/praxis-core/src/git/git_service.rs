//! Full Git repository service (`apps/praxis-desktop/main/src/main/gitService.ts`) backed by `tokio::process::Command`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, TimeZone, Utc};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::git_graph::{
    GitBlameLine, GitCommitChangedFile, GitCommitDetails, GitCommitInput, GitComparisonKind,
    GitConflictFile, GitConflictResolution, GitDiffDocument, GitDiffRequest, GitDiffResult,
    GitFileContent, GitFileHistoryEntry, GitHunkAction, GitHunkActionRequest,
    GitRepositoryOperation, GitRepositoryPreflight, GitRepositoryPreflightStatus,
    GitRepositorySnapshot, GitStatusSnapshot, build_commit_graph,
};
use super::git_parsing::{
    parse_git_branches, parse_git_diff, parse_git_log, parse_git_status, parse_git_tags,
};
use super::git_worktree_manager::block_on_git;

const MAX_COMMITS: usize = 5000;
const MAX_FILE_VIEW_BYTES: usize = 1_000_000;
const CACHE_TTL: Duration = Duration::from_millis(1500);

#[derive(Clone)]
struct CachedSnapshot {
    snapshot: GitRepositorySnapshot,
    cached_at: Instant,
}

/// Stateful Git CLI service with a short-lived snapshot cache (`CACHE_TTL_MS = 1500`).
#[derive(Clone, Default)]
pub struct GitService {
    configured_executable: Arc<Mutex<String>>,
    cache: Arc<Mutex<HashMap<String, CachedSnapshot>>>,
}

impl std::fmt::Debug for GitService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitService").finish_non_exhaustive()
    }
}

impl GitService {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_executable(executable_path: impl Into<String>) -> Self {
        Self {
            configured_executable: Arc::new(Mutex::new(executable_path.into())),
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn set_configured_executable(&self, executable_path: impl Into<String>) {
        if let Ok(mut guard) = self.configured_executable.lock() {
            *guard = executable_path.into();
        }
    }

    fn git_executable(&self) -> String {
        if let Ok(env_path) = std::env::var("PRAXIS_GIT_PATH") {
            let trimmed = env_path.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if let Ok(guard) = self.configured_executable.lock() {
            let trimmed = guard.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        "git".to_string()
    }

    fn format_git_error(args: &[String], detail: &str) -> String {
        let prefix: Vec<&str> = args.iter().take(2).map(String::as_str).collect();
        format!("Git could not complete “{}”: {}", prefix.join(" "), detail)
    }

    async fn git(&self, args: &[String], cwd: &Path) -> Result<String, String> {
        let executable = self.git_executable();
        let output = Command::new(&executable)
            .args(args)
            .current_dir(cwd)
            .output()
            .await
            .map_err(|err| Self::format_git_error(args, &err.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let msg = if stderr.is_empty() {
                format!("exit status {}", output.status)
            } else {
                stderr
            };
            return Err(Self::format_git_error(args, &msg));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    async fn git_strs(&self, args: &[&str], cwd: &Path) -> Result<String, String> {
        let owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
        self.git(&owned, cwd).await
    }

    async fn git_with_input(
        &self,
        args: &[String],
        cwd: &Path,
        input: &str,
    ) -> Result<String, String> {
        let executable = self.git_executable();
        let mut child = Command::new(&executable)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| Self::format_git_error(args, &err.to_string()))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(input.as_bytes())
                .await
                .map_err(|err| Self::format_git_error(args, &err.to_string()))?;
            let _ = stdin.shutdown().await;
        }

        let output = child
            .wait_with_output()
            .await
            .map_err(|err| Self::format_git_error(args, &err.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let code_msg = output
                .status
                .code()
                .map_or_else(|| "terminated".to_string(), |c| format!("exit code {c}"));
            let msg = if stderr.is_empty() { code_msg } else { stderr };
            return Err(Self::format_git_error(args, &msg));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    async fn resolve_repository(&self, input: &str) -> Result<String, String> {
        let candidate = input.trim();
        if candidate.is_empty() {
            return Err(
                "No repository path was supplied. Open Git from a project with a workspace folder."
                    .to_string(),
            );
        }
        let out = self
            .git_strs(&["rev-parse", "--show-toplevel"], Path::new(candidate))
            .await?;
        Ok(out.trim().to_string())
    }

    fn invalidate_cache(&self, repository_path: &str) {
        if let Ok(mut guard) = self.cache.lock() {
            guard.remove(repository_path);
        }
    }

    /// Inspects a folder path and classifies its Git status (`preflightGitRepository`).
    pub async fn preflight_git_repository(&self, input: Option<&str>) -> GitRepositoryPreflight {
        let requested_path = input.map(str::trim).filter(|s| !s.is_empty());
        let Some(req_str) = requested_path else {
            return GitRepositoryPreflight {
                status: GitRepositoryPreflightStatus::NoWorkspace,
                requested_path: None,
                repository_path: None,
                repository_name: None,
                message: "Attach a project workspace folder before opening Git Graph.".to_string(),
            };
        };

        let req_path = Path::new(req_str);
        match std::fs::metadata(req_path) {
            Ok(meta) => {
                if !meta.is_dir() {
                    return GitRepositoryPreflight {
                        status: GitRepositoryPreflightStatus::InaccessibleFolder,
                        requested_path: Some(req_str.to_string()),
                        repository_path: None,
                        repository_name: None,
                        message: "The selected workspace is not a folder.".to_string(),
                    };
                }
            }
            Err(_) => {
                return GitRepositoryPreflight {
                    status: GitRepositoryPreflightStatus::MissingFolder,
                    requested_path: Some(req_str.to_string()),
                    repository_path: None,
                    repository_name: None,
                    message: "The project workspace folder could not be found.".to_string(),
                };
            }
        }

        let inspect = async {
            let repo_path = self
                .git_strs(&["rev-parse", "--show-toplevel"], req_path)
                .await?
                .trim()
                .to_string();
            let bare = self
                .git_strs(&["rev-parse", "--is-bare-repository"], req_path)
                .await?
                .trim()
                == "true";
            let repo_name = Path::new(&repo_path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&repo_path)
                .to_string();
            if bare {
                return Ok(GitRepositoryPreflight {
                    status: GitRepositoryPreflightStatus::BareRepository,
                    requested_path: Some(req_str.to_string()),
                    repository_path: Some(repo_path),
                    repository_name: Some(repo_name),
                    message:
                        "This is a bare repository. Choose a working checkout to use Git Graph."
                            .to_string(),
                });
            }
            let git_dir = self
                .git_strs(&["rev-parse", "--git-dir"], req_path)
                .await?
                .trim()
                .to_string();
            let is_worktree = Path::new(&git_dir).is_absolute() && !git_dir.ends_with(".git");
            Ok::<GitRepositoryPreflight, String>(GitRepositoryPreflight {
                status: if is_worktree {
                    GitRepositoryPreflightStatus::Worktree
                } else {
                    GitRepositoryPreflightStatus::Repository
                },
                requested_path: Some(req_str.to_string()),
                repository_path: Some(repo_path),
                repository_name: Some(repo_name),
                message: if is_worktree {
                    "Git worktree found.".to_string()
                } else {
                    "Git repository found.".to_string()
                },
            })
        }
        .await;

        match inspect {
            Ok(preflight) => preflight,
            Err(detail) => {
                let not_repo = detail.to_ascii_lowercase().contains("not a git repository");
                GitRepositoryPreflight {
                    status: if not_repo {
                        GitRepositoryPreflightStatus::NotARepository
                    } else {
                        GitRepositoryPreflightStatus::InaccessibleFolder
                    },
                    requested_path: Some(req_str.to_string()),
                    repository_path: None,
                    repository_name: None,
                    message: if not_repo {
                        "This workspace is not a Git repository yet.".to_string()
                    } else {
                        "Git could not inspect this workspace. Check that the folder is accessible."
                            .to_string()
                    },
                }
            }
        }
    }

    /// Returns the repository's current branch name, or `None` on detached HEAD or non-repo path.
    pub async fn get_current_branch(&self, repository_path: &str) -> Option<String> {
        self.git_strs(
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            Path::new(repository_path),
        )
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    }

    /// Initializes a new Git repository in `repository_path` if it is not one yet.
    pub async fn initialize_git_repository(
        &self,
        repository_path: &str,
    ) -> Result<GitRepositoryPreflight, String> {
        let preflight = self.preflight_git_repository(Some(repository_path)).await;
        if preflight.status != GitRepositoryPreflightStatus::NotARepository {
            return Err(preflight.message);
        }
        self.git_strs(&["init"], Path::new(repository_path)).await?;
        Ok(self.preflight_git_repository(Some(repository_path)).await)
    }

    /// Clones `repository_url` into `target_parent/<target_name>`.
    pub async fn clone_git_repository(
        &self,
        repository_url: &str,
        target_parent: &str,
        target_name: Option<&str>,
    ) -> Result<GitRepositoryPreflight, String> {
        let url = repository_url.trim();
        let parent = target_parent.trim();
        if url.is_empty() {
            return Err("Enter a repository URL before cloning.".to_string());
        }
        if parent.is_empty() {
            return Err("Choose a destination folder before cloning.".to_string());
        }

        let raw_name = match target_name.map(str::trim).filter(|s| !s.is_empty()) {
            Some(explicit) => explicit.to_string(),
            None => {
                let trimmed_url = url.trim_end_matches(['/', '\\']);
                let without_git = trimmed_url
                    .strip_suffix(".git")
                    .or_else(|| trimmed_url.strip_suffix(".GIT"))
                    .unwrap_or(trimmed_url);
                Path::new(without_git)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string()
            }
        };

        let name: String = raw_name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '-'
                }
            })
            .collect();

        if name.is_empty() || name == "." || name == ".." {
            return Err("Enter a valid destination folder name.".to_string());
        }

        let destination = Path::new(parent).join(&name);
        if destination.exists() {
            return Err(format!(
                "The destination already exists: {}",
                destination.display()
            ));
        }

        let dest_str = destination.to_string_lossy().to_string();
        self.git_strs(&["clone", url, &dest_str], Path::new(parent))
            .await?;
        Ok(self.preflight_git_repository(Some(&dest_str)).await)
    }

    /// Loads the full commit graph, branch list, and tag list for `input`.
    pub async fn load_git_repository(
        &self,
        input: &str,
        force: bool,
    ) -> Result<GitRepositorySnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        if !force {
            if let Ok(guard) = self.cache.lock() {
                if let Some(entry) = guard.get(&repository_path) {
                    if entry.cached_at.elapsed() < CACHE_TTL {
                        return Ok(entry.snapshot.clone());
                    }
                }
            }
        }

        let repo_dir = Path::new(&repository_path);
        let max_count_arg = format!("--max-count={MAX_COMMITS}");
        let log_args = [
            "log",
            "--all",
            "--date=iso-strict",
            &max_count_arg,
            "--pretty=format:%H%x00%P%x00%an%x00%aI%x00%s%x00%b%x1e",
        ];

        let (head_res, current_branch_res, branch_res, tag_res, log_res) = tokio::join!(
            self.git_strs(&["rev-parse", "HEAD"], repo_dir),
            self.git_strs(&["symbolic-ref", "--quiet", "--short", "HEAD"], repo_dir),
            self.git_strs(
                &[
                    "for-each-ref",
                    "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)",
                    "refs/heads",
                    "refs/remotes"
                ],
                repo_dir
            ),
            self.git_strs(
                &[
                    "for-each-ref",
                    "--format=%(refname:short)%00%(objectname)",
                    "refs/tags"
                ],
                repo_dir
            ),
            self.git_strs(&log_args, repo_dir)
        );

        let head = head_res?.trim().to_string();
        let current_branch = current_branch_res
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let branch_raw = branch_res?;
        let tag_raw = tag_res?;
        let log_raw = log_res?;

        let branches = parse_git_branches(&branch_raw);
        let parsed_tags = parse_git_tags(&tag_raw);
        let tags: Vec<String> = parsed_tags.iter().map(|t| t.name.clone()).collect();

        let mut refs: HashMap<String, Vec<String>> = HashMap::new();
        for branch in &branches {
            refs.entry(branch.tip.clone())
                .or_default()
                .push(branch.name.clone());
        }
        for tag in &parsed_tags {
            refs.entry(tag.tip.clone())
                .or_default()
                .push(format!("tag:{}", tag.name));
        }

        let log_records = parse_git_log(&log_raw);
        let commit_inputs: Vec<GitCommitInput> =
            log_records.iter().map(GitCommitInput::from).collect();
        let commits = build_commit_graph(&commit_inputs, &refs, &branches);

        let repository_name = Path::new(&repository_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&repository_path)
            .to_string();

        let snapshot = GitRepositorySnapshot {
            repository_path: repository_path.clone(),
            repository_name,
            head,
            current_branch,
            branches,
            tags,
            commits,
            loaded_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };

        if let Ok(mut guard) = self.cache.lock() {
            guard.insert(
                repository_path,
                CachedSnapshot {
                    snapshot: snapshot.clone(),
                    cached_at: Instant::now(),
                },
            );
        }

        Ok(snapshot)
    }

    /// Reads the current working tree and index status (`getGitStatus`).
    pub async fn get_git_status(&self, input: &str) -> Result<GitStatusSnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        let repo_dir = Path::new(&repository_path);
        let branch = self
            .git_strs(&["symbolic-ref", "--quiet", "--short", "HEAD"], repo_dir)
            .await
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let status_raw = self
            .git_strs(&["status", "--porcelain=v1", "-z"], repo_dir)
            .await?;
        let mut status = parse_git_status(&status_raw, &repository_path, branch);

        let tracking = self
            .git_strs(
                &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
                repo_dir,
            )
            .await
            .unwrap_or_default();
        let mut counts = tracking
            .split_whitespace()
            .map(|v| v.parse::<usize>().unwrap_or(0));
        status.behind = counts.next().unwrap_or(0);
        status.ahead = counts.next().unwrap_or(0);

        let git_directory = self
            .git_strs(&["rev-parse", "--absolute-git-dir"], repo_dir)
            .await?
            .trim()
            .to_string();
        let git_dir_path = Path::new(&git_directory);

        let operation_checks = [
            (GitRepositoryOperation::Merge, "MERGE_HEAD"),
            (GitRepositoryOperation::Rebase, "rebase-merge"),
            (GitRepositoryOperation::Rebase, "rebase-apply"),
            (GitRepositoryOperation::CherryPick, "CHERRY_PICK_HEAD"),
            (GitRepositoryOperation::Revert, "REVERT_HEAD"),
        ];
        for (op, marker) in operation_checks {
            if git_dir_path.join(marker).exists() {
                status.operation = Some(op);
                break;
            }
        }

        Ok(status)
    }

    async fn mutate(&self, input: &str, args: &[String]) -> Result<GitRepositorySnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        self.invalidate_cache(&repository_path);
        self.git(args, Path::new(&repository_path)).await?;
        self.load_git_repository(&repository_path, true).await
    }

    async fn mutate_allowing_conflicts(
        &self,
        input: &str,
        args: &[String],
    ) -> Result<GitRepositorySnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        match self.mutate(&repository_path, args).await {
            Ok(snapshot) => Ok(snapshot),
            Err(err) => {
                if let Ok(status) = self.get_git_status(&repository_path).await {
                    if status.files.iter().any(|f| f.conflicted == Some(true)) {
                        return self.load_git_repository(&repository_path, true).await;
                    }
                }
                Err(err)
            }
        }
    }

    /// Stages the given `paths` in the repository index.
    pub async fn stage_git(
        &self,
        input: &str,
        paths: &[String],
    ) -> Result<GitStatusSnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        let mut args = vec!["add".to_string(), "--".to_string()];
        args.extend_from_slice(paths);
        self.git(&args, Path::new(&repository_path)).await?;
        self.get_git_status(&repository_path).await
    }

    /// Unstages the given `paths` in the repository index.
    pub async fn unstage_git(
        &self,
        input: &str,
        paths: &[String],
    ) -> Result<GitStatusSnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        let mut args = vec![
            "restore".to_string(),
            "--staged".to_string(),
            "--".to_string(),
        ];
        args.extend_from_slice(paths);
        self.git(&args, Path::new(&repository_path)).await?;
        self.get_git_status(&repository_path).await
    }

    /// Discards working tree edits for tracked `paths`, refusing untracked files.
    pub async fn discard_git(
        &self,
        input: &str,
        paths: &[String],
    ) -> Result<GitStatusSnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        let status = self.get_git_status(&repository_path).await?;
        let selected: HashSet<&str> = paths.iter().map(String::as_str).collect();
        if status
            .files
            .iter()
            .any(|file| selected.contains(file.path.as_str()) && file.index_status == "?")
        {
            return Err(
                "Untracked files are not discarded automatically. Delete them explicitly outside Praxis if they are no longer needed."
                    .to_string(),
            );
        }
        let mut args = vec![
            "restore".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
        ];
        args.extend_from_slice(paths);
        self.git(&args, Path::new(&repository_path)).await?;
        self.get_git_status(&repository_path).await
    }

    /// Creates a commit from the staged index.
    pub async fn commit_git(
        &self,
        input: &str,
        message: &str,
    ) -> Result<GitRepositorySnapshot, String> {
        let clean_message = message.trim();
        if clean_message.is_empty() {
            return Err("Enter a commit message before committing.".to_string());
        }
        self.mutate(
            input,
            &[
                "commit".to_string(),
                "-m".to_string(),
                clean_message.to_string(),
            ],
        )
        .await
    }

    /// Stages and commits only the specified `paths`.
    pub async fn commit_paths_git(
        &self,
        input: &str,
        paths: &[String],
        message: &str,
    ) -> Result<(), String> {
        let clean_message = message.trim();
        if clean_message.is_empty() {
            return Err("Enter a commit message before committing.".to_string());
        }
        if paths.is_empty() {
            return Ok(());
        }
        let repository_path = self.resolve_repository(input).await?;
        self.invalidate_cache(&repository_path);
        let repo_dir = Path::new(&repository_path);
        let mut add_args = vec!["add".to_string(), "--".to_string()];
        add_args.extend_from_slice(paths);
        self.git(&add_args, repo_dir).await?;

        let mut commit_args = vec![
            "commit".to_string(),
            "-m".to_string(),
            clean_message.to_string(),
            "--only".to_string(),
            "--".to_string(),
        ];
        commit_args.extend_from_slice(paths);
        self.git(&commit_args, repo_dir).await?;
        Ok(())
    }

    async fn validate_branch_name(
        &self,
        repository_path: &str,
        name: &str,
    ) -> Result<String, String> {
        let clean_name = name.trim();
        if clean_name.is_empty() || clean_name.starts_with('-') {
            return Err("Enter a valid branch name.".to_string());
        }
        self.git_strs(
            &["check-ref-format", "--branch", clean_name],
            Path::new(repository_path),
        )
        .await?;
        Ok(clean_name.to_string())
    }

    async fn resolve_commitish(
        &self,
        repository_path: &str,
        value: &str,
    ) -> Result<String, String> {
        let candidate = value.trim();
        if candidate.is_empty() || candidate.starts_with('-') {
            return Err("Choose a valid commit or branch to compare.".to_string());
        }
        let spec = format!("{candidate}^{{commit}}");
        let out = self
            .git_strs(
                &["rev-parse", "--verify", "--end-of-options", &spec],
                Path::new(repository_path),
            )
            .await?;
        Ok(out.trim().to_string())
    }

    /// Creates and switches to a new branch.
    pub async fn create_branch_git(
        &self,
        input: &str,
        name: &str,
        start_point: Option<&str>,
    ) -> Result<GitRepositorySnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        let clean_name = self.validate_branch_name(&repository_path, name).await?;
        let mut args = vec!["switch".to_string(), "-c".to_string(), clean_name];
        if let Some(sp) = start_point.filter(|s| !s.trim().is_empty()) {
            let resolved = self.resolve_commitish(&repository_path, sp).await?;
            args.push(resolved);
        }
        self.mutate(&repository_path, &args).await
    }

    /// Switches to branch `name`.
    pub async fn checkout_git(
        &self,
        input: &str,
        name: &str,
    ) -> Result<GitRepositorySnapshot, String> {
        self.mutate(
            input,
            &["switch".to_string(), "--".to_string(), name.to_string()],
        )
        .await
    }

    /// Deletes branch `name` (`git branch -d`).
    pub async fn delete_branch_git(
        &self,
        input: &str,
        name: &str,
    ) -> Result<GitRepositorySnapshot, String> {
        self.mutate(
            input,
            &[
                "branch".to_string(),
                "-d".to_string(),
                "--".to_string(),
                name.to_string(),
            ],
        )
        .await
    }

    /// Renames local branch `old_name` to `new_name`.
    pub async fn rename_branch_git(
        &self,
        input: &str,
        old_name: &str,
        new_name: &str,
    ) -> Result<GitRepositorySnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        let snapshot = self.load_git_repository(&repository_path, false).await?;
        if !snapshot
            .branches
            .iter()
            .any(|b| !b.is_remote && b.name == old_name)
        {
            return Err(format!("Local branch {old_name} was not found."));
        }
        let clean_name = self
            .validate_branch_name(&repository_path, new_name)
            .await?;
        self.mutate(
            &repository_path,
            &[
                "branch".to_string(),
                "-m".to_string(),
                "--".to_string(),
                old_name.to_string(),
                clean_name,
            ],
        )
        .await
    }

    /// Merges `source` into the current branch (`--no-edit`), tolerating merge conflicts.
    pub async fn merge_git(
        &self,
        input: &str,
        source: &str,
    ) -> Result<GitRepositorySnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        let commit = self.resolve_commitish(&repository_path, source).await?;
        self.mutate_allowing_conflicts(
            &repository_path,
            &["merge".to_string(), "--no-edit".to_string(), commit],
        )
        .await
    }

    /// Rebases the current branch onto `target`, tolerating conflicts.
    pub async fn rebase_git(
        &self,
        input: &str,
        target: &str,
    ) -> Result<GitRepositorySnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        let commit = self.resolve_commitish(&repository_path, target).await?;
        self.mutate_allowing_conflicts(&repository_path, &["rebase".to_string(), commit])
            .await
    }

    /// Cherry-picks `commitish`, tolerating conflicts.
    pub async fn cherry_pick_git(
        &self,
        input: &str,
        commitish: &str,
    ) -> Result<GitRepositorySnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        let commit = self.resolve_commitish(&repository_path, commitish).await?;
        self.mutate_allowing_conflicts(&repository_path, &["cherry-pick".to_string(), commit])
            .await
    }

    /// Reverts `commitish` (`--no-edit`), tolerating conflicts.
    pub async fn revert_git(
        &self,
        input: &str,
        commitish: &str,
    ) -> Result<GitRepositorySnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        let commit = self.resolve_commitish(&repository_path, commitish).await?;
        self.mutate_allowing_conflicts(
            &repository_path,
            &["revert".to_string(), "--no-edit".to_string(), commit],
        )
        .await
    }

    /// Pushes uncommitted and untracked changes to the stash.
    pub async fn stash_git(
        &self,
        input: &str,
        message: Option<&str>,
    ) -> Result<GitRepositorySnapshot, String> {
        let clean_message = message
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| {
                format!(
                    "Praxis stash {}",
                    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
                )
            });
        self.mutate(
            input,
            &[
                "stash".to_string(),
                "push".to_string(),
                "--include-untracked".to_string(),
                "-m".to_string(),
                clean_message,
            ],
        )
        .await
    }

    /// Pops the latest stash entry, tolerating conflicts.
    pub async fn pop_git_stash(&self, input: &str) -> Result<GitRepositorySnapshot, String> {
        self.mutate_allowing_conflicts(input, &["stash".to_string(), "pop".to_string()])
            .await
    }

    /// Fast-forward pulls from upstream.
    pub async fn pull_git(&self, input: &str) -> Result<GitRepositorySnapshot, String> {
        self.mutate(input, &["pull".to_string(), "--ff-only".to_string()])
            .await
    }

    /// Fetches all remotes and prunes deleted remote branches.
    pub async fn fetch_git(&self, input: &str) -> Result<GitRepositorySnapshot, String> {
        self.mutate(
            input,
            &[
                "fetch".to_string(),
                "--all".to_string(),
                "--prune".to_string(),
            ],
        )
        .await
    }

    /// Pushes the current branch.
    pub async fn push_git(&self, input: &str) -> Result<GitRepositorySnapshot, String> {
        self.mutate(input, &["push".to_string()]).await
    }

    /// Inspects a single commit's body and per-file diffstat.
    pub async fn get_git_commit(
        &self,
        repository_path: &str,
        hash: &str,
    ) -> Result<GitCommitDetails, String> {
        let snapshot = self.load_git_repository(repository_path, false).await?;
        let Some(node) = snapshot.commits.iter().find(|c| c.hash == hash).cloned() else {
            let short: String = hash.chars().take(8).collect();
            return Err(format!("Commit {short} was not found in this repository."));
        };

        let raw = self
            .git_strs(
                &[
                    "show",
                    "--format=%B",
                    "--numstat",
                    "--no-renames",
                    "--no-ext-diff",
                    hash,
                ],
                Path::new(&snapshot.repository_path),
            )
            .await?;

        let lines: Vec<&str> = raw.split('\n').collect();
        let mut changed_files = Vec::new();
        let mut first_stat_idx: Option<usize> = None;

        for (idx, line) in lines.iter().enumerate().skip(1) {
            if first_stat_idx.is_none()
                && line.chars().next().is_some_and(|c| c.is_ascii_digit())
                && line.contains(char::is_whitespace)
            {
                first_stat_idx = Some(idx);
            }
            let mut parts = line.splitn(3, ['\t', ' ']);
            let Some(add_str) = parts.next() else {
                continue;
            };
            let rest = line[add_str.len()..].trim_start_matches(['\t', ' ']);
            let Some(ws_pos) = rest.find(['\t', ' ']) else {
                continue;
            };
            let del_str = &rest[..ws_pos];
            let file_path = rest[ws_pos..].trim_start_matches(['\t', ' ']);
            if file_path.is_empty() {
                continue;
            }
            let valid_add = add_str == "-" || add_str.chars().all(|c| c.is_ascii_digit());
            let valid_del = del_str == "-" || del_str.chars().all(|c| c.is_ascii_digit());
            if !valid_add || !valid_del {
                continue;
            }
            let additions = if add_str == "-" {
                0
            } else {
                add_str.parse::<usize>().unwrap_or(0)
            };
            let deletions = if del_str == "-" {
                0
            } else {
                del_str.parse::<usize>().unwrap_or(0)
            };
            changed_files.push(GitCommitChangedFile {
                path: file_path.to_string(),
                additions,
                deletions,
                status: "modified".to_string(),
            });
        }

        let body_end = first_stat_idx.unwrap_or(1).max(1).min(lines.len());
        let body = lines[..body_end].join("\n").trim().to_string();

        Ok(GitCommitDetails {
            node,
            body,
            changed_files,
        })
    }

    /// Returns the raw patch for `hash` (optionally scoped to `file_path`).
    pub async fn get_git_diff(
        &self,
        repository_path: &str,
        hash: &str,
        file_path: Option<&str>,
    ) -> Result<GitDiffResult, String> {
        let resolved_repo = self.resolve_repository(repository_path).await?;
        let mut args = vec![
            "show".to_string(),
            "--format=fuller".to_string(),
            "--no-ext-diff".to_string(),
            "--patch".to_string(),
            hash.to_string(),
        ];
        if let Some(fp) = file_path.filter(|s| !s.is_empty()) {
            args.push("--".to_string());
            args.push(fp.to_string());
        }
        let patch = self.git(&args, Path::new(&resolved_repo)).await?;
        Ok(GitDiffResult {
            commit: hash.to_string(),
            path: file_path.map(ToString::to_string),
            patch,
        })
    }

    fn comparison_labels(request: &GitDiffRequest) -> (String, String) {
        match request.kind {
            GitComparisonKind::Working => (
                "Working changes".to_string(),
                "Working tree compared with the staged snapshot".to_string(),
            ),
            GitComparisonKind::Staged => (
                "Staged changes".to_string(),
                "Staged snapshot compared with HEAD".to_string(),
            ),
            GitComparisonKind::Commit => {
                let title = match request.left.as_deref().filter(|s| !s.is_empty()) {
                    Some(left) => {
                        let short: String = left.chars().take(8).collect();
                        format!("Commit {short}")
                    }
                    None => "Commit changes".to_string(),
                };
                (
                    title,
                    "Selected commit compared with its first parent".to_string(),
                )
            }
            GitComparisonKind::Compare => (
                "Compare revisions".to_string(),
                format!(
                    "{} → {}",
                    request.left.as_deref().unwrap_or("?"),
                    request.right.as_deref().unwrap_or("?")
                ),
            ),
        }
    }

    async fn untracked_file_patches(
        &self,
        repository_path: &str,
        selected_path: Option<&str>,
    ) -> Result<String, String> {
        let raw = self
            .git_strs(
                &["ls-files", "--others", "--exclude-standard", "-z"],
                Path::new(repository_path),
            )
            .await?;
        let repo_root = Path::new(repository_path);
        let mut patches = Vec::new();

        for file_path in raw
            .split('\0')
            .filter(|s| !s.is_empty())
            .filter(|fp| selected_path.is_none_or(|sel| *fp == sel))
            .take(250)
        {
            let resolved_path = repo_root.join(file_path);
            if !resolved_path.starts_with(repo_root) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&resolved_path) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            if meta.len() > 2 * 1024 * 1024 {
                patches.push(format!(
                    "diff --git a/{file_path} b/{file_path}\nnew file mode 100644\nBinary files /dev/null and b/{file_path} differ\n"
                ));
                continue;
            }
            let Ok(buffer) = std::fs::read(&resolved_path) else {
                continue;
            };
            if buffer.contains(&0) {
                patches.push(format!(
                    "diff --git a/{file_path} b/{file_path}\nnew file mode 100644\nBinary files /dev/null and b/{file_path} differ\n"
                ));
                continue;
            }
            let content = String::from_utf8_lossy(&buffer);
            let lines: Vec<&str> = if content.is_empty() {
                vec![]
            } else {
                let trimmed = content.strip_suffix('\n').unwrap_or(&content);
                trimmed.split('\n').collect()
            };
            let body = lines
                .iter()
                .map(|l| format!("+{l}"))
                .collect::<Vec<_>>()
                .join("\n");
            patches.push(format!(
                "diff --git a/{file_path} b/{file_path}\nnew file mode 100644\n--- /dev/null\n+++ b/{file_path}\n@@ -0,0 +1,{} @@\n{body}\n",
                lines.len()
            ));
        }

        if patches.is_empty() {
            Ok(String::new())
        } else {
            Ok(format!("\n{}", patches.join("")))
        }
    }

    /// Generates a structured diff document for working tree, staged index, commit, or branch comparison.
    pub async fn get_git_comparison(
        &self,
        input: &str,
        request: GitDiffRequest,
    ) -> Result<GitDiffDocument, String> {
        let repository_path = self.resolve_repository(input).await?;
        let context_lines = request.context_lines.unwrap_or(3).clamp(0, 50);
        let mut common = vec![
            format!("--unified={context_lines}"),
            "--no-ext-diff".to_string(),
            "--no-color".to_string(),
            "--find-renames".to_string(),
        ];
        if request.ignore_whitespace == Some(true) {
            common.push("--ignore-all-space".to_string());
        }

        let mut args = match request.kind {
            GitComparisonKind::Working => {
                let mut a = vec!["diff".to_string()];
                a.extend(common);
                a
            }
            GitComparisonKind::Staged => {
                let mut a = vec!["diff".to_string(), "--cached".to_string()];
                a.extend(common);
                a
            }
            GitComparisonKind::Commit => {
                let commit = self
                    .resolve_commitish(&repository_path, request.left.as_deref().unwrap_or("HEAD"))
                    .await?;
                let record_raw = self
                    .git_strs(
                        &["rev-list", "--parents", "-n", "1", &commit],
                        Path::new(&repository_path),
                    )
                    .await?;
                let mut parts = record_raw.split_whitespace();
                let _self_sha = parts.next();
                if let Some(first_parent) = parts.next() {
                    let mut a = vec!["diff".to_string()];
                    a.extend(common);
                    a.push(first_parent.to_string());
                    a.push(commit);
                    a
                } else {
                    let mut a = vec!["show".to_string(), "--format=".to_string()];
                    a.extend(common);
                    a.push(commit);
                    a
                }
            }
            GitComparisonKind::Compare => {
                let left = self
                    .resolve_commitish(&repository_path, request.left.as_deref().unwrap_or("HEAD"))
                    .await?;
                let right = self
                    .resolve_commitish(&repository_path, request.right.as_deref().unwrap_or("HEAD"))
                    .await?;
                let mut a = vec!["diff".to_string()];
                a.extend(common);
                a.push(left);
                a.push(right);
                a
            }
        };

        if let Some(p) = request.path.as_ref().filter(|s| !s.is_empty()) {
            args.push("--".to_string());
            args.push(p.clone());
        }

        let mut raw = self.git(&args, Path::new(&repository_path)).await?;
        if request.kind == GitComparisonKind::Working {
            raw.push_str(
                &self
                    .untracked_file_patches(&repository_path, request.path.as_deref())
                    .await?,
            );
        }

        let files = parse_git_diff(&raw);
        let (title, subtitle) = Self::comparison_labels(&request);
        let additions = files.iter().map(|f| f.additions).sum();
        let deletions = files.iter().map(|f| f.deletions).sum();

        Ok(GitDiffDocument {
            request,
            title,
            subtitle,
            additions,
            deletions,
            files,
            generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    }

    fn assert_repository_relative_path(file_path: &str) -> Result<(), String> {
        if file_path.is_empty()
            || Path::new(file_path).is_absolute()
            || file_path.split(['/', '\\']).any(|seg| seg == "..")
        {
            return Err("The selected file is outside this repository.".to_string());
        }
        Ok(())
    }

    fn assert_safe_hunk_request(request: &GitHunkActionRequest) -> Result<(), String> {
        Self::assert_repository_relative_path(&request.path)?;
        let files = parse_git_diff(&request.patch);
        if files.len() != 1 || files[0].display_path != request.path || files[0].hunks.len() != 1 {
            return Err(
                "The selected change no longer matches this file. Refresh the diff and try again."
                    .to_string(),
            );
        }
        Ok(())
    }

    /// Stages, unstages, or discards a single diff hunk via `git apply`.
    pub async fn apply_git_hunk(
        &self,
        input: &str,
        request: &GitHunkActionRequest,
    ) -> Result<GitStatusSnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        Self::assert_safe_hunk_request(request)?;
        let mut args = vec![
            "apply".to_string(),
            "--recount".to_string(),
            "--whitespace=nowarn".to_string(),
        ];
        match request.action {
            GitHunkAction::Stage => args.push("--cached".to_string()),
            GitHunkAction::Unstage => {
                args.push("--cached".to_string());
                args.push("--reverse".to_string());
            }
            GitHunkAction::Discard => args.push("--reverse".to_string()),
        }
        args.push("-".to_string());
        self.git_with_input(&args, Path::new(&repository_path), &request.patch)
            .await?;
        self.get_git_status(&repository_path).await
    }

    fn safe_repository_file(repository_path: &str, relative_path: &str) -> Result<PathBuf, String> {
        Self::assert_repository_relative_path(relative_path)?;
        let repo_root = Path::new(repository_path);
        let candidate = repo_root.join(relative_path);
        if !candidate.starts_with(repo_root) {
            return Err("The selected file is outside this repository.".to_string());
        }
        let parent_dir = candidate.parent().unwrap_or(repo_root);
        let real_parent = std::fs::canonicalize(parent_dir).map_err(|e| format!("ENOENT: {e}"))?;
        let real_repo = std::fs::canonicalize(repo_root).map_err(|e| format!("ENOENT: {e}"))?;
        if real_parent != real_repo && !real_parent.starts_with(&real_repo) {
            return Err("The selected file resolves outside this repository.".to_string());
        }
        Ok(candidate)
    }

    async fn conflict_stage(&self, repository_path: &str, stage: u8, file_path: &str) -> String {
        let spec = format!(":{stage}:{file_path}");
        self.git_strs(&["show", &spec], Path::new(repository_path))
            .await
            .unwrap_or_default()
    }

    /// Reads the base, current (`--ours`), incoming (`--theirs`), and working-tree content of a conflicted file.
    pub async fn get_git_conflict(
        &self,
        input: &str,
        file_path: &str,
    ) -> Result<GitConflictFile, String> {
        let repository_path = self.resolve_repository(input).await?;
        let status = self.get_git_status(&repository_path).await?;
        if !status
            .files
            .iter()
            .any(|f| f.path == file_path && f.conflicted == Some(true))
        {
            return Err(format!(
                "{file_path} is no longer conflicted. Refresh the working tree."
            ));
        }
        let resolved_path = Self::safe_repository_file(&repository_path, file_path)?;
        let (base, current, incoming) = tokio::join!(
            self.conflict_stage(&repository_path, 1, file_path),
            self.conflict_stage(&repository_path, 2, file_path),
            self.conflict_stage(&repository_path, 3, file_path),
        );
        let result_buffer = std::fs::read(&resolved_path).unwrap_or_default();
        let is_binary =
            result_buffer.contains(&0) || current.contains('\0') || incoming.contains('\0');
        let result = String::from_utf8_lossy(&result_buffer).to_string();

        Ok(GitConflictFile {
            path: file_path.to_string(),
            base,
            current,
            incoming,
            result,
            is_binary,
        })
    }

    fn contains_conflict_markers(content: &str) -> bool {
        content.lines().any(|line| {
            line.starts_with("<<<<<<<")
                || line.starts_with("=======")
                || line.starts_with(">>>>>>>")
        })
    }

    /// Resolves a conflicted file using `current`, `incoming`, or `manual` content and stages it.
    pub async fn resolve_git_conflict(
        &self,
        input: &str,
        file_path: &str,
        resolution: &GitConflictResolution,
    ) -> Result<GitStatusSnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        let status = self.get_git_status(&repository_path).await?;
        if !status
            .files
            .iter()
            .any(|f| f.path == file_path && f.conflicted == Some(true))
        {
            return Err(format!(
                "{file_path} is no longer conflicted. Refresh the working tree."
            ));
        }

        match resolution {
            GitConflictResolution::Manual { content } => {
                if content.len() > 8 * 1024 * 1024 {
                    return Err(
                        "The resolved file is too large to save safely in Praxis.".to_string()
                    );
                }
                if Self::contains_conflict_markers(content) {
                    return Err(
                        "Remove every conflict marker before saving the resolved file.".to_string(),
                    );
                }
                let resolved_path = Self::safe_repository_file(&repository_path, file_path)?;
                if let Ok(meta) = std::fs::symlink_metadata(&resolved_path) {
                    if meta.file_type().is_symlink() {
                        return Err(
                            "Praxis cannot write a manual resolution through a symbolic link."
                                .to_string(),
                        );
                    }
                }
                std::fs::write(&resolved_path, content).map_err(|e| e.to_string())?;
            }
            GitConflictResolution::Current => {
                self.git_strs(
                    &["checkout", "--ours", "--", file_path],
                    Path::new(&repository_path),
                )
                .await?;
            }
            GitConflictResolution::Incoming => {
                self.git_strs(
                    &["checkout", "--theirs", "--", file_path],
                    Path::new(&repository_path),
                )
                .await?;
            }
        }

        self.git_strs(&["add", "--", file_path], Path::new(&repository_path))
            .await?;
        self.get_git_status(&repository_path).await
    }

    /// Aborts an in-progress merge, rebase, cherry-pick, or revert.
    pub async fn abort_git_conflict(&self, input: &str) -> Result<GitRepositorySnapshot, String> {
        let repository_path = self.resolve_repository(input).await?;
        self.invalidate_cache(&repository_path);
        let repo_dir = Path::new(&repository_path);
        let candidates = [
            ["merge", "--abort"],
            ["rebase", "--abort"],
            ["cherry-pick", "--abort"],
            ["revert", "--abort"],
        ];
        let mut first_error: Option<String> = None;
        let mut aborted = false;
        for args in candidates {
            match self.git_strs(&args, repo_dir).await {
                Ok(_) => {
                    aborted = true;
                    break;
                }
                Err(err) => {
                    if first_error.is_none() {
                        first_error = Some(err);
                    }
                }
            }
        }
        if !aborted {
            return Err(first_error.unwrap_or_else(|| "No active operation to abort.".to_string()));
        }
        self.load_git_repository(&repository_path, true).await
    }

    /// Lists commits touching `file_path` (`git log --follow`).
    pub async fn get_git_file_history(
        &self,
        input: &str,
        file_path: &str,
        ref_name: Option<&str>,
    ) -> Result<Vec<GitFileHistoryEntry>, String> {
        let repository_path = self.resolve_repository(input).await?;
        Self::assert_repository_relative_path(file_path)?;
        let commit = self
            .resolve_commitish(
                &repository_path,
                ref_name.filter(|s| !s.is_empty()).unwrap_or("HEAD"),
            )
            .await?;
        let raw = self
            .git_strs(
                &[
                    "log",
                    "--follow",
                    "--date=iso-strict",
                    "--format=%H%x00%an%x00%aI%x00%s%x1e",
                    &commit,
                    "--",
                    file_path,
                ],
                Path::new(&repository_path),
            )
            .await?;

        Ok(raw
            .split('\x1e')
            .filter(|r| !r.is_empty())
            .filter_map(|record| {
                let trimmed = record.trim_start_matches(['\r', '\n']);
                let mut parts = trimmed.split('\0');
                let hash = parts.next().unwrap_or("");
                let author = parts.next().unwrap_or("");
                let date = parts.next().unwrap_or("");
                let message = parts.next().unwrap_or("").trim();
                if hash.is_empty() || author.is_empty() || date.is_empty() {
                    return None;
                }
                let short_hash: String = hash.chars().take(8).collect();
                Some(GitFileHistoryEntry {
                    hash: hash.to_string(),
                    short_hash,
                    author: author.to_string(),
                    date: date.to_string(),
                    message: if message.is_empty() {
                        "(no message)".to_string()
                    } else {
                        message.to_string()
                    },
                })
            })
            .collect())
    }

    /// Runs `git blame --line-porcelain` on `file_path`.
    pub async fn get_git_blame(
        &self,
        input: &str,
        file_path: &str,
        ref_name: Option<&str>,
    ) -> Result<Vec<GitBlameLine>, String> {
        let repository_path = self.resolve_repository(input).await?;
        Self::assert_repository_relative_path(file_path)?;
        let commit = self
            .resolve_commitish(
                &repository_path,
                ref_name.filter(|s| !s.is_empty()).unwrap_or("HEAD"),
            )
            .await?;
        let raw = self
            .git_strs(
                &["blame", "--line-porcelain", &commit, "--", file_path],
                Path::new(&repository_path),
            )
            .await?;

        let mut result = Vec::new();
        let mut current_commit: Option<String> = None;
        let mut current_line_number: Option<usize> = None;
        let mut current_author: Option<String> = None;
        let mut current_date: Option<String> = None;

        for line in raw.split('\n') {
            if let Some((sha, line_no)) = parse_blame_header(line) {
                current_commit = Some(sha);
                current_line_number = Some(line_no);
                current_author = None;
                current_date = None;
                continue;
            }
            if let Some(author) = line.strip_prefix("author ") {
                current_author = Some(author.to_string());
            } else if let Some(ts_str) = line.strip_prefix("author-time ") {
                if let Ok(secs) = ts_str.trim().parse::<i64>() {
                    if let Some(dt) = Utc.timestamp_opt(secs, 0).single() {
                        current_date = Some(dt.to_rfc3339_opts(SecondsFormat::Millis, true));
                    }
                }
            } else if let Some(content) = line.strip_prefix('\t') {
                if let (Some(commit_sha), Some(line_number)) =
                    (current_commit.take(), current_line_number.take())
                {
                    let short_hash: String = commit_sha.chars().take(8).collect();
                    result.push(GitBlameLine {
                        line_number,
                        commit: commit_sha,
                        short_hash,
                        author: current_author
                            .take()
                            .unwrap_or_else(|| "Unknown".to_string()),
                        date: current_date
                            .take()
                            .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
                        content: content.to_string(),
                    });
                }
            }
        }

        Ok(result)
    }

    /// Reads a file's working-tree text directly from disk (`getGitFileContent`).
    pub async fn get_git_file_content(
        &self,
        input: &str,
        file_path: &str,
    ) -> Result<GitFileContent, String> {
        let repository_path = self.resolve_repository(input).await?;
        let resolved_path = Self::safe_repository_file(&repository_path, file_path)?;
        let meta = std::fs::metadata(&resolved_path).map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "ENOENT: no such file or directory, stat '{}'",
                    resolved_path.display()
                )
            } else {
                err.to_string()
            }
        })?;
        if meta.is_dir() {
            return Err(format!("{file_path} is a directory, not a file."));
        }
        let buffer = std::fs::read(&resolved_path).map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "ENOENT: no such file or directory, open '{}'",
                    resolved_path.display()
                )
            } else {
                err.to_string()
            }
        })?;
        let head_len = buffer.len().min(8000);
        let is_binary = buffer[..head_len].contains(&0);
        let truncated = !is_binary && buffer.len() > MAX_FILE_VIEW_BYTES;
        let content = if is_binary {
            String::new()
        } else {
            let cap = buffer.len().min(MAX_FILE_VIEW_BYTES);
            String::from_utf8_lossy(&buffer[..cap]).to_string()
        };

        Ok(GitFileContent {
            path: file_path.to_string(),
            content,
            is_binary,
            size: meta.len(),
            truncated,
        })
    }

    /// Synchronous helper to run any async method on this [`GitService`].
    pub fn block_on<F: std::future::Future>(&self, fut: F) -> F::Output {
        block_on_git(fut)
    }
}

fn parse_blame_header(line: &str) -> Option<(String, usize)> {
    let mut parts = line.split_whitespace();
    let sha = parts.next()?;
    if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit() || c == '^') {
        return None;
    }
    let _orig_line: usize = parts.next()?.parse().ok()?;
    let final_line: usize = parts.next()?.parse().ok()?;
    if let Some(group_lines) = parts.next() {
        let _: usize = group_lines.parse().ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    Some((sha.to_string(), final_line))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::git_graph::GitDiffFileStatus;
    use std::process::Command as StdCommand;
    use std::time::{SystemTime, UNIX_EPOCH};

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
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn handles_missing_git_non_repositories_worktrees_shallow_history_and_detached_head() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root =
            std::env::temp_dir().join(format!("praxis-git-svc-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&root).expect("mkdir root");
        let repository = root.join("repo");
        let worktree = root.join("worktree");
        let shallow = root.join("shallow");
        std::fs::create_dir_all(&repository).expect("mkdir repo");

        let repo_str = repository.to_string_lossy().to_string();
        let root_str = root.to_string_lossy().to_string();

        let missing_svc =
            GitService::with_executable(root.join("missing-git").to_string_lossy().to_string());
        let missing_err = missing_svc
            .load_git_repository(&repo_str, false)
            .await
            .expect_err("missing git should fail");
        assert!(missing_err.contains("Git could not complete"));

        let svc = GitService::new();
        let non_repo_err = svc
            .load_git_repository(&root_str, false)
            .await
            .expect_err("non-repo should fail");
        assert!(non_repo_err.contains("Git could not complete"));

        assert_eq!(
            svc.preflight_git_repository(None).await.status,
            GitRepositoryPreflightStatus::NoWorkspace
        );
        assert_eq!(
            svc.preflight_git_repository(Some(&root_str)).await.status,
            GitRepositoryPreflightStatus::NotARepository
        );
        let initialized = svc
            .initialize_git_repository(&root_str)
            .await
            .expect("init");
        assert_eq!(initialized.status, GitRepositoryPreflightStatus::Repository);

        git_sync(&repository, &["init", "-b", "main"]);
        git_sync(&repository, &["config", "user.name", "Fixture User"]);
        git_sync(
            &repository,
            &["config", "user.email", "fixture@example.test"],
        );
        std::fs::write(repository.join("README.md"), "base\n").expect("write");
        git_sync(&repository, &["add", "README.md"]);
        git_sync(&repository, &["commit", "-m", "base"]);
        git_sync(&repository, &["tag", "v1.0"]);
        git_sync(&repository, &["branch", "feature/topic"]);
        std::fs::write(repository.join("README.md"), "feature\n").expect("write");
        git_sync(&repository, &["add", "README.md"]);
        git_sync(&repository, &["commit", "-m", "feature"]);

        let snapshot = svc
            .load_git_repository(&repo_str, true)
            .await
            .expect("load");
        assert_eq!(snapshot.current_branch.as_deref(), Some("main"));
        assert!(snapshot.tags.contains(&"v1.0".to_string()));
        assert!(snapshot.branches.iter().any(|b| b.name == "feature/topic"));

        let clone_parent = root.join("clones");
        std::fs::create_dir_all(&clone_parent).expect("mkdir clones");
        let clone_res = svc
            .clone_git_repository(
                &format!("file://{repo_str}"),
                &clone_parent.to_string_lossy(),
                Some("clone"),
            )
            .await
            .expect("clone");
        assert_eq!(clone_res.status, GitRepositoryPreflightStatus::Repository);

        let status = svc.get_git_status(&repo_str).await.expect("status");
        assert!(status.repository_path.ends_with("/repo"));

        let history = svc
            .get_git_file_history(&repo_str, "README.md", None)
            .await
            .expect("history");
        assert_eq!(history[0].message, "feature");

        let blame = svc
            .get_git_blame(&repo_str, "README.md", None)
            .await
            .expect("blame");
        assert_eq!(blame[0].author, "Fixture User");

        let readme = svc
            .get_git_file_content(&repo_str, "README.md")
            .await
            .expect("file content");
        assert_eq!(readme.content, "feature\n");
        assert!(!readme.is_binary);
        assert!(!readme.truncated);

        std::fs::write(
            repository.join("image.png"),
            [0x89u8, 0x50, 0x4e, 0x47, 0, 1, 2, 3],
        )
        .expect("write png");
        assert!(
            svc.get_git_file_content(&repo_str, "image.png")
                .await
                .expect("png content")
                .is_binary
        );
        assert!(
            svc.get_git_file_content(&repo_str, "../outside.txt")
                .await
                .expect_err("outside")
                .contains("outside this repository")
        );
        assert!(
            svc.get_git_file_content(&repo_str, "does-not-exist.txt")
                .await
                .expect_err("missing")
                .contains("ENOENT")
        );

        std::fs::write(repository.join("README.md"), "feature\nworking line\n").expect("write");
        std::fs::write(repository.join("notes.txt"), "untracked note\n").expect("write notes");
        let working_diff = svc
            .get_git_comparison(
                &repo_str,
                GitDiffRequest {
                    kind: GitComparisonKind::Working,
                    left: None,
                    right: None,
                    path: None,
                    context_lines: None,
                    ignore_whitespace: None,
                },
            )
            .await
            .expect("working diff");
        assert_eq!(working_diff.title, "Working changes");
        assert_eq!(working_diff.files[0].display_path, "README.md");
        assert_eq!(working_diff.files[0].additions, 1);
        assert_eq!(
            working_diff
                .files
                .iter()
                .find(|f| f.display_path == "notes.txt")
                .map(|f| f.status),
            Some(GitDiffFileStatus::Added)
        );

        let selected_hunk = &working_diff.files[0].hunks[0];
        let staged_status = svc
            .apply_git_hunk(
                &repo_str,
                &GitHunkActionRequest {
                    action: GitHunkAction::Stage,
                    path: "README.md".to_string(),
                    patch: selected_hunk.patch.clone(),
                },
            )
            .await
            .expect("stage hunk");
        assert_eq!(
            staged_status
                .files
                .iter()
                .find(|f| f.path == "README.md")
                .map(|f| f.staged),
            Some(true)
        );

        let staged_diff = svc
            .get_git_comparison(
                &repo_str,
                GitDiffRequest {
                    kind: GitComparisonKind::Staged,
                    left: None,
                    right: None,
                    path: None,
                    context_lines: None,
                    ignore_whitespace: None,
                },
            )
            .await
            .expect("staged diff");
        assert_eq!(staged_diff.files[0].hunks.len(), 1);

        svc.apply_git_hunk(
            &repo_str,
            &GitHunkActionRequest {
                action: GitHunkAction::Unstage,
                path: "README.md".to_string(),
                patch: staged_diff.files[0].hunks[0].patch.clone(),
            },
        )
        .await
        .expect("unstage hunk");
        assert_eq!(
            svc.get_git_status(&repo_str)
                .await
                .expect("status")
                .files
                .iter()
                .find(|f| f.path == "README.md")
                .map(|f| f.staged),
            Some(false)
        );

        svc.discard_git(&repo_str, &["README.md".to_string()])
            .await
            .expect("discard");
        assert!(
            !svc.get_git_status(&repo_str)
                .await
                .expect("status")
                .files
                .iter()
                .any(|f| f.path == "README.md")
        );

        svc.stash_git(&repo_str, Some("test untracked stash"))
            .await
            .expect("stash");
        assert_eq!(
            svc.get_git_status(&repo_str)
                .await
                .expect("status")
                .files
                .len(),
            0
        );
        svc.pop_git_stash(&repo_str).await.expect("pop stash");
        assert!(
            svc.get_git_status(&repo_str)
                .await
                .expect("status")
                .files
                .iter()
                .any(|f| f.path == "notes.txt")
        );

        let commit_diff = svc
            .get_git_comparison(
                &repo_str,
                GitDiffRequest {
                    kind: GitComparisonKind::Commit,
                    left: Some(snapshot.head.clone()),
                    right: None,
                    path: None,
                    context_lines: None,
                    ignore_whitespace: None,
                },
            )
            .await
            .expect("commit diff");
        assert!(
            commit_diff
                .files
                .iter()
                .any(|f| f.display_path == "README.md")
        );

        let wt_str = worktree.to_string_lossy().to_string();
        git_sync(&repository, &["worktree", "add", &wt_str, "feature/topic"]);
        let wt_snapshot = svc.load_git_repository(&wt_str, true).await.expect("wt");
        assert_eq!(wt_snapshot.current_branch.as_deref(), Some("feature/topic"));

        let shallow_str = shallow.to_string_lossy().to_string();
        git_sync(
            &repository,
            &[
                "clone",
                "--depth=1",
                &format!("file://{repo_str}"),
                &shallow_str,
            ],
        );
        let shallow_snapshot = svc
            .load_git_repository(&shallow_str, true)
            .await
            .expect("shallow");
        assert_eq!(shallow_snapshot.commits.len(), 1);

        git_sync(&repository, &["switch", "-c", "conflict-side", "HEAD~1"]);
        std::fs::write(repository.join("README.md"), "incoming version\n").expect("write");
        git_sync(&repository, &["add", "README.md"]);
        git_sync(&repository, &["commit", "-m", "incoming conflict"]);
        git_sync(&repository, &["switch", "main"]);
        std::fs::write(repository.join("README.md"), "current version\n").expect("write");
        git_sync(&repository, &["add", "README.md"]);
        git_sync(&repository, &["commit", "-m", "current conflict"]);
        svc.merge_git(&repo_str, "conflict-side")
            .await
            .expect("merge allowing conflicts");
        let conflict_status = svc.get_git_status(&repo_str).await.expect("status");
        assert_eq!(conflict_status.files[0].conflicted, Some(true));
        let conflict = svc
            .get_git_conflict(&repo_str, "README.md")
            .await
            .expect("conflict");
        assert!(conflict.current.contains("current version"));
        assert!(conflict.incoming.contains("incoming version"));

        let marker_err = svc
            .resolve_git_conflict(
                &repo_str,
                "README.md",
                &GitConflictResolution::Manual {
                    content: conflict.result.clone(),
                },
            )
            .await
            .expect_err("conflict markers must be rejected");
        assert!(marker_err.contains("Remove every conflict marker"));

        let resolved_status = svc
            .resolve_git_conflict(&repo_str, "README.md", &GitConflictResolution::Current)
            .await
            .expect("resolve current");
        assert!(
            !resolved_status
                .files
                .iter()
                .any(|f| f.conflicted == Some(true))
        );
        git_sync(&repository, &["commit", "-m", "resolve conflict"]);

        git_sync(&repository, &["checkout", "--detach", "HEAD"]);
        let detached_snapshot = svc
            .load_git_repository(&repo_str, true)
            .await
            .expect("detached");
        assert_eq!(detached_snapshot.current_branch, None);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn git_operations_refuse_an_empty_repository_path_instead_of_guessing_one() {
        let svc = GitService::new();
        for empty in ["", "   "] {
            let err = svc
                .load_git_repository(empty, false)
                .await
                .expect_err("expected refusal");
            assert!(err.contains("No repository path was supplied"));
        }
    }
}
