//! Runtime configuration and isolation settings for [` crate::HostContext `].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Errors returned when constructing or validating [`HostConfig`].
#[derive(Debug, Error, PartialEq, Eq)]
pub enum HostConfigError {
    #[error("user_data_dir must not be empty")]
    EmptyUserDataDir,
    #[error("settings_path must not be empty")]
    EmptySettingsPath,
}

/// Initialization parameters for an isolated [`crate::HostContext`] instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    /// Directory holding per-profile JSON stores (`projects.json`, `workspaces.json`, etc.).
    pub user_data_dir: PathBuf,
    /// Shared or per-test `settings.json` file path (`PRAXIS_SETTINGS_PATH`).
    pub settings_path: PathBuf,
    /// Whether the built-in `--demo` connection and fixtures are enabled.
    pub demo_mode: bool,
    /// Whether the host is running under Playwright / automated E2E isolation (`PRAXIS_E2E=1`).
    pub e2e_mode: bool,
}

impl HostConfig {
    /// Creates a validated [`HostConfig`] with explicit paths and flags.
    pub fn new(
        user_data_dir: impl Into<PathBuf>,
        settings_path: impl Into<PathBuf>,
        demo_mode: bool,
        e2e_mode: bool,
    ) -> Result<Self, HostConfigError> {
        let user_data_dir = user_data_dir.into();
        let settings_path = settings_path.into();
        if user_data_dir.as_os_str().is_empty() {
            return Err(HostConfigError::EmptyUserDataDir);
        }
        if settings_path.as_os_str().is_empty() {
            return Err(HostConfigError::EmptySettingsPath);
        }
        Ok(Self {
            user_data_dir,
            settings_path,
            demo_mode,
            e2e_mode,
        })
    }

    /// Creates a [`HostConfig`] defaulting `settings_path` to `<user_data_dir>/settings.json`.
    pub fn for_user_data_dir(
        user_data_dir: impl AsRef<Path>,
        demo_mode: bool,
        e2e_mode: bool,
    ) -> Result<Self, HostConfigError> {
        let dir = user_data_dir.as_ref().to_path_buf();
        let settings_path = dir.join("settings.json");
        Self::new(dir, settings_path, demo_mode, e2e_mode)
    }

    /// Parses CLI arguments (`--user-data-dir`, `--settings-path`, `--demo`) and environment
    /// variables (`PRAXIS_SETTINGS_PATH`, `PRAXIS_E2E`, `PRAXIS_USER_DATA_DIR`).
    pub fn from_args_and_env(
        args: &[String],
        env: &BTreeMap<String, String>,
    ) -> Result<Self, HostConfigError> {
        let mut user_data_dir: Option<PathBuf> = env
            .get("PRAXIS_USER_DATA_DIR")
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from);
        let mut settings_path: Option<PathBuf> = env
            .get("PRAXIS_SETTINGS_PATH")
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from);
        let mut demo_mode = false;

        let mut iter = args.iter();
        while let Some(arg) = iter.next() {
            if let Some(value) = arg.strip_prefix("--user-data-dir=") {
                user_data_dir = Some(PathBuf::from(value));
            } else if arg == "--user-data-dir" {
                if let Some(next) = iter.next() {
                    user_data_dir = Some(PathBuf::from(next));
                }
            } else if let Some(value) = arg.strip_prefix("--settings-path=") {
                settings_path = Some(PathBuf::from(value));
            } else if arg == "--settings-path" {
                if let Some(next) = iter.next() {
                    settings_path = Some(PathBuf::from(next));
                }
            } else if arg == "--demo" {
                demo_mode = true;
            }
        }

        let resolved_user_data_dir = user_data_dir
            .unwrap_or_else(|| std::env::temp_dir().join("praxis-host-default-profile"));
        let resolved_settings_path =
            settings_path.unwrap_or_else(|| resolved_user_data_dir.join("settings.json"));
        let e2e_mode = env
            .get("PRAXIS_E2E")
            .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));

        Self::new(
            resolved_user_data_dir,
            resolved_settings_path,
            demo_mode,
            e2e_mode,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_isolated_e2e_flags_and_env() {
        let args = vec![
            "--user-data-dir=/tmp/praxis-e2e-worker-1".to_string(),
            "--demo".to_string(),
        ];
        let mut env = BTreeMap::new();
        env.insert(
            "PRAXIS_SETTINGS_PATH".to_string(),
            "/tmp/praxis-e2e-worker-1/test-settings.json".to_string(),
        );
        env.insert("PRAXIS_E2E".to_string(), "1".to_string());

        let config = HostConfig::from_args_and_env(&args, &env).expect("valid config");
        assert_eq!(
            config.user_data_dir,
            PathBuf::from("/tmp/praxis-e2e-worker-1")
        );
        assert_eq!(
            config.settings_path,
            PathBuf::from("/tmp/praxis-e2e-worker-1/test-settings.json")
        );
        assert!(config.demo_mode);
        assert!(config.e2e_mode);
    }

    #[test]
    fn rejects_empty_paths() {
        assert_eq!(
            HostConfig::new("", "/tmp/settings.json", false, false),
            Err(HostConfigError::EmptyUserDataDir)
        );
        assert_eq!(
            HostConfig::new("/tmp/profile", "", false, false),
            Err(HostConfigError::EmptySettingsPath)
        );
    }
}
