use std::path::Path;

use praxis_host::HostContext;
use serde_json::{Value, json};

use super::storage::{parse, read, write_atomic};
use super::{Result, failure, now, text};

fn artifacts_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("deployment-artifacts.json")
}

fn read_artifacts(user_data_dir: &Path) -> Result<Vec<Value>> {
    let path = artifacts_file(user_data_dir);
    if let Some(content) = read(&path)? {
        let val = parse(&path, Some(&content))?;
        if let Some(list) = val
            .get("praxis.publishedArtifacts.v1")
            .and_then(Value::as_array)
        {
            return Ok(list.clone());
        }
    }
    Ok(Vec::new())
}

fn save_artifacts(user_data_dir: &Path, list: &[Value]) -> Result<()> {
    let path = artifacts_file(user_data_dir);
    let encoded = super::storage::encoded(&json!({ "praxis.publishedArtifacts.v1": list }))?;
    write_atomic(&path, &encoded, false)
}

fn extract_secret_name(reference: &str) -> Option<&str> {
    let trimmed = reference.trim();
    if trimmed.starts_with("${secret:") && trimmed.ends_with('}') {
        Some(&trimmed[9..trimmed.len() - 1])
    } else {
        None
    }
}

pub fn dispatch(
    host: &HostContext,
    user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "deployments:evaluateCredentials" => {
            let profile = args
                .first()
                .ok_or_else(|| failure("Profile is required."))?;
            let mut statuses = Vec::new();
            if let Some(credentials) = profile.get("credentials").and_then(Value::as_object) {
                for (key, reference_val) in credentials {
                    let ref_str = reference_val.as_str().unwrap_or("");
                    if let Some(secret_name) = extract_secret_name(ref_str) {
                        let bound = host.secrets().has(secret_name);
                        statuses.push(json!({
                            "key": key,
                            "secretName": secret_name,
                            "bound": bound
                        }));
                    } else {
                        statuses.push(json!({
                            "key": key,
                            "secretName": "",
                            "bound": false
                        }));
                    }
                }
            }
            let all_bound = statuses.iter().all(|s| s["bound"] == true);
            Ok(json!({
                "statuses": statuses,
                "allBound": all_bound
            }))
        }
        "deployments:publishArtifact" => {
            let artifact_id = text(args, 0)?;
            let deployment_profile_id = text(args, 1)?;
            let root_dir = text(args, 2)?;
            let source_commit = args
                .get(3)
                .cloned()
                .unwrap_or_else(|| json!({ "kind": "unknown" }));
            let mut artifacts = read_artifacts(user_data_dir)?;
            if artifacts.iter().any(|a| a["artifact"]["id"] == artifact_id) {
                return Err(failure(format!(
                    "Artifact {artifact_id} was already published; artifacts are immutable once created."
                )));
            }
            let record = json!({
                "artifact": {
                    "id": artifact_id,
                    "deploymentProfileId": deployment_profile_id,
                    "location": {
                        "kind": "directory",
                        "path": root_dir
                    },
                    "sourceCommit": source_commit,
                    "createdAt": now()
                },
                "manifest": {
                    "files": [],
                    "totalBytes": 0,
                    "manifestHash": format!("hash-{}", artifact_id)
                }
            });
            artifacts.push(record.clone());
            save_artifacts(user_data_dir, &artifacts)?;
            Ok(record)
        }
        "deployments:listArtifacts" => {
            let deployment_profile_id = text(args, 0)?;
            let artifacts = read_artifacts(user_data_dir)?;
            let filtered: Vec<_> = artifacts
                .into_iter()
                .filter(|a| a["artifact"]["deploymentProfileId"] == deployment_profile_id)
                .collect();
            Ok(json!(filtered))
        }
        "deployments:listAllArtifacts" => {
            let artifacts = read_artifacts(user_data_dir)?;
            Ok(json!(artifacts))
        }
        "deployments:getArtifact" => {
            let artifact_id = text(args, 0)?;
            let artifacts = read_artifacts(user_data_dir)?;
            let found = artifacts
                .into_iter()
                .find(|a| a["artifact"]["id"] == artifact_id)
                .unwrap_or(Value::Null);
            Ok(found)
        }
        _ => Err(failure("Unknown deployments operation.")),
    }
}
