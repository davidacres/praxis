//! Local process lifecycle for a project's Run profile (`projects/runServiceManager.ts` port).
//!
//! Each `RunServiceDefinition` is spawned as a real child process and treated as up only once
//! its readiness probe passes (or, with no probe, once it has stayed alive for a short settle
//! window). A service starts only after everything it `depends_on` is ready. A service whose
//! dependency failed is marked failed and never spawned.
//!
//! Every service runs in its own supervisor task that owns its child. Stopping cancels that
//! task, which terminates the whole process group (Unix) and then reports `stopped`. Only a
//! process this manager spawned is ever signalled.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use indexmap::IndexMap;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::run_profile::{
    RunProfile, RunProfileIssue, RunReadinessProbe, RunServiceDefinition, validate_run_profile,
};

pub const DEFAULT_READINESS_TIMEOUT: Duration = Duration::from_secs(30);
/// A probe-less service must stay alive this long to count as ready.
const NO_PROBE_SETTLE: Duration = Duration::from_millis(400);
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(200);
const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
/// How long a stopping service gets between SIGTERM and SIGKILL.
const FORCE_KILL_AFTER: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunServiceState {
    Pending,
    Starting,
    Ready,
    Failed,
    Stopping,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunServiceStatus {
    pub id: String,
    pub state: RunServiceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RunServiceStatus {
    fn pending(id: &str) -> Self {
        Self {
            id: id.to_string(),
            state: RunServiceState::Pending,
            pid: None,
            started_at: None,
            ready_at: None,
            exit_code: None,
            signal: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunLogStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLogLine {
    pub service_id: String,
    pub stream: RunLogStream,
    pub text: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunEvent {
    Status(RunServiceStatus),
    Log(RunLogLine),
}

#[derive(Debug, Clone)]
pub struct StartRunOptions {
    /// A service's `cwd` is repo-relative and resolved against this.
    pub project_folder: PathBuf,
    /// How long a service may take to pass its probe before it is failed.
    pub readiness_timeout: Duration,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RunError {
    #[error("A run is already active; stop it before starting another.")]
    AlreadyActive,
    #[error("Run profile is invalid: {0}")]
    Invalid(String),
    #[error("No run is active; call start() first.")]
    NoActiveRun,
    #[error("Unknown service \"{0}\".")]
    UnknownService(String),
    #[error("Cannot start \"{service}\": dependency {deps} is not ready.")]
    DependencyNotReady { service: String, deps: String },
}

/// Whether a service has become ready, for dependents to wait on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Pending,
    Ready,
    Failed,
}

/// One launch of a service. `settled` flips once readiness has been decided, which is when
/// `start` and `start_service` return. `finished` flips once the process has ended, which is
/// what a stop waits for. Stopping cancels the attempt.
struct Attempt {
    cancel: CancellationToken,
    settled: watch::Receiver<bool>,
    finished: watch::Receiver<bool>,
}

/// Held by a launch task. Dropping it marks the attempt finished, however it ends.
struct Done {
    settled: watch::Sender<bool>,
    finished: watch::Sender<bool>,
}

impl Done {
    fn settle(&self) {
        self.settled.send_replace(true);
    }
}

impl Drop for Done {
    fn drop(&mut self) {
        self.settled.send_replace(true);
        self.finished.send_replace(true);
    }
}

fn new_attempt(parent: &CancellationToken) -> (Attempt, Done) {
    let (settled_tx, settled_rx) = watch::channel(false);
    let (finished_tx, finished_rx) = watch::channel(false);
    (
        Attempt {
            cancel: parent.child_token(),
            settled: settled_rx,
            finished: finished_rx,
        },
        Done {
            settled: settled_tx,
            finished: finished_tx,
        },
    )
}

struct ManagedService {
    definition: RunServiceDefinition,
    status: RunServiceStatus,
    attempt: Option<Attempt>,
    outcome: Arc<watch::Sender<Outcome>>,
}

struct ActiveRun {
    options: StartRunOptions,
    cancel: CancellationToken,
}

#[derive(Default)]
struct Inner {
    active: Option<ActiveRun>,
    services: IndexMap<String, ManagedService>,
}

struct Shared {
    inner: Mutex<Inner>,
    events: broadcast::Sender<RunEvent>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Applies a status change to one service and announces it.
    fn patch(&self, id: &str, change: impl FnOnce(&mut RunServiceStatus)) {
        let mut inner = self.lock();
        if let Some(service) = inner.services.get_mut(id) {
            change(&mut service.status);
            let snapshot = service.status.clone();
            let _ = self.events.send(RunEvent::Status(snapshot));
        }
    }
}

/// Owns at most one active run. Create one per project rather than sharing it across projects.
pub struct RunServiceManager {
    shared: Arc<Shared>,
}

impl Default for RunServiceManager {
    fn default() -> Self {
        Self::new()
    }
}

impl RunServiceManager {
    #[must_use]
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(Inner::default()),
                events,
            }),
        }
    }

    /// Status and log events, as they happen. Lagging receivers may miss some.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<RunEvent> {
        self.shared.events.subscribe()
    }

    /// A snapshot of every tracked service's status, in profile order.
    #[must_use]
    pub fn status(&self) -> Vec<RunServiceStatus> {
        self.shared
            .lock()
            .services
            .values()
            .map(|s| s.status.clone())
            .collect()
    }

    /// Starts every service and resolves once each has either become ready or failed.
    pub async fn start(
        &self,
        profile: &RunProfile,
        options: StartRunOptions,
    ) -> Result<(), RunError> {
        let issues = validate_run_profile(profile);
        if !issues.is_empty() {
            return Err(RunError::Invalid(join_issues(&issues)));
        }

        let run_cancel = CancellationToken::new();
        let mut launches = Vec::new();
        let mut waits = Vec::new();
        {
            let mut inner = self.shared.lock();
            if inner.active.is_some() {
                return Err(RunError::AlreadyActive);
            }
            inner.active = Some(ActiveRun {
                options: options.clone(),
                cancel: run_cancel.clone(),
            });
            inner.services = profile
                .services
                .iter()
                .map(|definition| {
                    let service = ManagedService {
                        definition: definition.clone(),
                        status: RunServiceStatus::pending(&definition.id),
                        attempt: None,
                        outcome: Arc::new(watch::channel(Outcome::Pending).0),
                    };
                    (definition.id.clone(), service)
                })
                .collect();

            for definition in &profile.services {
                let deps: Vec<(String, watch::Receiver<Outcome>)> = definition
                    .depends_on
                    .iter()
                    .flatten()
                    .filter_map(|dep| {
                        inner
                            .services
                            .get(dep)
                            .map(|s| (dep.clone(), s.outcome.subscribe()))
                    })
                    .collect();
                let (attempt, done) = new_attempt(&run_cancel);
                waits.push(attempt.settled.clone());
                let cancel = attempt.cancel.clone();
                let service = inner
                    .services
                    .get_mut(&definition.id)
                    .expect("service was just inserted");
                let outcome = Arc::clone(&service.outcome);
                service.attempt = Some(attempt);
                launches.push((definition.clone(), deps, outcome, cancel, done));
            }
        }

        for (definition, deps, outcome, cancel, done) in launches {
            tokio::spawn(run_attempt(
                Arc::clone(&self.shared),
                definition,
                deps,
                Some(outcome),
                options.clone(),
                cancel,
                done,
            ));
        }
        for mut done in waits {
            let _ = done.wait_for(|finished| *finished).await;
        }
        Ok(())
    }

    /// Tears down every tracked process. Safe to call repeatedly.
    pub async fn stop(&self) {
        let run = self.shared.lock().active.take();
        let Some(run) = run else { return };
        run.cancel.cancel();
        let ids: Vec<String> = self.shared.lock().services.keys().cloned().collect();
        let mut stops = JoinSet::new();
        for id in ids {
            let shared = Arc::clone(&self.shared);
            stops.spawn(async move { stop_one(&shared, &id).await });
        }
        while stops.join_next().await.is_some() {}
    }

    /// Stops one service, leaving the rest of the run alone. Dependents keep running.
    pub async fn stop_service(&self, service_id: &str) -> Result<(), RunError> {
        if !self.shared.lock().services.contains_key(service_id) {
            return Err(RunError::UnknownService(service_id.to_string()));
        }
        stop_one(&self.shared, service_id).await;
        Ok(())
    }

    /// (Re)starts one stopped or failed service in an active run, reusing the run's options.
    /// Refuses when a dependency is not currently ready.
    pub async fn start_service(&self, service_id: &str) -> Result<(), RunError> {
        let (definition, options, run_cancel) = {
            let inner = self.shared.lock();
            let run = inner.active.as_ref().ok_or(RunError::NoActiveRun)?;
            let service = inner
                .services
                .get(service_id)
                .ok_or_else(|| RunError::UnknownService(service_id.to_string()))?;
            let not_ready: Vec<String> = service
                .definition
                .depends_on
                .iter()
                .flatten()
                .filter(|dep| {
                    inner
                        .services
                        .get(dep.as_str())
                        .is_none_or(|s| s.status.state != RunServiceState::Ready)
                })
                .map(|dep| format!("\"{dep}\""))
                .collect();
            if !not_ready.is_empty() {
                return Err(RunError::DependencyNotReady {
                    service: service_id.to_string(),
                    deps: not_ready.join(", "),
                });
            }
            (
                service.definition.clone(),
                run.options.clone(),
                run.cancel.clone(),
            )
        };

        let (attempt, done) = new_attempt(&run_cancel);
        let mut wait = attempt.settled.clone();
        let cancel = attempt.cancel.clone();
        if let Some(service) = self.shared.lock().services.get_mut(service_id) {
            service.attempt = Some(attempt);
        }
        tokio::spawn(run_attempt(
            Arc::clone(&self.shared),
            definition,
            Vec::new(),
            None,
            options,
            cancel,
            done,
        ));
        let _ = wait.wait_for(|finished| *finished).await;
        Ok(())
    }

    /// Stops then starts one service.
    pub async fn restart_service(&self, service_id: &str) -> Result<(), RunError> {
        self.stop_service(service_id).await?;
        self.start_service(service_id).await
    }
}

fn join_issues(issues: &[RunProfileIssue]) -> String {
    issues
        .iter()
        .map(|i| {
            format!(
                "{}: {}",
                if i.path.is_empty() { "(root)" } else { &i.path },
                i.message
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Stops one service. A service that has already failed or stopped is left as it is.
async fn stop_one(shared: &Shared, id: &str) {
    let done = {
        let mut inner = shared.lock();
        let Some(service) = inner.services.get_mut(id) else {
            return;
        };
        if matches!(
            service.status.state,
            RunServiceState::Failed | RunServiceState::Stopped
        ) {
            return;
        }
        match service.attempt.take() {
            Some(attempt) => {
                service.status.state = RunServiceState::Stopping;
                let snapshot = service.status.clone();
                let _ = shared.events.send(RunEvent::Status(snapshot));
                attempt.cancel.cancel();
                Some(attempt.finished)
            }
            None => {
                service.status.state = RunServiceState::Stopped;
                let snapshot = service.status.clone();
                let _ = shared.events.send(RunEvent::Status(snapshot));
                None
            }
        }
    };
    if let Some(mut done) = done {
        let _ = done.wait_for(|finished| *finished).await;
    }
}

/// One launch of a service: waits for its dependencies, launches it, and waits until readiness is
/// decided. Then it watches the process until that process ends or is stopped.
async fn run_attempt(
    shared: Arc<Shared>,
    definition: RunServiceDefinition,
    deps: Vec<(String, watch::Receiver<Outcome>)>,
    outcome: Option<Arc<watch::Sender<Outcome>>>,
    options: StartRunOptions,
    cancel: CancellationToken,
    done: Done,
) {
    let id = definition.id.clone();
    let mut blocked = false;
    for (dep, mut rx) in deps {
        let result = tokio::select! {
            () = cancel.cancelled() => None,
            waited = rx.wait_for(|o| *o != Outcome::Pending) => {
                Some(waited.map(|o| *o).unwrap_or(Outcome::Failed))
            }
        };
        match result {
            None => {
                shared.patch(&id, |s| s.state = RunServiceState::Stopped);
                blocked = true;
                break;
            }
            Some(Outcome::Failed) => {
                let message = format!("Dependency \"{dep}\" failed to become ready.");
                shared.patch(&id, |s| {
                    s.state = RunServiceState::Failed;
                    s.error = Some(message);
                });
                blocked = true;
                break;
            }
            Some(_) => {}
        }
    }
    if blocked {
        if let Some(tx) = &outcome {
            tx.send_replace(Outcome::Failed);
        }
        done.settle();
        return;
    }

    let running = launch_and_probe(&shared, &definition, &options, &cancel).await;
    if let Some(tx) = &outcome {
        tx.send_replace(if running.is_some() {
            Outcome::Ready
        } else {
            Outcome::Failed
        });
    }
    done.settle();
    if let Some(running) = running {
        watch_until_exit(&shared, &definition, &cancel, running).await;
    }
}

/// A service that has passed its readiness probe and is still running.
struct Running {
    child: Child,
    pid: Option<u32>,
}

enum Phase {
    Stop,
    TimedOut,
    Exited(std::io::Result<std::process::ExitStatus>),
    Ready,
}

/// Spawns one service and drives it to ready. Returns the live process when it became ready.
/// Otherwise the status already records why and the process has been stopped.
#[allow(clippy::too_many_lines)]
async fn launch_and_probe(
    shared: &Shared,
    definition: &RunServiceDefinition,
    options: &StartRunOptions,
    cancel: &CancellationToken,
) -> Option<Running> {
    let id = definition.id.as_str();
    let fail = |error: String| {
        move |s: &mut RunServiceStatus| {
            s.state = RunServiceState::Failed;
            s.error = Some(error);
        }
    };

    if let Some(error) = preflight_issue(definition) {
        shared.patch(id, fail(error));
        return None;
    }
    if let Some(port) = definition.port {
        if !is_port_available(port).await {
            shared.patch(id, fail(format!("Port {port} is already in use.")));
            return None;
        }
    }
    if cancel.is_cancelled() {
        shared.patch(id, |s| s.state = RunServiceState::Stopped);
        return None;
    }

    shared.patch(id, |s| {
        s.state = RunServiceState::Starting;
        s.started_at = Some(now());
        s.ready_at = None;
        s.error = None;
        s.exit_code = None;
        s.signal = None;
    });

    let cwd = definition.cwd.as_ref().map_or_else(
        || options.project_folder.clone(),
        |c| options.project_folder.join(c),
    );
    let mut command = Command::new(&definition.executable);
    command
        .args(definition.args.iter().flatten())
        .envs(definition.env.iter().flatten())
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    #[cfg(unix)]
    command.process_group(0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            shared.patch(
                id,
                fail(format!(
                    "Could not start {}: {error}",
                    definition.executable
                )),
            );
            return None;
        }
    };
    let pid = child.id();
    shared.patch(id, |s| s.pid = pid);

    let (ready_tx, mut ready_rx) = mpsc::unbounded_channel::<()>();
    let pattern = match &definition.readiness_probe {
        Some(RunReadinessProbe::LogLine { match_text }) => Some(match_text.clone()),
        _ => None,
    };
    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(
            stdout,
            RunLogStream::Stdout,
            id.to_string(),
            shared.events.clone(),
            ready_tx.clone(),
            pattern.clone(),
        );
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(
            stderr,
            RunLogStream::Stderr,
            id.to_string(),
            shared.events.clone(),
            ready_tx.clone(),
            pattern,
        );
    }
    drop(ready_tx);

    let timeout = options.readiness_timeout;
    let phase = tokio::select! {
        () = cancel.cancelled() => Phase::Stop,
        () = await_readiness(definition, &mut ready_rx) => Phase::Ready,
        () = tokio::time::sleep(timeout) => Phase::TimedOut,
        status = child.wait() => Phase::Exited(status),
    };

    match phase {
        Phase::Stop => {
            terminate(&mut child, pid).await;
            shared.patch(id, |s| s.state = RunServiceState::Stopped);
            None
        }
        Phase::TimedOut => {
            shared.patch(
                id,
                fail(format!(
                    "Readiness timed out after {}ms.",
                    timeout.as_millis()
                )),
            );
            terminate(&mut child, pid).await;
            None
        }
        Phase::Exited(status) => {
            let (code, signal) = exit_details(status);
            shared.patch(id, move |s| {
                s.state = RunServiceState::Failed;
                s.error = Some(format!(
                    "{} exited before it became ready (code {}).",
                    definition.name,
                    code.map_or_else(|| "null".to_string(), |c| c.to_string())
                ));
                s.exit_code = code;
                s.signal = signal;
            });
            None
        }
        Phase::Ready => {
            shared.patch(id, |s| {
                s.state = RunServiceState::Ready;
                s.pid = pid;
                s.ready_at = Some(now());
            });
            Some(Running { child, pid })
        }
    }
}

/// Watches a ready service until it is stopped or exits on its own.
async fn watch_until_exit(
    shared: &Shared,
    definition: &RunServiceDefinition,
    cancel: &CancellationToken,
    mut running: Running,
) {
    let id = definition.id.as_str();
    tokio::select! {
        () = cancel.cancelled() => {
            terminate(&mut running.child, running.pid).await;
            shared.patch(id, |s| s.state = RunServiceState::Stopped);
        }
        status = running.child.wait() => {
            let (code, signal) = exit_details(status);
            if cancel.is_cancelled() {
                shared.patch(id, |s| s.state = RunServiceState::Stopped);
            } else {
                shared.patch(id, move |s| {
                    s.state = RunServiceState::Failed;
                    s.error = Some(format!("{} exited unexpectedly.", definition.name));
                    s.exit_code = code;
                    s.signal = signal;
                });
            }
        }
    }
}

/// Waits until the service's readiness probe passes.
async fn await_readiness(
    definition: &RunServiceDefinition,
    ready_rx: &mut mpsc::UnboundedReceiver<()>,
) {
    match &definition.readiness_probe {
        None => tokio::time::sleep(NO_PROBE_SETTLE).await,
        Some(RunReadinessProbe::Tcp { port }) => loop {
            if probe_tcp(*port).await {
                return;
            }
            tokio::time::sleep(PROBE_POLL_INTERVAL).await;
        },
        Some(RunReadinessProbe::Http {
            path,
            expected_status,
        }) => loop {
            let port = definition.port.unwrap_or_default();
            if let Ok(port) = u16::try_from(port) {
                if check_http_ok(port, path, *expected_status, PROBE_CONNECT_TIMEOUT).await {
                    return;
                }
            }
            tokio::time::sleep(PROBE_POLL_INTERVAL).await;
        },
        Some(RunReadinessProbe::LogLine { .. }) => {
            if ready_rx.recv().await.is_none() {
                // Output closed without a match; the exit branch decides the outcome.
                std::future::pending::<()>().await;
            }
        }
    }
}

fn spawn_log_reader<R>(
    stream: R,
    kind: RunLogStream,
    service_id: String,
    events: broadcast::Sender<RunEvent>,
    ready: mpsc::UnboundedSender<()>,
    pattern: Option<String>,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(stream);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let decoded = String::from_utf8_lossy(&buffer);
            let text = decoded.trim_end_matches(['\n', '\r']);
            if text.is_empty() {
                continue;
            }
            let _ = events.send(RunEvent::Log(RunLogLine {
                service_id: service_id.clone(),
                stream: kind,
                text: text.to_string(),
                at: now(),
            }));
            if pattern.as_deref().is_some_and(|p| text.contains(p)) {
                let _ = ready.send(());
            }
        }
    });
}

fn exit_details(
    status: std::io::Result<std::process::ExitStatus>,
) -> (Option<i32>, Option<String>) {
    let Ok(status) = status else {
        return (None, None);
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        let signal = status
            .signal()
            .and_then(|n| nix::sys::signal::Signal::try_from(n).ok())
            .map(|s| s.as_str().to_string());
        (status.code(), signal)
    }
    #[cfg(not(unix))]
    {
        (status.code(), None)
    }
}

/// An http probe has no base URL of its own, so the service must declare its port.
fn preflight_issue(definition: &RunServiceDefinition) -> Option<String> {
    match &definition.readiness_probe {
        Some(RunReadinessProbe::Http { .. }) if definition.port.is_none() => {
            Some("An http readiness probe requires the service to declare a port.".to_string())
        }
        _ => None,
    }
}

/// Binds a throwaway listener to prove nothing else already holds the port.
async fn is_port_available(port: u32) -> bool {
    let Ok(port) = u16::try_from(port) else {
        return false;
    };
    TcpListener::bind(("127.0.0.1", port)).await.is_ok()
}

async fn probe_tcp(port: u32) -> bool {
    let Ok(port) = u16::try_from(port) else {
        return false;
    };
    matches!(
        tokio::time::timeout(
            PROBE_CONNECT_TIMEOUT,
            TcpStream::connect(("127.0.0.1", port))
        )
        .await,
        Ok(Ok(_))
    )
}

/// One minimal HTTP GET against `127.0.0.1:port`. Passes on `expected_status`, or any 2xx.
pub async fn check_http_ok(
    port: u16,
    probe_path: &str,
    expected_status: Option<u16>,
    timeout: Duration,
) -> bool {
    if !probe_path.starts_with('/') {
        return false;
    }
    let attempt = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        let request = format!(
            "GET {probe_path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.ok()?;
        let mut head = [0u8; 256];
        let read = stream.read(&mut head).await.ok()?;
        let text = String::from_utf8_lossy(&head[..read]);
        let status: u16 = text.split_whitespace().nth(1)?.parse().ok()?;
        Some(match expected_status {
            Some(expected) => status == expected,
            None => (200..300).contains(&status),
        })
    };
    matches!(tokio::time::timeout(timeout, attempt).await, Ok(Some(true)))
}

/// Ends the service's whole process tree: SIGTERM to the group, then SIGKILL after a grace period.
async fn terminate(child: &mut Child, pid: Option<u32>) {
    signal_tree(child, pid, false).await;
    if tokio::time::timeout(FORCE_KILL_AFTER, child.wait())
        .await
        .is_err()
    {
        signal_tree(child, pid, true).await;
        let _ = child.wait().await;
    }
}

#[cfg(unix)]
async fn signal_tree(child: &mut Child, pid: Option<u32>, force: bool) {
    use nix::errno::Errno;
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    let Some(pid) = pid else { return };
    let signal = if force {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    };
    let group_signalled = i32::try_from(pid).is_ok_and(|raw| {
        matches!(
            killpg(Pid::from_raw(raw), signal),
            Ok(()) | Err(Errno::ESRCH)
        )
    });
    if !group_signalled {
        let _ = child.start_kill();
    }
}

#[cfg(not(unix))]
async fn signal_tree(child: &mut Child, pid: Option<u32>, _force: bool) {
    let _ = &child;
    let Some(pid) = pid else { return };
    let _ = Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .status()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScratchDir;
    use std::time::Instant;

    fn service(id: &str, script: &str) -> RunServiceDefinition {
        RunServiceDefinition {
            id: id.into(),
            name: id.into(),
            executable: "sh".into(),
            args: Some(vec!["-c".into(), script.into()]),
            cwd: None,
            depends_on: None,
            readiness_probe: None,
            port: None,
            env: None,
        }
    }

    fn profile(services: Vec<RunServiceDefinition>) -> RunProfile {
        RunProfile {
            schema_version: 1,
            id: "p".into(),
            name: "Project".into(),
            services,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    fn options(dir: &ScratchDir) -> StartRunOptions {
        StartRunOptions {
            project_folder: dir.path().to_path_buf(),
            readiness_timeout: Duration::from_secs(10),
        }
    }

    fn status_of(manager: &RunServiceManager, id: &str) -> RunServiceStatus {
        manager
            .status()
            .into_iter()
            .find(|s| s.id == id)
            .expect("service is tracked")
    }

    /// Polls until a service reaches a state matching `done`, or fails the test after a deadline.
    async fn wait_for(
        manager: &RunServiceManager,
        id: &str,
        done: impl Fn(&RunServiceStatus) -> bool,
    ) -> RunServiceStatus {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let status = status_of(manager, id);
            if done(&status) {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting on {id}: {status:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn a_service_with_no_probe_becomes_ready_once_it_settles_and_stop_tears_it_down() {
        let dir = ScratchDir::new("svc-noprobe");
        let manager = RunServiceManager::new();
        manager
            .start(&profile(vec![service("web", "sleep 60")]), options(&dir))
            .await
            .expect("start");
        let status = status_of(&manager, "web");
        assert_eq!(status.state, RunServiceState::Ready);
        assert!(status.pid.is_some());
        manager.stop().await;
        assert_eq!(status_of(&manager, "web").state, RunServiceState::Stopped);
    }

    #[tokio::test]
    async fn a_log_line_probe_is_satisfied_by_matching_output_and_streams_it() {
        let dir = ScratchDir::new("svc-logline");
        let manager = RunServiceManager::new();
        let mut events = manager.subscribe();
        let mut web = service("web", "echo 'server ready'; sleep 60");
        web.readiness_probe = Some(RunReadinessProbe::LogLine {
            match_text: "server ready".into(),
        });
        manager
            .start(&profile(vec![web]), options(&dir))
            .await
            .expect("start");
        assert_eq!(status_of(&manager, "web").state, RunServiceState::Ready);

        let mut saw_line = false;
        while let Ok(event) = events.try_recv() {
            if let RunEvent::Log(line) = event {
                saw_line |= line.text == "server ready" && line.stream == RunLogStream::Stdout;
            }
        }
        assert!(
            saw_line,
            "the matching stdout line is streamed as a log event"
        );
        manager.stop().await;
    }

    #[tokio::test]
    async fn a_tcp_probe_is_satisfied_once_the_port_accepts_connections() {
        let dir = ScratchDir::new("svc-tcp");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = u32::from(listener.local_addr().expect("addr").port());
        let manager = RunServiceManager::new();
        let mut web = service("web", "sleep 60");
        web.readiness_probe = Some(RunReadinessProbe::Tcp { port });
        manager
            .start(&profile(vec![web]), options(&dir))
            .await
            .expect("start");
        assert_eq!(status_of(&manager, "web").state, RunServiceState::Ready);
        manager.stop().await;
        drop(listener);
    }

    #[tokio::test]
    async fn an_http_probe_checks_the_declared_path_and_status() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = [0u8; 512];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let status = if request.starts_with("GET /healthz ") {
                    "200 OK"
                } else {
                    "404 Not Found"
                };
                let _ = socket
                    .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes())
                    .await;
            }
        });

        let timeout = Duration::from_secs(2);
        assert!(check_http_ok(port, "/healthz", None, timeout).await);
        assert!(!check_http_ok(port, "/missing", None, timeout).await);
        assert!(check_http_ok(port, "/missing", Some(404), timeout).await);
        assert!(
            !check_http_ok(port, "healthz", None, timeout).await,
            "path must be absolute"
        );
    }

    #[tokio::test]
    async fn an_http_probe_without_a_declared_port_fails_before_anything_is_spawned() {
        let dir = ScratchDir::new("svc-http-noport");
        let manager = RunServiceManager::new();
        let mut web = service("web", "sleep 60");
        web.readiness_probe = Some(RunReadinessProbe::Http {
            path: "/".into(),
            expected_status: None,
        });
        manager
            .start(&profile(vec![web]), options(&dir))
            .await
            .expect("start");
        let status = status_of(&manager, "web");
        assert_eq!(status.state, RunServiceState::Failed);
        assert!(status.pid.is_none(), "nothing was spawned");
        assert!(
            status
                .error
                .unwrap_or_default()
                .contains("requires the service to declare a port")
        );
    }

    #[tokio::test]
    async fn a_port_already_held_by_something_else_fails_the_service_without_spawning_it() {
        let dir = ScratchDir::new("svc-port");
        let holder = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = u32::from(holder.local_addr().expect("addr").port());
        let manager = RunServiceManager::new();
        let mut web = service("web", "sleep 60");
        web.port = Some(port);
        manager
            .start(&profile(vec![web]), options(&dir))
            .await
            .expect("start");
        let status = status_of(&manager, "web");
        assert_eq!(status.state, RunServiceState::Failed);
        assert!(status.pid.is_none());
        assert_eq!(
            status.error.as_deref(),
            Some(format!("Port {port} is already in use.").as_str())
        );
    }

    #[tokio::test]
    async fn a_service_that_exits_before_becoming_ready_is_failed_not_ready() {
        let dir = ScratchDir::new("svc-early-exit");
        let manager = RunServiceManager::new();
        manager
            .start(&profile(vec![service("web", "exit 3")]), options(&dir))
            .await
            .expect("start");
        let status = status_of(&manager, "web");
        assert_eq!(status.state, RunServiceState::Failed);
        assert_eq!(status.exit_code, Some(3));
        assert!(
            status
                .error
                .unwrap_or_default()
                .contains("exited before it became ready (code 3)")
        );
    }

    #[tokio::test]
    async fn a_service_is_never_spawned_once_something_it_depends_on_fails() {
        let dir = ScratchDir::new("svc-failed-dep");
        let manager = RunServiceManager::new();
        let mut api = service("api", "sleep 60");
        api.depends_on = Some(vec!["db".into()]);
        manager
            .start(&profile(vec![service("db", "exit 1"), api]), options(&dir))
            .await
            .expect("start");
        let api = status_of(&manager, "api");
        assert_eq!(api.state, RunServiceState::Failed);
        assert!(
            api.pid.is_none(),
            "a dependent of a failed service is never spawned"
        );
        assert_eq!(
            api.error.as_deref(),
            Some("Dependency \"db\" failed to become ready.")
        );
    }

    #[tokio::test]
    async fn a_dependent_does_not_start_until_its_dependency_is_ready() {
        let dir = ScratchDir::new("svc-order");
        let manager = RunServiceManager::new();
        let mut db = service("db", "sleep 0.3; echo go; sleep 60");
        db.readiness_probe = Some(RunReadinessProbe::LogLine {
            match_text: "go".into(),
        });
        let mut api = service("api", "sleep 60");
        api.depends_on = Some(vec!["db".into()]);
        manager
            .start(&profile(vec![db, api]), options(&dir))
            .await
            .expect("start");
        let db_status = status_of(&manager, "db");
        let api_status = status_of(&manager, "api");
        assert_eq!(api_status.state, RunServiceState::Ready);
        let db_ready = db_status.ready_at.expect("db is ready");
        let api_started = api_status.started_at.expect("api started");
        assert!(
            api_started >= db_ready,
            "api started {api_started} before db was ready at {db_ready}"
        );
        manager.stop().await;
    }

    #[tokio::test]
    async fn a_service_whose_probe_is_never_satisfied_is_failed_and_killed_at_the_timeout() {
        let dir = ScratchDir::new("svc-timeout");
        let manager = RunServiceManager::new();
        let mut web = service("web", "sleep 60");
        web.readiness_probe = Some(RunReadinessProbe::LogLine {
            match_text: "never printed".into(),
        });
        manager
            .start(
                &profile(vec![web]),
                StartRunOptions {
                    project_folder: dir.path().to_path_buf(),
                    readiness_timeout: Duration::from_millis(500),
                },
            )
            .await
            .expect("start");
        let status = status_of(&manager, "web");
        assert_eq!(status.state, RunServiceState::Failed);
        assert_eq!(
            status.error.as_deref(),
            Some("Readiness timed out after 500ms.")
        );
    }

    #[tokio::test]
    async fn repeated_stop_is_a_safe_no_op() {
        let dir = ScratchDir::new("svc-stop-twice");
        let manager = RunServiceManager::new();
        manager
            .start(&profile(vec![service("web", "sleep 60")]), options(&dir))
            .await
            .expect("start");
        manager.stop().await;
        manager.stop().await;
        assert_eq!(status_of(&manager, "web").state, RunServiceState::Stopped);
    }

    #[tokio::test]
    async fn a_service_that_exits_unexpectedly_after_ready_is_marked_failed() {
        let dir = ScratchDir::new("svc-unexpected");
        let manager = RunServiceManager::new();
        let mut web = service("web", "echo ready; sleep 0.3; exit 2");
        web.readiness_probe = Some(RunReadinessProbe::LogLine {
            match_text: "ready".into(),
        });
        manager
            .start(&profile(vec![web]), options(&dir))
            .await
            .expect("start");
        let status = wait_for(&manager, "web", |s| s.state == RunServiceState::Failed).await;
        assert_eq!(status.error.as_deref(), Some("web exited unexpectedly."));
        assert_eq!(status.exit_code, Some(2));
        manager.stop().await;
    }

    #[tokio::test]
    async fn starting_a_second_run_while_one_is_active_is_refused() {
        let dir = ScratchDir::new("svc-second-run");
        let manager = RunServiceManager::new();
        let p = profile(vec![service("web", "sleep 60")]);
        manager.start(&p, options(&dir)).await.expect("start");
        assert_eq!(
            manager.start(&p, options(&dir)).await,
            Err(RunError::AlreadyActive)
        );
        manager.stop().await;
    }

    #[tokio::test]
    async fn an_invalid_profile_is_refused_before_anything_is_spawned() {
        let dir = ScratchDir::new("svc-invalid");
        let manager = RunServiceManager::new();
        let result = manager.start(&profile(vec![]), options(&dir)).await;
        assert!(matches!(result, Err(RunError::Invalid(_))));
        assert!(manager.status().is_empty());
    }

    #[tokio::test]
    async fn stop_service_stops_just_that_service() {
        let dir = ScratchDir::new("svc-stop-one");
        let manager = RunServiceManager::new();
        manager
            .start(
                &profile(vec![service("web", "sleep 60"), service("api", "sleep 60")]),
                options(&dir),
            )
            .await
            .expect("start");
        manager.stop_service("web").await.expect("stop web");
        assert_eq!(status_of(&manager, "web").state, RunServiceState::Stopped);
        assert_eq!(status_of(&manager, "api").state, RunServiceState::Ready);
        manager.stop().await;
    }

    #[tokio::test]
    async fn start_service_relaunches_a_stopped_service_with_the_runs_options() {
        let dir = ScratchDir::new("svc-start-one");
        let manager = RunServiceManager::new();
        manager
            .start(&profile(vec![service("web", "sleep 60")]), options(&dir))
            .await
            .expect("start");
        manager.stop_service("web").await.expect("stop");
        manager.start_service("web").await.expect("start web");
        assert_eq!(status_of(&manager, "web").state, RunServiceState::Ready);
        manager.stop().await;
    }

    #[tokio::test]
    async fn restart_service_is_stop_then_start() {
        let dir = ScratchDir::new("svc-restart");
        let manager = RunServiceManager::new();
        manager
            .start(&profile(vec![service("web", "sleep 60")]), options(&dir))
            .await
            .expect("start");
        let first_pid = status_of(&manager, "web").pid;
        manager.restart_service("web").await.expect("restart");
        let status = status_of(&manager, "web");
        assert_eq!(status.state, RunServiceState::Ready);
        assert_ne!(status.pid, first_pid, "a restart launches a new process");
        manager.stop().await;
    }

    #[tokio::test]
    async fn start_service_refuses_when_a_dependency_is_not_ready() {
        let dir = ScratchDir::new("svc-dep-not-ready");
        let manager = RunServiceManager::new();
        let mut api = service("api", "sleep 60");
        api.depends_on = Some(vec!["db".into()]);
        manager
            .start(
                &profile(vec![service("db", "sleep 60"), api]),
                options(&dir),
            )
            .await
            .expect("start");
        manager.stop_service("api").await.expect("stop api");
        manager.stop_service("db").await.expect("stop db");
        assert_eq!(
            manager.start_service("api").await,
            Err(RunError::DependencyNotReady {
                service: "api".into(),
                deps: "\"db\"".into(),
            })
        );
        manager.stop().await;
    }

    #[tokio::test]
    async fn run_controls_reject_unknown_services_and_inactive_runs() {
        let manager = RunServiceManager::new();
        assert_eq!(
            manager.start_service("web").await,
            Err(RunError::NoActiveRun)
        );
        let dir = ScratchDir::new("svc-unknown");
        manager
            .start(&profile(vec![service("web", "sleep 60")]), options(&dir))
            .await
            .expect("start");
        assert_eq!(
            manager.stop_service("ghost").await,
            Err(RunError::UnknownService("ghost".into()))
        );
        assert_eq!(
            manager.start_service("ghost").await,
            Err(RunError::UnknownService("ghost".into()))
        );
        manager.stop().await;
    }
}
