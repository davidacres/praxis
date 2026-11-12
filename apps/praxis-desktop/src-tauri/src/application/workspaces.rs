use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use praxis_core::workspaces::{
    CURRENT_WORKSPACE_SCHEMA_VERSION, CreateWorkspaceInput, WorkspaceContents, WorkspaceRecord,
    read_workspace_file, to_workspace_file, validate_workspace, workspace_file_name,
};
use serde_json::{Value, json};
use uuid::Uuid;

use super::storage::{Catalog, PROJECTS, WORKSPACES};
use super::{Result, failure, now, text};

fn unique(values: Option<Vec<String>>, trim: bool) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .unwrap_or_default()
        .into_iter()
        .map(|value| if trim { value.trim().to_owned() } else { value })
        .filter(|value| (!trim || !value.is_empty()) && seen.insert(value.clone()))
        .collect()
}

fn objectives(values: Option<Vec<String>>) -> Vec<String> {
    values
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect()
}

fn new_workspace(input: CreateWorkspaceInput, version: &str) -> Result<WorkspaceRecord> {
    let timestamp = now();
    let workspace = WorkspaceRecord {
        id: format!("workspace-{}", Uuid::new_v4()),
        name: input.name.trim().to_owned(),
        description: input.description.unwrap_or_default().trim().to_owned(),
        project_ids: unique(input.project_ids, false),
        connection_ids: unique(input.connection_ids, false),
        objectives: objectives(input.objectives),
        default_project_id: input.default_project_id,
        storage_path: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        created_with_app_version: version.into(),
        last_saved_with_app_version: version.into(),
        schema_version: CURRENT_WORKSPACE_SCHEMA_VERSION,
    };
    validate_workspace(&workspace).map_err(failure)?;
    Ok(workspace)
}

pub fn contents(catalog: &Catalog, workspace: &WorkspaceRecord) -> WorkspaceContents {
    let mut connections: Vec<Value> = catalog
        .list("connections")
        .into_iter()
        .filter(|connection| {
            workspace
                .connection_ids
                .iter()
                .any(|id| connection["id"] == *id)
                || workspace
                    .project_ids
                    .iter()
                    .any(|id| connection["settings"]["projectId"] == *id)
        })
        .collect();
    let mut projects: Vec<Value> = catalog
        .list(PROJECTS)
        .into_iter()
        .filter(|project| workspace.project_ids.iter().any(|id| project["id"] == *id))
        .collect();
    for project in &mut projects {
        if let Some(path) = project["workspaceFolder"]
            .as_str()
            .filter(|path| Path::new(path).is_absolute())
            && let Ok(path) = super::projects::absolute(Path::new(path))
        {
            project["workspaceFolder"] = json!(path);
        }
    }
    for connection in &mut connections {
        if let Some(roots) = connection["settings"]["roots"].as_array_mut() {
            for root in roots {
                if let Some(path) = root.as_str().filter(|path| Path::new(path).is_absolute())
                    && let Ok(path) = super::projects::absolute(Path::new(path))
                {
                    *root = json!(path);
                }
            }
        }
    }
    WorkspaceContents {
        projects: Some(projects),
        boards: Some(
            catalog
                .list("boards")
                .into_iter()
                .filter(|board| {
                    connections
                        .iter()
                        .any(|connection| board["connectionId"] == connection["id"])
                })
                .collect(),
        ),
        connections: Some(connections),
    }
}

fn create(catalog: &mut Catalog, input: &Value, version: &str) -> Result<Value> {
    let input: CreateWorkspaceInput = serde_json::from_value(input.clone()).map_err(failure)?;
    let storage_folder = input
        .storage_folder
        .clone()
        .filter(|folder| !folder.trim().is_empty());
    let workspace = new_workspace(input, version)?;
    let mut result = serde_json::to_value(&workspace).map_err(failure)?;
    if let Some(folder) = storage_folder {
        if !Path::new(&folder).is_absolute() {
            return Err(failure(
                "Workspace location must be an absolute folder path.",
            ));
        }
        let path = super::projects::absolute(Path::new(&folder))?
            .join(workspace_file_name(&workspace.name));
        if path.exists() {
            return Err(failure(format!(
                "A workspace file already exists at {}.",
                path.display()
            )));
        }
        let empty = WorkspaceContents {
            projects: Some(Vec::new()),
            connections: Some(Vec::new()),
            boards: Some(Vec::new()),
        };
        let document = to_workspace_file(&workspace, &empty, path.parent().and_then(Path::to_str))
            .map_err(failure)?;
        catalog.stage(
            path.clone(),
            serde_json::to_value(document).map_err(failure)?,
        )?;
        catalog.register(&workspace.id, &path);
        result["storagePath"] = json!(path);
    } else {
        catalog.replace(WORKSPACES, result.clone(), None);
    }
    Ok(result)
}

pub fn open_file(catalog: &mut Catalog, path: &Path) -> Result<Value> {
    let path = super::projects::absolute(path)?;
    let raw = fs::read_to_string(&path).map_err(failure)?;
    let parsed =
        read_workspace_file(&raw, path.parent().and_then(Path::to_str)).map_err(failure)?;
    catalog.register(&parsed.workspace.id, &path);
    let mut result = serde_json::to_value(parsed.workspace).map_err(failure)?;
    result["storagePath"] = json!(path);
    Ok(result)
}

pub fn update(catalog: &mut Catalog, id: &str, patch: &Value, version: &str) -> Result<Value> {
    if !patch.is_object() {
        return Err(failure("Workspace patch must be an object."));
    }
    let mut value = catalog.require(WORKSPACES, id)?;
    for field in ["name", "description"] {
        if let Some(change) = patch.get(field).filter(|value| !value.is_null()) {
            value[field] = json!(
                change
                    .as_str()
                    .ok_or_else(|| failure(format!("{field} must be a string.")))?
                    .trim()
            );
        }
    }
    for field in ["projectIds", "connectionIds", "objectives"] {
        if let Some(change) = patch.get(field).filter(|value| !value.is_null()) {
            let items: Vec<String> = serde_json::from_value(change.clone()).map_err(failure)?;
            value[field] = json!(if field == "objectives" {
                objectives(Some(items))
            } else {
                unique(Some(items), false)
            });
        }
    }
    if let Some(change) = patch.get("defaultProjectId") {
        if change.is_null() || change == "" {
            value
                .as_object_mut()
                .ok_or_else(|| failure("Invalid workspace."))?
                .remove("defaultProjectId");
        } else {
            value["defaultProjectId"] = json!(
                change
                    .as_str()
                    .ok_or_else(|| failure("defaultProjectId must be a string."))?
            );
        }
    }
    value["updatedAt"] = json!(now());
    value["lastSavedWithAppVersion"] = json!(version);
    let record: WorkspaceRecord = serde_json::from_value(value.clone()).map_err(failure)?;
    validate_workspace(&record).map_err(failure)?;
    catalog.replace(WORKSPACES, value.clone(), None);
    Ok(value)
}

pub fn dispatch(
    catalog: &mut Catalog,
    channel: &str,
    args: &[Value],
    version: &str,
) -> Result<Value> {
    match channel {
        "workspaces:list" => Ok(json!(catalog.list(WORKSPACES))),
        "workspaces:get" => Ok(catalog
            .get(WORKSPACES, text(args, 0)?)
            .unwrap_or(Value::Null)),
        "workspaces:create" => create(
            catalog,
            args.first()
                .ok_or_else(|| failure("Workspace input is required."))?,
            version,
        ),
        "workspaces:update" => update(
            catalog,
            text(args, 0)?,
            args.get(1)
                .ok_or_else(|| failure("Workspace patch is required."))?,
            version,
        ),
        "workspaces:remove" => {
            let id = text(args, 0)?;
            catalog.require(WORKSPACES, id)?;
            catalog.set(
                WORKSPACES,
                catalog
                    .list(WORKSPACES)
                    .into_iter()
                    .filter(|workspace| workspace["id"] != id)
                    .collect(),
                None,
            );
            catalog.deregister(id);
            Ok(Value::Null)
        }
        "workspaces:openFolder" => {
            let folder = Path::new(text(args, 0)?);
            if !folder.is_absolute() || !folder.is_dir() {
                return Err(failure("Choose an existing folder."));
            }
            let folder = super::projects::absolute(folder)?;
            let name = folder
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("workspace");
            let path = folder.join(workspace_file_name(name));
            if path.exists() {
                open_file(catalog, &path)
            } else {
                create(
                    catalog,
                    &json!({"name": name, "storageFolder": folder, "projectIds": []}),
                    version,
                )
            }
        }
        "workspaces:openFile" => open_file(catalog, Path::new(text(args, 0)?)),
        "workspaces:writeFile" => {
            let record: WorkspaceRecord =
                serde_json::from_value(catalog.require(WORKSPACES, text(args, 0)?)?)
                    .map_err(failure)?;
            let path = super::projects::absolute(Path::new(text(args, 1)?))?;
            let document = to_workspace_file(
                &record,
                &contents(catalog, &record),
                path.parent().and_then(Path::to_str),
            )
            .map_err(failure)?;
            catalog.stage(
                path.clone(),
                serde_json::to_value(document).map_err(failure)?,
            )?;
            Ok(json!(path))
        }
        _ => Err(failure("Unknown workspace operation.")),
    }
}
