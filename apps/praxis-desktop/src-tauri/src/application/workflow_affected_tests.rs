//! A QA check's deterministic contract: run only the test files this ticket added or updated
//! (`affectedTestsRunner.ts` `selectChangedTests` / `runAffectedTests`, `affectedTests.ts`
//! `isTestFile`, and `workflowCheckRunner.ts` `runChangeTests` / `runForkPoint` /
//! `scheduledTicketBase`).
//!
//! Selection reads git in the run's worktree. Each selected file then runs under the runner that
//! owns it (Playwright, Vitest, Jest, pytest or node:test), found from the nearest config or
//! package. A file no runner claims fails QA rather than passing unrun.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use praxis_workflows::check_process::{CheckProcessResult, check_environment, spawn_check};
use praxis_workflows::types::{WorkflowCheckNode, WorkflowNodeBase};
use regex::Regex;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

/// A test file picked for a change, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AffectedTest {
    pub file: String,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct AffectedTestSelection {
    pub tests: Vec<AffectedTest>,
    /// Selected tests left out because the selection ran past the cap.
    pub dropped: usize,
}

/// Test files, by the conventions of the common runners.
pub fn is_test_file(file: &str) -> bool {
    let normalized = file.replace('\\', "/");
    if normalized.starts_with("node_modules/") || normalized.contains("/node_modules/") {
        return false;
    }
    let base = normalized.rsplit('/').next().unwrap_or("");
    let spec = Regex::new(r"\.(spec|test)\.[cm]?[jt]sx?$").expect("static regex");
    let tests_dir = Regex::new(r"(^|/)__tests__/.+\.[cm]?[jt]sx?$").expect("static regex");
    let py = Regex::new(r"^test_.+\.py$|_test\.py$").expect("static regex");
    spec.is_match(base) || tests_dir.is_match(&normalized) || py.is_match(base) || base.ends_with("_test.go")
}

async fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
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
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Scheduled QA contract: the test files added or modified since this ticket acquired its branch.
pub async fn select_changed_tests(worktree: &Path, base_commit: &str) -> Result<AffectedTestSelection, String> {
    let range = format!("{base_commit}..HEAD");
    let out = git(worktree, &["diff", "--name-only", "--diff-filter=ACMR", &range]).await?;
    let files: BTreeSet<String> = out
        .lines()
        .map(str::trim)
        .filter(|f| !f.is_empty() && !f.starts_with(".praxis/") && !f.starts_with(".praxis-run/") && is_test_file(f))
        .map(str::to_string)
        .collect();
    Ok(AffectedTestSelection {
        tests: files
            .into_iter()
            .map(|file| AffectedTest { file, reasons: vec!["added or updated in this ticket".to_string()] })
            .collect(),
        dropped: 0,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Runner {
    Playwright,
    Vitest,
    Jest,
    Pytest,
    NodeTest,
    RendererNodeTest,
}

struct RunnerGroup {
    runner: Runner,
    cwd: PathBuf,
    files: Vec<String>,
}

/// The runner that owns a test file, from the nearest config or package up to the worktree root.
fn runner_for(worktree: &Path, file: &str) -> Option<(Runner, PathBuf)> {
    if file.ends_with(".py") {
        return Some((Runner::Pytest, worktree.to_path_buf()));
    }
    let spec = Regex::new(r"\.spec\.[cm]?[jt]sx?$").expect("static regex");
    let is_playwright_file = spec.is_match(file) || file.split(['/', '\\']).any(|part| part == "e2e");
    let root = worktree.to_path_buf();
    let mut dir = worktree.join(file).parent()?.to_path_buf();
    while dir.starts_with(&root) {
        if is_playwright_file {
            for name in ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cjs"] {
                if dir.join(name).exists() {
                    return Some((Runner::Playwright, dir));
                }
            }
        }
        for name in ["vitest.config.ts", "vitest.config.js", "vitest.config.mts"] {
            if dir.join(name).exists() {
                return Some((Runner::Vitest, dir));
            }
        }
        let package = dir.join("package.json");
        if package.exists() {
            let pkg: serde_json::Value = std::fs::read_to_string(&package)
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or_default();
            let scripts: Vec<&str> = pkg["scripts"]
                .as_object()
                .map(|o| o.values().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            if scripts.iter().any(|s| s.contains("node --import ./test/register.mjs --test")) {
                return Some((Runner::RendererNodeTest, dir));
            }
            if scripts.iter().any(|s| s.contains("node --test out/")) {
                return Some((Runner::NodeTest, dir));
            }
            let has_dep = |name: &str| pkg["dependencies"].get(name).is_some() || pkg["devDependencies"].get(name).is_some();
            if has_dep("vitest") {
                return Some((Runner::Vitest, dir));
            }
            if has_dep("jest") {
                return Some((Runner::Jest, dir));
            }
        }
        if dir == root {
            break;
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

fn check_node(id: &str, name: &str, command: &str, args: Vec<String>, timeout_ms: u64) -> WorkflowCheckNode {
    WorkflowCheckNode {
        base: WorkflowNodeBase { id: id.to_string(), name: name.to_string(), x: 0.0, y: 0.0, inputs: Vec::new(), enabled: None },
        command: command.to_string(),
        args: Some(args),
        success_exit_codes: None,
        outputs: Vec::new(),
        mutates_worktree: None,
        satisfies_gate: None,
        timeout_ms: Some(timeout_ms),
        max_attempts: None,
        adapter: None,
        report_path: None,
        observe: None,
        failure_recovery: None,
        affected_tests: None,
    }
}

fn command_for(runner: Runner, project: Option<&str>, files: &[String]) -> (String, Vec<String>) {
    let mut args: Vec<String>;
    let command = match runner {
        Runner::Playwright => {
            args = vec!["playwright".into(), "test".into()];
            if let Some(project) = project {
                args.push(format!("--project={project}"));
            }
            "npx"
        }
        Runner::Vitest => {
            args = vec!["vitest".into(), "run".into()];
            "npx"
        }
        Runner::Jest => {
            args = vec!["jest".into(), "--runTestsByPath".into()];
            "npx"
        }
        Runner::Pytest => {
            args = vec!["-m".into(), "pytest".into()];
            "python3"
        }
        Runner::NodeTest => {
            args = vec!["--test".into()];
            "node"
        }
        Runner::RendererNodeTest => {
            args = vec!["--import".into(), "./test/register.mjs".into(), "--test".into()];
            "node"
        }
    };
    args.extend(files.iter().cloned());
    (command.to_string(), args)
}

type FileProjects = Vec<(String, BTreeSet<String>)>;

fn collect_projects(suite: &serde_json::Value, by_file: &mut FileProjects) {
    for spec in suite["specs"].as_array().into_iter().flatten() {
        let Some(file) = spec["file"].as_str().or_else(|| suite["file"].as_str()) else { continue };
        for run in spec["tests"].as_array().into_iter().flatten() {
            let Some(project) = run["projectName"].as_str() else { continue };
            match by_file.iter_mut().find(|(f, _)| f == file) {
                Some((_, set)) => {
                    set.insert(project.to_string());
                }
                None => by_file.push((file.to_string(), BTreeSet::from([project.to_string()]))),
            }
        }
    }
    for child in suite["suites"].as_array().into_iter().flatten() {
        collect_projects(child, by_file);
    }
}

/// Each file in the first of its config's projects that includes it, so no file runs twice.
async fn playwright_projects(
    group: &RunnerGroup,
    env: &BTreeMap<String, String>,
    cancel: Option<&CancellationToken>,
) -> Option<Vec<(String, Vec<String>)>> {
    let mut args: Vec<String> = ["playwright", "test", "--list", "--reporter=json"].map(String::from).to_vec();
    args.extend(group.files.iter().cloned());
    let listed = spawn_check(&check_node("affected-tests-list", "List tests", "npx", args, 120_000), &group.cwd, env, cancel, None).await;
    let json = &listed.output[listed.output.find('{')?..];
    let report: serde_json::Value = serde_json::from_str(json).ok()?;
    let order: Vec<String> = report["config"]["projects"]
        .as_array()
        .map(|p| p.iter().filter_map(|p| p["name"].as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let mut by_file: FileProjects = Vec::new();
    for suite in report["suites"].as_array().into_iter().flatten() {
        collect_projects(suite, &mut by_file);
    }
    let mut by_project: Vec<(String, Vec<String>)> = Vec::new();
    for file in &group.files {
        // The JSON report names files relative to the config's test directory.
        let listed = by_file.iter().find(|(name, _)| file == name || file.ends_with(&format!("/{name}")));
        let Some(chosen) = order.iter().find(|name| listed.is_some_and(|(_, set)| set.contains(*name))) else { continue };
        match by_project.iter_mut().find(|(p, _)| p == chosen) {
            Some((_, files)) => files.push(file.clone()),
            None => by_project.push((chosen.clone(), vec![file.clone()])),
        }
    }
    Some(by_project)
}

/// Runs the selected tests and reports them as one check result: every runner's output in turn,
/// and a non-zero code when any of them failed.
pub async fn run_affected_tests(
    worktree: &Path,
    selection: &AffectedTestSelection,
    cancel: Option<&CancellationToken>,
    timeout_ms: Option<u64>,
    on_line: &mut (dyn FnMut(&str) + Send),
) -> CheckProcessResult {
    let mut lines: Vec<String> = vec!["== Tests for this change ==".into()];
    if selection.tests.is_empty() {
        lines.push("No test files were added or updated in this ticket.".into());
        return CheckProcessResult { code: Some(0), output: lines.join("\n"), timed_out: false, error: None };
    }
    for test in &selection.tests {
        lines.push(format!("- {}: {}", test.file, test.reasons.iter().take(3).cloned().collect::<Vec<_>>().join("; ")));
    }
    if selection.dropped > 0 {
        lines.push(format!("({} more matched less strongly and were left out.)", selection.dropped));
    }

    let mut groups: Vec<RunnerGroup> = Vec::new();
    let mut unclaimed: Vec<String> = Vec::new();
    for test in &selection.tests {
        let Some((runner, cwd)) = runner_for(worktree, &test.file) else {
            unclaimed.push(test.file.clone());
            continue;
        };
        let relative = worktree
            .join(&test.file)
            .strip_prefix(&cwd)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| test.file.clone());
        let file = if runner == Runner::NodeTest {
            let swapped = Regex::new(r"^src/").expect("static regex").replace(&relative, "out/").into_owned();
            Regex::new(r"\.tsx?$").expect("static regex").replace(&swapped, ".js").into_owned()
        } else {
            relative
        };
        match groups.iter_mut().find(|g| g.runner == runner && g.cwd == cwd) {
            Some(group) => group.files.push(file),
            None => groups.push(RunnerGroup { runner, cwd, files: vec![file] }),
        }
    }
    if !unclaimed.is_empty() {
        lines.push(format!("Could not run because no supported test runner setup claims them: {}", unclaimed.join(", ")));
    }

    let mut failed = !unclaimed.is_empty();
    let mut timed_out = false;
    let vars: Vec<(String, String)> = std::env::vars().collect();
    let env = check_environment("affected-tests", vars.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    for group in &groups {
        let runs: Vec<(Option<String>, Vec<String>)> = if group.runner == Runner::Playwright {
            match playwright_projects(group, &env, cancel).await {
                Some(projects) => projects.into_iter().map(|(p, f)| (Some(p), f)).collect(),
                None => vec![(None, group.files.clone())],
            }
        } else {
            vec![(None, group.files.clone())]
        };
        for (project, files) in runs {
            if cancel.is_some_and(CancellationToken::is_cancelled) {
                break;
            }
            let (command, args) = command_for(group.runner, project.as_deref(), &files);
            let relative = group.cwd.strip_prefix(worktree).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            lines.push(String::new());
            lines.push(format!("$ {command} {}  (in {})", args.join(" "), if relative.is_empty() { "." } else { &relative }));
            let node = check_node("affected-tests", "Tests for this change", &command, args, timeout_ms.unwrap_or(1_800_000));
            let result = spawn_check(&node, &group.cwd, &env, cancel, Some(&mut *on_line)).await;
            lines.push(result.output.trim_end().to_string());
            if let Some(error) = &result.error {
                lines.push(error.clone());
            }
            if result.timed_out {
                timed_out = true;
            }
            if result.code != Some(0) {
                failed = true;
            }
        }
    }
    CheckProcessResult { code: Some(i32::from(failed || timed_out)), output: lines.join("\n"), timed_out, error: None }
}

fn looks_like_sha(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// Where the run's branch left the project's current branch: the newest commit the run did not
/// make. None when the project checkout has no branch (detached HEAD) or git cannot answer.
pub async fn run_fork_point(worktree: &Path, project_folder: &Path) -> Option<String> {
    let branch = git(project_folder, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await.ok()?;
    let branch = branch.trim();
    if branch.is_empty() {
        return None;
    }
    let fork = git(worktree, &["merge-base", branch, "HEAD"]).await.ok()?;
    let fork = fork.trim();
    looks_like_sha(fork).then(|| fork.to_string())
}

/// The ticket-start commit for scheduled runs: the captured base when it is still an ancestor of
/// HEAD, else the last commit before the run started.
pub async fn scheduled_ticket_base(worktree: &Path, started_at: &str, captured: Option<&str>) -> Option<String> {
    if let Some(captured) = captured.filter(|c| !c.is_empty())
        && git(worktree, &["merge-base", "--is-ancestor", captured, "HEAD"]).await.is_ok()
    {
        return Some(captured.to_string());
    }
    let before = format!("--before={started_at}");
    let commit = git(worktree, &["log", &before, "-n", "1", "--format=%H"]).await.ok()?;
    let commit = commit.trim();
    looks_like_sha(commit).then(|| commit.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Repo(PathBuf);
    impl Repo {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("praxis-affected-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = Self(std::fs::canonicalize(&dir).unwrap());
            repo.git(&["init", "-q", "--initial-branch=main"]);
            repo
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn write(&self, rel: &str, text: &str) {
            let file = self.0.join(rel);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        fn git(&self, args: &[&str]) {
            let status = std::process::Command::new("git")
                .args(["-c", "user.name=T", "-c", "user.email=t@example.test"])
                .args(args)
                .current_dir(&self.0)
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        }
        fn commit(&self, message: &str) {
            self.git(&["add", "-f", "."]);
            self.git(&["commit", "-qm", message]);
        }
        fn head(&self) -> String {
            let out = std::process::Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&self.0).output().unwrap();
            String::from_utf8(out.stdout).unwrap().trim().to_string()
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn recognises_test_files() {
        assert!(is_test_file("e2e/a.spec.ts"));
        assert!(is_test_file("src/__tests__/x.tsx"));
        assert!(is_test_file("test/earlier-ticket.test.js"));
        assert!(is_test_file("pkg/test_x.py"));
        assert!(is_test_file("pkg/x_test.go"));
        assert!(!is_test_file("src/Shelf.tsx"));
        assert!(!is_test_file("node_modules/a/b.test.js"));
    }

    #[tokio::test]
    async fn selects_only_tests_changed_since_the_base_and_reports_none_when_there_are_none() {
        let repo = Repo::new();
        repo.write("test/earlier.test.js", "x\n");
        repo.commit("base");
        let base = repo.head();
        repo.write("source.js", "x\n");
        repo.commit("source");
        let none = select_changed_tests(repo.path(), &base).await.unwrap();
        assert!(none.tests.is_empty());
        let result = run_affected_tests(repo.path(), &none, None, None, &mut |_| {}).await;
        assert_eq!(result.code, Some(0));
        assert!(result.output.contains("== Tests for this change =="));
        assert!(result.output.contains("No test files were added or updated in this ticket."));

        repo.write("test/new.test.js", "x\n");
        repo.commit("test");
        let some = select_changed_tests(repo.path(), &base).await.unwrap();
        assert_eq!(some.tests.len(), 1);
        assert_eq!(some.tests[0].file, "test/new.test.js");
        // No runner setup claims it: that fails QA rather than passing unrun.
        let result = run_affected_tests(repo.path(), &some, None, None, &mut |_| {}).await;
        assert_eq!(result.code, Some(1));
        assert!(result.output.contains("- test/new.test.js: added or updated in this ticket"));
        assert!(result.output.contains("no supported test runner setup claims them"));
    }

    #[tokio::test]
    async fn runs_a_node_test_file_under_its_owning_package() {
        let repo = Repo::new();
        repo.write("package.json", r#"{"scripts":{"test":"node --test out/"}}"#);
        repo.commit("base");
        let base = repo.head();
        repo.write("src/a.test.ts", "x\n");
        repo.commit("test");
        // The compiled output is not committed; it exists on disk as `npm run build` leaves it.
        repo.write("out/a.test.js", "require('node:test')('ok', () => {});\n");
        let selection = select_changed_tests(repo.path(), &base).await.unwrap();
        let result = run_affected_tests(repo.path(), &selection, None, None, &mut |_| {}).await;
        assert!(result.output.contains("$ node --test out/a.test.js  (in .)"), "{}", result.output);
    }

    #[tokio::test]
    async fn a_scheduled_base_trusts_the_captured_ancestor() {
        let repo = Repo::new();
        repo.write("a", "1");
        repo.commit("base");
        let base = repo.head();
        repo.write("b", "1");
        repo.commit("next");
        let got = scheduled_ticket_base(repo.path(), "2000-01-01T00:00:00.000Z", Some(&base)).await;
        assert_eq!(got.as_deref(), Some(base.as_str()));
        assert_eq!(run_fork_point(repo.path(), repo.path()).await.as_deref(), Some(repo.head().as_str()));
    }
}
