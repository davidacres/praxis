//! Portable deployment profile storage and credential rebinding
//! (`projects/deploymentProfileStore.ts` port).
//!
//! One `<id>.deployment.praxis.json` per profile under `<project>/.praxis/deployments/`,
//! committed with the repository like `run.praxis.json`. Every path a profile carries is
//! repo-relative by validation, so targets need no per-machine rebinding. What cannot
//! travel is a credential value: `credentials` holds `${secret:NAME}` references only, and
//! [`evaluate_credential_bindings`] reports which of them this machine's secret store can
//! resolve, so a fresh checkout prompts for each one by name.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::deployment_profile::{
    DeploymentProfile, DeploymentProfileIssue, validate_deployment_profile_value,
};

pub const DEPLOYMENT_PROFILE_FILE_SUFFIX: &str = ".deployment.praxis.json";
pub const DEPLOYMENT_PROFILES_DIR: &str = ".praxis/deployments";

fn profiles_dir(project_folder: &Path) -> PathBuf {
    project_folder.join(DEPLOYMENT_PROFILES_DIR)
}

fn file_path(project_folder: &Path, id: &str) -> PathBuf {
    profiles_dir(project_folder).join(format!("{id}{DEPLOYMENT_PROFILE_FILE_SUFFIX}"))
}

fn issue(path: &str, message: String) -> DeploymentProfileIssue {
    DeploymentProfileIssue {
        path: path.to_string(),
        message,
    }
}

/// Validates, then writes. Refuses a profile that would come back invalid on the next read.
pub async fn write_deployment_profile(
    project_folder: &Path,
    profile: &DeploymentProfile,
) -> Result<(), String> {
    let value = serde_json::to_value(profile).map_err(|error| error.to_string())?;
    let errors = validate_deployment_profile_value(&value);
    if !errors.is_empty() {
        let id = if profile.id.is_empty() {
            "(unnamed)"
        } else {
            profile.id.as_str()
        };
        let reasons: Vec<String> = errors
            .iter()
            .map(|issue| {
                let path = if issue.path.is_empty() {
                    "(root)"
                } else {
                    issue.path.as_str()
                };
                format!("{path}: {}", issue.message)
            })
            .collect();
        return Err(format!(
            "Deployment profile {id} is invalid: {}",
            reasons.join("; ")
        ));
    }
    let dir = profiles_dir(project_folder);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("Failed to create {}: {error}", dir.display()))?;
    let text = serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?;
    let path = file_path(project_folder, &profile.id);
    tokio::fs::write(&path, format!("{text}\n"))
        .await
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReadDeploymentProfile {
    pub profile: Option<DeploymentProfile>,
    pub issues: Vec<DeploymentProfileIssue>,
}

/// A missing profile is not an error: no profile and no issues. A malformed hand-edited
/// file comes back with a visible reason.
pub async fn read_deployment_profile(project_folder: &Path, id: &str) -> ReadDeploymentProfile {
    let Ok(raw) = tokio::fs::read_to_string(file_path(project_folder, id)).await else {
        return ReadDeploymentProfile::default();
    };
    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            return ReadDeploymentProfile {
                profile: None,
                issues: vec![issue(
                    "",
                    format!("Could not read deployment profile: {error}"),
                )],
            };
        }
    };
    let errors = validate_deployment_profile_value(&value);
    if !errors.is_empty() {
        return ReadDeploymentProfile {
            profile: None,
            issues: errors,
        };
    }
    match serde_json::from_value::<DeploymentProfile>(value) {
        Ok(profile) => ReadDeploymentProfile {
            profile: Some(profile),
            issues: Vec::new(),
        },
        Err(error) => ReadDeploymentProfile {
            profile: None,
            issues: vec![issue(
                "",
                format!("Could not read deployment profile: {error}"),
            )],
        },
    }
}

/// Every valid profile stored for the project. A malformed file is skipped, so one corrupt
/// profile never hides the others.
pub async fn list_deployment_profiles(project_folder: &Path) -> Vec<DeploymentProfile> {
    let Ok(mut entries) = tokio::fs::read_dir(profiles_dir(project_folder)).await else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(DEPLOYMENT_PROFILE_FILE_SUFFIX) {
            ids.push(id.to_string());
        }
    }
    ids.sort();
    let mut profiles = Vec::new();
    for id in ids {
        if let Some(profile) = read_deployment_profile(project_folder, &id).await.profile {
            profiles.push(profile);
        }
    }
    profiles
}

/// One credential's rebinding status on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialBindingStatus {
    /// The key in the profile's `credentials` map, e.g. `DEPLOY_TOKEN`.
    pub key: String,
    /// The `NAME` from `${secret:NAME}`: what the secret store looks up.
    pub secret_name: String,
    pub bound: bool,
}

/// The `NAME` in an exact `${secret:NAME}` reference.
fn secret_name(reference: &str) -> Option<&str> {
    reference
        .strip_prefix("${secret:")
        .and_then(|rest| rest.strip_suffix('}'))
        .filter(|name| {
            !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        })
}

/// Checks each credential reference against this machine's secret store via `lookup`. A
/// malformed reference, or a secret stored as an empty string, reports `bound: false`.
pub fn evaluate_credential_bindings(
    profile: &DeploymentProfile,
    lookup: impl Fn(&str) -> Option<String>,
) -> Vec<CredentialBindingStatus> {
    profile
        .credentials
        .iter()
        .flatten()
        .map(|(key, reference)| match secret_name(reference) {
            None => CredentialBindingStatus {
                key: key.clone(),
                secret_name: String::new(),
                bound: false,
            },
            Some(name) => CredentialBindingStatus {
                key: key.clone(),
                secret_name: name.to_string(),
                bound: lookup(name).is_some_and(|value| !value.is_empty()),
            },
        })
        .collect()
}

/// True when every referenced credential is bound here: the gate before any deploy.
#[must_use]
pub fn all_credentials_bound(statuses: &[CredentialBindingStatus]) -> bool {
    statuses.iter().all(|status| status.bound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment_profile::{
        DEPLOYMENT_PROFILE_SCHEMA_VERSION, DeploymentRollbackKind, DeploymentRollbackPolicy,
        ExecutorRef, TargetRef,
    };
    use crate::test_support::ScratchDir;
    use std::collections::BTreeMap;

    const AT: &str = "2026-09-09T00:00:00.000Z";

    fn profile() -> DeploymentProfile {
        DeploymentProfile {
            schema_version: DEPLOYMENT_PROFILE_SCHEMA_VERSION,
            version: 1,
            id: "production".to_string(),
            name: "Production".to_string(),
            project_id: "proj-1".to_string(),
            environment: "production".to_string(),
            executor: ExecutorRef::DirectProcess,
            target: TargetRef::Directory {
                path: "dist".to_string(),
            },
            health_check: None,
            rollback: DeploymentRollbackPolicy {
                kind: DeploymentRollbackKind::None,
                retain_count: None,
            },
            credentials: None,
            created_at: AT.to_string(),
            updated_at: AT.to_string(),
        }
    }

    fn with_credentials(pairs: &[(&str, &str)]) -> DeploymentProfile {
        let credentials: BTreeMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        DeploymentProfile {
            credentials: Some(credentials),
            ..profile()
        }
    }

    #[tokio::test]
    async fn a_missing_profile_has_no_profile_and_no_issues() {
        let dir = ScratchDir::new("deploy-missing");
        assert_eq!(
            read_deployment_profile(dir.path(), "production").await,
            ReadDeploymentProfile::default()
        );
    }

    #[tokio::test]
    async fn a_written_profile_reads_back_unchanged_and_rewrites_overwrite() {
        let dir = ScratchDir::new("deploy-roundtrip");
        write_deployment_profile(dir.path(), &profile())
            .await
            .expect("write");
        let read = read_deployment_profile(dir.path(), "production").await;
        assert!(read.issues.is_empty());
        assert_eq!(read.profile, Some(profile()));

        let renamed = DeploymentProfile {
            name: "Production (renamed)".to_string(),
            ..profile()
        };
        write_deployment_profile(dir.path(), &renamed)
            .await
            .expect("write");
        let read = read_deployment_profile(dir.path(), "production").await;
        assert_eq!(
            read.profile.map(|p| p.name).as_deref(),
            Some("Production (renamed)")
        );
    }

    #[tokio::test]
    async fn an_invalid_profile_is_refused_before_touching_disk() {
        let dir = ScratchDir::new("deploy-invalid");
        let invalid = DeploymentProfile {
            target: TargetRef::Directory {
                path: "/absolute/path".to_string(),
            },
            ..profile()
        };
        let error = write_deployment_profile(dir.path(), &invalid)
            .await
            .expect_err("absolute target path");
        assert!(error.contains("is invalid"));
        assert_eq!(
            read_deployment_profile(dir.path(), "production").await,
            ReadDeploymentProfile::default()
        );
    }

    #[tokio::test]
    async fn a_malformed_file_comes_back_with_a_visible_reason() {
        let dir = ScratchDir::new("deploy-malformed");
        let folder = dir.path().join(DEPLOYMENT_PROFILES_DIR);
        std::fs::create_dir_all(&folder).expect("mkdir");
        std::fs::write(
            folder.join("production.deployment.praxis.json"),
            "not valid json",
        )
        .expect("write");
        let read = read_deployment_profile(dir.path(), "production").await;
        assert!(read.profile.is_none());
        assert!(!read.issues.is_empty());
    }

    #[tokio::test]
    async fn list_returns_every_valid_profile_and_skips_a_malformed_one() {
        let dir = ScratchDir::new("deploy-list");
        assert!(list_deployment_profiles(dir.path()).await.is_empty());

        for (id, name) in [("staging", "Staging"), ("production", "Production")] {
            let p = DeploymentProfile {
                id: id.to_string(),
                name: name.to_string(),
                ..profile()
            };
            write_deployment_profile(dir.path(), &p)
                .await
                .expect("write");
        }
        std::fs::write(
            dir.path()
                .join(DEPLOYMENT_PROFILES_DIR)
                .join("broken.deployment.praxis.json"),
            "not json",
        )
        .expect("write");
        let ids: Vec<String> = list_deployment_profiles(dir.path())
            .await
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ids, ["production", "staging"]);
    }

    #[test]
    fn credential_bindings_report_each_reference_independently() {
        let p = with_credentials(&[
            ("DEPLOY_TOKEN", "${secret:deploy-token}"),
            ("API_KEY", "${secret:api-key}"),
        ]);

        let empty = evaluate_credential_bindings(&p, |_| None);
        assert_eq!(empty.len(), 2);
        assert!(empty.iter().all(|s| !s.bound));
        assert!(!all_credentials_bound(&empty));

        let populated = evaluate_credential_bindings(&p, |name| {
            matches!(name, "deploy-token" | "api-key").then(|| "value".to_string())
        });
        assert!(all_credentials_bound(&populated));

        let partial = evaluate_credential_bindings(&p, |name| {
            (name == "deploy-token").then(|| "ghp_xxx".to_string())
        });
        let bound = |key: &str| partial.iter().find(|s| s.key == key).map(|s| s.bound);
        assert_eq!(bound("DEPLOY_TOKEN"), Some(true));
        assert_eq!(bound("API_KEY"), Some(false));
        assert!(!all_credentials_bound(&partial));
    }

    #[test]
    fn no_credentials_is_vacuously_all_bound_and_empty_values_are_unbound() {
        let statuses = evaluate_credential_bindings(&profile(), |_| None);
        assert!(statuses.is_empty());
        assert!(all_credentials_bound(&statuses));

        let p = with_credentials(&[("DEPLOY_TOKEN", "${secret:deploy-token}")]);
        let statuses = evaluate_credential_bindings(&p, |_| Some(String::new()));
        assert!(!statuses[0].bound);
        assert_eq!(statuses[0].secret_name, "deploy-token");
    }
}
