//! Workspace records, `.workspace.praxis.json` serialization, secret stripping, and validation (`FX-BE-049`, `FX-BE-050`).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::contains_word_bounded_pat;

use super::workspace_paths::{resolve_portable_folder_path, to_portable_folder_path};

/// Format discriminator for `.workspace.praxis.json` files.
pub const PRAXIS_WORKSPACE_FORMAT: &str = "praxis-workspace";

/// Current schema version for `.workspace.praxis.json` files.
pub const CURRENT_WORKSPACE_SCHEMA_VERSION: u32 = 2;

/// Final file extension used by OS open/save dialog filters.
pub const PRAXIS_WORKSPACE_FILE_EXTENSION: &str = "json";

/// Full file suffix for saved Praxis workspace files (`<slug>.workspace.praxis.json`).
pub const PRAXIS_WORKSPACE_FILE_SUFFIX: &str = ".workspace.praxis.json";

/// Converts a workspace display name (`My Team`) into its default filename (`my-team.workspace.praxis.json`).
#[must_use]
pub fn workspace_file_name(name: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in name.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let cleaned = slug.trim_matches('-');
    let base = if cleaned.is_empty() {
        "workspace"
    } else {
        cleaned
    };
    format!("{base}{PRAXIS_WORKSPACE_FILE_SUFFIX}")
}

/// Workspace record persisted in `workspaces.json` or a `.workspace.praxis.json` file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub project_ids: Vec<String>,
    #[serde(default)]
    pub connection_ids: Vec<String>,
    #[serde(default)]
    pub objectives: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub created_with_app_version: String,
    pub last_saved_with_app_version: String,
    pub schema_version: u32,
}

/// Input payload for creating a workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceInput {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objectives: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_folder: Option<String>,
}

/// Input payload for updating a workspace.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objectives: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_project_id: Option<String>,
}

/// Associated records stored alongside a workspace in a v2 `.workspace.praxis.json` file.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContents {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projects: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connections: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boards: Option<Vec<Value>>,
}

/// On-disk `.workspace.praxis.json` document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub format: String,
    pub schema_version: u32,
    pub created_with_app_version: String,
    pub last_saved_with_app_version: String,
    pub workspace: WorkspaceRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projects: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connections: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boards: Option<Vec<Value>>,
}

/// Parsed `.workspace.praxis.json` result (`{ workspace, projects?, connections?, boards? }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedWorkspaceFile {
    pub workspace: WorkspaceRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projects: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connections: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boards: Option<Vec<Value>>,
}

/// Validates a [`WorkspaceRecord`] against schema and invariant rules.
///
/// # Errors
/// Returns an error message if the name is blank, the schema version is newer than supported,
/// or `default_project_id` does not belong to `project_ids`.
pub fn validate_workspace(workspace: &WorkspaceRecord) -> Result<(), String> {
    if workspace.name.trim().is_empty() {
        return Err("Workspace name is required.".to_string());
    }
    if workspace.schema_version > CURRENT_WORKSPACE_SCHEMA_VERSION {
        return Err(format!(
            "This workspace was created with a newer Praxis workspace format (v{}). Update Praxis before opening it.",
            workspace.schema_version
        ));
    }
    if let Some(default_id) = workspace.default_project_id.as_deref()
        && !default_id.is_empty()
        && !workspace.project_ids.iter().any(|id| id == default_id)
    {
        return Err("The default project must belong to the workspace.".to_string());
    }
    Ok(())
}

/// Matches `/token|secret|password|apikey|api_key|\bpat\b/i`.
#[must_use]
pub fn is_secret_setting_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("apikey")
        || lower.contains("api_key")
        || contains_word_bounded_pat(&lower)
}

/// Strips credential-like keys from each connection's `settings` map (`stripSecretsFromConnections`).
#[must_use]
pub fn strip_secrets_from_connections(connections: &[Value]) -> Vec<Value> {
    connections
        .iter()
        .map(|conn| {
            let Some(mut obj) = conn.as_object().cloned() else {
                return conn.clone();
            };
            let filtered_settings = obj
                .get("settings")
                .and_then(Value::as_object)
                .map(|settings| {
                    settings
                        .iter()
                        .filter(|(k, _)| !is_secret_setting_key(k))
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect::<Map<String, Value>>()
                })
                .unwrap_or_default();
            obj.insert("settings".to_string(), Value::Object(filtered_settings));
            Value::Object(obj)
        })
        .collect()
}

fn portable_projects(projects: &[Value], dir: Option<&str>) -> Vec<Value> {
    projects
        .iter()
        .map(|proj| {
            let Some(mut obj) = proj.as_object().cloned() else {
                return proj.clone();
            };
            // Always drop cached local filesystem inspection (`FX-BE-049`).
            obj.remove("folderInspection");
            if let Some(d) = dir
                && !d.is_empty()
                && let Some(wf) = obj
                    .get("workspaceFolder")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
            {
                let portable = to_portable_folder_path(wf, d);
                obj.insert("workspaceFolder".to_string(), Value::String(portable));
            }
            Value::Object(obj)
        })
        .collect()
}

fn portable_connections(connections: &[Value], dir: Option<&str>) -> Vec<Value> {
    let stripped = strip_secrets_from_connections(connections);
    let Some(d) = dir.filter(|s| !s.is_empty()) else {
        return stripped;
    };
    stripped
        .into_iter()
        .map(|conn| {
            let Some(mut obj) = conn.as_object().cloned() else {
                return conn;
            };
            if let Some(settings) = obj.get_mut("settings").and_then(Value::as_object_mut)
                && let Some(roots) = settings.get_mut("roots").and_then(Value::as_array_mut)
            {
                for item in roots.iter_mut() {
                    if let Some(s) = item.as_str() {
                        *item = Value::String(to_portable_folder_path(s, d));
                    }
                }
            }
            Value::Object(obj)
        })
        .collect()
}

fn resolved_projects(projects: &[Value], dir: Option<&str>) -> Vec<Value> {
    let Some(d) = dir.filter(|s| !s.is_empty()) else {
        return projects.to_vec();
    };
    projects
        .iter()
        .map(|proj| {
            let Some(mut obj) = proj.as_object().cloned() else {
                return proj.clone();
            };
            if let Some(wf) = obj
                .get("workspaceFolder")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                let resolved = resolve_portable_folder_path(wf, d);
                obj.insert("workspaceFolder".to_string(), Value::String(resolved));
            }
            Value::Object(obj)
        })
        .collect()
}

fn resolved_connections(connections: &[Value], dir: Option<&str>) -> Vec<Value> {
    let Some(d) = dir.filter(|s| !s.is_empty()) else {
        return connections.to_vec();
    };
    connections
        .iter()
        .map(|conn| {
            let Some(mut obj) = conn.as_object().cloned() else {
                return conn.clone();
            };
            if let Some(settings) = obj.get_mut("settings").and_then(Value::as_object_mut)
                && let Some(roots) = settings.get_mut("roots").and_then(Value::as_array_mut)
            {
                for item in roots.iter_mut() {
                    if let Some(s) = item.as_str() {
                        *item = Value::String(resolve_portable_folder_path(s, d));
                    }
                }
            }
            Value::Object(obj)
        })
        .collect()
}

/// Builds a serializable [`WorkspaceFile`] document (`toWorkspaceFile`), stripping `storagePath`,
/// connection credentials, and `folderInspection`, and normalizing in-tree folder paths relative
/// to `workspace_file_dir`.
///
/// # Errors
/// Returns an error if `workspace` fails [`validate_workspace`].
pub fn to_workspace_file(
    workspace: &WorkspaceRecord,
    contents: &WorkspaceContents,
    workspace_file_dir: Option<&str>,
) -> Result<WorkspaceFile, String> {
    validate_workspace(workspace)?;
    let mut record = workspace.clone();
    record.storage_path = None;

    Ok(WorkspaceFile {
        format: PRAXIS_WORKSPACE_FORMAT.to_string(),
        schema_version: CURRENT_WORKSPACE_SCHEMA_VERSION,
        created_with_app_version: workspace.created_with_app_version.clone(),
        last_saved_with_app_version: workspace.last_saved_with_app_version.clone(),
        workspace: record,
        projects: contents
            .projects
            .as_ref()
            .map(|p| portable_projects(p, workspace_file_dir)),
        connections: contents
            .connections
            .as_ref()
            .map(|c| portable_connections(c, workspace_file_dir)),
        boards: contents.boards.clone(),
    })
}

/// Parses and validates a `.workspace.praxis.json` document (`readWorkspaceFile`), resolving
/// relative folder paths against `workspace_file_dir`.
///
/// # Errors
/// Returns an error if `raw` is not valid JSON, is not a Praxis workspace file, or fails validation.
pub fn read_workspace_file(
    raw: &str,
    workspace_file_dir: Option<&str>,
) -> Result<ParsedWorkspaceFile, String> {
    let parsed: Value = serde_json::from_str(raw)
        .map_err(|_| "The selected file is not valid JSON.".to_string())?;
    let Some(root) = parsed.as_object() else {
        return Err("This file is not a Praxis workspace.".to_string());
    };
    if root.get("format").and_then(Value::as_str) != Some(PRAXIS_WORKSPACE_FORMAT) {
        return Err("This file is not a Praxis workspace.".to_string());
    }
    let Some(ws_val) = root.get("workspace") else {
        return Err("This file is not a Praxis workspace.".to_string());
    };
    let Some(mut ws_obj) = ws_val.as_object().cloned() else {
        return Err("This file is not a Praxis workspace.".to_string());
    };

    let schema_version = root
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .or_else(|| ws_obj.get("schemaVersion").and_then(Value::as_u64))
        .unwrap_or(1) as u32;
    let created_ver = root
        .get("createdWithAppVersion")
        .and_then(Value::as_str)
        .or_else(|| ws_obj.get("createdWithAppVersion").and_then(Value::as_str))
        .unwrap_or("unknown")
        .to_string();
    let saved_ver = root
        .get("lastSavedWithAppVersion")
        .and_then(Value::as_str)
        .or_else(|| {
            ws_obj
                .get("lastSavedWithAppVersion")
                .and_then(Value::as_str)
        })
        .unwrap_or("unknown")
        .to_string();

    ws_obj.insert("schemaVersion".to_string(), Value::from(schema_version));
    ws_obj.insert(
        "createdWithAppVersion".to_string(),
        Value::String(created_ver),
    );
    ws_obj.insert(
        "lastSavedWithAppVersion".to_string(),
        Value::String(saved_ver),
    );

    let workspace: WorkspaceRecord = serde_json::from_value(Value::Object(ws_obj))
        .map_err(|_| "This file is not a Praxis workspace.".to_string())?;
    validate_workspace(&workspace)?;

    let projects = root
        .get("projects")
        .and_then(Value::as_array)
        .map(|arr| resolved_projects(arr, workspace_file_dir));
    let connections = root
        .get("connections")
        .and_then(Value::as_array)
        .map(|arr| resolved_connections(arr, workspace_file_dir));
    let boards = root.get("boards").and_then(Value::as_array).cloned();

    Ok(ParsedWorkspaceFile {
        workspace,
        projects,
        connections,
        boards,
    })
}

/// Parses and returns only the [`WorkspaceRecord`] from a `.workspace.praxis.json` string (`parseWorkspaceFile`).
///
/// # Errors
/// Returns an error if [`read_workspace_file`] fails.
pub fn parse_workspace_file(raw: &str) -> Result<WorkspaceRecord, String> {
    Ok(read_workspace_file(raw, None)?.workspace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_workspace() -> WorkspaceRecord {
        WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "My Team".to_string(),
            description: "Shared repo workspace".to_string(),
            project_ids: vec!["proj-1".to_string()],
            connection_ids: vec!["conn-1".to_string()],
            objectives: vec!["Ship Rust migration".to_string()],
            default_project_id: Some("proj-1".to_string()),
            storage_path: Some(
                "/Users/someone/dev/praxis/my-team.workspace.praxis.json".to_string(),
            ),
            created_at: "2026-11-08T00:00:00.000Z".to_string(),
            updated_at: "2026-11-08T00:00:00.000Z".to_string(),
            created_with_app_version: "0.1.0".to_string(),
            last_saved_with_app_version: "0.1.0".to_string(),
            schema_version: CURRENT_WORKSPACE_SCHEMA_VERSION,
        }
    }

    #[test]
    fn workspace_file_name_formats_slug_with_praxis_json_suffix() {
        assert_eq!(
            workspace_file_name("  My Team! "),
            "my-team.workspace.praxis.json"
        );
        assert_eq!(
            workspace_file_name("..."),
            "workspace.workspace.praxis.json"
        );
    }

    #[test]
    fn to_workspace_file_strips_secrets_storage_path_and_folder_inspection_and_relativizes_paths() {
        let ws = sample_workspace();
        let contents = WorkspaceContents {
            projects: Some(vec![json!({
                "id": "proj-1",
                "name": "Praxis",
                "workspaceFolder": "/Users/someone/dev/praxis/apps/praxis-desktop",
                "folderInspection": { "hasGit": true, "languages": ["TypeScript"] }
            })]),
            connections: Some(vec![json!({
                "id": "conn-1",
                "name": "Folder Board",
                "mode": "folder",
                "settings": {
                    "roots": ["/Users/someone/dev/praxis/docs/plans", "/var/external/plans"],
                    "apiToken": "secret-1",
                    "clientSecret": "secret-2",
                    "userPassword": "secret-3",
                    "my_api_key": "secret-4",
                    "github-pat": "secret-5",
                    "pat": "secret-6",
                    "dispatchPath": "/keep-this-word-contains-pat-inside"
                }
            })]),
            boards: Some(vec![json!({ "id": "b-1", "connectionId": "conn-1" })]),
        };

        let file = to_workspace_file(&ws, &contents, Some("/Users/someone/dev/praxis"))
            .expect("to_workspace_file");
        assert_eq!(file.format, PRAXIS_WORKSPACE_FORMAT);
        assert_eq!(file.workspace.storage_path, None);

        let proj = &file.projects.as_ref().expect("projects")[0];
        assert_eq!(proj.get("folderInspection"), None);
        assert_eq!(
            proj.get("workspaceFolder").and_then(Value::as_str),
            Some("./apps/praxis-desktop")
        );

        let conn_settings = file.connections.as_ref().expect("connections")[0]
            .get("settings")
            .and_then(Value::as_object)
            .expect("settings");
        assert_eq!(conn_settings.get("apiToken"), None);
        assert_eq!(conn_settings.get("clientSecret"), None);
        assert_eq!(conn_settings.get("userPassword"), None);
        assert_eq!(conn_settings.get("my_api_key"), None);
        assert_eq!(conn_settings.get("github-pat"), None);
        assert_eq!(conn_settings.get("pat"), None);
        assert_eq!(
            conn_settings.get("dispatchPath").and_then(Value::as_str),
            Some("/keep-this-word-contains-pat-inside")
        );
        assert_eq!(
            conn_settings.get("roots"),
            Some(&json!(["./docs/plans", "/var/external/plans"]))
        );

        // Round-trip via read_workspace_file in a cloned directory
        let raw = serde_json::to_string_pretty(&file).expect("serialize");
        let parsed = read_workspace_file(&raw, Some("/checkout/clone")).expect("read");
        assert_eq!(parsed.workspace.id, "ws-1");
        let resolved_proj = &parsed.projects.expect("projects")[0];
        assert_eq!(
            resolved_proj.get("workspaceFolder").and_then(Value::as_str),
            Some("/checkout/clone/apps/praxis-desktop")
        );
        let resolved_roots = parsed.connections.expect("connections")[0]
            .get("settings")
            .and_then(|s| s.get("roots"))
            .cloned();
        assert_eq!(
            resolved_roots,
            Some(json!(["/checkout/clone/docs/plans", "/var/external/plans"]))
        );
    }
}
