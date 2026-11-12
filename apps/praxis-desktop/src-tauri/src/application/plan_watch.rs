//! Observes edits made to a folder-backed project's plan files outside Praxis
//! (an editor, an agent CLI, a pull) and records them as project activity.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use praxis_core::folder::{FolderWatcher, folder_read_file, is_own_folder_write, watch_folder};
use praxis_host::HostContext;
use serde_json::Value;

use super::activity::{self, Observation};

/// Editors save in bursts; one entry per file per minute is what a person
/// would call "an edit".
const BURST_WINDOW: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct PlanWatchers {
    watchers: Mutex<HashMap<String, FolderWatcher>>,
}

impl PlanWatchers {
    /// Starts (once) a watcher per folder-backed project. Idempotent: called on
    /// every board read, as opening a board is what started the TS watcher.
    pub fn ensure(&self, host: &HostContext, projects: &[Value]) {
        let Ok(mut watchers) = self.watchers.lock() else {
            return;
        };
        let live: HashSet<String> = projects
            .iter()
            .filter(|project| project["storage"] == "folder")
            .filter_map(|project| {
                Some(format!(
                    "{}\u{0}{}",
                    project["id"].as_str()?,
                    project["workspaceFolder"].as_str()?
                ))
            })
            .collect();
        watchers.retain(|key, _| live.contains(key));
        for project in projects
            .iter()
            .filter(|project| project["storage"] == "folder")
        {
            let (Some(id), Some(folder)) =
                (project["id"].as_str(), project["workspaceFolder"].as_str())
            else {
                continue;
            };
            let key = format!("{id}\u{0}{folder}");
            if watchers.contains_key(&key) || !Path::new(folder).is_dir() {
                continue;
            }
            let observer = Observer {
                project_id: id.to_owned(),
                folder: PathBuf::from(folder),
                root: host.config().user_data_dir.clone(),
                host: host.clone(),
                last_event: Mutex::new(HashMap::new()),
            };
            let observer = Arc::new(observer);
            watchers.insert(
                key,
                watch_folder(Path::new(folder), move |path| observer.changed(&path)),
            );
        }
    }
}

struct Observer {
    project_id: String,
    folder: PathBuf,
    root: PathBuf,
    host: HostContext,
    last_event: Mutex<HashMap<PathBuf, Instant>>,
}

impl Observer {
    fn changed(&self, path: &Path) {
        let content = folder_read_file(path).ok();
        if is_own_folder_write(path, content.as_deref()) {
            return;
        }
        if let Ok(mut last) = self.last_event.lock() {
            let now = Instant::now();
            if last
                .get(path)
                .is_some_and(|previous| now.duration_since(*previous) < BURST_WINDOW)
            {
                return;
            }
            last.insert(path.to_path_buf(), now);
        }
        let exists = content.is_some();
        let heading = content.as_deref().and_then(heading);
        let plans = self.folder.join("docs").join("plans");
        let target = path
            .strip_prefix(&plans)
            .ok()
            .map(|relative| relative.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let summary = heading.unwrap_or_else(|| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
        let connection_id = format!("project:{}", self.project_id);
        activity::record(
            &self.root,
            &Observation {
                project_id: &self.project_id,
                kind: "plan",
                target_key: &target,
                summary: &summary,
                action: if exists {
                    "Plan file edited"
                } else {
                    "Plan file removed"
                },
                connection_id: Some(&connection_id),
                actor: "external",
            },
        );
        self.host
            .events()
            .emit("board:changed", Some(serde_json::json!(connection_id)));
    }
}

/// The first `# Heading` within the first 4 KiB, as the plan's title.
fn heading(content: &str) -> Option<String> {
    let mut end = content.len().min(4096);
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    content[..end]
        .lines()
        .find_map(|line| line.strip_prefix("# "))
        .map(|title| title.trim().to_owned())
        .filter(|title| !title.is_empty())
}

#[cfg(test)]
mod tests {
    use super::heading;

    #[test]
    fn heading_is_the_first_level_one_title() {
        assert_eq!(
            heading("intro\n# Plan title \n## Sub").as_deref(),
            Some("Plan title")
        );
        assert_eq!(heading("## only sub"), None);
    }
}
