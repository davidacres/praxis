//! `<projectFolder>/run.praxis.json` storage (`projects/runProfileStore.ts` port).
//!
//! A missing file is not an error: most projects have no Run profile yet. A malformed
//! one comes back with issues rather than being silently ignored.

use std::path::Path;

use serde_json::Value;

use crate::run_profile::{
    RUN_PROFILE_FILE_NAME, RunProfile, RunProfileIssue, parse_run_profile, serialize_run_profile,
    validate_run_profile,
};

/// Reads the profile for a project. `Ok(None)` when no file exists; `Err` lists why a file
/// that exists is not a valid profile.
pub async fn read_run_profile(
    project_folder: &Path,
) -> Result<Option<RunProfile>, Vec<RunProfileIssue>> {
    let raw = match tokio::fs::read_to_string(project_folder.join(RUN_PROFILE_FILE_NAME)).await {
        Ok(raw) => raw,
        Err(_) => return Ok(None),
    };
    let parsed: Value = serde_json::from_str(&raw).map_err(|error| {
        vec![RunProfileIssue {
            path: String::new(),
            message: format!("Could not read run profile: {error}"),
        }]
    })?;
    parse_run_profile(&parsed).map(Some)
}

/// Validates, then writes. Refuses to write a profile that would not read back as valid.
pub async fn write_run_profile(project_folder: &Path, profile: &RunProfile) -> Result<(), String> {
    let errors = validate_run_profile(profile);
    if !errors.is_empty() {
        let details = errors
            .iter()
            .map(|e| {
                format!(
                    "{}: {}",
                    if e.path.is_empty() { "(root)" } else { &e.path },
                    e.message
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!(
            "Run profile {} is invalid: {details}",
            if profile.id.is_empty() {
                "(unnamed)"
            } else {
                &profile.id
            }
        ));
    }
    tokio::fs::create_dir_all(project_folder)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::write(
        project_folder.join(RUN_PROFILE_FILE_NAME),
        serialize_run_profile(profile),
    )
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_profile::RunServiceDefinition;
    use crate::test_support::ScratchDir;

    fn profile(id: &str) -> RunProfile {
        RunProfile {
            schema_version: 1,
            id: id.into(),
            name: "Project".into(),
            services: vec![RunServiceDefinition {
                id: "web".into(),
                name: "Web".into(),
                executable: "npm".into(),
                args: None,
                cwd: None,
                depends_on: None,
                readiness_probe: None,
                port: None,
                env: None,
            }],
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    #[tokio::test]
    async fn reading_a_project_with_no_profile_gives_none_not_an_error() {
        let dir = ScratchDir::new("run-profile-none");
        assert_eq!(read_run_profile(dir.path()).await, Ok(None));
    }

    #[tokio::test]
    async fn a_profile_written_then_read_back_round_trips_unchanged() {
        let dir = ScratchDir::new("run-profile-rt");
        let original = profile("p");
        write_run_profile(dir.path(), &original)
            .await
            .expect("test setup");
        assert_eq!(read_run_profile(dir.path()).await, Ok(Some(original)));
    }

    #[tokio::test]
    async fn writing_an_invalid_profile_refuses_before_touching_disk() {
        let dir = ScratchDir::new("run-profile-invalid");
        let err = write_run_profile(dir.path(), &profile(""))
            .await
            .expect_err("test expects an error");
        assert!(err.contains("invalid"));
        assert!(!dir.path().join(RUN_PROFILE_FILE_NAME).exists());
    }

    #[tokio::test]
    async fn a_hand_edited_malformed_file_comes_back_with_a_visible_reason() {
        let dir = ScratchDir::new("run-profile-bad");
        tokio::fs::write(dir.path().join(RUN_PROFILE_FILE_NAME), "{ not json")
            .await
            .expect("test setup");
        let issues = read_run_profile(dir.path())
            .await
            .expect_err("test expects an error");
        assert!(issues[0].message.starts_with("Could not read run profile"));
    }

    #[tokio::test]
    async fn rewriting_a_profile_overwrites_rather_than_appends() {
        let dir = ScratchDir::new("run-profile-overwrite");
        write_run_profile(dir.path(), &profile("first"))
            .await
            .expect("test setup");
        write_run_profile(dir.path(), &profile("second"))
            .await
            .expect("test setup");
        let read = read_run_profile(dir.path())
            .await
            .expect("test setup")
            .expect("test setup");
        assert_eq!(read.id, "second");
    }
}
