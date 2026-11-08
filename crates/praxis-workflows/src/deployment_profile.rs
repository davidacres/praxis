//! Deployment domain contracts (`projects/deploymentProfile.ts` port).
//!
//! A deployment profile says how and where a project deploys, and is deliberately
//! independent of the project's issue tracker: nothing here reads or branches on tracker
//! identity. The executor and target kinds cover more than this build can run —
//! `github-actions`/`gitlab-ci` executors and an `iis` target are schema-valid so a profile
//! authored against them can be read, stored and displayed. [`validate_deployment_profile`]
//! checks shape only; [`preflight_deployment_capabilities`] is the separate "can this build
//! run it" check.
//!
//! Validation reads the raw JSON, as the TypeScript does, so a profile with an unknown
//! executor kind or a fractional version is reported as an issue rather than failing to
//! parse.

use std::collections::BTreeMap;

use praxis_core::workspaces::workspace_paths::is_portable_folder_path;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::run_profile::{RunReadinessProbe, is_secret_reference_value};

pub const DEPLOYMENT_PROFILE_SCHEMA_VERSION: u32 = 1;

const EXECUTOR_KINDS: [&str; 3] = ["direct-process", "github-actions", "gitlab-ci"];
const TARGET_KINDS: [&str; 3] = ["local-process", "directory", "iis"];
const ROLLBACK_KINDS: [&str; 2] = ["keep-previous-artifact", "none"];

/// Executors this build actually runs; everything else is schema-valid but not runnable.
pub const SUPPORTED_EXECUTOR_KINDS: [&str; 1] = ["direct-process"];
/// Targets this build actually runs. IIS needs Windows and a later feature.
pub const SUPPORTED_TARGET_KINDS: [&str; 2] = ["local-process", "directory"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ExecutorRef {
    DirectProcess,
    /// When `observe_only`, observe an already-triggered run instead of dispatching one.
    #[serde(rename_all = "camelCase")]
    GithubActions {
        workflow_file: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observe_only: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    GitlabCi {
        pipeline_file: String,
    },
}

impl ExecutorRef {
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::DirectProcess => "direct-process",
            Self::GithubActions { .. } => "github-actions",
            Self::GitlabCi { .. } => "gitlab-ci",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TargetRef {
    /// Runs the published artifact as a local process. `cwd` is repo-relative.
    LocalProcess {
        executable: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Copies the published artifact into a repo-relative directory, e.g. a web root.
    Directory { path: String },
    #[serde(rename_all = "camelCase")]
    Iis {
        site_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_pool_name: Option<String>,
    },
}

impl TargetRef {
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::LocalProcess { .. } => "local-process",
            Self::Directory { .. } => "directory",
            Self::Iis { .. } => "iis",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeploymentRollbackKind {
    KeepPreviousArtifact,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentRollbackPolicy {
    pub kind: DeploymentRollbackKind,
    /// Prior artifacts kept for rollback; only meaningful for `keep-previous-artifact`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retain_count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentProfile {
    pub schema_version: u32,
    pub id: String,
    /// Bumped by whoever writes the profile on any change; an approval's validity depends
    /// on it, so it is never inferred from `updated_at`. Starts at 1.
    pub version: u32,
    pub name: String,
    pub project_id: String,
    /// Free text ("staging", "production"); environments are project-defined.
    pub environment: String,
    pub executor: ExecutorRef,
    pub target: TargetRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_check: Option<RunReadinessProbe>,
    pub rollback: DeploymentRollbackPolicy,
    /// Credential names mapped to `${secret:NAME}` references, never literal values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<BTreeMap<String, String>>,
    pub created_at: String,
    pub updated_at: String,
}

/// The commit an artifact or evidence bundle came from, explicit when unknown
/// (`workflows/workflowEvidence.ts`'s `WorkflowEvidenceSourceRef`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WorkflowEvidenceSourceRef {
    Commit { sha: String },
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ArtifactLocation {
    LocalPath { path: String },
}

/// An immutable, published build. A deployment run references one by id; nothing ever
/// updates one in place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedArtifact {
    pub id: String,
    pub deployment_profile_id: String,
    pub source_commit: WorkflowEvidenceSourceRef,
    /// `sha256:<hex>` over the artifact's manifest: what was actually published.
    pub digest: String,
    pub created_at: String,
    pub location: ArtifactLocation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeploymentProfileIssue {
    pub path: String,
    pub message: String,
}

fn issue(path: impl Into<String>, message: impl Into<String>) -> DeploymentProfileIssue {
    DeploymentProfileIssue {
        path: path.into(),
        message: message.into(),
    }
}

fn non_empty(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
}

/// JavaScript's `Number.isInteger(n) && n >= 1`.
fn is_positive_integer(value: Option<&Value>) -> bool {
    match value.and_then(Value::as_f64) {
        Some(number) => number.fract() == 0.0 && number >= 1.0,
        None => false,
    }
}

/// How the TypeScript renders a missing or non-string kind inside its message.
fn kind_label(kind: Option<&Value>) -> String {
    match kind {
        Some(Value::String(text)) => text.clone(),
        None | Some(Value::Null) => "undefined".to_string(),
        Some(other) => other.to_string(),
    }
}

/// Shape validation of a profile as raw JSON. A profile naming a not-yet-implemented
/// executor or target is still valid here. An empty result means valid.
#[must_use]
pub fn validate_deployment_profile_value(profile: &Value) -> Vec<DeploymentProfileIssue> {
    let mut errors = Vec::new();
    for (field, label) in [
        ("id", "id"),
        ("name", "name"),
        ("projectId", "projectId"),
        ("environment", "environment"),
    ] {
        if !non_empty(profile.get(field)) {
            errors.push(issue(field, format!("{label} is required.")));
        }
    }
    if !is_positive_integer(profile.get("version")) {
        errors.push(issue("version", "version must be a positive integer."));
    }

    let executor = profile.get("executor");
    let executor_kind = executor.and_then(|e| e.get("kind"));
    match executor_kind.and_then(Value::as_str) {
        Some(kind) if EXECUTOR_KINDS.contains(&kind) => {
            let executor = executor.unwrap_or(&Value::Null);
            if kind == "github-actions" && !non_empty(executor.get("workflowFile")) {
                errors.push(issue(
                    "executor.workflowFile",
                    "workflowFile is required for a github-actions executor.",
                ));
            } else if kind == "gitlab-ci" && !non_empty(executor.get("pipelineFile")) {
                errors.push(issue(
                    "executor.pipelineFile",
                    "pipelineFile is required for a gitlab-ci executor.",
                ));
            }
        }
        _ => errors.push(issue(
            "executor.kind",
            format!("Unknown executor kind \"{}\".", kind_label(executor_kind)),
        )),
    }

    let target = profile.get("target");
    let target_kind = target.and_then(|t| t.get("kind"));
    match target_kind.and_then(Value::as_str) {
        Some(kind) if TARGET_KINDS.contains(&kind) => {
            let target = target.unwrap_or(&Value::Null);
            validate_target(kind, target, &mut errors);
        }
        _ => errors.push(issue(
            "target.kind",
            format!("Unknown target kind \"{}\".", kind_label(target_kind)),
        )),
    }

    // Every entry is a credential by definition, so every value must be a reference —
    // not only the ones whose key looks secret-shaped.
    if let Some(credentials) = profile.get("credentials").and_then(Value::as_object) {
        for (key, value) in credentials {
            if !value.as_str().is_some_and(is_secret_reference_value) {
                errors.push(issue(
                    format!("credentials.{key}"),
                    format!(
                        "\"{key}\" must be a ${{secret:NAME}} reference, never a literal credential value."
                    ),
                ));
            }
        }
    }

    let rollback = profile.get("rollback");
    let rollback_kind = rollback.and_then(|r| r.get("kind"));
    match rollback_kind.and_then(Value::as_str) {
        Some(kind) if ROLLBACK_KINDS.contains(&kind) => {
            let retain_count = rollback.and_then(|r| r.get("retainCount"));
            if kind == "keep-previous-artifact"
                && retain_count.is_some_and(|value| !value.is_null())
                && !is_positive_integer(retain_count)
            {
                errors.push(issue(
                    "rollback.retainCount",
                    "retainCount must be a positive integer when set.",
                ));
            }
        }
        _ => errors.push(issue(
            "rollback.kind",
            format!("Unknown rollback kind \"{}\".", kind_label(rollback_kind)),
        )),
    }

    errors
}

fn validate_target(kind: &str, target: &Value, errors: &mut Vec<DeploymentProfileIssue>) {
    match kind {
        "local-process" => {
            if !non_empty(target.get("executable")) {
                errors.push(issue(
                    "target.executable",
                    "executable is required for a local-process target.",
                ));
            }
            // Repo-relative, the same portability discipline as a run service's cwd.
            if let Some(cwd) = target.get("cwd").and_then(Value::as_str) {
                if !is_portable_folder_path(cwd) {
                    errors.push(issue(
                        "target.cwd",
                        format!("cwd must be repo-relative, not absolute: \"{cwd}\"."),
                    ));
                }
            }
        }
        "directory" => match target.get("path").and_then(Value::as_str) {
            Some(path) if !path.trim().is_empty() => {
                if !is_portable_folder_path(path) {
                    errors.push(issue(
                        "target.path",
                        format!("path must be repo-relative, not absolute: \"{path}\"."),
                    ));
                }
            }
            _ => errors.push(issue(
                "target.path",
                "path is required for a directory target.",
            )),
        },
        "iis" if !non_empty(target.get("siteName")) => {
            errors.push(issue(
                "target.siteName",
                "siteName is required for an iis target.",
            ));
        }
        _ => {}
    }
}

/// Shape validation of a typed profile. An empty result means valid.
#[must_use]
pub fn validate_deployment_profile(profile: &DeploymentProfile) -> Vec<DeploymentProfileIssue> {
    match serde_json::to_value(profile) {
        Ok(value) => validate_deployment_profile_value(&value),
        Err(error) => vec![issue(
            "",
            format!("Profile could not be serialized: {error}"),
        )],
    }
}

/// Every capability this build cannot run, so a caller can show all the reasons a
/// schema-valid profile can't be deployed from here. Never fails.
#[must_use]
pub fn preflight_deployment_capabilities(
    profile: &DeploymentProfile,
) -> Vec<DeploymentProfileIssue> {
    let mut issues = Vec::new();
    let executor_kind = profile.executor.kind();
    if !SUPPORTED_EXECUTOR_KINDS.contains(&executor_kind) {
        issues.push(issue(
            "executor.kind",
            format!("Executor \"{executor_kind}\" is not supported by this build."),
        ));
    }
    let target_kind = profile.target.kind();
    if !SUPPORTED_TARGET_KINDS.contains(&target_kind) {
        issues.push(issue(
            "target.kind",
            format!("Target \"{target_kind}\" is not supported by this build."),
        ));
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const AT: &str = "2026-09-09T00:00:00.000Z";

    fn profile_value() -> Value {
        json!({
            "schemaVersion": DEPLOYMENT_PROFILE_SCHEMA_VERSION,
            "version": 1,
            "id": "prod-deploy",
            "name": "Production",
            "projectId": "proj-1",
            "environment": "production",
            "executor": { "kind": "direct-process" },
            "target": { "kind": "directory", "path": "dist" },
            "rollback": { "kind": "none" },
            "createdAt": AT,
            "updatedAt": AT
        })
    }

    fn with(overrides: &Value) -> Value {
        let mut value = profile_value();
        if let (Some(base), Some(extra)) = (value.as_object_mut(), overrides.as_object()) {
            for (key, field) in extra {
                base.insert(key.clone(), field.clone());
            }
        }
        value
    }

    fn typed(value: &Value) -> DeploymentProfile {
        serde_json::from_value(value.clone()).expect("typed profile")
    }

    fn is_valid(value: &Value) -> bool {
        validate_deployment_profile_value(value).is_empty()
    }

    fn has_path(issues: &[DeploymentProfileIssue], path: &str) -> bool {
        issues.iter().any(|issue| issue.path == path)
    }

    #[test]
    fn direct_process_with_directory_target_is_valid_and_preflight_clean() {
        let value = profile_value();
        assert!(is_valid(&value));
        assert!(preflight_deployment_capabilities(&typed(&value)).is_empty());
        assert!(validate_deployment_profile(&typed(&value)).is_empty());
    }

    #[test]
    fn direct_process_with_local_process_target_is_valid_and_preflight_clean() {
        let value = with(
            &json!({ "target": { "kind": "local-process", "executable": "node", "args": ["server.js"] } }),
        );
        assert!(is_valid(&value));
        assert!(preflight_deployment_capabilities(&typed(&value)).is_empty());
    }

    #[test]
    fn unsupported_executor_and_target_are_schema_valid_but_fail_preflight() {
        let value = with(&json!({
            "executor": { "kind": "github-actions", "workflowFile": ".github/workflows/deploy.yml" },
            "target": { "kind": "iis", "siteName": "Default Web Site" }
        }));
        assert!(
            is_valid(&value),
            "schema-valid despite being unsupported to run"
        );
        let issues = preflight_deployment_capabilities(&typed(&value));
        assert_eq!(issues.len(), 2);
        assert!(
            issues
                .iter()
                .any(|i| i.path == "executor.kind" && i.message.contains("github-actions"))
        );
        assert!(
            issues
                .iter()
                .any(|i| i.path == "target.kind" && i.message.contains("iis"))
        );
    }

    #[test]
    fn gitlab_ci_is_schema_valid_but_fails_preflight() {
        let value =
            with(&json!({ "executor": { "kind": "gitlab-ci", "pipelineFile": ".gitlab-ci.yml" } }));
        assert!(is_valid(&value));
        let issues = preflight_deployment_capabilities(&typed(&value));
        assert_eq!(issues.len(), 1);
        assert!(issues[0].message.contains("gitlab-ci"));
    }

    #[test]
    fn tracker_identity_never_affects_validation() {
        let jira = typed(&with(&json!({ "projectId": "jira-project-1" })));
        let folder = typed(&with(&json!({ "projectId": "folder-project-1" })));
        assert_eq!(
            validate_deployment_profile(&jira),
            validate_deployment_profile(&folder)
        );
        assert_eq!(
            preflight_deployment_capabilities(&jira),
            preflight_deployment_capabilities(&folder)
        );
    }

    #[test]
    fn unknown_executor_target_and_rollback_kinds_are_reported() {
        let executor =
            validate_deployment_profile_value(&with(&json!({ "executor": { "kind": "ftp" } })));
        assert!(has_path(&executor, "executor.kind"));
        assert_eq!(executor[0].message, "Unknown executor kind \"ftp\".");
        let target =
            validate_deployment_profile_value(&with(&json!({ "target": { "kind": "s3-bucket" } })));
        assert!(has_path(&target, "target.kind"));
        let rollback = validate_deployment_profile_value(&with(
            &json!({ "rollback": { "kind": "archive-forever" } }),
        ));
        assert!(has_path(&rollback, "rollback.kind"));
        let missing = validate_deployment_profile_value(&with(&json!({ "executor": {} })));
        assert_eq!(missing[0].message, "Unknown executor kind \"undefined\".");
    }

    #[test]
    fn executor_and_target_required_fields_are_checked() {
        let cases = [
            (
                json!({ "executor": { "kind": "github-actions", "workflowFile": "" } }),
                "executor.workflowFile",
            ),
            (
                json!({ "executor": { "kind": "gitlab-ci", "pipelineFile": "" } }),
                "executor.pipelineFile",
            ),
            (
                json!({ "target": { "kind": "local-process", "executable": "" } }),
                "target.executable",
            ),
            (
                json!({ "target": { "kind": "directory", "path": "" } }),
                "target.path",
            ),
            (
                json!({ "target": { "kind": "iis", "siteName": "" } }),
                "target.siteName",
            ),
        ];
        for (overrides, path) in cases {
            let issues = validate_deployment_profile_value(&with(&overrides));
            assert!(has_path(&issues, path), "expected an issue at {path}");
        }
    }

    #[test]
    fn required_top_level_fields_are_checked() {
        let issues = validate_deployment_profile_value(&with(
            &json!({ "id": "", "name": "", "projectId": "", "environment": "" }),
        ));
        for path in ["id", "name", "projectId", "environment"] {
            assert!(has_path(&issues, path), "expected an issue at {path}");
        }
    }

    #[test]
    fn version_must_be_a_positive_integer() {
        assert!(!is_valid(&with(&json!({ "version": 0 }))));
        assert!(!is_valid(&with(&json!({ "version": -1 }))));
        assert!(!is_valid(&with(&json!({ "version": 1.5 }))));
        assert!(is_valid(&with(&json!({ "version": 2 }))));
    }

    #[test]
    fn keep_previous_artifact_retain_count_must_be_a_positive_integer_when_set() {
        let rollback = |r: Value| with(&json!({ "rollback": r }));
        assert!(is_valid(&rollback(
            json!({ "kind": "keep-previous-artifact", "retainCount": 3 })
        )));
        assert!(is_valid(&rollback(
            json!({ "kind": "keep-previous-artifact" })
        )));
        assert!(!is_valid(&rollback(
            json!({ "kind": "keep-previous-artifact", "retainCount": 0 })
        )));
        assert!(!is_valid(&rollback(
            json!({ "kind": "keep-previous-artifact", "retainCount": -1 })
        )));
        assert!(!is_valid(&rollback(
            json!({ "kind": "keep-previous-artifact", "retainCount": 1.5 })
        )));
        assert!(is_valid(&rollback(json!({ "kind": "none" }))));
    }

    #[test]
    fn a_health_check_reusing_the_readiness_probe_shape_is_valid() {
        let value = with(
            &json!({ "healthCheck": { "kind": "http", "path": "/healthz", "expectedStatus": 200 } }),
        );
        assert!(is_valid(&value));
        assert!(typed(&value).health_check.is_some());
    }

    #[test]
    fn target_paths_must_be_repo_relative() {
        let directory =
            |path: &str| with(&json!({ "target": { "kind": "directory", "path": path } }));
        assert!(!is_valid(&directory("/var/www/html")));
        assert!(!is_valid(&directory("C:\\inetpub\\wwwroot")));
        assert!(is_valid(&directory("dist/publish")));

        let local = |cwd: Option<&str>| {
            let mut target = json!({ "kind": "local-process", "executable": "node" });
            if let Some(cwd) = cwd {
                target["cwd"] = json!(cwd);
            }
            with(&json!({ "target": target }))
        };
        assert!(!is_valid(&local(Some("/opt/app"))));
        assert!(is_valid(&local(None)));
        assert!(is_valid(&local(Some("apps/api"))));
    }

    #[test]
    fn every_credential_must_be_a_secret_reference() {
        let plaintext = validate_deployment_profile_value(&with(
            &json!({ "credentials": { "DEPLOY_TOKEN": "ghp_abcdef1234567890" } }),
        ));
        assert!(has_path(&plaintext, "credentials.DEPLOY_TOKEN"));
        assert!(!is_valid(&with(
            &json!({ "credentials": { "NOTES": "not actually a secret but still not a reference" } })
        )));
        assert!(is_valid(&with(
            &json!({ "credentials": { "DEPLOY_TOKEN": "${secret:deploy-token}" } })
        )));
        assert!(is_valid(&with(&json!({ "credentials": {} }))));
    }

    #[test]
    fn profile_round_trips_through_the_typescript_json_shape() {
        let value = with(&json!({
            "executor": { "kind": "github-actions", "workflowFile": "deploy.yml", "observeOnly": true },
            "target": { "kind": "iis", "siteName": "Site", "appPoolName": "Pool" },
            "rollback": { "kind": "keep-previous-artifact", "retainCount": 2 },
            "credentials": { "TOKEN": "${secret:token}" }
        }));
        let round_tripped = serde_json::to_value(typed(&value)).expect("serialize");
        assert_eq!(round_tripped, value);
    }
}
