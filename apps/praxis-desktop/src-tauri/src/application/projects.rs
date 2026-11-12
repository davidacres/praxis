use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use praxis_contracts::ProjectWorkflowStage;
use praxis_core::folder::{
    discover_plan_folders, extract_front_matter_value, extract_main_heading, extract_status_raw,
    extract_type_raw,
};
use praxis_core::projects::{
    PROJECT_FILE_NAME, ProjectFileStatus, ProjectPlanningMode, ProjectRecord, ProjectStorage,
    ProjectType, ProjectWorkItem, SNAPSHOT_BEGIN, SNAPSHOT_END, normalize_workflow_stages,
    render_project_snapshot, validate_workflow_stages,
};
use praxis_core::sandbox::{open_sandboxed_file, resolve_sandboxed_path};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::storage::{Catalog, PROJECTS, WORKSPACES, read};
use super::{Result, failure, now, text};

pub fn absolute(path: &Path) -> Result<PathBuf> {
    let path = std::path::absolute(path).map_err(failure)?;
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            _ => result.push(component.as_os_str()),
        }
    }
    // Resolve existing ancestors too: on macOS /var and /private/var are the
    // same tree, and mixing their spellings must not break portable paths.
    let mut ancestor = result;
    let mut missing = Vec::new();
    loop {
        match fs::canonicalize(&ancestor) {
            Ok(mut resolved) => {
                for component in missing.into_iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if fs::symlink_metadata(&ancestor)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
                {
                    return Err(failure(
                        "The selected path contains an unresolved symbolic link.",
                    ));
                }
                missing.push(
                    ancestor
                        .file_name()
                        .ok_or_else(|| failure("Cannot resolve the selected path."))?
                        .to_owned(),
                );
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| failure("Cannot resolve the selected path."))?
                    .to_owned();
            }
            Err(error) => return Err(failure(error)),
        }
    }
}

fn walk(root: &Path, depth: usize, max_depth: usize, limit: usize, files: &mut Vec<PathBuf>) {
    if depth > max_depth || files.len() >= limit {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut entries = entries
        .filter_map(std::result::Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if files.len() >= limit {
            break;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir()
            && !["node_modules", ".git", "dist", "out"]
                .iter()
                .any(|name| entry.file_name() == *name)
        {
            walk(&entry.path(), depth + 1, max_depth, limit, files);
        } else if kind.is_file() {
            files.push(entry.path());
        }
    }
}

pub fn inspect(path: &Path) -> Result<Value> {
    let path = absolute(path)?;
    if !path.is_dir() {
        return Ok(
            json!({"path": path, "exists": path.exists(), "isDirectory": false, "hasGit": false, "projectFileExists": false,
            "manifests": [], "languages": [], "frameworks": [], "planFiles": []}),
        );
    }
    let mut files = Vec::new();
    walk(&path, 0, 16, 5000, &mut files);
    let roots = discover_plan_folders(&path.to_string_lossy()).unwrap_or_default();
    let mut manifests = Vec::new();
    let mut languages = BTreeSet::new();
    let mut frameworks = BTreeSet::new();
    let mut plans = Vec::new();
    let mut readme = None;
    for file in &files {
        let relative = file
            .strip_prefix(&path)
            .map_err(failure)?
            .to_string_lossy()
            .replace('\\', "/");
        let name = file
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_lowercase();
        if [
            "package.json",
            "pyproject.toml",
            "requirements.txt",
            "cargo.toml",
            "go.mod",
            "pom.xml",
            "build.gradle",
            "composer.json",
            "gemfile",
        ]
        .contains(&name.as_str())
            || name.ends_with(".csproj")
        {
            manifests.push(relative.clone());
        }
        let extension = file
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_lowercase();
        let language = match extension.as_str() {
            "ts" | "tsx" => "TypeScript",
            "js" | "jsx" => "JavaScript",
            "cs" => "C#",
            "py" => "Python",
            "rs" => "Rust",
            "go" => "Go",
            "java" => "Java",
            "kt" => "Kotlin",
            "swift" => "Swift",
            "rb" => "Ruby",
            "php" => "PHP",
            _ => "",
        };
        if !language.is_empty() {
            languages.insert(language);
        }
        if name.ends_with(".csproj") {
            frameworks.insert(".NET");
        }
        if relative.eq_ignore_ascii_case("manage.py") {
            frameworks.insert("Django");
        }
        if !relative.contains('/')
            && (name == "readme" || name.starts_with("readme."))
            && readme.is_none()
        {
            readme = Some(relative.clone());
        }
        if extension == "md"
            && roots
                .iter()
                .any(|root| file.starts_with(&root.plans_root_path))
        {
            plans.push(relative);
        }
    }
    if let Ok(raw) = fs::read_to_string(path.join("package.json"))
        && let Ok(package) = serde_json::from_str::<Value>(&raw)
    {
        for (dependency, name) in [
            ("react", "React"),
            ("vue", "Vue"),
            ("@angular/core", "Angular"),
            ("next", "Next.js"),
            ("electron", "Electron"),
        ] {
            if package["dependencies"].get(dependency).is_some()
                || package["devDependencies"].get(dependency).is_some()
            {
                frameworks.insert(name);
            }
        }
    }
    manifests.sort();
    plans.sort();
    let mut result = json!({"path": path, "exists": true, "isDirectory": true, "hasGit": path.join(".git").exists(),
        "projectFileExists": path.join(PROJECT_FILE_NAME).exists(), "manifests": manifests, "languages": languages,
        "frameworks": frameworks, "planFiles": plans});
    if let Some(readme) = readme {
        result["readme"] = json!(readme);
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Starter {
    summary: String,
    description: String,
    issue_type: String,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    name: String,
    key: String,
    #[serde(rename = "type")]
    project_type: ProjectType,
    purpose: String,
    brief: BTreeMap<String, String>,
    starting_point: String,
    storage: Option<ProjectStorage>,
    planning_mode: Option<ProjectPlanningMode>,
    folder_path: Option<String>,
    folder_name: Option<String>,
    workflow_stages: Vec<ProjectWorkflowStage>,
    starter_tickets: Vec<Starter>,
    /// Absent means project-board tools only, as a project created without one always got.
    #[serde(default)]
    default_ai_tool_mode: Option<String>,
}

pub fn list(catalog: &Catalog) -> Result<Vec<Value>> {
    catalog
        .list(PROJECTS)
        .into_iter()
        .filter(|project| {
            project["id"].is_string()
                && project["name"].is_string()
                && project["key"].is_string()
                && project["workflowStages"].is_array()
                && project["workItems"].is_array()
        })
        .map(|mut project| {
            let stages: Vec<ProjectWorkflowStage> =
                serde_json::from_value(project["workflowStages"].clone()).map_err(failure)?;
            project["workflowStages"] = json!(normalize_workflow_stages(Some(&stages)));
            Ok(project)
        })
        .collect()
}

pub fn require(catalog: &Catalog, id: &str) -> Result<Value> {
    list(catalog)?
        .into_iter()
        .find(|project| project["id"] == id)
        .ok_or_else(|| failure(format!("Project {id} was not found.")))
}

fn validate(project: &ProjectRecord) -> Result<()> {
    let key = project.key.as_bytes();
    if project.name.trim().is_empty() {
        return Err(failure("Project name is required."));
    }
    if key.is_empty()
        || key.len() > 15
        || !key[0].is_ascii_uppercase()
        || !key
            .iter()
            .all(|value| value.is_ascii_uppercase() || value.is_ascii_digit() || *value == b'_')
    {
        return Err(failure(
            "Project key must start with a letter and contain 1-15 uppercase letters, numbers, or underscores.",
        ));
    }
    if let Some(problem) = validate_workflow_stages(&project.workflow_stages) {
        return Err(failure(problem));
    }
    if project.work_items.iter().any(|item| {
        !project
            .workflow_stages
            .iter()
            .any(|stage| stage.name.eq_ignore_ascii_case(&item.status))
    }) {
        return Err(failure(
            "Every starter ticket must use one of the project workflow stages.",
        ));
    }
    if !["project-only", "read-only", "full"].contains(&project.default_ai_tool_mode.as_str()) {
        return Err(failure("Invalid project tool mode."));
    }
    if project.workspace_folder.is_none() {
        if project.default_ai_tool_mode != "project-only" {
            return Err(failure(
                "Folderless projects must use project-board tools only.",
            ));
        }
        if matches!(
            project.project_type,
            ProjectType::Software | ProjectType::Experiment
        ) {
            return Err(failure(
                "Software and Experiment projects require a workspace folder.",
            ));
        }
        if project.storage == Some(ProjectStorage::Folder) {
            return Err(failure(
                "A folder-backed project requires a workspace folder.",
            ));
        }
    }
    Ok(())
}

fn folder(start: &str, path: Option<&str>, name: Option<&str>) -> Result<Option<PathBuf>> {
    if start == "app-storage" {
        return Ok(None);
    }
    let path = path
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| failure("A project folder is required."))?;
    let path = absolute(Path::new(path.trim()))?;
    if !path.is_dir() {
        return Err(failure(format!(
            "{} is not an existing folder.",
            path.display()
        )));
    }
    match start {
        "existing-folder" => Ok(Some(fs::canonicalize(path).map_err(failure)?)),
        "new-folder" => {
            let name = name.unwrap_or("").trim();
            if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
                return Err(failure("A valid project folder name is required."));
            }
            let target = fs::canonicalize(path).map_err(failure)?.join(name);
            if fs::symlink_metadata(&target).is_ok() {
                return Err(failure(format!(
                    "The folder {} already exists. Choose Existing Folder instead.",
                    target.display()
                )));
            }
            Ok(Some(target))
        }
        _ => Err(failure("Invalid project starting point.")),
    }
}

fn snapshot(catalog: &mut Catalog, project: &mut ProjectRecord) -> Result<()> {
    let Some(folder) = project.workspace_folder.as_deref() else {
        return Ok(());
    };
    let path = Path::new(folder).join(PROJECT_FILE_NAME);
    let before = read(&path)?;
    let generated = render_project_snapshot(project);
    let next = match &before {
        None => Some(format!("{SNAPSHOT_BEGIN}\n{generated}{SNAPSHOT_END}\n")),
        Some(content) => match (content.find(SNAPSHOT_BEGIN), content.find(SNAPSHOT_END)) {
            (Some(begin), Some(end)) if end > begin => Some(format!(
                "{}{SNAPSHOT_BEGIN}\n{generated}{}",
                &content[..begin],
                &content[end..]
            )),
            _ => None,
        },
    };
    project.project_file_status = Some(if before.is_none() {
        ProjectFileStatus::Created
    } else {
        ProjectFileStatus::Retained
    });
    if let Some(next) = next {
        catalog.stage_text(path, before, next)?;
    }
    Ok(())
}

pub fn sync_connection(catalog: &mut Catalog, project: &Value, force: bool) {
    let id = project["id"].as_str().unwrap_or("");
    let connection_id = format!("project:{id}");
    let mut connections = catalog.list("connections");
    let mut boards = catalog.list("boards");
    let files = project["planningMode"] == "files";
    let folder = project["storage"] == "folder" && project["workspaceFolder"].is_string();
    if files {
        connections.retain(|connection| connection["id"] != connection_id);
        boards.retain(|board| board["connectionId"] != connection_id);
    } else {
        let mut settings = json!({"projectId": id, "projectKey": project["key"], "projectName": project["name"], "source": if folder {"folder"} else {"app"}, "allowIssueCreation": true});
        if folder {
            settings["roots"] = json!([project["workspaceFolder"]]);
        }
        let connection = json!({"id": connection_id, "name": project["name"], "mode": if folder {"folder"} else {"app"}, "settings": settings});
        if let Some(index) = connections
            .iter()
            .position(|value| value["id"] == connection_id)
        {
            if connections[index]["mode"] != connection["mode"] {
                boards.retain(|board| board["connectionId"] != connection_id);
            }
            if force || connections[index]["mode"] != connection["mode"] {
                connections[index] = connection;
            }
        } else {
            connections.push(connection);
        }
        let board_id = if folder {
            format!(
                "folder-{}",
                project["key"].as_str().unwrap_or("").to_lowercase()
            )
        } else {
            project["defaultBoardId"].as_str().unwrap_or("").to_owned()
        };
        if !boards
            .iter()
            .any(|board| board["connectionId"] == connection_id && board["boardId"] == board_id)
        {
            boards.push(json!({"connectionId": connection_id, "boardId": board_id, "displayName": project["name"]}));
        }
    }
    let owner = catalog.list(WORKSPACES).into_iter().find(|workspace| {
        workspace["projectIds"]
            .as_array()
            .is_some_and(|ids| ids.contains(&project["id"]))
    });
    let owner_id = owner
        .as_ref()
        .and_then(|workspace| workspace["id"].as_str());
    catalog.set("connections", connections, owner_id);
    catalog.set("boards", boards, owner_id);
}

fn create(catalog: &mut Catalog, args: &[Value], version: &str) -> Result<Value> {
    let workspace_id = text(args, 1)?;
    catalog
        .require(WORKSPACES, workspace_id)
        .map_err(|_| failure("Open a valid workspace before creating a project."))?;
    let input: CreateInput =
        serde_json::from_value(args.first().cloned().unwrap_or(Value::Null)).map_err(failure)?;
    let key = input.key.trim().to_uppercase();
    if list(catalog)?.iter().any(|project| {
        project["key"]
            .as_str()
            .is_some_and(|old| old.eq_ignore_ascii_case(&key))
    }) {
        return Err(failure(format!("Project key {key} is already in use.")));
    }
    let folder = folder(
        &input.starting_point,
        input.folder_path.as_deref(),
        input.folder_name.as_deref(),
    )?;
    if input.workflow_stages.len() < 2 {
        return Err(failure("At least two workflow stages are required."));
    }
    if input.planning_mode != Some(ProjectPlanningMode::Files)
        && input.starting_point != "existing-folder"
        && input.starter_tickets.is_empty()
    {
        return Err(failure("At least one starter ticket is required."));
    }
    let timestamp = now();
    let id = format!("project-{}", Uuid::new_v4());
    let storage = if folder.is_some() && input.storage == Some(ProjectStorage::Folder) {
        ProjectStorage::Folder
    } else {
        ProjectStorage::App
    };
    let mut project = ProjectRecord {
        id: id.clone(),
        name: input.name.trim().into(),
        key: key.clone(),
        project_type: input.project_type,
        purpose: input.purpose.trim().into(),
        brief: input
            .brief
            .into_iter()
            .map(|(key, value)| (key, value.trim().into()))
            .collect(),
        workspace_folder: folder
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        storage: Some(storage),
        planning_mode: Some(input.planning_mode.unwrap_or(ProjectPlanningMode::Board)),
        workflow_stages: normalize_workflow_stages(Some(&input.workflow_stages)),
        default_board_id: format!("{id}-board"),
        linked_boards: Vec::new(),
        default_ai_tool_mode: if folder.is_some() {
            input.default_ai_tool_mode.unwrap_or_else(|| "project-only".into())
        } else {
            "project-only".into()
        },
        work_items: if storage == ProjectStorage::Folder {
            Vec::new()
        } else {
            input
                .starter_tickets
                .into_iter()
                .enumerate()
                .map(|(index, item)| ProjectWorkItem {
                    id: format!("{id}-item-{}", index + 1),
                    key: format!("{key}-{}", index + 1),
                    summary: item.summary.trim().into(),
                    description: item.description.trim().into(),
                    issue_type: if item.issue_type.trim().is_empty() {
                        "Task".into()
                    } else {
                        item.issue_type.trim().into()
                    },
                    status: item.status,
                    created_at: timestamp.clone(),
                    updated_at: timestamp.clone(),
                    parent_key: None,
                    origin: None,
                })
                .collect()
        },
        project_file_status: Some(ProjectFileStatus::NotRequested),
        folder_inspection: None,
        recommended_workflow_template: None,
        icon: None,
        color: None,
        artifacts_folder: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    validate(&project)?;
    if let Some(folder) = &folder {
        if input.starting_point == "new-folder" {
            catalog.create_directory(folder)?;
        }
        snapshot(catalog, &mut project)?;
        let mut inspection = inspect(folder)?;
        inspection["projectFileExists"] = json!(true);
        project.folder_inspection = Some(serde_json::from_value(inspection).map_err(failure)?);
    }
    let value = serde_json::to_value(project).map_err(failure)?;
    catalog.replace(PROJECTS, value.clone(), Some(workspace_id));
    use_existing(catalog, &id, workspace_id, version)?;
    sync_connection(catalog, &value, true);
    Ok(value)
}

pub fn use_existing(
    catalog: &mut Catalog,
    id: &str,
    workspace_id: &str,
    version: &str,
) -> Result<Value> {
    let project = require(catalog, id)?;
    let workspace = catalog.require(WORKSPACES, workspace_id)?;
    let mut ids = workspace["projectIds"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if !ids.contains(&json!(id)) {
        ids.push(json!(id));
        let mut patch = json!({"projectIds": ids});
        if !workspace["defaultProjectId"].is_string() {
            patch["defaultProjectId"] = json!(id);
        }
        super::workspaces::update(catalog, workspace_id, &patch, version)?;
    }
    Ok(project)
}

fn document(path: &Path, root: &Path, include_content: bool) -> Result<Value> {
    let relative = path.strip_prefix(root).map_err(failure)?;
    let mut file = open_sandboxed_file(root, relative, false).map_err(failure)?;
    let mut content = String::new();
    std::io::Read::read_to_string(&mut file, &mut content).map_err(failure)?;
    let mut name = extract_front_matter_value(&content, "name")
        .or_else(|| extract_front_matter_value(&content, "title"))
        .unwrap_or_else(|| extract_main_heading(&content));
    if name.is_empty() {
        name = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .replace(['-', '_'], " ");
    }
    let kind = extract_type_raw(&content).unwrap_or_default();
    let status = extract_status_raw(&content);
    let mut result = json!({"relativePath": relative.to_string_lossy().replace('\\', "/"), "name": name, "type": if kind.is_empty() { "Other" } else { &kind }});
    if !status.trim().is_empty() {
        result["status"] = json!(
            status
                .trim()
                .trim_start_matches(|ch: char| !ch.is_ascii_alphanumeric())
                .replace(['-', '_'], " ")
        );
    }
    if include_content {
        result["content"] = json!(content);
    }
    Ok(result)
}

fn normalize_artifacts_folder(raw: &str) -> Result<Option<String>> {
    let value = raw.trim().replace('\\', "/");
    if value.is_empty() {
        return Ok(None);
    }
    if value.starts_with('/') || value.contains(':') {
        return Err(failure(
            "Artifacts folder must be a path inside the repository.",
        ));
    }
    let segments = value
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>();
    if segments.contains(&"..") {
        return Err(failure(
            "Artifacts folder cannot go above the repository root.",
        ));
    }
    if segments.is_empty() {
        return Err(failure(
            "Choose a folder inside the repository, not the repository root itself.",
        ));
    }
    if segments[0].eq_ignore_ascii_case(".git") {
        return Err(failure("Artifacts folder cannot be inside .git."));
    }
    Ok(Some(segments.join("/")))
}

fn update(catalog: &mut Catalog, id: &str, patch: &Value) -> Result<Value> {
    if !patch.is_object() {
        return Err(failure("Project patch must be an object."));
    }
    let mut value = require(catalog, id)?;
    for field in [
        "planningMode",
        "storage",
        "type",
        "brief",
        "workflowStages",
        "defaultAiToolMode",
        "icon",
        "color",
    ] {
        if let Some(change) = patch.get(field).filter(|value| !value.is_null()) {
            value[field] = change.clone();
        }
    }
    for field in ["name", "key", "purpose"] {
        if let Some(change) = patch.get(field).filter(|value| !value.is_null()) {
            let change = change
                .as_str()
                .ok_or_else(|| failure(format!("{field} must be a string.")))?
                .trim();
            value[field] = json!(if field == "key" {
                change.to_uppercase()
            } else {
                change.to_owned()
            });
        }
    }
    if let Some(change) = patch.get("artifactsFolder") {
        let normalized = normalize_artifacts_folder(
            change
                .as_str()
                .ok_or_else(|| failure("Artifacts folder must be a string."))?,
        )?;
        if let Some(folder) = normalized {
            value["artifactsFolder"] = json!(folder);
        } else {
            value
                .as_object_mut()
                .ok_or_else(|| failure("Invalid project."))?
                .remove("artifactsFolder");
        }
    }
    if let Some(icon) = value["icon"].as_str()
        && !praxis_core::projects::PROJECT_ICON_NAMES.contains(&icon)
    {
        return Err(failure("Invalid project icon."));
    }
    if let Some(color) = value["color"].as_str()
        && !praxis_core::projects::PROJECT_COLOR_NAMES.contains(&color)
    {
        return Err(failure("Invalid project color."));
    }
    let mut project: ProjectRecord = serde_json::from_value(value.clone()).map_err(failure)?;
    project.workflow_stages = normalize_workflow_stages(Some(&project.workflow_stages));
    project.updated_at = now();
    validate(&project)?;
    if list(catalog)?.iter().any(|other| {
        other["id"] != id
            && other["key"]
                .as_str()
                .is_some_and(|key| key.eq_ignore_ascii_case(&project.key))
    }) {
        return Err(failure(format!(
            "Project key {} is already in use.",
            project.key
        )));
    }
    if (patch.get("workflowStages").is_some()
        || patch.get("purpose").is_some()
        || patch.get("brief").is_some())
        && let Err(error) = snapshot(catalog, &mut project)
    {
        eprintln!("Project snapshot refresh failed: {}", error.message);
    }
    // Preserve fields not owned by this version of the application.
    value
        .as_object_mut()
        .ok_or_else(|| failure("Invalid project."))?
        .extend(
            serde_json::to_value(&project)
                .map_err(failure)?
                .as_object()
                .ok_or_else(|| failure("Invalid project."))?
                .clone(),
        );
    if patch.get("artifactsFolder").is_some() && project.artifacts_folder.is_none() {
        value
            .as_object_mut()
            .ok_or_else(|| failure("Invalid project."))?
            .remove("artifactsFolder");
    }
    catalog.replace(PROJECTS, value.clone(), None);
    if patch.get("planningMode").is_some() || patch.get("storage").is_some() {
        sync_connection(catalog, &value, true);
    }
    if patch.get("workflowStages").is_some()
        && project.storage == Some(ProjectStorage::Folder)
        && let Some(folder) = &project.workspace_folder
    {
        // The workflow is board identity and must travel with the plans root.
        for root in discover_plan_folders(folder).unwrap_or_default() {
            let path =
                Path::new(&root.plans_root_path).join(praxis_core::folder::BOARD_CONFIG_FILENAME);
            let config = praxis_core::folder::BoardConfigFile {
                project_key: Some(project.key.clone()),
                project_name: Some(project.name.clone()),
                allow_issue_creation: None,
                workflow: Some(project.workflow_stages.clone()),
            };
            if let Err(error) = catalog.stage(path, serde_json::to_value(config).map_err(failure)?)
            {
                eprintln!("Board configuration refresh failed: {}", error.message);
            }
        }
    }
    Ok(value)
}

fn remove(catalog: &mut Catalog, id: &str, version: &str) -> Result<Value> {
    require(catalog, id)?;
    let owned: BTreeSet<String> = catalog
        .list("connections")
        .into_iter()
        .filter(|connection| connection["settings"]["projectId"] == id)
        .filter_map(|connection| connection["id"].as_str().map(str::to_owned))
        .collect();
    catalog.set(
        PROJECTS,
        catalog
            .list(PROJECTS)
            .into_iter()
            .filter(|project| project["id"] != id)
            .collect(),
        None,
    );
    catalog.set(
        "connections",
        catalog
            .list("connections")
            .into_iter()
            .filter(|connection| !owned.contains(connection["id"].as_str().unwrap_or("")))
            .collect(),
        None,
    );
    catalog.set(
        "boards",
        catalog
            .list("boards")
            .into_iter()
            .filter(|board| !owned.contains(board["connectionId"].as_str().unwrap_or("")))
            .collect(),
        None,
    );
    for workspace in catalog.list(WORKSPACES) {
        let ids = workspace["projectIds"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if ids.contains(&json!(id)) {
            let mut patch = json!({"projectIds": ids.into_iter().filter(|project_id| *project_id != id).collect::<Vec<_>>()});
            if workspace["defaultProjectId"] == id {
                patch["defaultProjectId"] = Value::Null;
            }
            super::workspaces::update(
                catalog,
                workspace["id"]
                    .as_str()
                    .ok_or_else(|| failure("Invalid workspace id."))?,
                &patch,
                version,
            )?;
        }
    }
    Ok(Value::Null)
}

fn attach(catalog: &mut Catalog, args: &[Value]) -> Result<Value> {
    let id = text(args, 0)?;
    let mut value = require(catalog, id)?;
    if value["workspaceFolder"].is_string() {
        return Err(failure("This project already has a workspace folder."));
    }
    let input = args
        .get(1)
        .ok_or_else(|| failure("Folder input is required."))?;
    let start = input["startingPoint"]
        .as_str()
        .ok_or_else(|| failure("Folder starting point is required."))?;
    if start == "app-storage" {
        return Err(failure("Choose a new or existing folder."));
    }
    let folder = folder(
        start,
        input["folderPath"].as_str(),
        input["folderName"].as_str(),
    )?
    .ok_or_else(|| failure("Folder is required."))?;
    if start == "new-folder" {
        catalog.create_directory(&folder)?;
    }
    value["workspaceFolder"] = json!(folder);
    value["defaultAiToolMode"] = json!(if value["type"] == "software"
        || value["type"] == "experiment"
    {
        "full"
    } else {
        "read-only"
    });
    value["updatedAt"] = json!(now());
    let mut project: ProjectRecord = serde_json::from_value(value.clone()).map_err(failure)?;
    project.project_file_status = Some(ProjectFileStatus::NotRequested);
    validate(&project)?;
    if input["createProjectFile"] != false {
        snapshot(catalog, &mut project)?;
    }
    let mut inspection = inspect(&folder)?;
    inspection["projectFileExists"] = json!(
        folder.join(PROJECT_FILE_NAME).exists()
            || project.project_file_status == Some(ProjectFileStatus::Created)
    );
    project.folder_inspection = Some(serde_json::from_value(inspection).map_err(failure)?);
    value
        .as_object_mut()
        .ok_or_else(|| failure("Invalid project."))?
        .extend(
            serde_json::to_value(&project)
                .map_err(failure)?
                .as_object()
                .ok_or_else(|| failure("Invalid project."))?
                .clone(),
        );
    catalog.replace(PROJECTS, value.clone(), None);
    sync_connection(catalog, &value, true);
    Ok(json!({"project": value, "projectFileStatus": project.project_file_status}))
}

fn link(catalog: &mut Catalog, args: &[Value], remove: bool) -> Result<Value> {
    let id = text(args, 0)?;
    let mut project = require(catalog, id)?;
    let mut links = project["linkedBoards"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if remove {
        links.retain(|link| link["connectionId"] != args[1] || link["boardId"] != args[2]);
    } else {
        let board = args
            .get(1)
            .ok_or_else(|| failure("Board reference is required."))?;
        for field in ["connectionId", "boardId", "displayName"] {
            if board[field]
                .as_str()
                .is_none_or(|value| value.trim().is_empty())
            {
                return Err(failure("A complete board reference is required."));
            }
        }
        for other in list(catalog)? {
            if other["id"] != id
                && other["linkedBoards"].as_array().is_some_and(|links| {
                    links.iter().any(|link| {
                        link["connectionId"] == board["connectionId"]
                            && link["boardId"] == board["boardId"]
                    })
                })
            {
                return Err(failure(format!(
                    "Board {} is already linked to {}.",
                    board["displayName"], other["name"]
                )));
            }
        }
        if !links.iter().any(|link| {
            link["connectionId"] == board["connectionId"] && link["boardId"] == board["boardId"]
        }) {
            links.push(board.clone());
        }
    }
    project["linkedBoards"] = json!(links);
    project["updatedAt"] = json!(now());
    catalog.replace(PROJECTS, project.clone(), None);
    Ok(project)
}

pub fn dispatch(
    catalog: &mut Catalog,
    channel: &str,
    args: &[Value],
    version: &str,
) -> Result<Value> {
    match channel {
        "projects:list" => Ok(json!(list(catalog)?)),
        "projects:get" => Ok(list(catalog)?
            .into_iter()
            .find(|project| project["id"] == args.first().cloned().unwrap_or(Value::Null))
            .unwrap_or(Value::Null)),
        "projects:create" => create(catalog, args, version),
        "projects:update" => update(
            catalog,
            text(args, 0)?,
            args.get(1)
                .ok_or_else(|| failure("Project patch is required."))?,
        ),
        "projects:remove" => remove(catalog, text(args, 0)?, version),
        "projects:attachFolder" => attach(catalog, args),
        "projects:linkBoard" => link(catalog, args, false),
        "projects:unlinkBoard" => {
            text(args, 1)?;
            text(args, 2)?;
            link(catalog, args, true)
        }
        "projects:useExisting" => use_existing(catalog, text(args, 0)?, text(args, 1)?, version),
        "projects:inspectFolder" => inspect(Path::new(text(args, 0)?)),
        "projects:listDocuments" | "projects:readDocument" => {
            let project = require(catalog, text(args, 0)?)?;
            let folder = project["workspaceFolder"].as_str();
            let Some(folder) = folder else {
                if channel == "projects:readDocument" {
                    return Err(failure("This project has no workspace folder."));
                }
                return Ok(json!({"exists": false, "documents": []}));
            };
            let root = resolve_sandboxed_path(folder, "docs/plans").map_err(failure)?;
            if channel == "projects:readDocument" {
                let relative = Path::new(text(args, 1)?);
                if relative
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_none_or(|extension| !extension.eq_ignore_ascii_case("md"))
                {
                    return Err(failure("That project document is outside docs/plans."));
                }
                return document(&root.join(relative), &root, true);
            }
            if !root.is_dir() {
                return Ok(json!({"exists": false, "documents": []}));
            }
            let mut files = Vec::new();
            walk(&root, 0, 12, 2000, &mut files);
            let documents = files
                .iter()
                .filter(|path| {
                    path.extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
                })
                .map(|path| document(path, &root, false))
                .collect::<Result<Vec<_>>>()?;
            Ok(json!({"exists": true, "documents": documents}))
        }
        "projects:discoverImports" => discover_imports(catalog, text(args, 0)?),
        "projects:validateImports" => validate_imports(catalog, args.first()),
        "projects:createFromImports" => create_from_imports(catalog, args, version),
        _ => Err(failure("Unknown project operation.")),
    }
}

fn discover_imports(catalog: &Catalog, folder_path: &str) -> Result<Value> {
    let base = Path::new(folder_path);
    if !base.is_dir() {
        return Ok(json!([]));
    }
    let existing_paths: BTreeSet<String> = catalog
        .list(PROJECTS)
        .iter()
        .filter(|p| p["storage"] == "folder")
        .filter_map(|p| p["workspaceFolder"].as_str().map(|s| s.to_lowercase()))
        .collect();
    let existing_keys: BTreeSet<String> = catalog
        .list(PROJECTS)
        .iter()
        .filter_map(|p| p["key"].as_str().map(|s| s.to_uppercase()))
        .collect();

    let discovered = discover_plan_folders(folder_path).unwrap_or_default();
    let mut rows = Vec::new();
    let mut used_keys = existing_keys;

    if discovered.is_empty() {
        let name = base
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Project");
        let clean_name = name.replace(['-', '_'], " ");
        let mut key = clean_name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(15)
            .collect::<String>()
            .to_uppercase();
        if key.is_empty() || !key.chars().next().unwrap_or(' ').is_ascii_alphabetic() {
            key = "PLANS".into();
        }
        let base_key = key.clone();
        let mut counter = 2;
        while used_keys.contains(&key) {
            key = format!("{base_key}{counter}");
            counter += 1;
        }
        used_keys.insert(key.clone());
        let plans_path = base.to_string_lossy().into_owned();
        let already_added = existing_paths.contains(&plans_path.to_lowercase());
        rows.push(json!({
            "repositoryName": clean_name,
            "repositoryRootPath": plans_path,
            "plansFolderPath": plans_path,
            "projectKey": key,
            "projectName": clean_name,
            "alreadyAdded": already_added
        }));
    } else {
        for root in discovered {
            let path_str = root.plans_root_path.clone();
            let p = Path::new(&path_str);
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("Project");
            let clean_name = name.replace(['-', '_'], " ");
            let mut key = clean_name
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(15)
                .collect::<String>()
                .to_uppercase();
            if key.is_empty() || !key.chars().next().unwrap_or(' ').is_ascii_alphabetic() {
                key = "PLANS".into();
            }
            let base_key = key.clone();
            let mut counter = 2;
            while used_keys.contains(&key) {
                key = format!("{base_key}{counter}");
                counter += 1;
            }
            used_keys.insert(key.clone());
            let already_added = existing_paths.contains(&path_str.to_lowercase());
            rows.push(json!({
                "repositoryName": clean_name,
                "repositoryRootPath": path_str,
                "plansFolderPath": path_str,
                "projectKey": key,
                "projectName": clean_name,
                "alreadyAdded": already_added
            }));
        }
    }
    Ok(json!(rows))
}

fn validate_imports(catalog: &Catalog, rows_val: Option<&Value>) -> Result<Value> {
    let Some(rows) = rows_val.and_then(Value::as_array) else {
        return Ok(Value::Null);
    };
    let mut keys: BTreeSet<String> = catalog
        .list(PROJECTS)
        .iter()
        .filter_map(|p| p["key"].as_str().map(|s| s.to_uppercase()))
        .collect();

    for row in rows {
        if row["alreadyAdded"].as_bool().unwrap_or(false) {
            continue;
        }
        let key = row["projectKey"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_uppercase();
        if key.is_empty()
            || !key.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || key.len() > 15
        {
            return Ok(json!(format!(
                "Project code \"{}\" is invalid. Use 1-15 letters, numbers, or underscore, starting with a letter.",
                row["projectKey"].as_str().unwrap_or("")
            )));
        }
        if keys.contains(&key) {
            return Ok(json!(format!(
                "Project code \"{key}\" is used more than once. Give each repository a unique code."
            )));
        }
        keys.insert(key);
        let name = row["projectName"].as_str().unwrap_or("").trim();
        if name.is_empty() {
            return Ok(json!("Every folder needs a project name."));
        }
    }
    Ok(Value::Null)
}

fn create_from_imports(catalog: &mut Catalog, args: &[Value], version: &str) -> Result<Value> {
    let rows = args
        .first()
        .and_then(Value::as_array)
        .ok_or_else(|| failure("Project import rows are required."))?;
    let workspace_id = text(args, 1)?;
    catalog
        .require(WORKSPACES, workspace_id)
        .map_err(|_| failure("Open a valid workspace before importing projects."))?;

    let validation = validate_imports(catalog, args.first())?;
    if let Some(err_msg) = validation.as_str() {
        return Err(failure(err_msg));
    }

    let mut created = Vec::new();
    for row in rows {
        if row["alreadyAdded"].as_bool().unwrap_or(false) {
            continue;
        }
        let id = format!("project-{}", Uuid::new_v4());
        let name = row["projectName"].as_str().unwrap_or("Project").trim();
        let key = row["projectKey"]
            .as_str()
            .unwrap_or("PROJ")
            .trim()
            .to_uppercase();
        let plans_path = row["plansFolderPath"].as_str().unwrap_or("");
        let timestamp = now();
        let project = json!({
            "id": id,
            "name": name,
            "key": key,
            "type": "software",
            "purpose": "",
            "brief": {},
            "storage": "folder",
            "workspaceFolder": plans_path,
            "workflowStages": [
                { "id": format!("{id}-backlog"), "name": "Backlog" },
                { "id": format!("{id}-done"), "name": "Done" }
            ],
            "defaultBoardId": format!("{id}-board"),
            "workItems": [],
            "linkedBoards": [],
            "defaultAiToolMode": "full",
            "createdAt": timestamp,
            "updatedAt": timestamp
        });
        catalog.replace(PROJECTS, project.clone(), Some(workspace_id));
        use_existing(catalog, &id, workspace_id, version)?;
        sync_connection(catalog, &project, false);
        created.push(project);
    }
    Ok(json!(created))
}

/// Preserve legacy project data while repairing missing storage/connection
/// metadata, as the Electron startup boundary does. Unreadable folders are left
/// untouched so another launch can retry them.
pub fn heal(catalog: &mut Catalog) -> Result<()> {
    for mut project in list(catalog)? {
        if project["storage"].is_null()
            && project["workItems"].as_array().is_some_and(Vec::is_empty)
            && let Some(folder) = project["workspaceFolder"].as_str()
            && let Ok(roots) = discover_plan_folders(folder)
        {
            let folder_backed = !roots.is_empty();
            project["storage"] = json!(if folder_backed { "folder" } else { "app" });
            project["updatedAt"] = json!(now());
            if folder_backed {
                let companion = format!("project-plans-{}", project["id"].as_str().unwrap_or(""));
                let links = project["linkedBoards"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|link| link["connectionId"] != companion)
                    .collect::<Vec<_>>();
                project["linkedBoards"] = json!(links);
                catalog.set(
                    "connections",
                    catalog
                        .list("connections")
                        .into_iter()
                        .filter(|connection| connection["id"] != companion)
                        .collect(),
                    None,
                );
                catalog.set(
                    "boards",
                    catalog
                        .list("boards")
                        .into_iter()
                        .filter(|board| board["connectionId"] != companion)
                        .collect(),
                    None,
                );
            }
            catalog.replace(PROJECTS, project.clone(), None);
        }
        sync_connection(catalog, &project, false);
    }
    Ok(())
}
