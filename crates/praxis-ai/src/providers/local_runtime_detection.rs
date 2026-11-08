//! Finding the local AI runtimes a user has installed.
//!
//! Praxis can start a model on the user's own machine. Which runtimes are
//! there is discovered from the PATH rather than configured, so a user who
//! installs Ollama between two sessions sees it the next time they open the
//! settings.

use serde::{Deserialize, Serialize};

/// A local runtime found on the PATH.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedLocalRuntime {
    /// The runtime's identifier, as the settings store it.
    pub id: String,
    /// The name to show a user.
    pub label: String,
    /// The executable that was found.
    pub command: String,
}

/// The runtimes Praxis can start locally, and the commands that identify each.
///
/// The first command that is found wins, so a machine with both `lms` and
/// `lmstudio` is reported once.
const LOCAL_RUNTIME_CANDIDATES: &[(&str, &str, &[&str])] = &[
    ("ollama", "Ollama", &["ollama"]),
    ("lmstudio", "LM Studio", &["lms", "lmstudio"]),
    ("llama-server", "llama.cpp server", &["llama-server"]),
];

/// The first of `names` that exists on the PATH.
///
/// `path` is the PATH to search, taken as an argument so the search can be
/// tested without touching the process's own environment.
#[must_use]
pub fn find_on_path(names: &[&str], path: &str) -> Option<String> {
    for name in names {
        for directory in std::env::split_paths(path) {
            if directory.as_os_str().is_empty() {
                continue;
            }
            let candidate = directory.join(name);
            if candidate.exists() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// The local runtimes installed at the given PATH.
#[must_use]
pub fn detect_local_runtimes(path: &str) -> Vec<DetectedLocalRuntime> {
    LOCAL_RUNTIME_CANDIDATES
        .iter()
        .filter_map(|(id, label, commands)| {
            find_on_path(commands, path).map(|command| DetectedLocalRuntime {
                id: (*id).to_string(),
                label: (*label).to_string(),
                command,
            })
        })
        .collect()
}

/// The local runtimes installed on this machine, from this process's PATH.
#[must_use]
pub fn detect_local_runtimes_from_env() -> Vec<DetectedLocalRuntime> {
    let path = std::env::var("PATH").unwrap_or_default();
    detect_local_runtimes(&path)
}

#[cfg(test)]
mod tests {
    use super::{detect_local_runtimes, find_on_path};
    use std::fs;
    use std::path::PathBuf;

    /// A directory of stub executables, standing in for a PATH.
    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("praxis-ai-runtimes-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("the scratch directory can be created");
        directory
    }

    #[test]
    fn ollama_and_lmstudio_are_found_when_they_are_on_the_path() {
        let directory = scratch("found");
        fs::write(directory.join("ollama"), "").expect("the stub can be written");
        fs::write(directory.join("lmstudio"), "").expect("the stub can be written");

        let found = detect_local_runtimes(&directory.to_string_lossy());
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].id, "ollama");
        assert_eq!(found[0].label, "Ollama");
        assert_eq!(found[1].id, "lmstudio");
        assert_eq!(found[1].label, "LM Studio");
        assert!(found[0].command.ends_with("ollama"));

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn nothing_is_reported_when_no_runtime_is_installed() {
        let directory = scratch("empty");
        assert!(detect_local_runtimes(&directory.to_string_lossy()).is_empty());
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn the_first_command_on_the_path_wins() {
        let directory = scratch("first");
        fs::write(directory.join("lms"), "").expect("the stub can be written");
        fs::write(directory.join("lmstudio"), "").expect("the stub can be written");
        let found = find_on_path(&["lms", "lmstudio"], &directory.to_string_lossy());
        assert_eq!(
            found,
            Some(directory.join("lms").to_string_lossy().into_owned())
        );
        let _ = fs::remove_dir_all(&directory);
    }
}
