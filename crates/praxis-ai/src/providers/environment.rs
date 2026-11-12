//! The executable search path for agent CLIs.
//!
//! An app launched from Finder, the Dock or a desktop runner inherits a minimal `PATH`
//! (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS) that excludes Homebrew, nvm, Volta, cargo and
//! every other place `claude-agent-acp`/`codex-acp` actually live. This mirrors the Electron
//! app's `shellEnvironment.ts`: take the user's login-shell `PATH`, then the inherited one,
//! then well-known tool directories that exist.
//!
//! The result is returned as a string and passed to child processes explicitly; the process
//! environment is never mutated.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const MARKER_START: &str = "__PRAXIS_PATH_START__";
const MARKER_END: &str = "__PRAXIS_PATH_END__";

/// Directories that commonly hold user-installed developer tools.
#[must_use]
pub fn candidate_tool_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = vec![
        home.join(".local/bin"),
        home.join(".cargo/bin"),
        home.join(".yarn/bin"),
    ];
    let nvm = home.join(".nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm) {
        let mut versions: Vec<_> = entries
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        versions.sort();
        versions.reverse();
        paths.extend(
            versions
                .into_iter()
                .map(|version| nvm.join(version).join("bin")),
        );
    }
    paths.extend([
        home.join(".fnm/current/bin"),
        home.join(".volta/bin"),
        home.join(".asdf/shims"),
    ]);
    paths
}

fn well_known(platform_macos: bool) -> Vec<PathBuf> {
    let base: &[&str] = if platform_macos {
        &[
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
    } else {
        &[
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
    };
    base.iter().map(PathBuf::from).collect()
}

/// Shell entries first (the user's explicit terminal setup), then the inherited entries, then
/// well-known directories that exist. Duplicates keep their first position.
#[must_use]
pub fn merge_path(shell: Option<&str>, current: &str, fallback_dirs: &[PathBuf]) -> String {
    let mut seen = BTreeSet::new();
    let mut ordered: Vec<String> = Vec::new();
    let mut push = |entry: &str| {
        let entry = entry.trim();
        if !entry.is_empty() && seen.insert(entry.to_owned()) {
            ordered.push(entry.to_owned());
        }
    };
    for entry in std::env::split_paths(shell.unwrap_or_default()) {
        push(&entry.to_string_lossy());
    }
    for entry in std::env::split_paths(current) {
        push(&entry.to_string_lossy());
    }
    for dir in fallback_dirs.iter().filter(|dir| dir.exists()) {
        push(&dir.to_string_lossy());
    }
    std::env::join_paths(ordered).map_or_else(
        |_| current.to_owned(),
        |joined| joined.to_string_lossy().into_owned(),
    )
}

/// The user's interactive login-shell `PATH`, or `None` when it cannot be read within 3 seconds.
#[cfg(unix)]
fn resolve_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else {
                "/bin/bash".into()
            }
        });
    let script = format!("echo -n {MARKER_START}; printenv PATH; echo -n {MARKER_END}");
    // -i evaluates .zshrc/.bashrc, -l evaluates .zprofile/.bash_profile.
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .env("CI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut output = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut output);
        output
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(15)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = reader.join().ok()?;
    let start = output.find(MARKER_START)? + MARKER_START.len();
    let end = output.find(MARKER_END)?;
    (end > start)
        .then(|| output[start..end].trim().to_owned())
        .filter(|path| !path.is_empty())
}

#[cfg(not(unix))]
fn resolve_shell_path() -> Option<String> {
    None
}

/// The effective search path for agent CLIs, computed once per process.
#[must_use]
pub fn effective_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let current = std::env::var("PATH").unwrap_or_default();
        if cfg!(windows) {
            return current;
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        let mut dirs = well_known(cfg!(target_os = "macos"));
        dirs.extend(candidate_tool_paths(&home));
        merge_path(resolve_shell_path().as_deref(), &current, &dirs)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_entries_come_first_then_inherited_then_existing_fallbacks_without_duplicates() {
        let tmp = std::env::temp_dir().join(format!("praxis-path-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("dir");
        let missing = tmp.join("does-not-exist");
        let merged = merge_path(
            Some("/opt/shell/bin:/usr/bin"),
            "/usr/bin:/bin",
            &[tmp.clone(), missing],
        );
        let parts: Vec<_> = std::env::split_paths(&merged)
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            parts,
            vec![
                "/opt/shell/bin".to_string(),
                "/usr/bin".into(),
                "/bin".into(),
                tmp.to_string_lossy().into_owned()
            ]
        );
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn nvm_versions_are_listed_newest_first() {
        let home = std::env::temp_dir().join(format!("praxis-nvm-{}", std::process::id()));
        for version in ["v18.0.0", "v22.1.0", "v20.5.0"] {
            std::fs::create_dir_all(home.join(".nvm/versions/node").join(version)).expect("dir");
        }
        let found: Vec<_> = candidate_tool_paths(&home)
            .iter()
            .filter_map(|p| {
                p.parent()
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
            })
            .filter(|n| n.starts_with('v'))
            .collect();
        assert_eq!(found, vec!["v22.1.0", "v20.5.0", "v18.0.0"]);
        let _ = std::fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn the_real_login_shell_path_resolves_and_includes_the_system_dirs() {
        let path = effective_path();
        assert!(path.contains("/usr/bin"), "{path}");
    }
}
