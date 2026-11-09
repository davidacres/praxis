//! Integrated terminal sessions on `portable-pty` (`main/src/main/terminalManager.ts` port).
//!
//! Mirrors the operations `terminalIpc.ts` exposes: list profiles, list sessions, create (or
//! reuse), write, resize, kill, read the raw buffer, read the ANSI-free context, and list
//! tracked commands. Output, exit, context-availability and command events are pushed onto an
//! unbounded channel so a host can forward them (`terminal:output`, `terminal:exit`,
//! `terminal:contextAvailability`, `terminal:command`).
//!
//! Each session owns three threads: a reader that decodes PTY output as UTF-8 without ever
//! splitting a multi-byte sequence across events (node-pty's `setEncoding('utf8')` behaves
//! the same way), a writer that drains queued input so `write` never blocks the caller, and a
//! waiter that reaps the shell and reports its exit once output has drained (or 200 ms have
//! passed, node-pty's `DESTROY_SOCKET_TIMEOUT_MS`).
//!
//! zsh and bash get the same OSC 633 shell-integration hooks as the TypeScript manager,
//! installed through a per-session startup file in a private temp directory that is removed
//! when the session exits or is killed.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use indexmap::IndexMap;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use praxis_contracts::ipc::{
    CreateTerminalInput, TerminalCommandEvent, TerminalCommandRecord, TerminalCommandStatus,
    TerminalContext, TerminalContextAvailabilityEvent, TerminalExitEvent, TerminalOutputEvent,
    TerminalProfile, TerminalSessionInfo,
};
use regex::Regex;
use tokio::sync::mpsc;

/// Bytes of recent output (and of each tracked command's output) kept per session.
pub const CONTEXT_LIMIT_BYTES: usize = 5 * 1024;
/// Tracked commands kept per session; the oldest are dropped first.
const COMMAND_HISTORY_LIMIT: usize = 50;
/// Characters of an unterminated shell-integration marker carried into the next chunk.
const MARKER_REMAINDER_CHARS: usize = 512;
/// How long the exit event waits for trailing output after the shell is reaped.
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_millis(200);
/// Grace period between the hang-up sent by `kill` and a forced kill of the tree.
const FORCE_KILL_AFTER: Duration = Duration::from_secs(3);
const READ_CHUNK_BYTES: usize = 8 * 1024;
const TERM_NAME: &str = "xterm-256color";

static INTEGRATION_DIR_COUNTER: AtomicUsize = AtomicUsize::new(0);

const ZSH_HOOK: &str = r#"function __tm_precmd(){ local s=$?; printf '\033]633;D;%s\007\033]633;A\007' $s; }; precmd_functions+=(__tm_precmd); function __tm_preexec(){ printf '\033]633;C\007\033]633;E;%s\007' "$1"; }; preexec_functions+=(__tm_preexec)"#;
const BASH_HOOK: &str = r#"__tm_preexec(){ printf '\033]633;C\007\033]633;E;%s\007' "$1"; }; trap '__tm_preexec "$BASH_COMMAND"' DEBUG; __tm_prompt(){ local s=$?; printf '\033]633;D;%s\007\033]633;A\007' $s; }; PROMPT_COMMAND="__tm_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}""#;

/// An event a host forwards to every window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    Output(TerminalOutputEvent),
    Exit(TerminalExitEvent),
    ContextAvailability(TerminalContextAvailabilityEvent),
    Command(TerminalCommandEvent),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TerminalError {
    #[error("Terminal working directory does not exist: {0}")]
    MissingWorkingDirectory(String),
    #[error("Terminal profile '{0}' is not installed.")]
    ProfileNotInstalled(String),
    #[error("No supported terminal shell was found.")]
    NoShell,
    #[error("The selected terminal no longer exists.")]
    NoLongerExists,
    #[error("The selected terminal is not running.")]
    NotRunning,
    #[error("Could not start the terminal: {0}")]
    Spawn(String),
    #[error("Terminal I/O failed: {0}")]
    Io(String),
}

/// The environment a session inherits and that profile detection reads (`process.env`).
/// Keys compare case-insensitively on Windows, as Node's `process.env` does.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerminalEnvironment {
    vars: Vec<(String, String)>,
}

impl TerminalEnvironment {
    /// Snapshot of this process's environment.
    pub fn from_process() -> Self {
        Self::from_vars(std::env::vars_os().map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        }))
    }

    pub fn from_vars<K: Into<String>, V: Into<String>>(
        vars: impl IntoIterator<Item = (K, V)>,
    ) -> Self {
        let mut env = Self::default();
        for (key, value) in vars {
            env.set(key, value);
        }
        env
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.vars
            .iter()
            .find(|(candidate, _)| keys_equal(candidate, key))
            .map(|(_, value)| value.as_str())
    }

    pub fn set(&mut self, key: impl Into<String>, value: impl Into<String>) {
        let key = key.into();
        let value = value.into();
        match self
            .vars
            .iter_mut()
            .find(|(candidate, _)| keys_equal(candidate, &key))
        {
            Some(entry) => entry.1 = value,
            None => self.vars.push((key, value)),
        }
    }

    pub fn vars(&self) -> impl Iterator<Item = (&str, &str)> {
        self.vars.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }

    /// Non-empty value of `key`, like JavaScript's `process.env.KEY || fallback`.
    fn non_empty(&self, key: &str) -> Option<&str> {
        self.get(key).filter(|value| !value.is_empty())
    }

    /// `os.homedir()`: `HOME` (`USERPROFILE` on Windows), else the platform's lookup.
    fn home_dir(&self) -> PathBuf {
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        self.non_empty(key)
            .map(PathBuf::from)
            .or_else(std::env::home_dir)
            .unwrap_or_else(|| PathBuf::from("/"))
    }
}

fn keys_equal(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// How a manager finds shells and what environment its sessions inherit.
#[derive(Debug, Clone, Default)]
pub struct TerminalManagerOptions {
    /// `None` re-reads the process environment on every call, as the TypeScript does.
    pub env: Option<TerminalEnvironment>,
    /// Replaces detection with a fixed profile list (a host's configured shells, or tests).
    pub profiles: Option<Vec<TerminalProfile>>,
}

/// Owns every terminal session; dropping it disposes them all.
pub struct TerminalManager {
    sessions: Mutex<IndexMap<String, Arc<Session>>>,
    events: mpsc::UnboundedSender<TerminalEvent>,
    options: TerminalManagerOptions,
}

struct Session {
    state: Mutex<SessionState>,
    io: Mutex<Option<SessionIo>>,
    pid: Option<u32>,
}

struct SessionIo {
    master: Box<dyn MasterPty + Send>,
    input: std_mpsc::Sender<Vec<u8>>,
    #[cfg(windows)]
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

struct SessionState {
    info: TerminalSessionInfo,
    recent: Vec<u8>,
    commands: Vec<TerminalCommandRecord>,
    command_remainder: String,
    active_command_id: Option<String>,
    /// `info.last_command` is the live active command until it finishes (the TS shares the
    /// object, so a running command's text and output show through `list`).
    last_command_is_active: bool,
    integration_dir: Option<PathBuf>,
}

impl SessionState {
    fn info_snapshot(&self) -> TerminalSessionInfo {
        let mut info = self.info.clone();
        if self.last_command_is_active
            && let Some(active) = self.active_command()
        {
            info.last_command = Some(active.clone());
        }
        info
    }

    fn active_command(&self) -> Option<&TerminalCommandRecord> {
        let id = self.active_command_id.as_deref()?;
        self.commands.iter().rev().find(|command| command.id == id)
    }

    fn active_command_mut(&mut self) -> Option<&mut TerminalCommandRecord> {
        let id = self.active_command_id.as_deref()?;
        self.commands
            .iter_mut()
            .rev()
            .find(|command| command.id == id)
    }

    fn cleanup_integration(&mut self) {
        if let Some(directory) = self.integration_dir.take() {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

impl TerminalManager {
    /// A manager reading the live process environment and detecting installed shells.
    pub fn new() -> (Self, mpsc::UnboundedReceiver<TerminalEvent>) {
        Self::with_options(TerminalManagerOptions::default())
    }

    pub fn with_options(
        options: TerminalManagerOptions,
    ) -> (Self, mpsc::UnboundedReceiver<TerminalEvent>) {
        let (events, receiver) = mpsc::unbounded_channel();
        let manager = Self {
            sessions: Mutex::new(IndexMap::new()),
            events,
            options,
        };
        (manager, receiver)
    }

    pub fn list(&self) -> Vec<TerminalSessionInfo> {
        self.sessions()
            .values()
            .map(|session| lock(&session.state).info_snapshot())
            .collect()
    }

    pub fn list_profiles(&self) -> Vec<TerminalProfile> {
        match &self.options.profiles {
            Some(profiles) => profiles.clone(),
            None => detect_profiles(&self.env()),
        }
    }

    pub fn commands(&self, session_id: &str) -> Result<Vec<TerminalCommandRecord>, TerminalError> {
        let session = self.require(session_id)?;
        let state = lock(&session.state);
        Ok(state.commands.clone())
    }

    /// Spawns the selected (or default) profile's shell, or returns a live session with the
    /// same cwd and profile when `reuse_existing` is set.
    pub fn create(
        &self,
        input: &CreateTerminalInput,
    ) -> Result<TerminalSessionInfo, TerminalError> {
        let env = self.env();
        let requested = input
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
            .map_or_else(|| env.home_dir(), PathBuf::from);
        let cwd_path = resolve_path(&requested);
        let cwd = cwd_path.to_string_lossy().into_owned();
        if !cwd_path.is_dir() {
            return Err(TerminalError::MissingWorkingDirectory(cwd));
        }
        let profiles = self.list_profiles();
        let profile = match input.profile_id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => profiles
                .iter()
                .find(|candidate| candidate.id == id)
                .ok_or_else(|| TerminalError::ProfileNotInstalled(id.to_string()))?,
            None => profiles
                .iter()
                .find(|candidate| candidate.is_default)
                .ok_or(TerminalError::NoShell)?,
        };
        if input.reuse_existing == Some(true) {
            let sessions = self.sessions();
            let existing = sessions.values().find_map(|session| {
                let state = lock(&session.state);
                let info = &state.info;
                (!info.exited && info.cwd == cwd && info.profile_id == profile.id)
                    .then(|| state.info_snapshot())
            });
            if let Some(existing) = existing {
                return Ok(existing);
            }
        }

        let shell = profile.shell.clone();
        let integration = prepare_shell_integration(&profile.id, &env)?;
        let spawned = spawn_shell(input, &shell, &profile.id, &cwd, &env, &integration);
        let spawned = match spawned {
            Ok(spawned) => spawned,
            Err(error) => {
                if let Some(directory) = &integration.directory {
                    let _ = std::fs::remove_dir_all(directory);
                }
                return Err(error);
            }
        };

        let id = uuid::Uuid::new_v4().to_string();
        let info = TerminalSessionInfo {
            id: id.clone(),
            title: profile.name.clone(),
            cwd,
            shell,
            profile_id: profile.id.clone(),
            profile_name: profile.name.clone(),
            has_context: false,
            exited: false,
            last_command: None,
        };
        let session = Arc::new(Session {
            state: Mutex::new(SessionState {
                info: info.clone(),
                recent: Vec::new(),
                commands: Vec::new(),
                command_remainder: String::new(),
                active_command_id: None,
                last_command_is_active: false,
                integration_dir: integration.directory,
            }),
            io: Mutex::new(Some(spawned.io)),
            pid: spawned.pid,
        });
        self.sessions().insert(id, Arc::clone(&session));
        start_session_threads(&session, spawned.reader, spawned.child, &self.events)?;
        Ok(info)
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), TerminalError> {
        let session = self.require_live(session_id)?;
        let io = lock(&session.io);
        let io = io.as_ref().ok_or(TerminalError::NotRunning)?;
        io.input
            .send(data.as_bytes().to_vec())
            .map_err(|_| TerminalError::NotRunning)
    }

    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), TerminalError> {
        let session = self.require_live(session_id)?;
        let io = lock(&session.io);
        let io = io.as_ref().ok_or(TerminalError::NotRunning)?;
        io.master
            .resize(pty_size(cols, rows))
            .map_err(|error| TerminalError::Io(error.to_string()))
    }

    /// Hangs up the whole process tree, forgets the session, and reports that its context is
    /// gone. An unknown id is a no-op. The exit event still follows once the shell is reaped.
    pub fn kill(&self, session_id: &str) {
        let Some(session) = self.sessions().shift_remove(session_id) else {
            return;
        };
        terminate_session(&session);
        let _ = self.events.send(TerminalEvent::ContextAvailability(
            TerminalContextAvailabilityEvent {
                session_id: session_id.to_string(),
                terminal_has_context: false,
            },
        ));
    }

    /// The ANSI-free recent output, for attaching to an AI session.
    pub fn context(&self, session_id: &str) -> Result<TerminalContext, TerminalError> {
        let session = self.require(session_id)?;
        let state = lock(&session.state);
        Ok(TerminalContext {
            session_id: session_id.to_string(),
            cwd: state.info.cwd.clone(),
            output: terminal_output_to_plain_text(&String::from_utf8_lossy(&state.recent)),
            captured_at: now_iso(),
        })
    }

    /// The raw recent output (at most [`CONTEXT_LIMIT_BYTES`]), escape sequences included.
    pub fn buffer(&self, session_id: &str) -> Result<String, TerminalError> {
        let session = self.require(session_id)?;
        let state = lock(&session.state);
        Ok(String::from_utf8_lossy(&state.recent).into_owned())
    }

    /// Kills every live session and removes every integration directory.
    pub fn dispose(&self) {
        let sessions: Vec<_> = self.sessions().drain(..).map(|(_, s)| s).collect();
        for session in sessions {
            terminate_session(&session);
        }
    }

    fn env(&self) -> TerminalEnvironment {
        self.options
            .env
            .clone()
            .unwrap_or_else(TerminalEnvironment::from_process)
    }

    fn sessions(&self) -> MutexGuard<'_, IndexMap<String, Arc<Session>>> {
        lock(&self.sessions)
    }

    fn require(&self, session_id: &str) -> Result<Arc<Session>, TerminalError> {
        self.sessions()
            .get(session_id)
            .cloned()
            .ok_or(TerminalError::NoLongerExists)
    }

    fn require_live(&self, session_id: &str) -> Result<Arc<Session>, TerminalError> {
        let session = self
            .sessions()
            .get(session_id)
            .cloned()
            .ok_or(TerminalError::NotRunning)?;
        if lock(&session.state).info.exited {
            return Err(TerminalError::NotRunning);
        }
        Ok(session)
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        self.dispose();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `Math.max(2, Math.floor(n || default))`, capped to what a PTY can represent.
fn pty_size(cols: u32, rows: u32) -> PtySize {
    let clamp = |value: u32| u16::try_from(value.max(2)).unwrap_or(u16::MAX);
    PtySize {
        rows: clamp(rows),
        cols: clamp(cols),
        pixel_width: 0,
        pixel_height: 0,
    }
}

// ---- Profiles ----------------------------------------------------------------------------

fn path_delimiter() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

fn is_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

fn find_on_path(env: &TerminalEnvironment, executable: &str) -> Option<PathBuf> {
    env.get("PATH")
        .unwrap_or_default()
        .split(path_delimiter())
        .filter(|directory| !directory.is_empty())
        .map(|directory| Path::new(directory).join(executable))
        .find(|candidate| is_file(candidate))
}

/// Installed shells in the TypeScript's preference order; the one matching `SHELL` (after
/// resolving symlinks) is the default, else the first found.
pub fn detect_profiles(env: &TerminalEnvironment) -> Vec<TerminalProfile> {
    let candidates: Vec<(&str, &str, Vec<Option<PathBuf>>)> = if cfg!(windows) {
        vec![
            (
                "powershell",
                "PowerShell",
                vec![
                    find_on_path(env, "pwsh.exe"),
                    find_on_path(env, "powershell.exe"),
                ],
            ),
            (
                "command-prompt",
                "Command Prompt",
                vec![
                    env.non_empty("COMSPEC").map(PathBuf::from),
                    find_on_path(env, "cmd.exe"),
                ],
            ),
            (
                "git-bash",
                "Git Bash",
                vec![
                    env.non_empty("ProgramFiles")
                        .map(|dir| Path::new(dir).join("Git").join("bin").join("bash.exe")),
                    find_on_path(env, "bash.exe"),
                ],
            ),
            ("wsl", "WSL", vec![find_on_path(env, "wsl.exe")]),
        ]
    } else {
        vec![
            (
                "zsh",
                "zsh",
                vec![find_on_path(env, "zsh"), Some("/bin/zsh".into())],
            ),
            (
                "bash",
                "bash",
                vec![find_on_path(env, "bash"), Some("/bin/bash".into())],
            ),
            (
                "fish",
                "fish",
                vec![
                    find_on_path(env, "fish"),
                    Some("/opt/homebrew/bin/fish".into()),
                    Some("/usr/local/bin/fish".into()),
                ],
            ),
            ("powershell", "PowerShell", vec![find_on_path(env, "pwsh")]),
        ]
    };
    let configured = env
        .get("SHELL")
        .map(str::trim)
        .filter(|shell| !shell.is_empty() && Path::new(shell).exists())
        .and_then(|shell| std::fs::canonicalize(shell).ok());
    let found: Vec<TerminalProfile> = candidates
        .into_iter()
        .filter_map(|(id, name, paths)| {
            let shell = paths.into_iter().flatten().find(|path| is_file(path))?;
            Some(TerminalProfile {
                id: id.to_string(),
                name: name.to_string(),
                shell: resolve_path(&shell).to_string_lossy().into_owned(),
                is_default: false,
            })
        })
        .collect();
    let default_index = found
        .iter()
        .position(|profile| {
            configured.as_ref().is_some_and(|configured| {
                std::fs::canonicalize(&profile.shell).is_ok_and(|real| &real == configured)
            })
        })
        .unwrap_or(0);
    found
        .into_iter()
        .enumerate()
        .map(|(index, profile)| TerminalProfile {
            is_default: index == default_index,
            ..profile
        })
        .collect()
}

/// `path.resolve`: absolute against the current directory, `.`/`..` folded lexically.
fn resolve_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other),
        }
    }
    resolved
}

// ---- Spawning ----------------------------------------------------------------------------

#[derive(Debug, Default)]
struct ShellIntegration {
    args: Vec<String>,
    env: Vec<(String, String)>,
    directory: Option<PathBuf>,
}

/// Installs hooks through a per-session startup file, never by typing setup commands into an
/// already-echoing interactive prompt. zsh reads it via `ZDOTDIR`, bash via `--rcfile`; the
/// user's own rc file is sourced first.
fn prepare_shell_integration(
    profile_id: &str,
    env: &TerminalEnvironment,
) -> Result<ShellIntegration, TerminalError> {
    let is_zsh = profile_id == "zsh";
    if !is_zsh && profile_id != "bash" {
        return Ok(ShellIntegration::default());
    }
    let directory =
        make_private_temp_dir().map_err(|error| TerminalError::Io(error.to_string()))?;
    let (hook, original, rc) = if is_zsh {
        let base = env
            .non_empty("ZDOTDIR")
            .map_or_else(|| env.home_dir(), PathBuf::from);
        (ZSH_HOOK, base.join(".zshrc"), directory.join(".zshrc"))
    } else {
        let base = env
            .non_empty("HOME")
            .map_or_else(|| env.home_dir(), PathBuf::from);
        (BASH_HOOK, base.join(".bashrc"), directory.join(".bashrc"))
    };
    let quoted = serde_json::to_string(&original.to_string_lossy())
        .map_err(|error| TerminalError::Io(error.to_string()))?;
    let contents = format!("if [ -f {quoted} ]; then source {quoted}; fi\n{hook}\n");
    if let Err(error) = write_private_file(&rc, &contents) {
        let _ = std::fs::remove_dir_all(&directory);
        return Err(TerminalError::Io(error.to_string()));
    }
    let directory_text = directory.to_string_lossy().into_owned();
    Ok(if is_zsh {
        ShellIntegration {
            args: Vec::new(),
            env: vec![("ZDOTDIR".to_string(), directory_text)],
            directory: Some(directory),
        }
    } else {
        ShellIntegration {
            args: vec!["--rcfile".to_string(), rc.to_string_lossy().into_owned()],
            env: Vec::new(),
            directory: Some(directory),
        }
    })
}

/// `mkdtemp(tmpdir/praxis-terminal-)`, owner-only on Unix.
fn make_private_temp_dir() -> std::io::Result<PathBuf> {
    let unique = INTEGRATION_DIR_COUNTER.fetch_add(1, Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let path = std::env::temp_dir().join(format!(
        "praxis-terminal-{}-{unique}-{nanos}",
        std::process::id()
    ));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&path)?;
    Ok(path)
}

fn write_private_file(path: &Path, contents: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(contents.as_bytes())
}

struct SpawnedShell {
    io: SessionIo,
    pid: Option<u32>,
    reader: Box<dyn Read + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// The child's environment: the inherited one, the profile's identity, the terminal type,
/// and the integration's overrides, in the TypeScript's precedence order. node-pty adds
/// `PWD` on Unix, so this does too.
fn shell_environment(
    shell: &str,
    profile_id: &str,
    cwd: &str,
    env: &TerminalEnvironment,
    integration: &ShellIntegration,
) -> TerminalEnvironment {
    let mut child_env = env.clone();
    // Keep the child shell's identity aligned with the selected profile. macOS's legacy Bash
    // startup notice appears when Bash inherits a parent SHELL value pointing at zsh.
    child_env.set("SHELL", shell);
    if cfg!(target_os = "macos") && profile_id == "bash" {
        child_env.set("BASH_SILENCE_DEPRECATION_WARNING", "1");
    }
    child_env.set("TERM", TERM_NAME);
    child_env.set("COLORTERM", "truecolor");
    child_env.set("TERM_PROGRAM", "Praxis");
    for (key, value) in &integration.env {
        child_env.set(key.clone(), value.clone());
    }
    if cfg!(unix) {
        child_env.set("PWD", cwd);
    }
    child_env
}

fn spawn_shell(
    input: &CreateTerminalInput,
    shell: &str,
    profile_id: &str,
    cwd: &str,
    env: &TerminalEnvironment,
    integration: &ShellIntegration,
) -> Result<SpawnedShell, TerminalError> {
    let spawn_error = |error: &dyn std::fmt::Display| TerminalError::Spawn(error.to_string());
    let cols = if input.cols == 0 { 80 } else { input.cols };
    let rows = if input.rows == 0 { 24 } else { input.rows };
    let pair = native_pty_system()
        .openpty(pty_size(cols, rows))
        .map_err(|e| spawn_error(&e))?;
    let mut command = CommandBuilder::new(shell);
    command.args(&integration.args);
    command.cwd(cwd);
    command.env_clear();
    for (key, value) in shell_environment(shell, profile_id, cwd, env, integration).vars() {
        command.env(key, value);
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| spawn_error(&e))?;
    // The parent must not hold the slave open, or the reader never sees end-of-file.
    drop(pair.slave);
    let master = pair.master;
    let reader = master.try_clone_reader().map_err(|e| spawn_error(&e))?;
    let writer = master.take_writer().map_err(|e| spawn_error(&e))?;
    let (input_sender, input_receiver) = std_mpsc::channel::<Vec<u8>>();
    std::thread::Builder::new()
        .name("terminal-writer".to_string())
        .spawn(move || pump_input(writer, &input_receiver))
        .map_err(|e| spawn_error(&e))?;
    Ok(SpawnedShell {
        pid: child.process_id(),
        io: SessionIo {
            master,
            input: input_sender,
            #[cfg(windows)]
            killer: child.clone_killer(),
        },
        reader,
        child,
    })
}

fn pump_input(mut writer: Box<dyn Write + Send>, input: &std_mpsc::Receiver<Vec<u8>>) {
    while let Ok(bytes) = input.recv() {
        if writer
            .write_all(&bytes)
            .and_then(|()| writer.flush())
            .is_err()
        {
            return;
        }
    }
}

fn start_session_threads(
    session: &Arc<Session>,
    reader: Box<dyn Read + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    events: &mpsc::UnboundedSender<TerminalEvent>,
) -> Result<(), TerminalError> {
    let (drained_sender, drained) = std_mpsc::channel::<()>();
    let reader_session = Arc::clone(session);
    let reader_events = events.clone();
    let spawn_error = |error: std::io::Error| TerminalError::Spawn(error.to_string());
    std::thread::Builder::new()
        .name("terminal-reader".to_string())
        .spawn(move || {
            pump_output(reader, &reader_session, &reader_events);
            let _ = drained_sender.send(());
        })
        .map_err(spawn_error)?;
    let waiter_session = Arc::clone(session);
    let waiter_events = events.clone();
    std::thread::Builder::new()
        .name("terminal-waiter".to_string())
        .spawn(move || {
            let (exit_code, signal) = wait_for_exit(child, waiter_session.pid);
            let _ = drained.recv_timeout(OUTPUT_DRAIN_TIMEOUT);
            let mut state = lock(&waiter_session.state);
            state.info.exited = true;
            state.cleanup_integration();
            let _ = waiter_events.send(TerminalEvent::Exit(TerminalExitEvent {
                session_id: state.info.id.clone(),
                exit_code,
                signal,
            }));
            drop(state);
            // node-pty closes its socket on exit; release the PTY the same way.
            lock(&waiter_session.io).take();
        })
        .map_err(spawn_error)?;
    Ok(())
}

fn pump_output(
    mut reader: Box<dyn Read + Send>,
    session: &Session,
    events: &mpsc::UnboundedSender<TerminalEvent>,
) {
    let mut decoder = Utf8StreamDecoder::default();
    let mut buffer = vec![0_u8; READ_CHUNK_BYTES];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let text = decoder.decode(&buffer[..read]);
        if !text.is_empty() && !handle_output(session, &text, events) {
            return;
        }
    }
    let rest = decoder.finish();
    if !rest.is_empty() {
        handle_output(session, &rest, events);
    }
}

/// Records one decoded chunk and emits its events. Returns false once the session has
/// exited, after which node-pty would have destroyed its socket and dropped further output.
fn handle_output(
    session: &Session,
    data: &str,
    events: &mpsc::UnboundedSender<TerminalEvent>,
) -> bool {
    let mut state = lock(&session.state);
    if state.info.exited {
        return false;
    }
    append_bounded(&mut state.recent, data.as_bytes());
    for command in consume_shell_integration(&mut state, data) {
        let _ = events.send(TerminalEvent::Command(command));
    }
    let session_id = state.info.id.clone();
    if !state.info.has_context
        && !terminal_output_to_plain_text(&String::from_utf8_lossy(&state.recent)).is_empty()
    {
        state.info.has_context = true;
        let _ = events.send(TerminalEvent::ContextAvailability(
            TerminalContextAvailabilityEvent {
                session_id: session_id.clone(),
                terminal_has_context: true,
            },
        ));
    }
    let _ = events.send(TerminalEvent::Output(TerminalOutputEvent {
        session_id,
        data: data.to_string(),
    }));
    true
}

/// Reaps the shell. A normal exit reports its code; a signal death reports code 0 plus the
/// signal number, as node-pty does.
#[cfg(unix)]
fn wait_for_exit(
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pid: Option<u32>,
) -> (i32, Option<i32>) {
    use nix::errno::Errno;
    use nix::sys::wait::{WaitStatus, waitpid};
    use nix::unistd::Pid;

    let Some(raw) = pid.and_then(|pid| i32::try_from(pid).ok()) else {
        return (1, None);
    };
    let status = loop {
        match waitpid(Pid::from_raw(raw), None) {
            Err(Errno::EINTR) => {}
            Ok(WaitStatus::Exited(_, code)) => break (code, None),
            Ok(WaitStatus::Signaled(_, signal, _)) => break (0, Some(signal as i32)),
            Ok(_) => {}
            // Reaped elsewhere: the status is unknowable, so report a generic failure.
            Err(_) => break (1, None),
        }
    };
    drop(child);
    status
}

#[cfg(not(unix))]
fn wait_for_exit(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    _pid: Option<u32>,
) -> (i32, Option<i32>) {
    match child.wait() {
        Ok(status) => (i32::try_from(status.exit_code()).unwrap_or(i32::MAX), None),
        Err(_) => (1, None),
    }
}

/// Kills a live session's process tree, releases its PTY and removes its integration files.
fn terminate_session(session: &Arc<Session>) {
    let io = lock(&session.io).take();
    let exited = {
        let mut state = lock(&session.state);
        state.cleanup_integration();
        state.info.exited
    };
    if !exited && let Some(io) = &io {
        hang_up_tree(session, io);
    }
    drop(io);
}

/// SIGHUP (node-pty's `kill()` default) to the shell's process group and to the terminal's
/// foreground job, so a running command dies with its shell; SIGKILL after a grace period if
/// the shell is still alive.
#[cfg(unix)]
fn hang_up_tree(session: &Arc<Session>, io: &SessionIo) {
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    let Some(shell) = session.pid.and_then(|pid| i32::try_from(pid).ok()) else {
        return;
    };
    let mut groups = vec![shell];
    if let Some(foreground) = io.master.process_group_leader()
        && foreground > 0
        && foreground != shell
    {
        groups.push(foreground);
    }
    for group in &groups {
        let _ = killpg(Pid::from_raw(*group), Signal::SIGHUP);
    }
    let session = Arc::clone(session);
    let _ = std::thread::Builder::new()
        .name("terminal-force-kill".to_string())
        .spawn(move || {
            std::thread::sleep(FORCE_KILL_AFTER);
            // Holding the state lock while checking keeps this from racing the waiter's
            // `exited` update for any meaningful window.
            let state = lock(&session.state);
            if !state.info.exited {
                for group in &groups {
                    let _ = killpg(Pid::from_raw(*group), Signal::SIGKILL);
                }
            }
        });
}

/// Windows has no process groups: terminate the console's tree, then the shell itself.
#[cfg(not(unix))]
fn hang_up_tree(session: &Arc<Session>, io: &SessionIo) {
    if let Some(pid) = session.pid {
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .status();
    }
    let mut killer = io.killer.clone_killer();
    let _ = killer.kill();
}

// ---- Output processing -------------------------------------------------------------------

/// Appends `data`, keeping only the newest [`CONTEXT_LIMIT_BYTES`] (which may cut a
/// multi-byte character; it decodes lossily, as `Buffer#toString` does).
fn append_bounded(current: &mut Vec<u8>, data: &[u8]) {
    current.extend_from_slice(data);
    if current.len() > CONTEXT_LIMIT_BYTES {
        let excess = current.len() - CONTEXT_LIMIT_BYTES;
        current.drain(..excess);
    }
}

/// Incremental UTF-8 decoding that holds back an incomplete trailing sequence for the next
/// chunk; invalid bytes become U+FFFD.
#[derive(Debug, Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn decode(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        let mut rest: &[u8] = &self.pending;
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    out.push_str(valid);
                    rest = &[];
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    out.push_str(&String::from_utf8_lossy(valid));
                    match error.error_len() {
                        Some(invalid) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &after[invalid..];
                        }
                        None => {
                            rest = after;
                            break;
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        out
    }

    fn finish(&mut self) -> String {
        let rest = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        rest
    }
}

static OSC_SEQUENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\][^\x07]*(?:\x07|\x1b\\)").expect("valid OSC pattern"));
static STRING_SEQUENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b[PX^_](?s:.)*?\x1b\\").expect("valid DCS pattern"));
static CSI_SEQUENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").expect("valid CSI pattern"));
static CONTROL_CHARS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]").expect("valid control pattern")
});
static BLANK_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n{4,}").expect("valid blank-run pattern"));
static SHELL_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b\]633;([A-Z])(?:;([^\x07]*))?\x07").expect("valid marker pattern")
});
static HEX_ESCAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\x([0-9a-fA-F]{2})").expect("valid hex escape pattern"));

/// Removes terminal control sequences and non-text controls before chat attachment.
pub fn terminal_output_to_plain_text(raw: &str) -> String {
    let text = OSC_SEQUENCE.replace_all(raw, "");
    let text = STRING_SEQUENCE.replace_all(&text, "");
    let text = CSI_SEQUENCE.replace_all(&text, "");
    // `\r(?!\n)` → `\n`; the regex crate has no look-ahead.
    let mut newlines = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' && chars.peek() != Some(&'\n') {
            newlines.push('\n');
        } else {
            newlines.push(c);
        }
    }
    let text = CONTROL_CHARS.replace_all(&newlines, "");
    let text = BLANK_RUN.replace_all(&text, "\n\n\n");
    // JavaScript's `trim` also strips the byte-order mark.
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_string()
}

fn tail_chars(text: &str, count: usize) -> &str {
    match text.char_indices().rev().nth(count.saturating_sub(1)) {
        Some((index, _)) if count > 0 => &text[index..],
        _ if count == 0 => "",
        _ => text,
    }
}

/// Parses OSC 633 markers out of a chunk, carrying a partial marker into the next one, and
/// returns the command events to emit.
fn consume_shell_integration(state: &mut SessionState, data: &str) -> Vec<TerminalCommandEvent> {
    let source = format!("{}{data}", state.command_remainder);
    let mut events = Vec::new();
    let mut last = 0;
    let mut found = false;
    for captures in SHELL_MARKER.captures_iter(&source) {
        let Some(whole) = captures.get(0) else {
            continue;
        };
        found = true;
        append_command_output(state, &source[last..whole.start()]);
        let marker = captures.get(1).map_or("", |m| m.as_str());
        let payload = captures.get(2).map_or("", |m| m.as_str());
        if let Some(event) = handle_shell_marker(state, marker, payload) {
            events.push(event);
        }
        last = whole.end();
    }
    if found {
        state.command_remainder = tail_chars(&source[last..], MARKER_REMAINDER_CHARS).to_string();
    } else if source.contains("\x1b]633;") {
        state.command_remainder = tail_chars(&source, MARKER_REMAINDER_CHARS).to_string();
    } else {
        append_command_output(state, &source);
        state.command_remainder.clear();
    }
    events
}

fn append_command_output(state: &mut SessionState, data: &str) {
    if data.is_empty() {
        return;
    }
    if let Some(active) = state.active_command_mut() {
        let mut bytes = std::mem::take(&mut active.output).into_bytes();
        append_bounded(&mut bytes, data.as_bytes());
        active.output = String::from_utf8_lossy(&bytes).into_owned();
    }
}

fn handle_shell_marker(
    state: &mut SessionState,
    marker: &str,
    payload: &str,
) -> Option<TerminalCommandEvent> {
    let session_id = state.info.id.clone();
    match marker {
        "P" => {
            if let Some(cwd) = payload.strip_prefix("Cwd=").filter(|cwd| !cwd.is_empty()) {
                state.info.cwd = cwd.to_string();
            }
            None
        }
        "C" => {
            let command = TerminalCommandRecord {
                id: uuid::Uuid::new_v4().to_string(),
                command: String::new(),
                cwd: state.info.cwd.clone(),
                started_at: now_iso(),
                finished_at: None,
                exit_code: None,
                output: String::new(),
                status: TerminalCommandStatus::Running,
            };
            state.active_command_id = Some(command.id.clone());
            if state.commands.len() >= COMMAND_HISTORY_LIMIT {
                let excess = state.commands.len() + 1 - COMMAND_HISTORY_LIMIT;
                state.commands.drain(..excess);
            }
            state.commands.push(command.clone());
            state.info.last_command = Some(command.clone());
            state.last_command_is_active = true;
            Some(TerminalCommandEvent {
                session_id,
                command,
            })
        }
        "E" => {
            let text = HEX_ESCAPE
                .replace_all(payload, |caps: &regex::Captures<'_>| {
                    u8::from_str_radix(&caps[1], 16)
                        .map(char::from)
                        .map(String::from)
                        .unwrap_or_default()
                })
                .into_owned();
            if let Some(active) = state.active_command_mut() {
                active.command = text;
            }
            None
        }
        "D" => {
            let exit_code = parse_leading_int(payload.split(';').next().unwrap_or_default());
            let finished_at = now_iso();
            let active = state.active_command_mut()?;
            active.exit_code = Some(exit_code);
            active.finished_at = Some(finished_at);
            active.status = if exit_code == 0 {
                TerminalCommandStatus::Success
            } else {
                TerminalCommandStatus::Failed
            };
            let command = active.clone();
            state.info.last_command = Some(command.clone());
            state.last_command_is_active = false;
            state.active_command_id = None;
            Some(TerminalCommandEvent {
                session_id,
                command,
            })
        }
        _ => None,
    }
}

/// `Number.parseInt(text || '0', 10) || 0`: leading whitespace, an optional sign, then
/// digits; anything unparseable is 0.
fn parse_leading_int(text: &str) -> i32 {
    let trimmed = text.trim_start();
    let (negative, digits) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, &trimmed[1..]),
        Some(b'+') => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    let value = digits[..end].parse::<i64>().unwrap_or(0);
    let value = if negative { -value } else { value };
    i32::try_from(value).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScratchDir;

    const WAIT: Duration = Duration::from_secs(20);

    fn blank_state() -> SessionState {
        SessionState {
            info: TerminalSessionInfo {
                id: "session-1".to_string(),
                title: "sh".to_string(),
                cwd: "/start".to_string(),
                shell: "/bin/sh".to_string(),
                profile_id: "sh".to_string(),
                profile_name: "sh".to_string(),
                has_context: false,
                exited: false,
                last_command: None,
            },
            recent: Vec::new(),
            commands: Vec::new(),
            command_remainder: String::new(),
            active_command_id: None,
            last_command_is_active: false,
            integration_dir: None,
        }
    }

    fn create_input(cwd: Option<&Path>) -> CreateTerminalInput {
        CreateTerminalInput {
            cwd: cwd.map(|path| path.to_string_lossy().into_owned()),
            cols: 80,
            rows: 24,
            profile_id: None,
            reuse_existing: None,
        }
    }

    #[test]
    fn plain_text_matches_the_typescript_output() {
        // Expected values produced by running the TypeScript `terminalOutputToPlainText`.
        let cases = [
            (
                "\x1b]0;title\x07\x1b[1;32mgreen\x1b[0m text\r\n",
                "green text",
            ),
            ("a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b", "ab"),
            ("\x1bPdcs payload\x1b\\after", "after"),
            (
                "progress 10%\rprogress 99%\r\ndone\x07\x08",
                "progress 10%\nprogress 99%\r\ndone",
            ),
            ("\u{feff}  one\n\n\n\n\n\ntwo\t\x7f  ", "one\n\n\ntwo"),
            ("\x1b]633;A\x07$ \x1b]633;C\x07ls\r\n", "$ ls"),
        ];
        for (raw, expected) in cases {
            assert_eq!(terminal_output_to_plain_text(raw), expected, "{raw:?}");
        }
    }

    #[test]
    fn the_decoder_never_splits_a_multi_byte_character() {
        let text = "aé€😀z";
        let bytes = text.as_bytes();
        for split in 0..=bytes.len() {
            let mut decoder = Utf8StreamDecoder::default();
            let first = decoder.decode(&bytes[..split]);
            let second = decoder.decode(&bytes[split..]);
            assert!(
                !first.contains(char::REPLACEMENT_CHARACTER),
                "split {split}"
            );
            assert_eq!(format!("{first}{second}{}", decoder.finish()), text);
        }
    }

    #[test]
    fn the_decoder_replaces_invalid_bytes_and_flushes_a_truncated_tail() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.decode(b"a\xffb\xe2\x82"), "a\u{fffd}b");
        assert_eq!(decoder.finish(), "\u{fffd}");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn bounded_buffers_keep_the_newest_bytes() {
        let mut buffer = vec![b'a'; CONTEXT_LIMIT_BYTES - 1];
        append_bounded(&mut buffer, b"xyz");
        assert_eq!(buffer.len(), CONTEXT_LIMIT_BYTES);
        assert!(buffer.ends_with(b"axyz"));
    }

    #[test]
    fn leading_integers_parse_like_number_parse_int() {
        assert_eq!(parse_leading_int("0"), 0);
        assert_eq!(parse_leading_int(" 12abc"), 12);
        assert_eq!(parse_leading_int("-3"), -3);
        assert_eq!(parse_leading_int("abc"), 0);
        assert_eq!(parse_leading_int(""), 0);
    }

    #[test]
    fn tail_chars_counts_characters_not_bytes() {
        assert_eq!(tail_chars("abcdé", 2), "dé");
        assert_eq!(tail_chars("ab", 5), "ab");
        assert_eq!(tail_chars("ab", 0), "");
    }

    #[test]
    fn shell_markers_track_a_command_across_split_chunks() {
        let mut state = blank_state();
        let started = consume_shell_integration(
            &mut state,
            "prompt\x1b]633;P;Cwd=/work\x07\x1b]633;C\x07\x1b]633;E;echo\\x20hi\x07hel",
        );
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].command.status, TerminalCommandStatus::Running);
        assert_eq!(started[0].command.cwd, "/work");
        assert_eq!(state.info.cwd, "/work");
        assert_eq!(state.command_remainder, "hel");
        // A running command shows through the session info, text and all.
        let last = state.info_snapshot().last_command.expect("running command");
        assert_eq!(last.command, "echo hi");

        assert!(consume_shell_integration(&mut state, "lo\r\n\x1b]633;").is_empty());
        let finished = consume_shell_integration(&mut state, "D;0\x07\x1b]633;A\x07$ ");
        assert_eq!(finished.len(), 1);
        let command = &finished[0].command;
        assert_eq!(command.command, "echo hi");
        assert_eq!(command.output, "hello\r\n");
        assert_eq!(command.exit_code, Some(0));
        assert_eq!(command.status, TerminalCommandStatus::Success);
        assert!(command.finished_at.is_some());
        assert_eq!(state.commands, vec![command.clone()]);
        assert_eq!(state.info_snapshot().last_command.as_ref(), Some(command));
        assert_eq!(state.command_remainder, "$ ");
    }

    #[test]
    fn a_non_zero_or_unparseable_status_is_reported_like_the_typescript() {
        let mut state = blank_state();
        consume_shell_integration(&mut state, "\x1b]633;C\x07");
        let failed = consume_shell_integration(&mut state, "\x1b]633;D;130;x\x07");
        assert_eq!(failed[0].command.status, TerminalCommandStatus::Failed);
        assert_eq!(failed[0].command.exit_code, Some(130));
        consume_shell_integration(&mut state, "\x1b]633;C\x07");
        let garbage = consume_shell_integration(&mut state, "\x1b]633;D;abc\x07");
        assert_eq!(garbage[0].command.status, TerminalCommandStatus::Success);
        // A finish marker with no running command is ignored.
        assert!(consume_shell_integration(&mut state, "\x1b]633;D;1\x07").is_empty());
    }

    #[test]
    fn command_history_keeps_the_newest_fifty() {
        let mut state = blank_state();
        for _ in 0..60 {
            consume_shell_integration(&mut state, "\x1b]633;C\x07\x1b]633;D;0\x07");
        }
        assert_eq!(state.commands.len(), COMMAND_HISTORY_LIMIT);
    }

    #[cfg(unix)]
    #[test]
    fn profiles_follow_the_typescript_order_and_default_to_shell() {
        let scratch = ScratchDir::new("terminal-profiles");
        let bin = scratch.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin dir");
        for name in ["zsh", "bash"] {
            std::fs::write(bin.join(name), "").expect("fake shell");
        }
        std::os::unix::fs::symlink(bin.join("bash"), scratch.path().join("login-shell"))
            .expect("symlink");
        let path = bin.to_string_lossy().into_owned();
        let profiles = |shell: Option<String>| {
            let mut env = TerminalEnvironment::from_vars([("PATH", path.clone())]);
            if let Some(shell) = shell {
                env.set("SHELL", shell);
            }
            detect_profiles(&env)
        };

        let found = profiles(None);
        assert_eq!(found[0].id, "zsh");
        assert_eq!(found[0].shell, bin.join("zsh").to_string_lossy());
        assert_eq!(found[1].id, "bash");
        assert!(found[0].is_default);
        assert_eq!(found.iter().filter(|p| p.is_default).count(), 1);

        let via_link = profiles(Some(
            scratch
                .path()
                .join("login-shell")
                .to_string_lossy()
                .into_owned(),
        ));
        assert!(via_link[1].is_default && !via_link[0].is_default);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_path_folds_dots_lexically() {
        assert_eq!(
            resolve_path(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
        assert!(resolve_path(Path::new("rel")).is_absolute());
    }

    #[test]
    fn create_rejects_a_missing_cwd_and_unknown_profiles() {
        let scratch = ScratchDir::new("terminal-errors");
        let missing = scratch.path().join("missing");
        let (manager, _events) = sh_manager(&scratch);
        let error = manager
            .create(&create_input(Some(&missing)))
            .expect_err("missing cwd");
        assert_eq!(
            error.to_string(),
            format!(
                "Terminal working directory does not exist: {}",
                missing.display()
            )
        );
        let mut input = create_input(Some(scratch.path()));
        input.profile_id = Some("nushell".to_string());
        assert_eq!(
            manager
                .create(&input)
                .expect_err("unknown profile")
                .to_string(),
            "Terminal profile 'nushell' is not installed."
        );
        let (empty, _events) = TerminalManager::with_options(TerminalManagerOptions {
            env: None,
            profiles: Some(Vec::new()),
        });
        assert_eq!(
            empty
                .create(&create_input(Some(scratch.path())))
                .expect_err("no shells"),
            TerminalError::NoShell
        );
        assert_eq!(manager.write("nope", "x"), Err(TerminalError::NotRunning));
        assert_eq!(manager.buffer("nope"), Err(TerminalError::NoLongerExists));
        manager.kill("nope");
    }

    // ---- Real shells --------------------------------------------------------------------

    /// A manager whose only profile is `/bin/sh`, with a minimal environment and a scratch
    /// `HOME` so no user startup file runs.
    fn sh_manager(
        scratch: &ScratchDir,
    ) -> (TerminalManager, mpsc::UnboundedReceiver<TerminalEvent>) {
        TerminalManager::with_options(TerminalManagerOptions {
            env: Some(test_env(scratch)),
            profiles: Some(vec![TerminalProfile {
                id: "sh".to_string(),
                name: "sh".to_string(),
                shell: "/bin/sh".to_string(),
                is_default: true,
            }]),
        })
    }

    fn test_env(scratch: &ScratchDir) -> TerminalEnvironment {
        TerminalEnvironment::from_vars([
            ("PATH", "/usr/bin:/bin:/usr/sbin:/sbin".to_string()),
            ("HOME", scratch.path().to_string_lossy().into_owned()),
            ("PS1", "$ ".to_string()),
            ("SHELL", "/bin/sh".to_string()),
        ])
    }

    async fn next_event(events: &mut mpsc::UnboundedReceiver<TerminalEvent>) -> TerminalEvent {
        tokio::time::timeout(WAIT, events.recv())
            .await
            .expect("terminal event before the timeout")
            .expect("event channel open")
    }

    /// Collects a session's output until it contains `needle`, returning everything seen.
    async fn output_until(
        events: &mut mpsc::UnboundedReceiver<TerminalEvent>,
        session_id: &str,
        needle: &str,
    ) -> String {
        let mut seen = String::new();
        let deadline = tokio::time::Instant::now() + WAIT;
        while !seen.contains(needle) {
            let event = tokio::time::timeout_at(deadline, events.recv()).await;
            match event {
                Ok(Some(TerminalEvent::Output(event))) if event.session_id == session_id => {
                    seen.push_str(&event.data);
                }
                Ok(Some(_)) => {}
                Ok(None) => panic!("event channel closed waiting for {needle:?}; saw {seen:?}"),
                Err(_) => panic!("timed out waiting for {needle:?}; saw {seen:?}"),
            }
        }
        seen
    }

    async fn exit_of(
        events: &mut mpsc::UnboundedReceiver<TerminalEvent>,
        session_id: &str,
    ) -> TerminalExitEvent {
        loop {
            if let TerminalEvent::Exit(event) = next_event(events).await
                && event.session_id == session_id
            {
                return event;
            }
        }
    }

    /// Runs `command` and returns the pid it prints after `<label>:` (the typed echo of the
    /// command shows `$$`, not digits).
    #[cfg(unix)]
    async fn pid_of(
        manager: &TerminalManager,
        events: &mut mpsc::UnboundedReceiver<TerminalEvent>,
        session_id: &str,
        command: &str,
        label: &str,
    ) -> i32 {
        manager.write(session_id, command).expect("write");
        let pattern = Regex::new(&format!(r"{label}:(\d+)")).expect("pid pattern");
        let mut seen = String::new();
        loop {
            if let TerminalEvent::Output(event) = next_event(events).await
                && event.session_id == session_id
            {
                seen.push_str(&event.data);
            }
            if let Some(pid) = pattern.captures(&seen).and_then(|c| c[1].parse().ok()) {
                return pid;
            }
        }
    }

    #[cfg(unix)]
    async fn wait_until_dead(pid: i32) {
        let deadline = tokio::time::Instant::now() + WAIT;
        while nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "pid {pid} still alive"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_shell_echoes_input_and_exposes_buffer_and_context() {
        let scratch = ScratchDir::new("terminal-echo");
        let (manager, mut events) = sh_manager(&scratch);
        let info = manager
            .create(&create_input(Some(scratch.path())))
            .expect("create");
        assert_eq!(info.shell, "/bin/sh");
        assert_eq!(info.title, "sh");
        assert_eq!(info.cwd, scratch.path().to_string_lossy());
        assert!(!info.exited && !info.has_context);

        manager
            .write(&info.id, "echo \"hello-$((40 + 2))\"\n")
            .expect("write");
        let mut context_announced = false;
        let mut seen = String::new();
        while !seen.contains("hello-42") {
            match next_event(&mut events).await {
                TerminalEvent::Output(event) => {
                    assert!(context_announced, "context availability precedes output");
                    seen.push_str(&event.data);
                }
                TerminalEvent::ContextAvailability(event) => {
                    assert_eq!(event.session_id, info.id);
                    assert!(event.terminal_has_context);
                    context_announced = true;
                }
                other => panic!("unexpected event {other:?}"),
            }
        }
        assert!(
            manager
                .buffer(&info.id)
                .expect("buffer")
                .contains("hello-42")
        );
        let context = manager.context(&info.id).expect("context");
        assert!(context.output.contains("hello-42"));
        assert!(!context.output.contains('\x1b'));
        assert_eq!(context.cwd, info.cwd);
        assert!(manager.list()[0].has_context);
        assert!(manager.commands(&info.id).expect("commands").is_empty());
        manager.kill(&info.id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_child_gets_the_terminal_identity_and_cwd() {
        let scratch = ScratchDir::new("terminal-env");
        let (manager, mut events) = sh_manager(&scratch);
        let info = manager
            .create(&create_input(Some(scratch.path())))
            .expect("create");
        manager
            .write(
                &info.id,
                "echo \"env=$TERM|$COLORTERM|$TERM_PROGRAM|$SHELL|$((1))\"; echo \"dir=$(pwd -P)|$((2))\"\n",
            )
            .expect("write");
        let seen = output_until(&mut events, &info.id, "|2\r\n").await;
        assert!(
            seen.contains("env=xterm-256color|truecolor|Praxis|/bin/sh|1"),
            "{seen}"
        );
        let real = std::fs::canonicalize(scratch.path()).expect("canonical scratch");
        assert!(
            seen.contains(&format!("dir={}|2", real.display())),
            "{seen}"
        );
        manager.kill(&info.id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resize_reaches_the_pty() {
        let scratch = ScratchDir::new("terminal-resize");
        let (manager, mut events) = sh_manager(&scratch);
        let mut input = create_input(Some(scratch.path()));
        input.cols = 0;
        input.rows = 0;
        let info = manager.create(&input).expect("create");
        manager
            .write(&info.id, "echo \"size=$(stty size)\"\n")
            .expect("write");
        output_until(&mut events, &info.id, "size=24 80").await;
        manager.resize(&info.id, 132, 1).expect("resize");
        manager
            .write(&info.id, "echo \"size=$(stty size)\"\n")
            .expect("write");
        output_until(&mut events, &info.id, "size=2 132").await;
        manager.kill(&info.id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_exiting_shell_reports_its_code_and_stops_accepting_input() {
        let scratch = ScratchDir::new("terminal-exit");
        let (manager, mut events) = sh_manager(&scratch);
        let info = manager
            .create(&create_input(Some(scratch.path())))
            .expect("create");
        manager.write(&info.id, "exit 7\n").expect("write");
        let exit = exit_of(&mut events, &info.id).await;
        assert_eq!(exit.exit_code, 7);
        assert_eq!(exit.signal, None);
        assert!(manager.list()[0].exited);
        assert_eq!(manager.write(&info.id, "x"), Err(TerminalError::NotRunning));
        assert_eq!(
            manager.resize(&info.id, 80, 24),
            Err(TerminalError::NotRunning)
        );
        // An exited session keeps its buffer until it is killed.
        assert!(manager.buffer(&info.id).is_ok());
        manager.kill(&info.id);
        assert!(manager.list().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_hangs_up_the_shell_and_its_foreground_job() {
        let scratch = ScratchDir::new("terminal-kill");
        let (manager, mut events) = sh_manager(&scratch);
        let info = manager
            .create(&create_input(Some(scratch.path())))
            .expect("create");
        let shell = pid_of(
            &manager,
            &mut events,
            &info.id,
            "echo \"shell:$$\"\n",
            "shell",
        )
        .await;
        let job = pid_of(
            &manager,
            &mut events,
            &info.id,
            "sh -c 'echo \"job:$$\"; exec sleep 300'\n",
            "job",
        )
        .await;

        manager.kill(&info.id);
        assert!(manager.list().is_empty());
        assert_eq!(
            manager.context(&info.id),
            Err(TerminalError::NoLongerExists)
        );
        let mut context_cleared = false;
        let exit = loop {
            match next_event(&mut events).await {
                TerminalEvent::ContextAvailability(event) if !event.terminal_has_context => {
                    context_cleared = true;
                }
                TerminalEvent::Exit(event) => break event,
                _ => {}
            }
        };
        assert!(context_cleared, "kill announces the context is gone first");
        assert_eq!(exit.session_id, info.id);
        assert!(exit.signal.is_some() || exit.exit_code != 0, "{exit:?}");
        wait_until_dead(shell).await;
        wait_until_dead(job).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dispose_kills_every_session() {
        let scratch = ScratchDir::new("terminal-dispose");
        let (manager, mut events) = sh_manager(&scratch);
        let first = manager
            .create(&create_input(Some(scratch.path())))
            .expect("first");
        let second = manager
            .create(&create_input(Some(scratch.path())))
            .expect("second");
        assert_ne!(first.id, second.id);
        let one = pid_of(&manager, &mut events, &first.id, "echo \"one:$$\"\n", "one").await;
        let two = pid_of(
            &manager,
            &mut events,
            &second.id,
            "echo \"two:$$\"\n",
            "two",
        )
        .await;
        drop(manager);
        wait_until_dead(one).await;
        wait_until_dead(two).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reuse_existing_returns_the_live_matching_session() {
        let scratch = ScratchDir::new("terminal-reuse");
        let (manager, _events) = sh_manager(&scratch);
        let first = manager
            .create(&create_input(Some(scratch.path())))
            .expect("first");
        let mut input = create_input(Some(scratch.path()));
        input.reuse_existing = Some(true);
        assert_eq!(manager.create(&input).expect("reused").id, first.id);
        let other = ScratchDir::new("terminal-reuse-other");
        let mut elsewhere = create_input(Some(other.path()));
        elsewhere.reuse_existing = Some(true);
        assert_ne!(manager.create(&elsewhere).expect("new").id, first.id);
        assert_eq!(manager.list().len(), 2);
        manager.dispose();
        assert!(manager.list().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn multi_byte_output_is_never_split_across_events() {
        let scratch = ScratchDir::new("terminal-utf8");
        let (manager, mut events) = sh_manager(&scratch);
        let info = manager
            .create(&create_input(Some(scratch.path())))
            .expect("create");
        // 7 bytes per iteration, so read-chunk edges land mid-character.
        manager
            .write(
                &info.id,
                "i=0; while [ $i -lt 4000 ]; do printf '\\342\\202\\254\\360\\237\\230\\200'; i=$((i+1)); done; echo; echo \"done-$((5 * 5))\"\n",
            )
            .expect("write");
        let seen = output_until(&mut events, &info.id, "done-25").await;
        assert!(!seen.contains(char::REPLACEMENT_CHARACTER));
        assert!(seen.contains(&"€😀".repeat(4000)));
        manager.kill(&info.id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn zsh_integration_tracks_commands_and_cleans_up() {
        if !Path::new("/bin/zsh").is_file() {
            eprintln!("skipping: /bin/zsh is not installed");
            return;
        }
        let scratch = ScratchDir::new("terminal-zsh");
        let mut env = test_env(&scratch);
        env.set("SHELL", "/bin/zsh");
        let (manager, mut events) = TerminalManager::with_options(TerminalManagerOptions {
            env: Some(env),
            profiles: None,
        });
        let mut input = create_input(Some(scratch.path()));
        input.profile_id = Some("zsh".to_string());
        let info = manager.create(&input).expect("create zsh");
        assert_eq!(info.profile_id, "zsh");
        let session = manager.sessions().get(&info.id).cloned().expect("session");
        let integration = lock(&session.state)
            .integration_dir
            .clone()
            .expect("integration dir");
        let rc = std::fs::read_to_string(integration.join(".zshrc")).expect("rc file");
        assert!(rc.contains("__tm_precmd") && rc.contains(".zshrc\"; fi"));

        manager
            .write(&info.id, "echo mark-$((2 + 3))\n")
            .expect("write");
        let finished = finished_command(&mut events).await;
        assert_eq!(finished.command, "echo mark-$((2 + 3))");
        assert_eq!(finished.status, TerminalCommandStatus::Success);
        assert!(finished.output.contains("mark-5"), "{finished:?}");

        manager.write(&info.id, "false\n").expect("write");
        let failed = finished_command(&mut events).await;
        assert_eq!(failed.exit_code, Some(1));
        assert_eq!(failed.status, TerminalCommandStatus::Failed);
        assert_eq!(manager.commands(&info.id).expect("commands").len(), 2);
        assert_eq!(manager.list()[0].last_command.as_ref(), Some(&failed));

        manager.write(&info.id, "exit\n").expect("write");
        exit_of(&mut events, &info.id).await;
        assert!(!integration.exists(), "integration dir removed on exit");
    }

    async fn finished_command(
        events: &mut mpsc::UnboundedReceiver<TerminalEvent>,
    ) -> TerminalCommandRecord {
        loop {
            if let TerminalEvent::Command(event) = next_event(events).await
                && event.command.status != TerminalCommandStatus::Running
            {
                return event.command;
            }
        }
    }
}
