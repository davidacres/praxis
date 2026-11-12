//! The agent runtime catalog: runtime hosts (`agent.json`), agent profiles (`AGENT.md`) and
//! skills (`SKILL.md`), discovered from disk, plus the bundled built-ins and the authoring
//! and import rules.
//!
//! A port of `packages/core/src/ai/agentRuntime` (discovery, manifest, skillRegistry,
//! profileRegistry, agentAuthoring, bundledAgents). Outputs are `serde_json::Value`s shaped
//! exactly like the TypeScript snapshot the renderer consumes, so the wire format is unchanged.
//! Nothing here executes anything: starting a host is the application layer's job.

pub mod authoring;
pub mod bundled;
pub mod catalog;
pub mod manifest;
pub mod native_sources;

pub use catalog::{CatalogOptions, CatalogSnapshot, refresh_catalog};

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256, the fingerprint format the TypeScript catalog used.
pub(crate) fn fingerprint(content: &str) -> String {
    Sha256::digest(content.as_bytes())
        .iter()
        .fold(String::new(), |mut hex, byte| {
            use std::fmt::Write as _;
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

/// Immediate subdirectories of `root`, sorted by full path; empty when unreadable.
pub(crate) fn directories(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect();
    found.sort();
    found
}

/// `path.resolve` for an absolute-or-relative path without touching the filesystem.
pub(crate) fn resolve(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `path.resolve(root, child)`: `child` joined onto `root` (unless absolute) with `.` and `..`
/// folded away, without touching the filesystem.
#[must_use]
pub fn resolve_against(root: &Path, child: &str) -> String {
    use std::path::Component;
    let joined = if Path::new(child).is_absolute() {
        PathBuf::from(child)
    } else {
        resolve(root).join(child)
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.to_string_lossy().into_owned()
}

/// One `key: value` front-matter line (`^([A-Za-z][\w-]*):\s*(.*)$` on the trimmed line).
pub(crate) fn front_matter_pair(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    let (key, rest) = line.split_once(':')?;
    let mut chars = key.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic()
        || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some((key, rest.trim_start()))
}

/// Case-insensitive ordering, the closest std equivalent of `localeCompare` for these names.
pub(crate) fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}
