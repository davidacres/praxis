//! Desktop metadata collections and recoverable multi-file writes.
//! Portable workspace files remain authoritative and are never deleted on removal.
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use praxis_core::workspaces::{
    WorkspaceContents, WorkspaceRecord, read_workspace_file, to_workspace_file,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{Result, failure};

pub const WORKSPACES: &str = "praxis.workspaces.v1";
pub const PROJECTS: &str = "praxis.projects.v1";
pub const LOCATIONS: &str = "praxis.workspaceLocations.v1";
const JOURNAL: &str = "desktop-transaction.praxis.json";

#[derive(Clone)]
struct Document {
    path: PathBuf,
    before: Option<String>,
    value: Value,
    scope: Option<String>,
    dirty: bool,
    text: Option<String>,
}

pub struct Catalog {
    root: PathBuf,
    documents: Vec<Document>,
    locations: Value,
    locations_before: Option<String>,
    created_folders: Vec<PathBuf>,
    committed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Change {
    path: PathBuf,
    before: Option<String>,
    after: String,
}

pub(super) fn read(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failure(format!("Cannot read {}: {error}", path.display()))),
    }
}

pub(super) fn parse(path: &Path, raw: Option<&str>) -> Result<Value> {
    let value = match raw {
        Some(raw) => serde_json::from_str(raw)
            .map_err(|error| failure(format!("Invalid JSON in {}: {error}", path.display())))?,
        None => json!({}),
    };
    if !value.is_object() {
        return Err(failure(format!(
            "{} must contain a JSON object.",
            path.display()
        )));
    }
    Ok(value)
}

pub(super) fn encoded(value: &Value) -> Result<String> {
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(value).map_err(failure)?
    ))
}

fn preflight(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| failure("File has no parent directory."))?;
    fs::create_dir_all(parent).map_err(failure)?;
    let temporary = parent.join(format!(".praxis-preflight-{}.tmp", Uuid::new_v4()));
    let result = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(failure);
    if result.is_ok() {
        fs::remove_file(&temporary).map_err(failure)?;
    }
    result.map(|_| ())
}

pub(super) fn write_atomic(path: &Path, value: &str, create_new: bool) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| failure("File has no parent directory."))?;
    fs::create_dir_all(parent).map_err(failure)?;
    let temporary = parent.join(format!(".praxis-write-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(failure)?;
        file.write_all(value.as_bytes()).map_err(failure)?;
        file.sync_all().map_err(failure)?;
        if create_new {
            // A hard link provides exclusive publication without a check/rename
            // race that could overwrite a file created by another program.
            fs::hard_link(&temporary, path).map_err(failure)?;
            fs::remove_file(&temporary).map_err(failure)?;
        } else {
            fs::rename(&temporary, path).map_err(failure)?;
        }
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(failure)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

/// An interrupted write rolls forward only while every target still contains
/// its expected old/new bytes. An external edit stops recovery, rather than
/// silently overwriting a person's newer data.
pub fn recover(root: &Path) -> Result<()> {
    let journal = root.join(JOURNAL);
    let Some(raw) = read(&journal)? else {
        return Ok(());
    };
    let changes: Vec<Change> = serde_json::from_str(&raw).map_err(failure)?;
    for change in &changes {
        let current = read(&change.path)?;
        if current.as_deref() != Some(&change.after) && current != change.before {
            return Err(failure(format!(
                "Desktop write recovery stopped: {} changed outside this transaction. Preserve the journal at {} before repairing it.",
                change.path.display(),
                journal.display()
            )));
        }
    }
    for change in &changes {
        if read(&change.path)?.as_deref() != Some(&change.after) {
            write_atomic(&change.path, &change.after, change.before.is_none())?;
        }
    }
    fs::remove_file(&journal).map_err(failure)?;
    Ok(())
}

impl Catalog {
    pub fn is_dirty(&self) -> bool {
        self.documents.iter().any(|document| document.dirty)
            || self
                .locations_before
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .unwrap_or_else(|| json!({}))
                != self.locations
    }
    pub fn load(root: &Path, settings: &Path) -> Result<Self> {
        recover(root)?;
        let mut documents = Vec::new();
        for path in [
            root.join("workspaces.json"),
            root.join("projects.json"),
            settings.to_owned(),
        ] {
            let before = read(&path)?;
            let value = parse(&path, before.as_deref())?;
            documents.push(Document {
                path,
                before,
                value,
                scope: None,
                dirty: false,
                text: None,
            });
        }
        let location_path = root.join("workspace-locations.json");
        let locations_before = read(&location_path)?;
        let locations = parse(&location_path, locations_before.as_deref())?;
        for location in locations[LOCATIONS].as_array().into_iter().flatten() {
            let (Some(id), Some(path)) = (location["id"].as_str(), location["path"].as_str())
            else {
                continue;
            };
            let path = PathBuf::from(path);
            let loaded = (|| {
                let before = read(&path)?.ok_or_else(|| failure("Workspace file is missing."))?;
                let parent = path
                    .parent()
                    .map(|parent| parent.to_string_lossy().into_owned());
                let parsed = read_workspace_file(&before, parent.as_deref()).map_err(failure)?;
                if parsed.workspace.id != id {
                    return Err(failure(
                        "Workspace identity does not match its registered location.",
                    ));
                }
                let mut value = parse(&path, Some(&before))?;
                value["workspace"] = serde_json::to_value(parsed.workspace).map_err(failure)?;
                value["projects"] = json!(parsed.projects.unwrap_or_default());
                value["connections"] = json!(parsed.connections.unwrap_or_default());
                value["boards"] = json!(parsed.boards.unwrap_or_default());
                Ok(Document {
                    path: path.clone(),
                    before: Some(before),
                    value,
                    scope: Some(id.to_owned()),
                    dirty: false,
                    text: None,
                })
            })();
            match loaded {
                Ok(document) => documents.push(document),
                Err(error) => eprintln!(
                    "Workspace {} is unavailable: {}",
                    path.display(),
                    error.message
                ),
            }
        }
        Ok(Self {
            root: root.to_owned(),
            documents,
            locations,
            locations_before,
            created_folders: Vec::new(),
            committed: false,
        })
    }

    fn collection(document: &Document, key: &str) -> Vec<Value> {
        if document.text.is_some() {
            return Vec::new();
        }
        if document.scope.is_some() && key == WORKSPACES {
            let mut workspace = document.value["workspace"].clone();
            workspace["storagePath"] = json!(document.path);
            vec![workspace]
        } else {
            let key = if document.scope.is_some() && key == PROJECTS {
                "projects"
            } else {
                key
            };
            document.value[key].as_array().cloned().unwrap_or_default()
        }
    }

    pub fn list(&self, key: &str) -> Vec<Value> {
        let mut merged: Vec<Value> = Vec::new();
        for (index, document) in self.documents.iter().enumerate() {
            if document.scope.is_none() && index != base_index(key) {
                continue;
            }
            for value in Self::collection(document, key) {
                let identity = identity(&value);
                if let Some(index) = identity.as_ref().and_then(|id| {
                    merged
                        .iter()
                        .position(|candidate| identity_of(candidate).as_ref() == Some(id))
                }) {
                    merged[index] = value;
                } else {
                    merged.push(value);
                }
            }
        }
        merged
    }

    pub fn get(&self, key: &str, id: &str) -> Option<Value> {
        self.list(key).into_iter().find(|value| value["id"] == id)
    }

    pub fn require(&self, key: &str, id: &str) -> Result<Value> {
        self.get(key, id)
            .ok_or_else(|| failure(format!("Record {id} was not found.")))
    }

    pub fn set(&mut self, key: &str, values: Vec<Value>, preferred: Option<&str>) {
        let mut owners = BTreeMap::new();
        for (index, document) in self.documents.iter().enumerate() {
            if document.scope.is_none() && index != base_index(key) {
                continue;
            }
            for value in Self::collection(document, key) {
                if let Some(id) = identity(&value) {
                    owners.insert(id, index);
                }
            }
        }
        let base = base_index(key);
        let preferred = self
            .documents
            .iter()
            .position(|document| document.scope.as_deref() == preferred && preferred.is_some())
            .unwrap_or(base);
        let mut buckets = vec![Vec::new(); self.documents.len()];
        for value in values {
            let index = identity(&value)
                .and_then(|id| owners.get(&id).copied())
                .unwrap_or(preferred);
            buckets[index].push(value);
        }
        for (index, document) in self.documents.iter_mut().enumerate() {
            if document.text.is_some() {
                continue;
            }
            if document.scope.is_some() && key == WORKSPACES {
                if let Some(workspace) = buckets[index].first() {
                    let mut workspace = workspace.clone();
                    if let Some(record) = workspace.as_object_mut() {
                        record.remove("storagePath");
                    }
                    if document.value["workspace"] != workspace {
                        document.value["workspace"] = workspace;
                        document.dirty = true;
                    }
                }
            } else {
                let stored_key = if document.scope.is_some() && key == PROJECTS {
                    "projects"
                } else {
                    key
                };
                // Only the appropriate base file owns a collection.
                if document.scope.is_some() || index == base {
                    let current = document.value[stored_key]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    if current != buckets[index] {
                        document.value[stored_key] = json!(buckets[index]);
                        document.dirty = true;
                    }
                }
            }
        }
    }

    pub fn replace(&mut self, key: &str, value: Value, preferred: Option<&str>) {
        let mut values = self.list(key);
        if let Some(index) = values
            .iter()
            .position(|existing| existing["id"] == value["id"])
        {
            values[index] = value;
        } else {
            values.push(value);
        }
        self.set(key, values, preferred);
    }

    pub fn register(&mut self, id: &str, path: &Path) {
        let mut values = self.locations[LOCATIONS]
            .as_array()
            .cloned()
            .unwrap_or_default();
        values.retain(|value| value["id"] != id);
        values.push(json!({"id": id, "path": path}));
        self.locations[LOCATIONS] = json!(values);
    }

    pub fn deregister(&mut self, id: &str) {
        let mut values = self.locations[LOCATIONS]
            .as_array()
            .cloned()
            .unwrap_or_default();
        values.retain(|value| value["id"] != id);
        self.locations[LOCATIONS] = json!(values);
    }

    pub fn stage(&mut self, path: PathBuf, value: Value) -> Result<()> {
        if let Some(document) = self
            .documents
            .iter_mut()
            .find(|document| document.path == path)
        {
            if document.scope.as_deref() != value["workspace"]["id"].as_str()
                || document.scope.is_none()
            {
                return Err(failure(
                    "Cannot replace another open workspace or application metadata file.",
                ));
            }
            preflight(&path)?;
            document.value = value;
            document.dirty = true;
            return Ok(());
        }
        let before = read(&path)?;
        preflight(&path)?;
        self.documents.push(Document {
            path,
            before,
            value,
            scope: None,
            dirty: true,
            text: None,
        });
        Ok(())
    }

    pub fn stage_text(
        &mut self,
        path: PathBuf,
        before: Option<String>,
        after: String,
    ) -> Result<()> {
        // Text is staged separately from metadata and is never interpreted as JSON.
        if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(failure(
                "A generated project file cannot be a symbolic link.",
            ));
        }
        preflight(&path)?;
        self.documents.push(Document {
            path,
            before,
            value: Value::Null,
            scope: None,
            dirty: true,
            text: Some(after),
        });
        Ok(())
    }

    pub fn create_directory(&mut self, path: &Path) -> Result<()> {
        fs::create_dir(path).map_err(failure)?;
        self.created_folders.push(path.to_owned());
        Ok(())
    }

    pub fn commit(mut self) -> Result<()> {
        let mut changes = Vec::new();
        for document in std::mem::take(&mut self.documents) {
            if !document.dirty {
                continue;
            }
            let value = if let Some(after) = document.text {
                if document.before.as_deref() != Some(&after) {
                    changes.push(Change {
                        path: document.path,
                        before: document.before,
                        after,
                    });
                }
                continue;
            } else if document.scope.is_some() {
                let workspace: WorkspaceRecord =
                    serde_json::from_value(document.value["workspace"].clone()).map_err(failure)?;
                let contents = WorkspaceContents {
                    projects: Some(
                        document.value["projects"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default(),
                    ),
                    connections: Some(
                        document.value["connections"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default(),
                    ),
                    boards: Some(
                        document.value["boards"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default(),
                    ),
                };
                serde_json::to_value(
                    to_workspace_file(
                        &workspace,
                        &contents,
                        document.path.parent().and_then(Path::to_str),
                    )
                    .map_err(failure)?,
                )
                .map_err(failure)?
            } else {
                document.value
            };
            if document
                .before
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .as_ref()
                == Some(&value)
            {
                continue;
            }
            if document.before.is_none() && value == json!({}) {
                continue;
            }
            changes.push(Change {
                path: document.path,
                before: document.before,
                after: encoded(&value)?,
            });
        }
        let location_path = self.root.join("workspace-locations.json");
        if self
            .locations_before
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or_else(|| json!({}))
            != self.locations
        {
            changes.push(Change {
                path: location_path,
                before: self.locations_before.take(),
                after: encoded(&self.locations)?,
            });
        }
        if changes.is_empty() {
            self.committed = true;
            return Ok(());
        }
        for change in &changes {
            if read(&change.path)? != change.before {
                return Err(failure(format!(
                    "{} changed while saving; reload and try again.",
                    change.path.display()
                )));
            }
            preflight(&change.path)?;
        }
        let journal = self.root.join(JOURNAL);
        write_atomic(
            &journal,
            &encoded(&serde_json::to_value(&changes).map_err(failure)?)?,
            true,
        )?;
        recover(&self.root)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for Catalog {
    fn drop(&mut self) {
        if !self.committed && !self.root.join(JOURNAL).exists() {
            // Only empty directories created by this request can be removed.
            // A person's files, and directories needed by journal recovery, stay.
            for path in self.created_folders.iter().rev() {
                let _ = fs::remove_dir(path);
            }
        }
    }
}

fn base_index(key: &str) -> usize {
    match key {
        WORKSPACES => 0,
        PROJECTS => 1,
        _ => 2,
    }
}

fn identity(value: &Value) -> Option<String> {
    identity_of(value)
}
fn identity_of(value: &Value) -> Option<String> {
    match (value["connectionId"].as_str(), value["boardId"].as_str()) {
        (Some(connection), Some(board)) => Some(format!("{connection}:{board}")),
        _ => value["id"].as_str().map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_finishes_an_interrupted_transaction_and_refuses_external_edits() {
        let root = std::env::temp_dir().join(format!("praxis-catalog-recovery-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("profile");
        let first = root.join("first.json");
        let second = root.join("second.json");
        fs::write(&first, "new").expect("first already committed");
        fs::write(&second, "old").expect("second pending");
        let changes = vec![
            Change {
                path: first.clone(),
                before: Some("old".into()),
                after: "new".into(),
            },
            Change {
                path: second.clone(),
                before: Some("old".into()),
                after: "new".into(),
            },
        ];
        fs::write(
            root.join(JOURNAL),
            serde_json::to_vec(&changes).expect("journal"),
        )
        .expect("write journal");
        recover(&root).expect("roll forward");
        assert_eq!(fs::read_to_string(&second).expect("second"), "new");
        assert!(!root.join(JOURNAL).exists());
        fs::write(
            root.join(JOURNAL),
            serde_json::to_vec(&changes).expect("journal"),
        )
        .expect("write journal");
        fs::write(&second, "person edited this").expect("external edit");
        assert!(recover(&root).is_err());
        assert_eq!(
            fs::read_to_string(&second).expect("preserved"),
            "person edited this"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }
}
