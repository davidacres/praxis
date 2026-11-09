//! Opt-in Direct Deployment actions bridge (FX-BE-059 / TASK-158):
//! prepare, approve, deploy, health results, and rollback.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use praxis_contracts::RustRpcError;
use praxis_workflows::deployment_profile::{DeploymentProfile, PublishedArtifact};
use praxis_workflows::deployment_run_state::DeploymentTargetLockRegistry;
use praxis_workflows::deployment_run_store::{DeploymentRunBackend, DeploymentRunStore, RUNS_KEY};
use praxis_workflows::direct_deployment_orchestrator::{
    DeploymentLinks, DirectDeploymentOptions, approve_direct_deployment, deployment_health_result,
    prepare_direct_deployment, rollback_direct_deployment, run_direct_deployment,
};
use praxis_workflows::publish_manifest::PublishManifest;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::runtime::Handle;

use crate::HostContext;

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn failure(message: impl std::fmt::Display) -> RustRpcError {
    RustRpcError {
        code: "DEPLOYMENT_ERROR".into(),
        message: message.to_string(),
    }
}

pub struct JsonFileDeploymentRunBackend {
    path: PathBuf,
}

impl JsonFileDeploymentRunBackend {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl DeploymentRunBackend for JsonFileDeploymentRunBackend {
    fn read(&self) -> Option<Value> {
        let text = std::fs::read_to_string(&self.path).ok()?;
        let obj: Value = serde_json::from_str(&text).ok()?;
        obj.get(RUNS_KEY).cloned()
    }

    fn write(&mut self, value: Value) -> Result<(), String> {
        let mut obj = match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({})),
            Err(_) => json!({}),
        };
        if !obj.is_object() {
            obj = json!({});
        }
        obj[RUNS_KEY] = value;
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let temp_path = format!("{}.{}.tmp", self.path.display(), std::process::id());
        let text = serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?;
        std::fs::write(&temp_path, text).map_err(|e| e.to_string())?;
        std::fs::rename(&temp_path, &self.path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareDeploymentContextInput {
    issue_key: Option<String>,
    issue_connection_id: Option<String>,
    workflow_run_id: Option<String>,
    target_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectDeployOptionsInput {
    exclude_paths: Option<Vec<String>>,
    backup_dir: Option<String>,
    staging_dir: Option<String>,
    process_inputs: Option<BTreeMap<String, String>>,
    timeout_ms: Option<u64>,
    health_check_host: Option<String>,
    health_check_port: Option<u16>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectRollbackOptionsInput {
    backup_dir: Option<String>,
    exclude_paths: Option<Vec<String>>,
}

pub fn register_deployment_channels(host: &HostContext, runtime: &Handle) {
    let runs_path = host.config().user_data_dir.join("deploymentRuns.json");
    let store = Arc::new(Mutex::new(DeploymentRunStore::new(
        JsonFileDeploymentRunBackend::new(runs_path),
    )));
    let locks = Arc::new(Mutex::new(DeploymentTargetLockRegistry::new()));

    // deployments:prepare
    {
        let store = Arc::clone(&store);
        host.register_handler("deployments:prepare", move |_, args| {
            let run_id = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Missing runId"))?;
            let profile: DeploymentProfile = serde_json::from_value(
                args.get(2)
                    .cloned()
                    .ok_or_else(|| failure("Missing profile"))?,
            )
            .map_err(failure)?;
            let artifact: PublishedArtifact = serde_json::from_value(
                args.get(3)
                    .cloned()
                    .ok_or_else(|| failure("Missing artifact"))?,
            )
            .map_err(failure)?;
            let ctx: PrepareDeploymentContextInput = args
                .get(4)
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let links = DeploymentLinks {
                issue_key: ctx.issue_key,
                issue_connection_id: ctx.issue_connection_id,
                workflow_run_id: ctx.workflow_run_id,
                target_url: ctx.target_url,
            };
            let run =
                prepare_direct_deployment(&store, run_id, &profile, &artifact, links, &now_iso)
                    .map_err(failure)?;
            serde_json::to_value(run).map_err(failure)
        });
    }

    // deployments:approve
    {
        let store = Arc::clone(&store);
        host.register_handler("deployments:approve", move |_, args| {
            let run_id = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Missing runId"))?;
            let profile: DeploymentProfile = serde_json::from_value(
                args.get(2)
                    .cloned()
                    .ok_or_else(|| failure("Missing profile"))?,
            )
            .map_err(failure)?;
            let artifact: PublishedArtifact = serde_json::from_value(
                args.get(3)
                    .cloned()
                    .ok_or_else(|| failure("Missing artifact"))?,
            )
            .map_err(failure)?;
            let actor = args
                .get(4)
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Missing actor"))?;
            let result =
                approve_direct_deployment(&store, run_id, &profile, &artifact, actor, &now_iso)
                    .map_err(failure)?;
            serde_json::to_value(result).map_err(failure)
        });
    }

    // deployments:deploy
    {
        let store = Arc::clone(&store);
        let locks = Arc::clone(&locks);
        let handle = runtime.clone();
        host.register_handler("deployments:deploy", move |_, args| {
            let project_folder = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Missing projectFolder"))?;
            let run_id = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Missing runId"))?;
            let profile: DeploymentProfile = serde_json::from_value(
                args.get(2)
                    .cloned()
                    .ok_or_else(|| failure("Missing profile"))?,
            )
            .map_err(failure)?;
            let artifact: PublishedArtifact = serde_json::from_value(
                args.get(3)
                    .cloned()
                    .ok_or_else(|| failure("Missing artifact"))?,
            )
            .map_err(failure)?;
            let manifest: PublishManifest = serde_json::from_value(
                args.get(4)
                    .cloned()
                    .ok_or_else(|| failure("Missing manifest"))?,
            )
            .map_err(failure)?;
            let raw_opts: DirectDeployOptionsInput = args
                .get(5)
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            let options = DirectDeploymentOptions {
                project_folder: PathBuf::from(project_folder),
                exclude_paths: raw_opts.exclude_paths.unwrap_or_default(),
                backup_dir: raw_opts.backup_dir.map(PathBuf::from),
                staging_dir: raw_opts.staging_dir.map(PathBuf::from),
                process_inputs: raw_opts.process_inputs.unwrap_or_default(),
                timeout: raw_opts.timeout_ms.map(Duration::from_millis),
                health_check_host: raw_opts.health_check_host,
                health_check_port: raw_opts.health_check_port,
            };

            let store = Arc::clone(&store);
            let locks = Arc::clone(&locks);
            let result = handle
                .block_on(async move {
                    run_direct_deployment(
                        &store, &locks, run_id, &profile, &artifact, &manifest, &options, &now_iso,
                    )
                    .await
                })
                .map_err(failure)?;
            serde_json::to_value(result).map_err(failure)
        });
    }

    // deployments:getRun
    {
        let store = Arc::clone(&store);
        host.register_handler("deployments:getRun", move |_, args| {
            let run_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Missing runId"))?;
            let run = store
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(run_id);
            serde_json::to_value(run).map_err(failure)
        });
    }

    // deployments:listRuns
    {
        let store = Arc::clone(&store);
        host.register_handler("deployments:listRuns", move |_, args| {
            let profile_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Missing deploymentProfileId"))?;
            let runs = store
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .for_profile(profile_id);
            serde_json::to_value(runs).map_err(failure)
        });
    }

    // deployments:health
    {
        let store = Arc::clone(&store);
        host.register_handler("deployments:health", move |_, args| {
            let run_id = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Missing runId"))?;
            let run = store
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(run_id)
                .ok_or_else(|| failure(format!("Deployment run {run_id} was not found.")))?;
            let health = deployment_health_result(&run);
            serde_json::to_value(health).map_err(failure)
        });
    }

    // deployments:rollback
    {
        let store = Arc::clone(&store);
        let handle = runtime.clone();
        host.register_handler("deployments:rollback", move |_, args| {
            let project_folder = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Missing projectFolder"))?;
            let run_id = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Missing runId"))?;
            let profile: DeploymentProfile = serde_json::from_value(
                args.get(2)
                    .cloned()
                    .ok_or_else(|| failure("Missing profile"))?,
            )
            .map_err(failure)?;
            let raw_opts: DirectRollbackOptionsInput = args
                .get(3)
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let backup_dir = raw_opts.backup_dir.as_deref().map(Path::new);
            let exclude_paths = raw_opts.exclude_paths.unwrap_or_default();

            let store = Arc::clone(&store);
            let result = handle
                .block_on(async move {
                    rollback_direct_deployment(
                        &store,
                        run_id,
                        &profile,
                        Path::new(project_folder),
                        backup_dir,
                        &exclude_paths,
                        &now_iso,
                    )
                    .await
                })
                .map_err(failure)?;
            serde_json::to_value(result).map_err(failure)
        });
    }
}
