//! Recursive markdown plan watcher backed by `notify` (`packages/core/src/folder/folderWatch.ts`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// Handle to an active directory watcher over a plans root.
pub struct FolderWatcher {
    _watcher: Option<RecommendedWatcher>,
}

impl FolderWatcher {
    /// Stops watching and releases OS file-event handles.
    pub fn close(&mut self) {
        self._watcher = None;
    }
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

/// Watches `root_path` recursively for added, modified, or removed `*.md` files.
pub fn watch_folder<F>(root_path: &Path, on_change: F) -> FolderWatcher
where
    F: Fn(PathBuf) + Send + Sync + 'static,
{
    let callback = Arc::new(on_change);
    let cb = Arc::clone(&callback);
    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                    for path in event.paths {
                        if is_markdown_path(&path) {
                            cb(path);
                        }
                    }
                }
                _ => {}
            }
        }
    })
    .ok();

    if let Some(ref mut w) = watcher {
        let _ = w.watch(root_path, RecursiveMode::Recursive);
    }

    FolderWatcher { _watcher: watcher }
}
