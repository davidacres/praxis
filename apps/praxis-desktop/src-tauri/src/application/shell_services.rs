//! Shell commands an agent runs, and what they leave running (FX-BF-048 / TASK-393).
//!
//! On macOS and Linux a command runs as the leader of its own process group. The tool's result
//! is ready when the shell exits, not when every inherited output pipe closes, so a
//! backgrounded dev server no longer holds the tool open until the timeout. Whatever is still
//! in the group then is a *survivor*: a service the command started. It is tracked: one claim
//! on the process group for as long as it lives, plus the ports it listens on (a server is
//! usually still starting when the command that launched it returns), reported to the session
//! as a background task. A process that calls `setsid` leaves the group and is not seen.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use praxis_ai::coordination::{ClaimMode, Lifetime, RequestItem, Resource};
use serde_json::{Value, json};

use super::acp_host::{Task, evt};
use super::coordination::{Decision, Gate, Grant};
use super::runtime::runtime;

const MAX_BUFFER: usize = 2 * 1024 * 1024;
const SERVICE_POLL: Duration = Duration::from_secs(2);

/// What a finished shell command left behind.
#[derive(Debug, Default)]
pub struct ShellRun {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    /// Set when the command failed to start, timed out, was cancelled or exited non-zero.
    pub error: Option<String>,
    /// The command's process group (its shell's pid).
    pub pgid: Option<i64>,
    /// Processes still in the group after the shell exited.
    pub survivors: Vec<i64>,
}

/// Members of a process group. Empty when the group is gone; `None` means observation failed,
/// not that the processes exited.
pub fn read_process_group_members(pgid: i64) -> Option<Vec<i64>> {
    let output = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,pgid=,stat="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(members_in(&String::from_utf8_lossy(&output.stdout), pgid))
}

/// Parses `ps -o pid=,pgid=,stat=` output. A zombie has exited; it holds nothing.
fn members_in(listing: &str, pgid: i64) -> Vec<i64> {
    listing
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let (pid, group, stat) = (
                fields.next()?,
                fields.next()?,
                fields.next().unwrap_or_default(),
            );
            (group.parse::<i64>().ok()? == pgid && !stat.starts_with('Z'))
                .then(|| pid.parse::<i64>().ok())
                .flatten()
        })
        .collect()
}

fn process_group_members(pgid: i64) -> Vec<i64> {
    read_process_group_members(pgid).unwrap_or_default()
}

/// TCP ports the given processes listen on (best effort, via `lsof`).
pub fn listening_ports(pids: &[i64]) -> Vec<u32> {
    if pids.is_empty() {
        return Vec::new();
    }
    let list = pids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    // lsof exits 1 when nothing matches.
    let Ok(output) = std::process::Command::new("lsof")
        .args(["-nP", "-a", "-p", &list, "-iTCP", "-sTCP:LISTEN", "-Fn"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    ports_in(&String::from_utf8_lossy(&output.stdout))
}

fn ports_in(listing: &str) -> Vec<u32> {
    let mut ports: Vec<u32> = listing
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix('n')?
                .rsplit(':')
                .next()?
                .parse::<u32>()
                .ok()
        })
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

#[cfg(unix)]
fn signal_process_group(pgid: i64, signal: nix::sys::signal::Signal) -> bool {
    i32::try_from(pgid).is_ok_and(|raw| {
        raw > 1 && nix::sys::signal::killpg(nix::unistd::Pid::from_raw(raw), signal).is_ok()
    })
}

#[cfg(not(unix))]
fn signal_process_group(_pgid: i64, _signal: i32) -> bool {
    false
}

/// Stops a process group: SIGTERM, then SIGKILL for anything still there after a grace period.
pub async fn stop_process_group(pgid: i64) -> bool {
    #[cfg(unix)]
    {
        use nix::sys::signal::Signal;
        signal_process_group(pgid, Signal::SIGTERM);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while tokio::time::Instant::now() < deadline {
            if read_process_group_members(pgid).is_some_and(|members| members.is_empty()) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        signal_process_group(pgid, Signal::SIGKILL);
        tokio::time::sleep(Duration::from_millis(100)).await;
        read_process_group_members(pgid).is_some_and(|members| members.is_empty())
    }
    #[cfg(not(unix))]
    {
        let _ = pgid;
        false
    }
}

/// Kills the command's whole group if the tool call is dropped (a cancelled turn).
struct GroupGuard {
    pgid: Option<i64>,
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pgid) = self.pgid {
            signal_process_group(pgid, nix::sys::signal::Signal::SIGKILL);
        }
    }
}

async fn read_capped(mut stream: impl tokio::io::AsyncRead + Unpin, into: Arc<Mutex<Vec<u8>>>) {
    use tokio::io::AsyncReadExt;
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if let Ok(mut buffer) = into.lock() {
                    let room = MAX_BUFFER.saturating_sub(buffer.len());
                    buffer.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
        }
    }
}

fn text_of(buffer: &Mutex<Vec<u8>>) -> String {
    buffer
        .lock()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

/// Runs `command` in its own process group. Dropping the returned future stops the group.
pub async fn run_shell_command(
    command: &str,
    cwd: &Path,
    timeout: Duration,
    path_env: String,
) -> ShellRun {
    let mut shell = tokio::process::Command::new("/bin/sh");
    shell
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .env("PATH", path_env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    #[cfg(unix)]
    shell.process_group(0);
    let mut child = match shell.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ShellRun {
                exit_code: 1,
                error: Some(error.to_string()),
                ..ShellRun::default()
            };
        }
    };
    let pgid = child.id().map(i64::from);
    let mut guard = GroupGuard { pgid };
    let (out, err) = (
        Arc::new(Mutex::new(Vec::new())),
        Arc::new(Mutex::new(Vec::new())),
    );
    let readers: Vec<tokio::task::JoinHandle<()>> = [
        child
            .stdout
            .take()
            .map(|s| tokio::spawn(read_capped(s, Arc::clone(&out)))),
        child
            .stderr
            .take()
            .map(|s| tokio::spawn(read_capped(s, Arc::clone(&err)))),
    ]
    .into_iter()
    .flatten()
    .collect();

    let waited = tokio::time::timeout(timeout, child.wait()).await;
    let (exit_code, signalled, timed_out) = match waited {
        Err(_) => {
            if let Some(pgid) = pgid {
                stop_process_group(pgid).await;
            }
            let _ = child.wait().await;
            (1, false, true)
        }
        Ok(Ok(status)) => (status.code().unwrap_or(128), status.code().is_none(), false),
        Ok(Err(error)) => {
            guard.pgid = None;
            return ShellRun {
                exit_code: 1,
                error: Some(error.to_string()),
                pgid,
                ..ShellRun::default()
            };
        }
    };
    // Read what was written until both pipes end — or, if a background process inherited them
    // and keeps them open, for a moment more, then stop: it must not hold the tool open.
    let mut waiting = Vec::new();
    for reader in readers {
        waiting.push(reader);
    }
    let all_ended = async {
        for reader in &mut waiting {
            let _ = reader.await;
        }
    };
    let _ = tokio::time::timeout(Duration::from_millis(250), all_ended).await;
    for reader in &waiting {
        reader.abort();
    }
    let survivors = pgid.map(process_group_members).unwrap_or_default();
    // The command ended normally: whatever survived is a service, not something to kill.
    guard.pgid = None;
    let error = if timed_out {
        Some(format!(
            "timed out after {} s; the command's processes were stopped",
            timeout.as_secs()
        ))
    } else if exit_code != 0 {
        Some(format!(
            "exited with code {exit_code}{}",
            if signalled { " (signal)" } else { "" }
        ))
    } else {
        None
    };
    ShellRun {
        stdout: text_of(&out),
        stderr: text_of(&err),
        exit_code,
        error,
        pgid,
        survivors,
    }
}

// ── services ─────────────────────────────────────────────────────────────

struct Service {
    command: String,
    ports: Vec<u32>,
    started_at: i64,
    releases: Vec<Grant>,
    task: Arc<Task>,
    gate: Option<Gate>,
    checking: bool,
    unobserved: bool,
    poller: tokio::task::JoinHandle<()>,
}

type Services = Mutex<HashMap<i64, Service>>;

fn services() -> &'static Services {
    static SERVICES: OnceLock<Services> = OnceLock::new();
    SERVICES.get_or_init(Default::default)
}

fn with_services<T>(change: impl FnOnce(&mut HashMap<i64, Service>) -> T) -> T {
    change(
        &mut services()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    )
}

fn label(command: &str) -> String {
    if command.chars().count() > 60 {
        format!("{}…", command.chars().take(60).collect::<String>())
    } else {
        command.to_owned()
    }
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn task_id(pgid: i64, started_at: i64) -> String {
    format!("shell:{pgid}:{started_at}")
}

/// Persists a background task's lifecycle independently of the foreground turn (`updateBackgroundTask`).
pub(super) fn report_background(task: &Task, incoming: Value) {
    report(task, incoming);
}

fn report(task: &Task, incoming: Value) {
    // A task from an earlier run of this session must not write into the session's new one.
    if task
        .store
        .get(&task.key)
        .ok()
        .flatten()
        .is_none_or(|record| record["sessionId"] != task.owner_session_id.as_str())
    {
        return;
    }
    let changed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = Arc::clone(&changed);
    let live = |state: &Value| matches!(state.as_str(), Some("running" | "paused"));
    let summary = incoming.clone();
    task.mutate(true, move |record| {
        let current = record["backgroundTasks"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let id = incoming["id"].clone();
        let previous = current.iter().find(|item| item["id"] == id).cloned();
        // A replayed beat must never resurrect a finished task.
        if previous
            .as_ref()
            .is_some_and(|p| !live(&p["state"]) && p["state"] != "unknown")
            && live(&incoming["state"])
        {
            return;
        }
        let mut next = previous.clone().unwrap_or_else(|| json!({}));
        for (key, value) in incoming.as_object().into_iter().flatten() {
            next[key] = value.clone();
        }
        next["label"] = json!(
            next["label"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(180)
                .collect::<String>()
        );
        if let Some(detail) = next["detail"].as_str() {
            next["detail"] = json!(detail.chars().take(2000).collect::<String>());
        }
        if previous.as_ref().is_some_and(|p| {
            p["state"] == next["state"]
                && p["label"] == next["label"]
                && p["detail"] == next["detail"]
        }) {
            return;
        }
        // A provider's structured launch result is superseded once the same call reports real status.
        let supersedes = |item: &Value| {
            !incoming["callId"].is_null()
                && item["state"] == "unknown"
                && item["source"] == incoming["source"]
                && item["producerId"] == incoming["producerId"]
                && item["callId"] == incoming["callId"]
        };
        let others: Vec<Value> = current
            .into_iter()
            .filter(|item| item["id"] != id && !supersedes(item))
            .collect();
        let (running, finished): (Vec<Value>, Vec<Value>) =
            others.into_iter().partition(|item| live(&item["state"]));
        let keep = finished.len().saturating_sub(49);
        let mut all = running;
        all.extend(finished.into_iter().skip(keep));
        flag.store(
            previous
                .as_ref()
                .is_none_or(|p| p["state"] != next["state"]),
            std::sync::atomic::Ordering::SeqCst,
        );
        all.push(next);
        record["backgroundTasks"] = json!(all);
    });
    if changed.load(std::sync::atomic::Ordering::SeqCst) {
        let state = summary["state"].as_str().unwrap_or("unknown");
        let label = summary["label"].as_str().unwrap_or_default();
        task.append(
            evt(
                "background_task",
                format!("Background task {state}: {label}"),
                summary["detail"].as_str().map(str::to_owned),
                None,
            ),
            0,
        );
    }
}

fn running_report(service: &Service, pgid: i64, detail: &str) -> Value {
    json!({ "id": task_id(pgid, service.started_at), "source": "shell", "label": service.command, "state": "running", "startedAt": iso(service.started_at), "updatedAt": iso(super::coordination::epoch_ms()), "detail": detail })
}

async fn settle_service(pgid: i64, how: &str) {
    let Some(service) = with_services(|all| all.remove(&pgid)) else {
        return;
    };
    service.poller.abort();
    let exited = how == "exited";
    let now = iso(super::coordination::epoch_ms());
    report(
        &service.task,
        json!({
            "id": task_id(pgid, service.started_at), "source": "shell", "label": service.command,
            "state": if exited { "exited" } else { "stopped" },
            "startedAt": iso(service.started_at), "updatedAt": now, "completedAt": now,
            "detail": if exited { "All observed processes exited. Their final exit code is unavailable." } else { how }
        }),
    );
    let evidence = format!("its processes (group {pgid}) {how}");
    for grant in &service.releases {
        grant.release(Some(&evidence)).await;
    }
}

/// Stops one tracked service (only one this process started); its claims are released once it is gone.
pub async fn stop_service(pgid: i64) -> bool {
    if !with_services(|all| all.contains_key(&pgid)) {
        return false;
    }
    let stopped = stop_process_group(pgid).await;
    if stopped {
        settle_service(pgid, "stopped from Praxis").await;
    }
    stopped
}

/// Stops every tracked service — the app is quitting and nothing would watch them.
pub async fn stop_all_services() {
    let all: Vec<i64> = with_services(|all| all.keys().copied().collect());
    for pgid in all {
        stop_service(pgid).await;
    }
}

/// Claims ports a service has started listening on since it was last looked at.
async fn claim_new_ports(pgid: i64, members: Vec<i64>) -> Result<Vec<u32>, String> {
    let (fresh, gate, command) = {
        let found = with_services(|all| {
            all.get_mut(&pgid).map(|service| {
                let fresh: Vec<u32> = listening_ports(&members)
                    .into_iter()
                    .filter(|port| !service.ports.contains(port))
                    .collect();
                service.ports.extend(&fresh);
                (fresh, service.gate.clone(), service.command.clone())
            })
        });
        let Some(found) = found else {
            return Ok(Vec::new());
        };
        found
    };
    if fresh.is_empty() {
        return Ok(Vec::new());
    }
    let Some(gate) = gate else { return Ok(fresh) };
    let items = fresh
        .iter()
        .map(|port| RequestItem {
            resource: Resource::Port { port: *port },
            mode: ClaimMode::Exclusive,
        })
        .collect();
    match gate
        .acquire(
            items,
            &format!("service `{}` listening", label(&command)),
            Lifetime::Service,
        )
        .await
    {
        Decision::Granted(grant) => {
            with_services(|all| {
                all.get_mut(&pgid)
                    .map(|service| service.releases.push(grant))
            });
            Ok(fresh)
        }
        Decision::Refused(reason) => Err(reason),
    }
}

async fn poll_service(pgid: i64) {
    let busy = with_services(|all| {
        all.get_mut(&pgid)
            .is_none_or(|service| std::mem::replace(&mut service.checking, true))
    });
    if busy {
        return;
    }
    let members = tokio::task::spawn_blocking(move || read_process_group_members(pgid))
        .await
        .ok()
        .flatten();
    match members {
        None => {
            with_services(|all| {
                if let Some(service) = all.get_mut(&pgid) {
                    if !service.unobserved {
                        let mut update = running_report(
                            service,
                            pgid,
                            "Process observation failed. Completion has not been confirmed; Praxis will retry.",
                        );
                        update["state"] = json!("unknown");
                        report(&service.task, update);
                    }
                    service.unobserved = true;
                    service.checking = false;
                }
            });
        }
        Some(members) if members.is_empty() => {
            settle_service(pgid, "exited").await;
        }
        Some(members) => {
            with_services(|all| {
                if let Some(service) = all.get_mut(&pgid)
                    && service.unobserved
                {
                    service.unobserved = false;
                    report(
                        &service.task,
                        running_report(service, pgid, "Process observation resumed."),
                    );
                }
            });
            let _ = claim_new_ports(pgid, members).await;
            with_services(|all| all.get_mut(&pgid).map(|service| service.checking = false));
        }
    }
}

/// Tracks what a shell command left running and describes it for the agent.
pub async fn track_service(
    task: &Arc<Task>,
    gate: Option<&Gate>,
    command: &str,
    pgid: i64,
    survivors: Vec<i64>,
) -> String {
    // Claimed before the command's own tool claim is released, so nothing slips in between.
    let decision = match gate {
        Some(gate) => Some(
            gate.acquire(
                vec![RequestItem {
                    resource: Resource::Process {
                        host: hostname(),
                        pgid,
                    },
                    mode: ClaimMode::Exclusive,
                }],
                &format!("service `{}`", label(command)),
                Lifetime::Service,
            )
            .await,
        ),
        None => None,
    };
    let started_at = super::coordination::epoch_ms();
    let poller = runtime().spawn(async move {
        loop {
            tokio::time::sleep(SERVICE_POLL).await;
            poll_service(pgid).await;
        }
    });
    let mut releases = Vec::new();
    let mut refused = None;
    match decision {
        Some(Decision::Granted(grant)) => releases.push(grant),
        Some(Decision::Refused(reason)) => refused = Some(reason),
        None => {}
    }
    let service = Service {
        command: command.to_owned(),
        ports: Vec::new(),
        started_at,
        releases,
        task: Arc::clone(task),
        gate: gate.cloned(),
        checking: false,
        unobserved: false,
        poller,
    };
    report(
        task,
        running_report(
            &service,
            pgid,
            "Praxis is watching the processes left running by this shell command.",
        ),
    );
    with_services(|all| all.insert(pgid, service));
    let ports = match claim_new_ports(pgid, survivors.clone()).await {
        Ok(ports) => ports,
        Err(reason) => {
            refused.get_or_insert(reason);
            Vec::new()
        }
    };
    let count = survivors.len();
    let listening = if ports.is_empty() {
        String::new()
    } else {
        format!(
            ", listening on port {}",
            ports
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let what = format!(
        "{count} process{} (group {pgid}){listening}",
        if count == 1 { "" } else { "es" }
    );
    match refused {
        Some(reason) => format!(
            "Still running in the background: {what}. It could not be claimed — {reason} Stop it with `kill -- -{pgid}` unless you meant to share it."
        ),
        None => format!(
            "Still running in the background: {what}. It stays claimed for this session (with any port it opens) until it exits; stop it with `kill -- -{pgid}` when you are done."
        ),
    }
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "localhost".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_listings_are_parsed_by_group_and_zombies_are_ignored() {
        let listing = "  101   101 Ss\n  102   101 S\n  103   101 Z\n  200   200 Ss\n";
        assert_eq!(members_in(listing, 101), vec![101, 102]);
        assert_eq!(members_in(listing, 200), vec![200]);
        assert!(members_in(listing, 999).is_empty());
    }

    #[test]
    fn listening_ports_are_read_from_lsof_field_output() {
        let listing = "p123\nn127.0.0.1:8080\nn*:3000\nn[::1]:8080\nnnot-a-port\n";
        assert_eq!(ports_in(listing), vec![3000, 8080]);
    }

    #[test]
    fn a_label_is_clipped_to_sixty_characters() {
        assert_eq!(label("short"), "short");
        assert_eq!(label(&"x".repeat(80)).chars().count(), 61);
    }

    #[tokio::test]
    async fn a_command_that_leaves_a_process_running_reports_it_as_a_survivor() {
        let dir = std::env::temp_dir();
        let run = run_shell_command(
            "sleep 30 > /dev/null 2>&1 & echo started",
            &dir,
            Duration::from_secs(20),
            std::env::var("PATH").unwrap_or_default(),
        )
        .await;
        assert_eq!(run.stdout.trim(), "started");
        assert!(run.error.is_none(), "{:?}", run.error);
        let pgid = run.pgid.expect("a process group");
        assert_eq!(
            run.survivors.len(),
            1,
            "the backgrounded sleep survives its shell"
        );
        assert!(stop_process_group(pgid).await);
        assert!(process_group_members(pgid).is_empty());
    }

    #[tokio::test]
    async fn a_failing_command_reports_its_exit_code_and_a_timeout_stops_the_group() {
        let dir = std::env::temp_dir();
        let path = std::env::var("PATH").unwrap_or_default();
        let failed = run_shell_command(
            "echo out; echo err >&2; exit 3",
            &dir,
            Duration::from_secs(20),
            path.clone(),
        )
        .await;
        assert_eq!(failed.exit_code, 3);
        assert_eq!(failed.error.as_deref(), Some("exited with code 3"));
        assert_eq!((failed.stdout.trim(), failed.stderr.trim()), ("out", "err"));
        assert!(failed.survivors.is_empty());

        let slow = run_shell_command("sleep 30", &dir, Duration::from_millis(300), path).await;
        assert!(
            slow.error
                .as_deref()
                .is_some_and(|e| e.starts_with("timed out after")),
            "{:?}",
            slow.error
        );
        assert!(process_group_members(slow.pgid.expect("pgid")).is_empty());
    }
}
