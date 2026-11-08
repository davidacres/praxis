//! Filesystem helpers and self-write echo tracking (`packages/core/src/folder/folderFs.ts`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// Kind of directory entry reported by [`folder_read_directory`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Directory,
}

#[derive(Default)]
struct WriteHistory {
    last_written: HashMap<PathBuf, String>,
    moved_away: HashSet<PathBuf>,
}

static WRITE_HISTORY: LazyLock<Mutex<WriteHistory>> =
    LazyLock::new(|| Mutex::new(WriteHistory::default()));

fn resolve_key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// True when `content` (`None` = the file is gone) is exactly what this process left at `file_path`.
#[must_use]
pub fn is_own_folder_write(file_path: &Path, content: Option<&str>) -> bool {
    let key = resolve_key(file_path);
    let Ok(guard) = WRITE_HISTORY.lock() else {
        return false;
    };
    match content {
        None => guard.moved_away.contains(&key),
        Some(text) => guard.last_written.get(&key).map(String::as_str) == Some(text),
    }
}

/// Reads a UTF-8 file from disk.
pub fn folder_read_file(file_path: &Path) -> std::io::Result<String> {
    std::fs::read_to_string(file_path)
}

/// Writes a UTF-8 file to disk and records it in the self-write tracker.
pub fn folder_write_file(file_path: &Path, content: &str) -> std::io::Result<()> {
    std::fs::write(file_path, content)?;
    let key = resolve_key(file_path);
    if let Ok(mut guard) = WRITE_HISTORY.lock() {
        guard.last_written.insert(key.clone(), content.to_string());
        guard.moved_away.remove(&key);
    }
    Ok(())
}

/// Lists immediate directory entries as `(name, FileKind)` pairs.
pub fn folder_read_directory(dir_path: &Path) -> std::io::Result<Vec<(String, FileKind)>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir_path)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        out.push((
            name,
            if is_dir {
                FileKind::Directory
            } else {
                FileKind::File
            },
        ));
    }
    Ok(out)
}

/// Creates a directory and any missing parent directories.
pub fn folder_mkdir(dir_path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir_path)
}

/// Moves a managed markdown file and updates the self-write tracker.
pub fn folder_move_file(source_path: &Path, target_path: &Path) -> std::io::Result<()> {
    let source_key = resolve_key(source_path);
    std::fs::rename(source_path, target_path)?;
    let target_key = resolve_key(target_path);
    if let Ok(mut guard) = WRITE_HISTORY.lock() {
        let content = guard.last_written.remove(&source_key);
        guard.moved_away.insert(source_key);
        if let Some(c) = content {
            guard.last_written.insert(target_key.clone(), c);
        }
        guard.moved_away.remove(&target_key);
    }
    Ok(())
}
