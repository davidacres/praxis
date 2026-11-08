//! Live `.workspace.praxis.json` file store (`WorkspaceFileStore` & `create_workspace_file`).

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use super::workspace_types::{
    CURRENT_WORKSPACE_SCHEMA_VERSION, PRAXIS_WORKSPACE_FORMAT, WorkspaceFile, WorkspaceRecord,
    read_workspace_file, strip_secrets_from_connections,
};

/// Store key for workspace records.
pub const WORKSPACES_KEY: &str = "praxis.workspaces.v1";
/// Store key for project records.
pub const PROJECTS_KEY: &str = "praxis.projects.v1";
/// Store key for connection records.
pub const CONNECTIONS_KEY: &str = "connections";
/// Store key for tracked boards.
pub const BOARDS_KEY: &str = "boards";

/// A single `.workspace.praxis.json` file presented as a key-value store.
#[derive(Debug, Clone)]
pub struct WorkspaceFileStore {
    file_path: PathBuf,
    document: WorkspaceFile,
}

impl WorkspaceFileStore {
    /// Loads a `.workspace.praxis.json` file from `file_path`.
    ///
    /// # Errors
    /// Returns an error if the file cannot be read or is not a valid Praxis workspace file.
    pub fn open(file_path: impl Into<PathBuf>) -> io::Result<Self> {
        let file_path = file_path.into();
        let document = Self::load_from_path(&file_path)?;
        Ok(Self {
            file_path,
            document,
        })
    }

    /// Returns the path of the `.workspace.praxis.json` file.
    #[must_use]
    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    /// Returns the ID of the workspace stored in this file.
    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.document.workspace.id
    }

    /// Reads one of the four workspace-scoped collections (`praxis.workspaces.v1`, `praxis.projects.v1`, `connections`, `boards`).
    #[must_use]
    pub fn get(&self, key: &str) -> Option<Value> {
        match key {
            WORKSPACES_KEY => {
                let mut stamped = self.document.workspace.clone();
                stamped.storage_path = Some(self.file_path.to_string_lossy().into_owned());
                serde_json::to_value(vec![stamped]).ok()
            }
            PROJECTS_KEY => Some(Value::Array(
                self.document.projects.clone().unwrap_or_default(),
            )),
            CONNECTIONS_KEY => Some(Value::Array(
                self.document.connections.clone().unwrap_or_default(),
            )),
            BOARDS_KEY => Some(Value::Array(
                self.document.boards.clone().unwrap_or_default(),
            )),
            _ => None,
        }
    }

    /// Updates one of the four workspace-scoped keys and persists the document atomically.
    ///
    /// # Errors
    /// Returns an error if disk persistence fails.
    pub fn update(&mut self, key: &str, value: &Value) -> io::Result<()> {
        let mut next = self.document.clone();
        match key {
            WORKSPACES_KEY => {
                let Some(arr) = value.as_array() else {
                    return Ok(());
                };
                let records: Vec<WorkspaceRecord> = arr
                    .iter()
                    .filter_map(|v| serde_json::from_value::<WorkspaceRecord>(v.clone()).ok())
                    .collect();
                let record = records
                    .iter()
                    .find(|item| item.id == self.document.workspace.id)
                    .or_else(|| records.first())
                    .cloned();
                let Some(mut record) = record else {
                    return Ok(());
                };
                record.storage_path = None;
                next.last_saved_with_app_version = record.last_saved_with_app_version.clone();
                next.workspace = record;
            }
            PROJECTS_KEY => {
                next.projects = Some(value.as_array().cloned().unwrap_or_default());
            }
            CONNECTIONS_KEY => {
                let raw_conns = value.as_array().cloned().unwrap_or_default();
                next.connections = Some(strip_secrets_from_connections(&raw_conns));
            }
            BOARDS_KEY => {
                next.boards = Some(value.as_array().cloned().unwrap_or_default());
            }
            _ => return Ok(()),
        }

        self.persist_document(&next)?;
        self.document = next;
        Ok(())
    }

    fn load_from_path(file_path: &Path) -> io::Result<WorkspaceFile> {
        let raw = fs::read_to_string(file_path)?;
        let dir = file_path.parent().map(|p| p.to_string_lossy().into_owned());
        let parsed = read_workspace_file(&raw, dir.as_deref())
            .map_err(|msg| io::Error::new(io::ErrorKind::InvalidData, msg))?;
        Ok(WorkspaceFile {
            format: PRAXIS_WORKSPACE_FORMAT.to_string(),
            schema_version: CURRENT_WORKSPACE_SCHEMA_VERSION,
            created_with_app_version: parsed.workspace.created_with_app_version.clone(),
            last_saved_with_app_version: parsed.workspace.last_saved_with_app_version.clone(),
            workspace: parsed.workspace,
            projects: Some(parsed.projects.unwrap_or_default()),
            connections: Some(strip_secrets_from_connections(
                &parsed.connections.unwrap_or_default(),
            )),
            boards: Some(parsed.boards.unwrap_or_default()),
        })
    }

    fn persist_document(&self, doc: &WorkspaceFile) -> io::Result<()> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let temp_path = PathBuf::from(format!(
            "{}.{}.{}.tmp",
            self.file_path.display(),
            std::process::id(),
            nanos
        ));
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(doc).unwrap_or_else(|_| json!({}).to_string())
        );
        fs::write(&temp_path, text)?;
        if let Err(err) = fs::rename(&temp_path, &self.file_path) {
            let _ = fs::remove_file(&temp_path);
            return Err(err);
        }
        Ok(())
    }
}

/// Writes a brand-new, empty `.workspace.praxis.json` file using exclusive creation (`create_new`),
/// failing if a file already exists at `file_path`.
///
/// # Errors
/// Returns an `io::Error` (`AlreadyExists` if the file already exists).
pub fn create_workspace_file(file_path: &Path, workspace: &WorkspaceRecord) -> io::Result<()> {
    let mut stored = workspace.clone();
    stored.storage_path = None;
    let document = WorkspaceFile {
        format: PRAXIS_WORKSPACE_FORMAT.to_string(),
        schema_version: CURRENT_WORKSPACE_SCHEMA_VERSION,
        created_with_app_version: workspace.created_with_app_version.clone(),
        last_saved_with_app_version: workspace.last_saved_with_app_version.clone(),
        workspace: stored,
        projects: Some(Vec::new()),
        connections: Some(Vec::new()),
        boards: Some(Vec::new()),
    };
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut handle = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(file_path)?;
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&document).map_err(|err| io::Error::other(err.to_string()))?
    );
    handle.write_all(text.as_bytes())?;
    handle.flush()
}
