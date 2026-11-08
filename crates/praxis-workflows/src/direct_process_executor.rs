//! The `direct-process` deployment executor (`deployments/directProcessExecutor.ts` port).
//!
//! Spawns a project's own reviewed deployment script with its argument list, a scoped
//! working directory, and typed inputs passed as `PRAXIS_DEPLOY_<KEY>` environment
//! variables. Nothing builds a command string, so an argument or input containing spaces,
//! quotes, `;`, `&&`, `$(...)` or backticks reaches the script byte-for-byte and is never
//! parsed as shell syntax.
//!
//! The caller mints and persists `operation_id` before dispatch; it is echoed back on every
//! path, including a startup failure that never obtained a pid, a timeout and a
//! cancellation.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::process_tree::signal_process_tree;

/// Combined stdout+stderr retained; the oldest bytes are dropped first.
pub const MAX_OUTPUT_BYTES: usize = 200_000;
const INPUT_ENV_PREFIX: &str = "PRAXIS_DEPLOY_";
/// Grace period between SIGTERM and SIGKILL when stopping.
const FORCE_KILL_AFTER: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Default)]
pub struct DirectProcessDeploymentInput {
    /// Caller-assigned identity for this attempt, echoed back on every path.
    pub operation_id: String,
    pub executable: String,
    pub args: Vec<String>,
    /// Already resolved to an absolute path; no resolution happens here.
    pub cwd: PathBuf,
    /// Surfaced to the script as `PRAXIS_DEPLOY_<key>`, byte-identical.
    pub inputs: BTreeMap<String, String>,
    /// Extra environment beyond the inherited one and `inputs`.
    pub env: BTreeMap<String, String>,
    pub timeout: Option<Duration>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectProcessDeploymentResult {
    pub operation_id: String,
    /// Present once the process spawned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// `None` when the process never produced an exit code: a startup failure, or a kill.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    /// Bounded combined stdout+stderr, oldest truncated first.
    pub output: String,
    pub started_at: String,
    pub ended_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

type OutputBuffer = Arc<Mutex<Vec<u8>>>;

fn collect(buffer: &OutputBuffer, chunk: &[u8]) {
    let mut output = buffer.lock().unwrap_or_else(PoisonError::into_inner);
    output.extend_from_slice(chunk);
    if output.len() > MAX_OUTPUT_BYTES {
        let excess = output.len() - MAX_OUTPUT_BYTES;
        output.drain(..excess);
    }
}

fn read_into(
    mut stream: impl AsyncRead + Unpin + Send + 'static,
    buffer: OutputBuffer,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut chunk = [0u8; 8192];
        while let Ok(read) = stream.read(&mut chunk).await {
            if read == 0 {
                break;
            }
            collect(&buffer, &chunk[..read]);
        }
    })
}

fn output_text(buffer: &OutputBuffer) -> String {
    let output = buffer.lock().unwrap_or_else(PoisonError::into_inner);
    String::from_utf8_lossy(&output).into_owned()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stop {
    TimedOut,
    Cancelled,
}

/// Runs the deployment script to completion, a timeout, or cancellation via `cancel`. A
/// non-zero exit is a typed result, not an error; the caller reads `exit_code`.
pub async fn run_direct_process_deployment(
    input: DirectProcessDeploymentInput,
    cancel: Option<CancellationToken>,
) -> DirectProcessDeploymentResult {
    let started_at = now_iso();
    let cancel = cancel.unwrap_or_default();
    let result =
        |pid, exit_code, stop: Option<Stop>, output, error| DirectProcessDeploymentResult {
            operation_id: input.operation_id.clone(),
            pid,
            exit_code,
            timed_out: stop == Some(Stop::TimedOut),
            cancelled: stop == Some(Stop::Cancelled),
            output,
            started_at: started_at.clone(),
            ended_at: now_iso(),
            error,
        };

    if cancel.is_cancelled() {
        return result(
            None,
            None,
            Some(Stop::Cancelled),
            String::new(),
            Some("Deployment cancelled before it started.".to_string()),
        );
    }

    let mut command = Command::new(&input.executable);
    command
        .args(&input.args)
        .current_dir(&input.cwd)
        .envs(&input.env)
        .envs(
            input
                .inputs
                .iter()
                .map(|(key, value)| (format!("{INPUT_ENV_PREFIX}{key}"), value)),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return result(
                None,
                None,
                None,
                String::new(),
                Some(format!("Could not start {}: {error}", input.executable)),
            );
        }
    };
    let pid = child.id();

    let buffer: OutputBuffer = Arc::default();
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        readers.push(read_into(stdout, buffer.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(read_into(stderr, buffer.clone()));
    }

    let deadline = async {
        match input.timeout {
            Some(timeout) => tokio::time::sleep(timeout).await,
            None => std::future::pending().await,
        }
    };

    let mut stop = None;
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        () = deadline => { stop = Some(Stop::TimedOut); None }
        () = cancel.cancelled() => { stop = Some(Stop::Cancelled); None }
    };
    let status = match status {
        Some(status) => Some(status),
        None => {
            signal_process_tree(&mut child, pid, false).await;
            match tokio::time::timeout(FORCE_KILL_AFTER, child.wait()).await {
                Ok(status) => status.ok(),
                Err(_) => {
                    signal_process_tree(&mut child, pid, true).await;
                    child.wait().await.ok()
                }
            }
        }
    };
    if stop.is_some() {
        // Descendants can close their inherited pipes and outlive the leader.
        signal_process_tree(&mut child, pid, true).await;
    }
    for reader in readers {
        let _ = reader.await;
    }

    let error = match stop {
        Some(Stop::TimedOut) => Some(format!(
            "Deployment script timed out after {}ms.",
            input.timeout.unwrap_or_default().as_millis()
        )),
        Some(Stop::Cancelled) => Some("Deployment cancelled.".to_string()),
        None => None,
    };
    result(
        pid,
        status.and_then(|status| status.code()),
        stop,
        output_text(&buffer),
        error,
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::test_support::ScratchDir;

    fn sh(script: &str) -> DirectProcessDeploymentInput {
        DirectProcessDeploymentInput {
            operation_id: "op-1".to_string(),
            executable: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), script.to_string()],
            cwd: std::env::temp_dir(),
            ..DirectProcessDeploymentInput::default()
        }
    }

    fn is_alive(pid: i32) -> bool {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
    }

    #[tokio::test]
    async fn a_zero_exit_is_a_typed_success() {
        let result = run_direct_process_deployment(sh("printf hello; exit 0"), None).await;
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out && !result.cancelled);
        assert_eq!(result.output, "hello");
        assert_eq!(result.operation_id, "op-1");
        assert_eq!(result.error, None);
        assert!(result.pid.is_some());
    }

    #[tokio::test]
    async fn a_non_zero_exit_is_a_result_not_an_error() {
        let result = run_direct_process_deployment(sh("exit 7"), None).await;
        assert_eq!(result.exit_code, Some(7));
        assert_eq!(result.error, None);
    }

    #[tokio::test]
    async fn inputs_with_shell_metacharacters_arrive_byte_identical() {
        let dangerous = "/tmp/my dir; rm -rf / && echo pwned $(whoami) `echo x` \"quo'ted\"";
        let mut input = sh("printf %s \"$PRAXIS_DEPLOY_ARTIFACT_PATH\"");
        input
            .inputs
            .insert("ARTIFACT_PATH".to_string(), dangerous.to_string());
        let result = run_direct_process_deployment(input, None).await;
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.output, dangerous);

        let mut input =
            sh("printf '%s|%s' \"$PRAXIS_DEPLOY_ARTIFACT_PATH\" \"$PRAXIS_DEPLOY_TARGET_PATH\"");
        input
            .inputs
            .insert("ARTIFACT_PATH".to_string(), "/artifacts/a.zip".to_string());
        input
            .inputs
            .insert("TARGET_PATH".to_string(), "/var/www/site".to_string());
        let result = run_direct_process_deployment(input, None).await;
        assert_eq!(result.output, "/artifacts/a.zip|/var/www/site");
    }

    #[tokio::test]
    async fn a_cwd_with_spaces_is_honored() {
        let dir = ScratchDir::new("praxis deploy cwd");
        let real = std::fs::canonicalize(dir.path()).expect("realpath");
        let mut input = sh("pwd -P | tr -d '\\n'");
        input.cwd = dir.path().to_path_buf();
        let result = run_direct_process_deployment(input, None).await;
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.output, real.to_string_lossy());
    }

    #[tokio::test]
    async fn a_missing_executable_is_a_typed_startup_failure() {
        let mut input = sh("");
        input.executable = std::env::temp_dir()
            .join("praxis-does-not-exist-xyz")
            .to_string_lossy()
            .into_owned();
        input.args.clear();
        let result = run_direct_process_deployment(input, None).await;
        assert_eq!(result.exit_code, None);
        assert_eq!(result.operation_id, "op-1");
        assert!(result.error.unwrap_or_default().contains("Could not start"));
        assert_eq!(result.output, "");
    }

    #[tokio::test]
    async fn a_timeout_kills_the_process_and_keeps_its_output() {
        let mut input = sh("printf '%s' $$; exec sleep 30");
        input.timeout = Some(Duration::from_millis(200));
        let result = run_direct_process_deployment(input, None).await;
        assert!(result.timed_out);
        assert_eq!(result.operation_id, "op-1");
        assert!(result.error.unwrap_or_default().contains("timed out"));
        let pid: i32 = result.output.parse().expect("the script printed its pid");
        assert!(!is_alive(pid), "the timed-out process is actually gone");
    }

    #[tokio::test]
    async fn cancellation_before_or_during_the_run_is_reported() {
        let token = CancellationToken::new();
        token.cancel();
        let result = run_direct_process_deployment(sh("exit 0"), Some(token)).await;
        assert!(result.cancelled);
        assert_eq!(result.pid, None);
        assert_eq!(result.operation_id, "op-1");

        let token = CancellationToken::new();
        let trigger = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            trigger.cancel();
        });
        let result = run_direct_process_deployment(sh("exec sleep 30"), Some(token)).await;
        assert!(result.cancelled);
        assert!(!result.timed_out);
        assert_eq!(result.error.as_deref(), Some("Deployment cancelled."));
    }

    #[tokio::test]
    async fn output_beyond_the_bound_is_truncated() {
        let result =
            run_direct_process_deployment(sh("head -c 300000 /dev/zero | tr '\\0' x"), None).await;
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.output.len(), MAX_OUTPUT_BYTES);
    }
}
