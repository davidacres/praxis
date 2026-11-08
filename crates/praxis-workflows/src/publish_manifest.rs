//! Publish manifests and digest validation (`projects/publishManifest.ts` port).
//!
//! A [`PublishedArtifact`] claims "this exact set of files is what deploys". A manifest
//! makes that claim checkable: every file under the artifact root, content-hashed, folded
//! into one digest that changes if anything is added, removed or modified. A deployment
//! re-validates the files on disk against it rather than rebuilding.
//!
//! The digests are byte-compatible with the TypeScript, so a manifest written by either
//! runtime validates under the other: files are listed in UTF-16 code-unit order (what
//! JavaScript's `sort()` uses), and the overall digest hashes `path\0digest\n` per file.

use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::deployment_profile::{ArtifactLocation, PublishedArtifact, WorkflowEvidenceSourceRef};

pub const PUBLISH_MANIFEST_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishManifestEntry {
    /// POSIX-separated and relative to the artifact root, whichever OS built it.
    pub path: String,
    pub digest: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishManifest {
    pub schema_version: u32,
    /// Combines every file's digest; this is the value `PublishedArtifact::digest` carries.
    pub digest: String,
    pub files: Vec<PublishManifestEntry>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PublishValidationIssueKind {
    Missing,
    Modified,
    Unexpected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishValidationIssue {
    pub path: String,
    pub kind: PublishValidationIssueKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishValidation {
    pub valid: bool,
    pub issues: Vec<PublishValidationIssue>,
}

fn sha256(content: &[u8]) -> String {
    let digest = Sha256::digest(content);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("sha256:{hex}")
}

fn combined_digest(files: &[PublishManifestEntry]) -> String {
    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(format!("{}\0{}\n", file.path, file.digest).as_bytes());
    }
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("sha256:{hex}")
}

async fn is_directory(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|metadata| metadata.is_dir())
}

/// Every regular file under `root_dir`, recursively, as POSIX-relative paths sorted the
/// way JavaScript sorts strings. Symlinks are neither followed nor listed, matching
/// `readdir`'s `isFile()`/`isDirectory()` on a dirent.
pub async fn list_files_recursive(root_dir: &Path) -> Result<Vec<String>, String> {
    let mut results = Vec::new();
    let mut pending: Vec<PathBuf> = vec![root_dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let mut entries = tokio::fs::read_dir(&dir)
            .await
            .map_err(|error| format!("Failed to read directory {}: {error}", dir.display()))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| format!("Failed to read directory {}: {error}", dir.display()))?
        {
            let file_type = entry
                .file_type()
                .await
                .map_err(|error| format!("Failed to stat {}: {error}", entry.path().display()))?;
            let full = entry.path();
            if file_type.is_dir() {
                pending.push(full);
            } else if file_type.is_file() {
                results.push(to_posix_relative(root_dir, &full));
            }
        }
    }
    results.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(results)
}

fn to_posix_relative(root: &Path, full: &Path) -> String {
    full.strip_prefix(root)
        .unwrap_or(full)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Hashes every file under `root_dir`. Fails if it is not a directory: there is no empty
/// manifest for a publish that never happened. `created_at` defaults to now.
pub async fn build_publish_manifest(
    root_dir: &Path,
    created_at: Option<String>,
) -> Result<PublishManifest, String> {
    if !is_directory(root_dir).await {
        return Err(format!("Not a directory: {}", root_dir.display()));
    }
    let mut files = Vec::new();
    for relative_path in list_files_recursive(root_dir).await? {
        let content = tokio::fs::read(root_dir.join(&relative_path))
            .await
            .map_err(|error| format!("Failed to read {relative_path}: {error}"))?;
        files.push(PublishManifestEntry {
            digest: sha256(&content),
            size: content.len() as u64,
            path: relative_path,
        });
    }
    Ok(PublishManifest {
        schema_version: PUBLISH_MANIFEST_SCHEMA_VERSION,
        digest: combined_digest(&files),
        files,
        created_at: created_at.unwrap_or_else(now_iso),
    })
}

/// Re-hashes `root_dir` against `manifest`. A file the manifest expects but that is gone is
/// `missing`, one whose content changed is `modified`, and a file it never recorded is
/// `unexpected`: an artifact is exactly the files its manifest names.
pub async fn validate_published_artifact(
    root_dir: &Path,
    manifest: &PublishManifest,
) -> Result<PublishValidation, String> {
    if !is_directory(root_dir).await {
        let issues = manifest
            .files
            .iter()
            .map(|file| PublishValidationIssue {
                path: file.path.clone(),
                kind: PublishValidationIssueKind::Missing,
            })
            .collect();
        return Ok(PublishValidation {
            valid: false,
            issues,
        });
    }

    let on_disk = list_files_recursive(root_dir).await?;
    let mut issues = Vec::new();
    for expected in &manifest.files {
        if !on_disk.contains(&expected.path) {
            issues.push(PublishValidationIssue {
                path: expected.path.clone(),
                kind: PublishValidationIssueKind::Missing,
            });
            continue;
        }
        let content = tokio::fs::read(root_dir.join(&expected.path))
            .await
            .map_err(|error| format!("Failed to read {}: {error}", expected.path))?;
        if sha256(&content) != expected.digest {
            issues.push(PublishValidationIssue {
                path: expected.path.clone(),
                kind: PublishValidationIssueKind::Modified,
            });
        }
    }
    for relative_path in on_disk {
        if !manifest.files.iter().any(|file| file.path == relative_path) {
            issues.push(PublishValidationIssue {
                path: relative_path,
                kind: PublishValidationIssueKind::Unexpected,
            });
        }
    }

    Ok(PublishValidation {
        valid: issues.is_empty(),
        issues,
    })
}

/// Builds a manifest and folds it into a [`PublishedArtifact`] whose digest is the
/// manifest's. The caller chooses `id` before calling: artifacts are created once.
pub async fn create_published_artifact(
    id: &str,
    deployment_profile_id: &str,
    source_commit: WorkflowEvidenceSourceRef,
    root_dir: &Path,
) -> Result<(PublishedArtifact, PublishManifest), String> {
    let manifest = build_publish_manifest(root_dir, None).await?;
    let artifact = PublishedArtifact {
        id: id.to_string(),
        deployment_profile_id: deployment_profile_id.to_string(),
        source_commit,
        digest: manifest.digest.clone(),
        created_at: manifest.created_at.clone(),
        location: ArtifactLocation::LocalPath {
            path: root_dir.to_string_lossy().into_owned(),
        },
    };
    Ok((artifact, manifest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScratchDir;

    fn write(root: &Path, relative: &str, content: &[u8]) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(path, content).expect("write");
    }

    fn dotnet_publish_dir() -> ScratchDir {
        let dir = ScratchDir::new("publish-dotnet");
        write(dir.path(), "MyApp.dll", b"fake-dll-bytes");
        write(dir.path(), "MyApp.deps.json", br#"{"runtimeTarget":{}}"#);
        write(
            dir.path(),
            "MyApp.runtimeconfig.json",
            br#"{"runtimeOptions":{}}"#,
        );
        write(dir.path(), "runtimes/win-x64/native/lib.dll", b"native");
        dir
    }

    fn web_artifact_dir() -> ScratchDir {
        let dir = ScratchDir::new("publish-web");
        write(dir.path(), "index.html", b"<!doctype html><html></html>");
        write(dir.path(), "assets/app.js", br#"console.log("hi");"#);
        write(dir.path(), "assets/app.css", b"body{margin:0}");
        dir
    }

    fn issue(path: &str, kind: PublishValidationIssueKind) -> PublishValidationIssue {
        PublishValidationIssue {
            path: path.to_string(),
            kind,
        }
    }

    #[tokio::test]
    async fn dotnet_and_web_artifacts_validate() {
        let dotnet = dotnet_publish_dir();
        let manifest = build_publish_manifest(dotnet.path(), None)
            .await
            .expect("manifest");
        assert_eq!(manifest.schema_version, PUBLISH_MANIFEST_SCHEMA_VERSION);
        assert_eq!(manifest.files.len(), 4);
        let result = validate_published_artifact(dotnet.path(), &manifest)
            .await
            .expect("validate");
        assert!(result.valid);
        assert!(result.issues.is_empty());

        let web = web_artifact_dir();
        let manifest = build_publish_manifest(web.path(), None)
            .await
            .expect("manifest");
        assert_eq!(manifest.files.len(), 3);
        assert!(
            validate_published_artifact(web.path(), &manifest)
                .await
                .expect("validate")
                .valid
        );
    }

    /// Digests computed by `packages/core`'s `buildPublishManifest` over the same web
    /// fixture, so a manifest from either runtime validates under the other.
    #[tokio::test]
    async fn digests_match_the_typescript_implementation() {
        let web = web_artifact_dir();
        let manifest = build_publish_manifest(web.path(), None)
            .await
            .expect("manifest");
        let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["assets/app.css", "assets/app.js", "index.html"]);
        assert_eq!(
            manifest.files[2].digest,
            "sha256:ad5141d367c05081f6f668a11f85655d6e5acbdf4bec269c9fe27017f6a89836"
        );
        assert_eq!(
            manifest.digest,
            "sha256:048e5cebc03ea1e287e12af9a14719b58765f7e9ce57da501b321cf1c95b10c6"
        );
    }

    #[tokio::test]
    async fn files_sort_by_utf16_code_units_like_javascript() {
        let dir = ScratchDir::new("publish-sort");
        // U+FF5E sorts after U+1F600 by bytes but before it by UTF-16 code units.
        write(dir.path(), "\u{ff5e}.txt", b"a");
        write(dir.path(), "\u{1f600}.txt", b"b");
        write(dir.path(), "Z.txt", b"c");
        let files = list_files_recursive(dir.path()).await.expect("list");
        assert_eq!(files, ["Z.txt", "\u{1f600}.txt", "\u{ff5e}.txt"]);
    }

    #[tokio::test]
    async fn an_absent_directory_reports_every_file_missing() {
        let web = web_artifact_dir();
        let manifest = build_publish_manifest(web.path(), None)
            .await
            .expect("manifest");
        let root = web.path().to_path_buf();
        drop(web);
        let result = validate_published_artifact(&root, &manifest)
            .await
            .expect("validate");
        assert!(!result.valid);
        assert_eq!(result.issues.len(), 3);
        assert!(
            result
                .issues
                .iter()
                .all(|i| i.kind == PublishValidationIssueKind::Missing)
        );
    }

    #[tokio::test]
    async fn modified_removed_and_added_files_are_each_reported() {
        let web = web_artifact_dir();
        let manifest = build_publish_manifest(web.path(), None)
            .await
            .expect("manifest");

        write(
            web.path(),
            "index.html",
            b"<!doctype html><html>tampered</html>",
        );
        let result = validate_published_artifact(web.path(), &manifest)
            .await
            .expect("validate");
        assert_eq!(
            result.issues,
            [issue("index.html", PublishValidationIssueKind::Modified)]
        );

        let web = web_artifact_dir();
        let manifest = build_publish_manifest(web.path(), None)
            .await
            .expect("manifest");
        std::fs::remove_file(web.path().join("assets/app.js")).expect("remove");
        let result = validate_published_artifact(web.path(), &manifest)
            .await
            .expect("validate");
        assert_eq!(
            result.issues,
            [issue("assets/app.js", PublishValidationIssueKind::Missing)]
        );

        let web = web_artifact_dir();
        let manifest = build_publish_manifest(web.path(), None)
            .await
            .expect("manifest");
        write(web.path(), "assets/sneaky.js", br#"eval("...")"#);
        let result = validate_published_artifact(web.path(), &manifest)
            .await
            .expect("validate");
        assert_eq!(
            result.issues,
            [issue(
                "assets/sneaky.js",
                PublishValidationIssueKind::Unexpected
            )]
        );
    }

    #[tokio::test]
    async fn digest_is_content_based_and_changes_with_any_file() {
        let first = web_artifact_dir();
        let second = web_artifact_dir();
        let from_first = build_publish_manifest(first.path(), None)
            .await
            .expect("manifest");
        assert!(
            validate_published_artifact(second.path(), &from_first)
                .await
                .expect("validate")
                .valid
        );

        let rebuilt = build_publish_manifest(first.path(), None)
            .await
            .expect("manifest");
        assert_eq!(from_first.digest, rebuilt.digest);
        write(
            first.path(),
            "index.html",
            b"<!doctype html><html>changed</html>",
        );
        let changed = build_publish_manifest(first.path(), None)
            .await
            .expect("manifest");
        assert_ne!(from_first.digest, changed.digest);

        let dotnet = dotnet_publish_dir();
        let dotnet_manifest = build_publish_manifest(dotnet.path(), None)
            .await
            .expect("manifest");
        assert_ne!(dotnet_manifest.digest, from_first.digest);
    }

    #[tokio::test]
    async fn a_path_that_is_not_a_directory_is_rejected() {
        let dir = ScratchDir::new("publish-file");
        write(dir.path(), "not-a-dir.txt", b"hello");
        let error = build_publish_manifest(&dir.path().join("not-a-dir.txt"), None)
            .await
            .expect_err("a file is not an artifact root");
        assert!(error.contains("Not a directory"));
    }

    #[tokio::test]
    async fn create_published_artifact_carries_the_manifest_digest() {
        let dotnet = dotnet_publish_dir();
        let (artifact, manifest) = create_published_artifact(
            "artifact-1",
            "production",
            WorkflowEvidenceSourceRef::Commit {
                sha: "abc123".to_string(),
            },
            dotnet.path(),
        )
        .await
        .expect("artifact");
        assert_eq!(artifact.digest, manifest.digest);
        assert_eq!(artifact.deployment_profile_id, "production");
        assert_eq!(
            artifact.location,
            ArtifactLocation::LocalPath {
                path: dotnet.path().to_string_lossy().into_owned()
            }
        );
        assert_eq!(
            serde_json::to_value(&artifact.source_commit).expect("json"),
            serde_json::json!({ "kind": "commit", "sha": "abc123" })
        );
    }
}
