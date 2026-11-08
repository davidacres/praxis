//! The complete direct delivery journey through the public API
//! (`deployments/directDeliveryJourney.test.ts` port): build, publish, review, deploy, a
//! failed health check, an explicit rollback, and the previous version back in place.

#![cfg(unix)]

use std::cell::Cell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use praxis_workflows::deployment_profile::{
    DeploymentProfile, DeploymentRollbackKind, DeploymentRollbackPolicy, ExecutorRef, TargetRef,
    WorkflowEvidenceSourceRef, preflight_deployment_capabilities, validate_deployment_profile,
};
use praxis_workflows::deployment_profile_store::{
    all_credentials_bound, evaluate_credential_bindings,
};
use praxis_workflows::deployment_run_state::{DeploymentRunStatus, DeploymentTargetLockRegistry};
use praxis_workflows::deployment_run_store::{DeploymentRunBackend, DeploymentRunStore};
use praxis_workflows::direct_deployment_orchestrator::{
    DeploymentLinks, DirectDeploymentOptions, approve_direct_deployment, deployment_health_result,
    prepare_direct_deployment, rollback_direct_deployment, run_direct_deployment,
};
use praxis_workflows::publish_manifest::create_published_artifact;
use praxis_workflows::run_profile::RunReadinessProbe;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "praxis-journey-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).expect("mkdir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct Memory(Option<Value>);

impl DeploymentRunBackend for Memory {
    fn read(&self) -> Option<Value> {
        self.0.clone()
    }
    fn write(&mut self, value: Value) -> Result<(), String> {
        self.0 = Some(value);
        Ok(())
    }
}

async fn serve_ok() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buffer = [0u8; 512];
            let _ = socket.read(&mut buffer).await;
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .await;
        }
    });
    port
}

async fn unused_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    listener.local_addr().expect("addr").port()
}

fn read(dir: &Path, relative: &str) -> String {
    std::fs::read_to_string(dir.join(relative)).expect("read")
}

#[tokio::test]
async fn build_publish_review_deploy_fail_rollback() {
    let store = Mutex::new(DeploymentRunStore::new(Memory::default()));
    let locks = Mutex::new(DeploymentTargetLockRegistry::new());
    let tick = Cell::new(0u32);
    let now = || {
        tick.set(tick.get() + 1);
        format!(
            "2026-09-09T00:{:02}:{:02}.000Z",
            tick.get() / 60,
            tick.get() % 60
        )
    };
    let (target, build, backups, staging1, staging2) = (
        Scratch::new("target"),
        Scratch::new("build"),
        Scratch::new("backups"),
        Scratch::new("staging1"),
        Scratch::new("staging2"),
    );

    // 1. Build: files landing in a directory.
    std::fs::write(
        build.path().join("index.html"),
        "<h1>release candidate</h1>",
    )
    .expect("write");
    std::fs::create_dir_all(build.path().join("assets")).expect("mkdir");
    std::fs::write(build.path().join("assets/app.js"), "console.log(\"v1\");").expect("write");

    // 2. Publish.
    let (artifact, manifest) = create_published_artifact(
        "artifact-journey-1",
        "profile-staging",
        WorkflowEvidenceSourceRef::Commit {
            sha: "abc123".to_string(),
        },
        build.path(),
    )
    .await
    .expect("publish");
    assert!(artifact.digest.starts_with("sha256:"));
    assert_eq!(manifest.files.len(), 2);

    // 3. Review: a valid, runnable profile whose credential is not bound on this machine.
    let profile = DeploymentProfile {
        schema_version: 1,
        id: "profile-staging".to_string(),
        version: 1,
        name: "Staging web root".to_string(),
        project_id: "project-1".to_string(),
        environment: "staging".to_string(),
        executor: ExecutorRef::DirectProcess,
        // Repo-relative, resolved against the project folder at deploy and rollback time.
        target: TargetRef::Directory {
            path: ".".to_string(),
        },
        health_check: Some(RunReadinessProbe::Http {
            path: "/healthz".to_string(),
            expected_status: None,
        }),
        rollback: DeploymentRollbackPolicy {
            kind: DeploymentRollbackKind::KeepPreviousArtifact,
            retain_count: Some(1),
        },
        credentials: Some(BTreeMap::from([(
            "DEPLOY_TOKEN".to_string(),
            "${secret:DEPLOY_TOKEN}".to_string(),
        )])),
        created_at: now(),
        updated_at: now(),
    };
    assert!(validate_deployment_profile(&profile).is_empty());
    assert!(preflight_deployment_capabilities(&profile).is_empty());
    let credentials = evaluate_credential_bindings(&profile, |_| None);
    assert!(!all_credentials_bound(&credentials));
    assert!(
        !credentials[0].bound,
        "a missing credential is surfaced, not hidden"
    );

    // 4. Prepare and approve.
    let links = || DeploymentLinks {
        issue_key: Some("PROJ-42".to_string()),
        ..DeploymentLinks::default()
    };
    prepare_direct_deployment(&store, "run-1", &profile, &artifact, links(), &now)
        .expect("prepare");
    let approved = approve_direct_deployment(
        &store,
        "run-1",
        &profile,
        &artifact,
        "release-manager",
        &now,
    )
    .expect("approve");
    assert!(approved.ok);

    // 5. Deploy v1 with a passing health check: the version a later rollback restores.
    let port = serve_ok().await;
    let first = run_direct_deployment(
        &store,
        &locks,
        "run-1",
        &profile,
        &artifact,
        &manifest,
        &DirectDeploymentOptions {
            project_folder: target.path().to_path_buf(),
            backup_dir: Some(backups.path().join("b1")),
            staging_dir: Some(staging1.path().to_path_buf()),
            health_check_port: Some(port),
            ..DirectDeploymentOptions::default()
        },
        &now,
    )
    .await
    .expect("deploy v1");
    assert_eq!(first.run.status, DeploymentRunStatus::Succeeded);
    assert_eq!(
        read(target.path(), "index.html"),
        "<h1>release candidate</h1>"
    );
    assert_eq!(deployment_health_result(&first.run).healthy, Some(true));

    // 6. Publish and deploy a bad v2 whose health check reaches nothing.
    let build2 = Scratch::new("build2");
    std::fs::write(build2.path().join("index.html"), "<h1>bad release</h1>").expect("write");
    let (artifact2, manifest2) = create_published_artifact(
        "artifact-journey-2",
        "profile-staging",
        WorkflowEvidenceSourceRef::Commit {
            sha: "def456".to_string(),
        },
        build2.path(),
    )
    .await
    .expect("publish v2");
    assert_ne!(artifact2.digest, artifact.digest);

    prepare_direct_deployment(&store, "run-2", &profile, &artifact2, links(), &now)
        .expect("prepare");
    approve_direct_deployment(
        &store,
        "run-2",
        &profile,
        &artifact2,
        "release-manager",
        &now,
    )
    .expect("approve");
    let backup2 = backups.path().join("b2");
    let second = run_direct_deployment(
        &store,
        &locks,
        "run-2",
        &profile,
        &artifact2,
        &manifest2,
        &DirectDeploymentOptions {
            project_folder: target.path().to_path_buf(),
            backup_dir: Some(backup2.clone()),
            staging_dir: Some(staging2.path().to_path_buf()),
            health_check_port: Some(unused_port().await),
            ..DirectDeploymentOptions::default()
        },
        &now,
    )
    .await
    .expect("deploy v2");
    assert!(second.dispatched);
    assert_eq!(second.run.status, DeploymentRunStatus::Failed);
    assert_eq!(
        read(target.path(), "index.html"),
        "<h1>bad release</h1>",
        "no auto-restore before an explicit rollback"
    );
    assert_eq!(deployment_health_result(&second.run).healthy, Some(false));

    // 7. Explicit rollback restores v1 from the backup run-2's deploy took.
    let rollback = rollback_direct_deployment(
        &store,
        "run-2",
        &profile,
        target.path(),
        Some(&backup2),
        &[],
        &now,
    )
    .await
    .expect("rollback");
    assert!(rollback.rolled_back);
    assert_eq!(rollback.run.status, DeploymentRunStatus::RolledBack);
    assert_eq!(
        read(target.path(), "index.html"),
        "<h1>release candidate</h1>"
    );

    assert_eq!(first.run.artifact_digest, artifact.digest);
    assert_eq!(second.run.artifact_digest, artifact2.digest);
    assert_eq!(first.run.issue_key.as_deref(), Some("PROJ-42"));
}
