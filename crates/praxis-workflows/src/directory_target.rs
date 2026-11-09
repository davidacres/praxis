//! The `directory` deployment target (`deployments/directoryTarget.ts` port): a persistent
//! local web root updated in place from one immutable artifact.
//!
//! Every file the artifact's manifest names is application content, replaced wholesale on
//! each deploy. Anything under a configured exclude path is mutable data (uploads, a local
//! config override, a database file) and is never read, copied over or deleted. There is
//! no third category and no guessing.
//!
//! The flow: stage the new artifact first, so a read failure never touches the live
//! target; back up the target's current non-excluded content; remove it; copy the staged
//! files in. A failed post-install health check restores the backup this deploy just took.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::network_probe::{DEFAULT_CONNECT_TIMEOUT, check_http_ok, check_tcp_open};
use crate::publish_manifest::{PublishManifest, list_files_recursive, validate_published_artifact};
use crate::run_profile::RunReadinessProbe;

/// A filesystem-safe path segment (`workflows/workflowEvidence.ts`'s `isSafeSegment`):
/// `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`, and never `.` or `..`.
#[must_use]
pub fn is_safe_segment(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value != "."
        && value != ".."
        && value.len() <= 128
        && first.is_ascii_alphanumeric()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A relative, POSIX-separated path under the target: no leading `/`, no `..`, every
/// segment filesystem-safe.
#[must_use]
pub fn is_valid_exclude_path(value: &str) -> bool {
    !value.is_empty()
        && !Path::new(value).is_absolute()
        && !value.starts_with('/')
        && value
            .split('/')
            .all(|segment| segment != ".." && is_safe_segment(segment))
}

fn is_excluded(relative_path: &str, exclude_paths: &[String]) -> bool {
    exclude_paths.iter().any(|exclude| {
        relative_path == exclude
            || relative_path
                .strip_prefix(exclude.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

fn join_relative(root: &Path, relative_path: &str) -> PathBuf {
    relative_path
        .split('/')
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

async fn copy_relative(
    from_root: &Path,
    to_root: &Path,
    relative_path: &str,
) -> Result<(), String> {
    let from = join_relative(from_root, relative_path);
    let to = join_relative(to_root, relative_path);
    if let Some(parent) = to.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    tokio::fs::copy(&from, &to)
        .await
        .map(|_| ())
        .map_err(|error| format!("Failed to copy {relative_path}: {error}"))
}

async fn is_directory(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|metadata| metadata.is_dir())
}

/// Copies every non-excluded file under `target_dir` into `backup_dir`. Nothing to back up
/// on a first deploy.
async fn backup_application_content(
    target_dir: &Path,
    exclude_paths: &[String],
    backup_dir: &Path,
) -> Result<(), String> {
    if !is_directory(target_dir).await {
        return Ok(());
    }
    for relative_path in list_files_recursive(target_dir).await? {
        if !is_excluded(&relative_path, exclude_paths) {
            copy_relative(target_dir, backup_dir, &relative_path).await?;
        }
    }
    Ok(())
}

/// Deletes every non-excluded file under `target_dir`; excluded files, and directories that
/// hold only excluded files, stay.
async fn remove_application_content(
    target_dir: &Path,
    exclude_paths: &[String],
) -> Result<(), String> {
    if !is_directory(target_dir).await {
        return Ok(());
    }
    for relative_path in list_files_recursive(target_dir).await? {
        if is_excluded(&relative_path, exclude_paths) {
            continue;
        }
        match tokio::fs::remove_file(join_relative(target_dir, &relative_path)).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to remove {relative_path}: {error}")),
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct DirectoryDeploymentInput {
    /// The resolved target directory.
    pub target_dir: PathBuf,
    /// Where the immutable artifact lives; re-validated before the target is touched.
    pub artifact_root_dir: PathBuf,
    pub manifest: PublishManifest,
    /// Relative paths under the target that are mutable user data.
    pub exclude_paths: Vec<String>,
    /// A fresh directory per deploy for the replaced content.
    pub backup_dir: PathBuf,
    /// Scratch directory the artifact is staged into first.
    pub staging_dir: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryDeploymentResult {
    pub applied: bool,
    pub files_written: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Absent when no health check was configured or the deploy never applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub healthy: Option<bool>,
    /// Set once a failed health check's automatic restore has run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored: Option<bool>,
}

fn refused(error: String) -> DirectoryDeploymentResult {
    DirectoryDeploymentResult {
        error: Some(error),
        ..DirectoryDeploymentResult::default()
    }
}

/// Updates the target in place from the manifest's artifact, keeping excluded paths
/// untouched and backing up replaced content first. Refuses, without touching the target,
/// an unsafe exclude path or an artifact that no longer matches its manifest.
pub async fn apply_directory_deployment(
    input: &DirectoryDeploymentInput,
) -> Result<DirectoryDeploymentResult, String> {
    if let Some(bad) = input
        .exclude_paths
        .iter()
        .find(|value| !is_valid_exclude_path(value))
    {
        return Ok(refused(format!("Not a safe exclude path: \"{bad}\".")));
    }

    let check = validate_published_artifact(&input.artifact_root_dir, &input.manifest).await?;
    if !check.valid {
        let issues: Vec<String> = check
            .issues
            .iter()
            .map(|issue| {
                let kind = serde_json::to_value(issue.kind)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_string))
                    .unwrap_or_default();
                format!("{kind} {}", issue.path)
            })
            .collect();
        return Ok(refused(format!(
            "Artifact no longer matches its manifest: {}.",
            issues.join(", ")
        )));
    }

    // Stage first, so a source-side problem never leaves the target half-replaced.
    for file in &input.manifest.files {
        copy_relative(&input.artifact_root_dir, &input.staging_dir, &file.path).await?;
    }

    tokio::fs::create_dir_all(&input.target_dir)
        .await
        .map_err(|error| format!("Failed to create {}: {error}", input.target_dir.display()))?;
    backup_application_content(&input.target_dir, &input.exclude_paths, &input.backup_dir).await?;
    remove_application_content(&input.target_dir, &input.exclude_paths).await?;

    let mut files_written = Vec::new();
    for file in &input.manifest.files {
        copy_relative(&input.staging_dir, &input.target_dir, &file.path).await?;
        files_written.push(file.path.clone());
    }

    Ok(DirectoryDeploymentResult {
        applied: true,
        files_written,
        ..DirectoryDeploymentResult::default()
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryRestoreResult {
    pub restored: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Restores the target's application content from a backup, leaving excluded paths alone.
pub async fn restore_directory_backup(
    target_dir: &Path,
    backup_dir: &Path,
    exclude_paths: &[String],
) -> Result<DirectoryRestoreResult, String> {
    if !is_directory(backup_dir).await {
        return Ok(DirectoryRestoreResult {
            restored: false,
            error: Some(format!(
                "Backup directory not found: {}",
                backup_dir.display()
            )),
        });
    }
    remove_application_content(target_dir, exclude_paths).await?;
    for relative_path in list_files_recursive(backup_dir).await? {
        copy_relative(backup_dir, target_dir, &relative_path).await?;
    }
    Ok(DirectoryRestoreResult {
        restored: true,
        error: None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryHealthCheckResult {
    pub healthy: bool,
    pub detail: String,
}

/// Runs a post-install health check against `host:port`. A log-line probe is refused: a
/// directory has no process whose output Praxis reads, and an unsupported check must
/// never pass.
pub async fn verify_directory_health(
    probe: &RunReadinessProbe,
    host: &str,
    port: u16,
) -> DirectoryHealthCheckResult {
    let healthy = match probe {
        RunReadinessProbe::LogLine { .. } => {
            return DirectoryHealthCheckResult {
                healthy: false,
                detail: "A log-line health check is not supported for a directory target — nothing serving it has a log stream Praxis controls.".to_string(),
            };
        }
        RunReadinessProbe::Tcp { .. } => check_tcp_open(host, port, DEFAULT_CONNECT_TIMEOUT).await,
        RunReadinessProbe::Http {
            path,
            expected_status,
        } => check_http_ok(host, port, path, *expected_status, DEFAULT_CONNECT_TIMEOUT).await,
    };
    DirectoryHealthCheckResult {
        healthy,
        detail: if healthy {
            "Health check passed."
        } else {
            "Health check failed."
        }
        .to_string(),
    }
}

#[derive(Debug, Clone)]
pub struct DirectoryHealthCheck {
    pub probe: RunReadinessProbe,
    /// Defaults to `127.0.0.1`.
    pub host: Option<String>,
    /// Defaults to 80.
    pub port: Option<u16>,
}

/// [`apply_directory_deployment`] plus, when a health check is configured, an automatic
/// restore of this deploy's backup if the check fails, so a caller cannot apply without a
/// restore path. No health check leaves the deploy applied and unverified.
pub async fn deploy_directory_with_health_check(
    input: &DirectoryDeploymentInput,
    health_check: Option<&DirectoryHealthCheck>,
) -> Result<DirectoryDeploymentResult, String> {
    let applied = apply_directory_deployment(input).await?;
    let Some(check) = health_check.filter(|_| applied.applied) else {
        return Ok(applied);
    };

    let host = check.host.as_deref().unwrap_or("127.0.0.1");
    let health = verify_directory_health(&check.probe, host, check.port.unwrap_or(80)).await;
    if health.healthy {
        return Ok(DirectoryDeploymentResult {
            healthy: Some(true),
            ..applied
        });
    }

    let restore =
        restore_directory_backup(&input.target_dir, &input.backup_dir, &input.exclude_paths)
            .await?;
    let error = if restore.restored {
        format!("{} Restored the previous version.", health.detail)
    } else {
        format!(
            "{} Restore also failed: {}",
            health.detail,
            restore.error.unwrap_or_default()
        )
    };
    Ok(DirectoryDeploymentResult {
        healthy: Some(false),
        restored: Some(restore.restored),
        error: Some(error),
        ..applied
    })
}

/// Every file under `dir`, POSIX-relative. Empty when `dir` does not exist.
pub async fn list_directory_contents(dir: &Path) -> Result<Vec<String>, String> {
    if !is_directory(dir).await {
        return Ok(Vec::new());
    }
    list_files_recursive(dir).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publish_manifest::build_publish_manifest;
    use crate::test_support::ScratchDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct Rig {
        target: ScratchDir,
        artifact: ScratchDir,
        backups: ScratchDir,
        staging: ScratchDir,
    }

    impl Rig {
        fn new() -> Self {
            Self {
                target: ScratchDir::new("dir-target"),
                artifact: ScratchDir::new("dir-artifact"),
                backups: ScratchDir::new("dir-backups"),
                staging: ScratchDir::new("dir-staging"),
            }
        }

        fn input(
            &self,
            manifest: PublishManifest,
            exclude_paths: &[&str],
        ) -> DirectoryDeploymentInput {
            DirectoryDeploymentInput {
                target_dir: self.target.path().to_path_buf(),
                artifact_root_dir: self.artifact.path().to_path_buf(),
                manifest,
                exclude_paths: exclude_paths.iter().map(|p| (*p).to_string()).collect(),
                backup_dir: self.backups.path().join("b1"),
                staging_dir: self.staging.path().to_path_buf(),
            }
        }

        fn target_file(&self, relative: &str) -> String {
            std::fs::read_to_string(self.target.path().join(relative)).expect("read target file")
        }
    }

    fn write(root: &Path, relative: &str, content: &str) {
        let path = join_relative(root, relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(path, content).expect("write");
    }

    async fn artifact(root: &Path, files: &[(&str, &str)]) -> PublishManifest {
        for (relative, content) in files {
            write(root, relative, content);
        }
        build_publish_manifest(root, None).await.expect("manifest")
    }

    async fn serve_status(status: u16) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0u8; 512];
                let _ = socket.read(&mut buffer).await;
                let _ = socket
                    .write_all(
                        format!("HTTP/1.1 {status} OK\r\nContent-Length: 0\r\n\r\n").as_bytes(),
                    )
                    .await;
            }
        });
        port
    }

    /// A port no test can listen on: binding below 1024 needs root, so connections are
    /// refused. Binding port 0 and releasing it races with parallel tests reusing it.
    async fn unused_port() -> u16 {
        1
    }

    #[tokio::test]
    async fn a_web_root_updates_from_one_immutable_artifact() {
        let rig = Rig::new();
        let manifest = artifact(
            rig.artifact.path(),
            &[
                ("index.html", "<h1>v1</h1>"),
                ("assets/app.js", "console.log(1)"),
            ],
        )
        .await;
        let result = apply_directory_deployment(&rig.input(manifest, &[]))
            .await
            .expect("deploy");
        assert!(result.applied);
        let mut written = result.files_written.clone();
        written.sort();
        assert_eq!(written, ["assets/app.js", "index.html"]);
        assert_eq!(rig.target_file("index.html"), "<h1>v1</h1>");
        assert_eq!(rig.target_file("assets/app.js"), "console.log(1)");
    }

    #[tokio::test]
    async fn a_second_deploy_removes_files_the_new_artifact_no_longer_names() {
        let rig = Rig::new();
        let v1 = artifact(
            rig.artifact.path(),
            &[("index.html", "v1"), ("old.html", "stale")],
        )
        .await;
        apply_directory_deployment(&rig.input(v1, &[]))
            .await
            .expect("deploy v1");

        let artifact2 = ScratchDir::new("dir-artifact2");
        let v2 = artifact(artifact2.path(), &[("index.html", "v2")]).await;
        let input = DirectoryDeploymentInput {
            artifact_root_dir: artifact2.path().to_path_buf(),
            backup_dir: rig.backups.path().join("b2"),
            ..rig.input(v2, &[])
        };
        let result = apply_directory_deployment(&input).await.expect("deploy v2");
        assert!(result.applied);
        assert_eq!(rig.target_file("index.html"), "v2");
        assert_eq!(
            list_directory_contents(rig.target.path())
                .await
                .expect("list"),
            ["index.html"]
        );
    }

    #[tokio::test]
    async fn excluded_user_data_survives_and_is_never_reported_written() {
        let rig = Rig::new();
        write(rig.target.path(), "uploads/photo.jpg", "binary-ish-content");
        write(rig.target.path(), "old.html", "stale");
        let manifest = artifact(rig.artifact.path(), &[("index.html", "v1")]).await;
        let result = apply_directory_deployment(&rig.input(manifest, &["uploads"]))
            .await
            .expect("deploy");
        assert!(result.applied);
        assert!(
            !result
                .files_written
                .iter()
                .any(|f| f == "uploads/photo.jpg")
        );
        assert_eq!(rig.target_file("uploads/photo.jpg"), "binary-ish-content");
        assert_eq!(
            list_directory_contents(rig.target.path())
                .await
                .expect("list"),
            ["index.html", "uploads/photo.jpg"]
        );
    }

    #[tokio::test]
    async fn a_nested_exclude_path_is_honored() {
        let rig = Rig::new();
        write(rig.target.path(), "data/db.sqlite", "db-bytes");
        let manifest = artifact(rig.artifact.path(), &[("index.html", "v1")]).await;
        apply_directory_deployment(&rig.input(manifest, &["data/db.sqlite"]))
            .await
            .expect("deploy");
        assert_eq!(rig.target_file("data/db.sqlite"), "db-bytes");
    }

    #[test]
    fn exclude_paths_reject_traversal_absolute_and_unsafe_values() {
        assert!(is_valid_exclude_path("uploads"));
        assert!(is_valid_exclude_path("data/db.sqlite"));
        assert!(!is_valid_exclude_path("../etc"));
        assert!(!is_valid_exclude_path("/etc/passwd"));
        assert!(!is_valid_exclude_path("uploads/../../etc"));
        assert!(!is_valid_exclude_path(""));
        assert!(!is_valid_exclude_path("uploads; rm -rf /"));
        assert!(!is_excluded("uploadsX/a", &["uploads".to_string()]));
    }

    #[tokio::test]
    async fn an_unsafe_exclude_or_a_tampered_artifact_refuses_before_touching_the_target() {
        let rig = Rig::new();
        write(rig.target.path(), "existing.html", "untouched");
        let manifest = artifact(rig.artifact.path(), &[("index.html", "v1")]).await;

        let result = apply_directory_deployment(&rig.input(manifest.clone(), &["../escape"]))
            .await
            .expect("deploy");
        assert!(!result.applied);
        assert!(
            result
                .error
                .unwrap_or_default()
                .contains("safe exclude path")
        );
        assert_eq!(rig.target_file("existing.html"), "untouched");

        write(rig.artifact.path(), "index.html", "tampered");
        let result = apply_directory_deployment(&rig.input(manifest, &[]))
            .await
            .expect("deploy");
        assert!(!result.applied);
        assert!(
            result
                .error
                .unwrap_or_default()
                .contains("no longer matches its manifest")
        );
        assert_eq!(rig.target_file("existing.html"), "untouched");
    }

    #[tokio::test]
    async fn backup_captures_replaced_content_and_restore_puts_it_back() {
        let rig = Rig::new();
        write(rig.target.path(), "uploads/keep.txt", "keep-me");
        write(rig.target.path(), "index.html", "v1");
        let manifest = artifact(rig.artifact.path(), &[("index.html", "v2")]).await;
        let input = rig.input(manifest, &["uploads"]);
        apply_directory_deployment(&input).await.expect("deploy");

        assert_eq!(
            list_directory_contents(&input.backup_dir)
                .await
                .expect("list"),
            ["index.html"]
        );
        assert_eq!(rig.target_file("index.html"), "v2");

        let restore =
            restore_directory_backup(&input.target_dir, &input.backup_dir, &input.exclude_paths)
                .await
                .expect("restore");
        assert!(restore.restored);
        assert_eq!(rig.target_file("index.html"), "v1");
        assert_eq!(rig.target_file("uploads/keep.txt"), "keep-me");

        let missing = restore_directory_backup(
            &input.target_dir,
            &rig.backups.path().join("no-such-backup"),
            &[],
        )
        .await
        .expect("restore");
        assert!(!missing.restored);
        assert!(missing.error.unwrap_or_default().contains("not found"));
    }

    #[tokio::test]
    async fn health_checks_refuse_log_lines_and_report_http_and_tcp() {
        let log_line = verify_directory_health(
            &RunReadinessProbe::LogLine {
                match_text: "ready".to_string(),
            },
            "127.0.0.1",
            80,
        )
        .await;
        assert!(!log_line.healthy);
        assert!(log_line.detail.contains("not supported"));

        let port = serve_status(200).await;
        let http = RunReadinessProbe::Http {
            path: "/healthz".to_string(),
            expected_status: None,
        };
        assert!(
            verify_directory_health(&http, "127.0.0.1", port)
                .await
                .healthy
        );

        let port = unused_port().await;
        let tcp = RunReadinessProbe::Tcp {
            port: u32::from(port),
        };
        assert!(
            !verify_directory_health(&tcp, "127.0.0.1", port)
                .await
                .healthy
        );
    }

    #[tokio::test]
    async fn a_failed_health_check_restores_the_previous_version() {
        let rig = Rig::new();
        write(rig.target.path(), "index.html", "v1");
        let manifest = artifact(rig.artifact.path(), &[("index.html", "v2-bad")]).await;
        let port = unused_port().await;
        let check = DirectoryHealthCheck {
            probe: RunReadinessProbe::Tcp {
                port: u32::from(port),
            },
            host: None,
            port: Some(port),
        };
        let outcome = deploy_directory_with_health_check(&rig.input(manifest, &[]), Some(&check))
            .await
            .expect("deploy");
        assert!(outcome.applied);
        assert_eq!(outcome.healthy, Some(false));
        assert_eq!(outcome.restored, Some(true));
        assert_eq!(rig.target_file("index.html"), "v1");
    }

    #[tokio::test]
    async fn a_passing_or_absent_health_check_leaves_the_new_version() {
        let rig = Rig::new();
        write(rig.target.path(), "index.html", "v1");
        let manifest = artifact(rig.artifact.path(), &[("index.html", "v2-good")]).await;
        let port = serve_status(200).await;
        let check = DirectoryHealthCheck {
            probe: RunReadinessProbe::Http {
                path: "/healthz".to_string(),
                expected_status: None,
            },
            host: None,
            port: Some(port),
        };
        let outcome =
            deploy_directory_with_health_check(&rig.input(manifest.clone(), &[]), Some(&check))
                .await
                .expect("deploy");
        assert_eq!(outcome.healthy, Some(true));
        assert_eq!(outcome.restored, None);
        assert_eq!(rig.target_file("index.html"), "v2-good");

        let unverified = deploy_directory_with_health_check(&rig.input(manifest, &[]), None)
            .await
            .expect("deploy");
        assert!(unverified.applied);
        assert_eq!(unverified.healthy, None);
        assert_eq!(unverified.restored, None);
    }
}
