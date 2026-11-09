//! Opt-in Run/deployment profile operations. Electron resolves project membership and
//! keeps credential lookup; Rust owns profile files and validation on this path.
use std::path::{Path, PathBuf};

use praxis_contracts::RustRpcError;
use praxis_workflows::deployment_profile::{
    SUPPORTED_EXECUTOR_KINDS, SUPPORTED_TARGET_KINDS, validate_deployment_profile_value,
};
use praxis_workflows::deployment_profile_store::{
    DEPLOYMENT_PROFILE_FILE_SUFFIX, DEPLOYMENT_PROFILES_DIR,
};
use praxis_workflows::run_profile::{RUN_PROFILE_FILE_NAME, validate_run_profile_value};
use praxis_workflows::run_profile_discovery::{
    ProposalSource, ProposedRunService, propose_dotnet_run_service, propose_node_run_service,
};
use serde_json::{Value, json};
use tokio::runtime::Handle;

use crate::HostContext;

fn failure(message: impl std::fmt::Display) -> RustRpcError {
    RustRpcError {
        code: "PROFILE_ERROR".into(),
        message: message.to_string(),
    }
}
fn text(args: &[Value], index: usize) -> Result<&str, RustRpcError> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| failure("Profile argument must be a string."))
}
fn value(args: &[Value], index: usize) -> Result<&Value, RustRpcError> {
    args.get(index)
        .ok_or_else(|| failure("Profile argument is missing."))
}
fn deployment_path(folder: &str, id: &str) -> PathBuf {
    Path::new(folder)
        .join(DEPLOYMENT_PROFILES_DIR)
        .join(format!("{id}{DEPLOYMENT_PROFILE_FILE_SUFFIX}"))
}
async fn write(path: &Path, profile: &Value) -> Result<(), RustRpcError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(failure)?;
    }
    let text = serde_json::to_string_pretty(profile).map_err(failure)?;
    tokio::fs::write(path, format!("{text}\n"))
        .await
        .map_err(failure)
}
async fn read(path: &Path, deployment: bool) -> Value {
    let Ok(text) = tokio::fs::read_to_string(path).await else {
        return json!({"issues": []});
    };
    let parsed = match serde_json::from_str::<Value>(&text) {
        Ok(value) => value,
        Err(_) => {
            // Preserve V8's user-facing JSON error text in Electron without returning
            // parser-specific messages from serde. This sentinel stays internal.
            return json!({"invalidJson": text});
        }
    };
    if deployment {
        let issues = validate_deployment_profile_value(&parsed);
        if issues.is_empty() {
            json!({"profile": parsed, "issues": []})
        } else {
            json!({"issues": issues})
        }
    } else {
        if parsed
            .get("schemaVersion")
            .and_then(Value::as_f64)
            .is_some_and(|v| v > 1.0)
        {
            return json!({"issues": [{"path": "schemaVersion", "message": format!("Unsupported run profile schema version {}.", parsed["schemaVersion"])}]});
        }
        if !parsed.is_object() {
            return json!({"issues": [{"path": "", "message": "A run profile must be a JSON object."}]});
        }
        let mut normalized = json!({"schemaVersion": parsed.get("schemaVersion").filter(|v| v.is_number()).cloned().unwrap_or(json!(0)),
            "services": parsed.get("services").filter(|v| v.is_array()).cloned().unwrap_or(json!([]))});
        for key in ["id", "name", "createdAt", "updatedAt"] {
            normalized[key] = json!(parsed.get(key).and_then(Value::as_str).unwrap_or_default());
        }
        let issues = validate_run_profile_value(&normalized);
        if issues.is_empty() {
            json!({"profile": normalized, "issues": []})
        } else {
            json!({"issues": issues})
        }
    }
}
fn proposal(value: ProposedRunService, relative: &str) -> Value {
    let mut output = json!({"executable": value.executable, "args": value.args,
        "source": match value.source { ProposalSource::PackageJson => "package.json", ProposalSource::LaunchSettingsJson => "launchSettings.json" },
        "relativeDir": relative});
    if let Some(port) = value.port {
        output["port"] = json!(port);
    }
    if let Some(origin) = value.browser_origin {
        output["browserOrigin"] = json!(origin);
    }
    output
}
async fn discover(folder: &str) -> Vec<Value> {
    let root = Path::new(folder);
    let mut candidates = vec![(root.to_path_buf(), ".".to_string())];
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return vec![];
    };
    // Node readdir's directory order is lexical on the supported desktop hosts.
    let mut children = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with('.')
            && name != "node_modules"
            && entry.file_type().await.is_ok_and(|kind| kind.is_dir())
        {
            children.push((entry.path(), name));
        }
    }
    children.sort_by(|a, b| a.1.cmp(&b.1));
    candidates.extend(children);
    let mut output = Vec::new();
    for (dir, relative) in candidates {
        if let Ok(raw) = tokio::fs::read_to_string(dir.join("package.json")).await {
            if let Some(found) = propose_node_run_service(&raw) {
                output.push(proposal(found, &relative));
            }
        }
        if let Ok(raw) = tokio::fs::read_to_string(dir.join("Properties/launchSettings.json")).await
        {
            if let Some(found) = propose_dotnet_run_service(&raw) {
                output.push(proposal(found, &relative));
            }
        }
    }
    output
}

pub fn register_profile_channels(host: &HostContext, runtime: &Handle) {
    let handle = runtime.clone();
    host.register_handler("projects:getRunProfile", move |_, args| {
        let folder = text(args, 0)?;
        if folder.is_empty() {
            return Ok(json!({"issues": []}));
        }
        Ok(handle.block_on(read(&Path::new(folder).join(RUN_PROFILE_FILE_NAME), false)))
    });
    host.register_handler("projects:validateRunProfile", |_, args| {
        let errors = validate_run_profile_value(value(args, 0)?);
        Ok(json!({"valid": errors.is_empty(), "errors": errors}))
    });
    let handle = runtime.clone();
    host.register_handler("projects:saveRunProfile", move |_, args| {
        let folder = text(args, 0)?;
        if folder.is_empty() {
            return Err(failure(
                "This project has no working folder to store a run profile in.",
            ));
        }
        let raw = value(args, 1)?;
        let errors = validate_run_profile_value(raw);
        if !errors.is_empty() {
            let details = errors
                .iter()
                .map(|issue| {
                    format!(
                        "{}: {}",
                        if issue.path.is_empty() {
                            "(root)"
                        } else {
                            &issue.path
                        },
                        issue.message
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            return Err(failure(format!(
                "Run profile {} is invalid: {details}",
                if raw["id"].as_str().unwrap_or_default().is_empty() {
                    "(unnamed)"
                } else {
                    raw["id"].as_str().unwrap_or_default()
                }
            )));
        }
        handle.block_on(write(&Path::new(folder).join(RUN_PROFILE_FILE_NAME), raw))?;
        Ok(Value::Null)
    });
    let handle = runtime.clone();
    host.register_handler("projects:discoverRunServices", move |_, args| {
        Ok(json!(handle.block_on(discover(text(args, 0)?))))
    });
    host.register_handler("deployments:validateProfile", |_, args| {
        let errors = validate_deployment_profile_value(value(args, 0)?);
        Ok(json!({"valid": errors.is_empty(), "errors": errors}))
    });
    host.register_handler("deployments:preflightCapabilities", |_, args| {
        let profile = value(args, 0)?;
        let mut issues = Vec::new();
        for (field, supported, label) in [("executor", SUPPORTED_EXECUTOR_KINDS.as_slice(), "Executor"), ("target", SUPPORTED_TARGET_KINDS.as_slice(), "Target")] {
            let kind = profile.get(field).and_then(|v| v.get("kind")).and_then(Value::as_str).unwrap_or("undefined");
            if !supported.contains(&kind) { issues.push(json!({"path": format!("{field}.kind"), "message": format!("{label} \"{kind}\" is not supported by this build.")})); }
        }
        Ok(json!(issues))
    });
    let handle = runtime.clone();
    host.register_handler("deployments:getProfile", move |_, args| {
        Ok(handle.block_on(read(&deployment_path(text(args, 0)?, text(args, 1)?), true)))
    });
    let handle = runtime.clone();
    host.register_handler("deployments:saveProfile", move |_, args| {
        let folder = text(args, 0)?;
        let raw = value(args, 1)?;
        let errors = validate_deployment_profile_value(raw);
        if !errors.is_empty() {
            return Err(failure(format!(
                "Deployment profile is invalid: {}",
                errors
                    .iter()
                    .map(|issue| format!(
                        "{}: {}",
                        if issue.path.is_empty() {
                            "(root)"
                        } else {
                            &issue.path
                        },
                        issue.message
                    ))
                    .collect::<Vec<_>>()
                    .join("; ")
            )));
        }
        handle.block_on(write(
            &deployment_path(folder, raw["id"].as_str().unwrap_or_default()),
            raw,
        ))?;
        Ok(raw.clone())
    });
    let handle = runtime.clone();
    host.register_handler("deployments:listProfiles", move |_, args| {
        let folder = text(args, 0)?;
        Ok(handle.block_on(async {
            let Ok(mut entries) =
                tokio::fs::read_dir(Path::new(folder).join(DEPLOYMENT_PROFILES_DIR)).await
            else {
                return json!([]);
            };
            let mut paths = Vec::new();
            while let Ok(Some(entry)) = entries.next_entry().await {
                if entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(DEPLOYMENT_PROFILE_FILE_SUFFIX)
                {
                    paths.push(entry.path());
                }
            }
            paths.sort();
            let mut profiles = Vec::new();
            for path in paths {
                if let Some(profile) = read(&path, true).await.get("profile") {
                    profiles.push(profile.clone());
                }
            }
            json!(profiles)
        }))
    });
}
