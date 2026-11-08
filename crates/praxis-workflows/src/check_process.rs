//! Runs a check stage's command and owns its process tree until it has stopped
//! (`workflowCheckProcess.ts` port).
//!
//! The command runs without a shell, in its own process group (Unix) so cancellation and
//! timeouts reach every descendant: SIGTERM first, SIGKILL a second later. On Windows the
//! tree is ended with `taskkill /T /F`. Checks get an allow-listed environment — a usable
//! PATH and locale, never the app's credentials or Node injection variables.
//!
//! Unlike the TS original, the environment to draw from is passed in rather than read from
//! (and enriched on) the global process environment, so the host decides what PATH means.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::types::WorkflowCheckNode;

/// The most output kept for a check, from the end.
const MAX_OUTPUT_CHARS: usize = 200_000;

/// How long a stopping check gets between SIGTERM and SIGKILL.
const FORCE_KILL_AFTER: Duration = Duration::from_secs(1);

/// Variables a check may inherit from the host environment.
const INHERITED_KEYS: &[&str] = &[
    "PATH",
    "Path",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "PRAXIS_E2E_WORKERS",
];

/// How a check process ended.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CheckProcessResult {
    /// The exit code; `None` when the process was ended by a signal or never ran.
    pub code: Option<i32>,
    pub output: String,
    pub timed_out: bool,
    pub error: Option<String>,
}

/// The environment a check runs with, drawn from `source`: the allow-listed keys, plus
/// unattended CI semantics (`CI=1` unless already set) and, outside real CI, four isolated
/// Electron workers (one for the affected-tests check) unless a worker count was chosen.
#[must_use]
pub fn check_environment<'a>(
    node_id: &str,
    source: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> BTreeMap<String, String> {
    let source: BTreeMap<&str, &str> = source.into_iter().collect();
    let mut env: BTreeMap<String, String> = INHERITED_KEYS
        .iter()
        .filter_map(|key| {
            source
                .get(key)
                .map(|value| ((*key).to_string(), (*value).to_string()))
        })
        .collect();
    let inherited_ci = source.get("CI");
    env.insert(
        "CI".to_string(),
        inherited_ci.map_or_else(|| "1".to_string(), |ci| (*ci).to_string()),
    );
    if inherited_ci.is_none() && !source.contains_key("PRAXIS_E2E_WORKERS") {
        let workers = if node_id == "affected-tests" {
            "1"
        } else {
            "4"
        };
        env.insert("PRAXIS_E2E_WORKERS".to_string(), workers.to_string());
    }
    env
}

fn is_executable_file(file: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(file) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Whether [`spawn_check`] would find `command` on `path` (no shell; PATHEXT on Windows),
/// so a missing scanner is reported before a run starts rather than when it reaches the stage.
#[must_use]
pub fn is_check_command_available(
    command: &str,
    path: Option<&str>,
    path_ext: Option<&str>,
) -> bool {
    let extensions: Vec<String> = if cfg!(windows) {
        std::iter::once(String::new())
            .chain(
                path_ext
                    .unwrap_or(".COM;.EXE;.BAT;.CMD")
                    .split(';')
                    .filter(|e| !e.is_empty())
                    .map(str::to_string),
            )
            .collect()
    } else {
        vec![String::new()]
    };
    let candidates = |file: &Path| {
        extensions.iter().any(|ext| {
            let mut name = file.as_os_str().to_os_string();
            name.push(ext);
            is_executable_file(Path::new(&name))
        })
    };
    let command_path = Path::new(command);
    if command_path.is_absolute() {
        return candidates(command_path);
    }
    std::env::split_paths(path.unwrap_or_default())
        .filter(|dir| !dir.as_os_str().is_empty())
        .any(|dir| candidates(&dir.join(command)))
}

enum Chunk {
    Data(Vec<u8>),
    Closed,
}

fn read_into(
    mut stream: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    tx: mpsc::UnboundedSender<Chunk>,
) {
    tokio::spawn(async move {
        let mut buffer = [0u8; 8192];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(Chunk::Data(buffer[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = tx.send(Chunk::Closed);
    });
}

/// Ends the check's whole process tree.
async fn kill_tree(child: &mut Child, pid: Option<u32>, force: bool) {
    let Some(pid) = pid else { return };
    #[cfg(unix)]
    {
        use nix::sys::signal::{Signal, killpg};
        use nix::unistd::Pid;
        let signal = if force {
            Signal::SIGKILL
        } else {
            Signal::SIGTERM
        };
        let group_killed =
            i32::try_from(pid).is_ok_and(|pid| match killpg(Pid::from_raw(pid), signal) {
                Ok(()) | Err(nix::errno::Errno::ESRCH) => true,
                Err(_) => false,
            });
        if !group_killed {
            let _ = child.start_kill();
        }
    }
    #[cfg(windows)]
    {
        let _ = child;
        let _ = force;
        let _ = Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .status()
            .await;
    }
}

/// Runs a check node's command in `cwd` with `env`, streaming complete output lines to
/// `on_line`. Resolves only once the process (and, when stopping, its tree) has stopped:
/// on cancellation the result carries `Check cancelled.`; on timeout, `timed_out`.
pub async fn spawn_check(
    node: &WorkflowCheckNode,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    cancel: Option<&CancellationToken>,
    mut on_line: Option<&mut (dyn FnMut(&str) + Send)>,
) -> CheckProcessResult {
    let cancelled = || cancel.is_some_and(CancellationToken::is_cancelled);
    if cancelled() {
        return CheckProcessResult {
            error: Some("Check cancelled.".to_string()),
            ..CheckProcessResult::default()
        };
    }

    let mut command = Command::new(&node.command);
    command
        .args(node.args.as_deref().unwrap_or_default())
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    #[cfg(unix)]
    command.process_group(0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return CheckProcessResult {
                error: Some(format!("Could not run {}: {error}", node.command)),
                ..CheckProcessResult::default()
            };
        }
    };
    let pid = child.id();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut open_streams = 0;
    if let Some(stdout) = child.stdout.take() {
        read_into(stdout, tx.clone());
        open_streams += 1;
    }
    if let Some(stderr) = child.stderr.take() {
        read_into(stderr, tx.clone());
        open_streams += 1;
    }
    drop(tx);

    let mut output = String::new();
    let mut pending_line = String::new();
    let mut timed_out = false;
    let mut stopping = false;
    let mut exit: Option<Option<i32>> = None;
    let timeout = tokio::time::sleep(Duration::from_millis(
        node.timeout_ms.filter(|t| *t > 0).unwrap_or(u64::MAX / 4),
    ));
    tokio::pin!(timeout);
    let force = tokio::time::sleep(Duration::MAX / 4);
    tokio::pin!(force);
    let never = CancellationToken::new();
    let cancel_token = cancel.unwrap_or(&never);

    while exit.is_none() || open_streams > 0 {
        tokio::select! {
            chunk = rx.recv(), if open_streams > 0 => match chunk {
                Some(Chunk::Data(bytes)) => {
                    let text = String::from_utf8_lossy(&bytes);
                    output.push_str(&text);
                    let excess = output.chars().count().saturating_sub(MAX_OUTPUT_CHARS);
                    if excess > 0 {
                        let cut = output.char_indices().nth(excess).map_or(output.len(), |(i, _)| i);
                        output.drain(..cut);
                    }
                    if let Some(on_line) = on_line.as_mut() {
                        pending_line.push_str(&text);
                        while let Some(newline) = pending_line.find('\n') {
                            let line: String = pending_line.drain(..=newline).collect();
                            on_line(line.trim_end_matches('\n').trim_end_matches('\r'));
                        }
                    }
                }
                Some(Chunk::Closed) | None => open_streams -= 1,
            },
            status = child.wait(), if exit.is_none() => {
                exit = Some(status.ok().and_then(|s| s.code()));
            }
            () = &mut timeout, if !stopping => {
                timed_out = true;
                stopping = true;
                kill_tree(&mut child, pid, false).await;
                force.as_mut().reset(tokio::time::Instant::now() + FORCE_KILL_AFTER);
            }
            () = cancel_token.cancelled(), if !stopping => {
                stopping = true;
                kill_tree(&mut child, pid, false).await;
                force.as_mut().reset(tokio::time::Instant::now() + FORCE_KILL_AFTER);
            }
            () = &mut force, if stopping => {
                kill_tree(&mut child, pid, true).await;
                force.as_mut().reset(tokio::time::Instant::now() + FORCE_KILL_AFTER);
            }
        }
    }
    if let Some(on_line) = on_line.as_mut()
        && !pending_line.is_empty()
    {
        on_line(&pending_line);
    }
    // Descendants can close their inherited pipes and outlive the leader.
    if stopping {
        kill_tree(&mut child, pid, true).await;
    }
    CheckProcessResult {
        code: exit.flatten(),
        output,
        timed_out,
        error: cancelled().then(|| "Check cancelled.".to_string()),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::types::WorkflowNodeBase;

    fn sh(script: &str) -> WorkflowCheckNode {
        WorkflowCheckNode {
            base: WorkflowNodeBase {
                id: "check".to_string(),
                name: "Check".to_string(),
                x: 0.0,
                y: 0.0,
                inputs: Vec::new(),
                enabled: None,
            },
            command: "/bin/sh".to_string(),
            args: Some(vec!["-c".to_string(), script.to_string()]),
            success_exit_codes: None,
            outputs: Vec::new(),
            mutates_worktree: None,
            satisfies_gate: None,
            timeout_ms: None,
            max_attempts: None,
            adapter: None,
            report_path: None,
            observe: None,
            failure_recovery: None,
            affected_tests: None,
        }
    }

    fn host_env() -> BTreeMap<String, String> {
        check_environment("check", [("PATH", "/usr/bin:/bin"), ("HOME", "/tmp")])
    }

    #[tokio::test]
    async fn an_already_cancelled_check_never_launches() {
        let token = CancellationToken::new();
        token.cancel();
        let marker = std::env::temp_dir().join(format!("praxis-never-{}", std::process::id()));
        let script = format!("touch {}", marker.display());
        let result = spawn_check(
            &sh(&script),
            &std::env::temp_dir(),
            &host_env(),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(result.error.as_deref(), Some("Check cancelled."));
        assert_eq!(result.output, "");
        assert!(!marker.exists());
    }

    #[test]
    fn local_checks_get_ci_semantics_with_parallel_workers_by_default() {
        let env = check_environment("check", [("PATH", "/bin")]);
        assert_eq!(
            (env["CI"].as_str(), env["PRAXIS_E2E_WORKERS"].as_str()),
            ("1", "4")
        );
        let affected = check_environment("affected-tests", [("PATH", "/bin")]);
        assert_eq!(affected["PRAXIS_E2E_WORKERS"], "1");
        let real_ci = check_environment("check", [("CI", "custom-ci")]);
        assert_eq!(real_ci["CI"], "custom-ci");
        assert!(
            !real_ci.contains_key("PRAXIS_E2E_WORKERS"),
            "real CI stays serial"
        );
        let explicit = check_environment("check", [("PRAXIS_E2E_WORKERS", "2")]);
        assert_eq!(
            (
                explicit["CI"].as_str(),
                explicit["PRAXIS_E2E_WORKERS"].as_str()
            ),
            ("1", "2")
        );
    }

    #[test]
    fn checks_never_inherit_credentials_or_node_injection_variables() {
        let env = check_environment(
            "check",
            [
                ("PATH", "/bin"),
                ("PRAXIS_SECURITY_TEST_SECRET", "fixture"),
                ("NODE_OPTIONS", "--require=/probe"),
                ("NODE_PATH", "/modules"),
                ("AWS_SECRET_ACCESS_KEY", "cloud"),
                ("PRAXIS_TEST_API_KEY", "sk-should-not-leak"),
            ],
        );
        assert_eq!(
            env.keys().map(String::as_str).collect::<Vec<_>>(),
            ["CI", "PATH", "PRAXIS_E2E_WORKERS"]
        );
    }

    #[tokio::test]
    async fn the_spawned_process_sees_only_the_given_environment() {
        let mut env = host_env();
        env.insert("EXTRA".into(), "x".into());
        let result = spawn_check(
            &sh("printf '%s|%s|%s' \"$CI\" \"$PRAXIS_E2E_WORKERS\" \"${PRAXIS_TEST_API_KEY:-none}\""),
            &std::env::temp_dir(),
            &env,
            None,
            None,
        )
        .await;
        assert_eq!(result.code, Some(0));
        assert_eq!(result.output, "1|4|none");
    }

    #[tokio::test]
    async fn checks_stream_complete_output_lines_and_report_exit_codes() {
        let mut lines: Vec<String> = Vec::new();
        let mut collect = |line: &str| lines.push(line.to_string());
        let result = spawn_check(
            &sh("printf '✔ 1 [functional] › opens the board\\r\\n304 passed (5.7m)\\npartial'; exit 3"),
            &std::env::temp_dir(),
            &host_env(),
            None,
            Some(&mut collect),
        )
        .await;
        assert_eq!(result.code, Some(3));
        assert_eq!(
            lines,
            [
                "✔ 1 [functional] › opens the board",
                "304 passed (5.7m)",
                "partial"
            ]
        );
    }

    #[tokio::test]
    async fn cancellation_terminates_a_process_tree_that_ignores_sigterm() {
        let dir = std::env::temp_dir().join(format!("praxis-check-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let marker = dir.join("ready");
        // A child that ignores SIGTERM, with a grandchild holding the pipes open.
        let script = format!(
            "trap '' TERM; (trap '' TERM; sleep 30) & touch {}; sleep 30",
            marker.display()
        );
        let token = CancellationToken::new();
        let node = sh(&script);
        let env = host_env();
        let run = spawn_check(&node, &dir, &env, Some(&token), None);
        let canceller = async {
            for _ in 0..200 {
                if marker.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(marker.exists(), "the check started");
            token.cancel();
        };
        let started = std::time::Instant::now();
        let (result, ()) = tokio::join!(run, canceller);
        assert_eq!(result.error.as_deref(), Some("Check cancelled."));
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the tree was force-killed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_timeout_resolves_only_after_the_process_has_stopped() {
        let mut node = sh("trap '' TERM; sleep 30");
        node.timeout_ms = Some(200);
        let result = spawn_check(&node, &std::env::temp_dir(), &host_env(), None, None).await;
        assert!(result.timed_out);
        assert_eq!(result.code, None);
    }

    #[tokio::test]
    async fn a_missing_command_is_an_error_not_a_hang() {
        let mut node = sh("");
        node.command = "praxis-no-such-scanner-9f3a".to_string();
        let result = spawn_check(&node, &std::env::temp_dir(), &host_env(), None, None).await;
        assert!(
            result
                .error
                .unwrap_or_default()
                .starts_with("Could not run praxis-no-such-scanner-9f3a")
        );
    }

    #[test]
    fn the_pre_run_lookup_finds_what_spawn_check_can_run_and_nothing_else() {
        assert!(is_check_command_available("/bin/sh", None, None));
        assert!(is_check_command_available(
            "sh",
            Some("/usr/bin:/bin"),
            None
        ));
        assert!(!is_check_command_available(
            "praxis-no-such-scanner-9f3a",
            Some("/usr/bin:/bin"),
            None
        ));
        assert!(!is_check_command_available(
            "/tmp/praxis-no-such-scanner-9f3a",
            None,
            None
        ));
        assert!(!is_check_command_available("sh", Some(""), None));
    }
}
