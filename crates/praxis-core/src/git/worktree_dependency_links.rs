//! Removes `node_modules` symlinks inside a run worktree that escape outside the worktree (`worktreeDependencyLinks.ts`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::git_worktree_manager::block_on_git;

/// Record of a symlink removed because it resolved outside the worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedDependencyLink {
    /// The link path relative to the worktree (POSIX separators).
    pub link: String,
    /// Resolved target path where the link pointed.
    pub target: String,
}

async fn package_dirs(root: &Path) -> Vec<String> {
    let mut dirs = BTreeSet::new();
    dirs.insert(".".to_string());
    if let Ok(output) = Command::new("git")
        .args(["ls-files", "-z", "--", "package.json", "*/package.json"])
        .current_dir(root)
        .output()
        .await
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for file in stdout.split('\0') {
                if file.is_empty() {
                    continue;
                }
                let parts: Vec<&str> = file.split('/').collect();
                if parts.last().copied() == Some("package.json") && !parts.contains(&"node_modules")
                {
                    if parts.len() == 1 {
                        dirs.insert(".".to_string());
                    } else {
                        dirs.insert(parts[..parts.len() - 1].join("/"));
                    }
                }
            }
        }
    }
    dirs.into_iter().collect()
}

fn normalize_lexical_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn remove_if_escaping(root: &Path, link: &Path, removed: &mut Vec<RemovedDependencyLink>) {
    let Ok(raw) = std::fs::read_link(link) else {
        return;
    };
    let resolved = if raw.is_absolute() {
        normalize_lexical_path(&raw)
    } else {
        normalize_lexical_path(&link.parent().unwrap_or(root).join(raw))
    };
    let target = std::fs::canonicalize(&resolved).unwrap_or(resolved);
    if target.starts_with(root) {
        return;
    }
    if std::fs::remove_file(link).is_ok() {
        let rel = link
            .strip_prefix(root)
            .unwrap_or(link)
            .to_string_lossy()
            .replace('\\', "/");
        removed.push(RemovedDependencyLink {
            link: rel,
            target: target.to_string_lossy().to_string(),
        });
    }
}

/// Removes `node_modules` symlinks in `worktree_path` that point outside the worktree.
pub async fn remove_escaping_dependency_links(
    worktree_path: &Path,
) -> Result<Vec<RemovedDependencyLink>, String> {
    let root = std::fs::canonicalize(worktree_path).map_err(|e| e.to_string())?;
    let mut removed = Vec::new();
    for dir in package_dirs(&root).await {
        let modules = if dir == "." {
            root.join("node_modules")
        } else {
            root.join(&dir).join("node_modules")
        };
        let Ok(meta) = std::fs::symlink_metadata(&modules) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            remove_if_escaping(&root, &modules, &mut removed);
            continue;
        }
        if !meta.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&modules) else {
            continue;
        };
        for entry in entries.flatten() {
            let full = entry.path();
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_string();
            if ft.is_symlink() {
                remove_if_escaping(&root, &full, &mut removed);
            } else if ft.is_dir() && name.starts_with('@') {
                if let Ok(scoped_entries) = std::fs::read_dir(&full) {
                    for scoped in scoped_entries.flatten() {
                        if scoped.file_type().is_ok_and(|sft| sft.is_symlink()) {
                            remove_if_escaping(&root, &scoped.path(), &mut removed);
                        }
                    }
                }
            }
        }
    }
    Ok(removed)
}

/// Synchronous wrapper for [`remove_escaping_dependency_links`].
pub fn remove_escaping_dependency_links_sync(
    worktree_path: &Path,
) -> Result<Vec<RemovedDependencyLink>, String> {
    block_on_git(remove_escaping_dependency_links(worktree_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestLayout {
        base: PathBuf,
        main: PathBuf,
        worktree: PathBuf,
    }

    impl Drop for TestLayout {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    fn setup_layout() -> TestLayout {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let raw_base =
            std::env::temp_dir().join(format!("praxis-deplinks-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&raw_base).expect("mkdir");
        let base = std::fs::canonicalize(&raw_base).expect("canon");
        let main = base.join("main");
        let worktree = base.join("worktree");
        for root in [&main, &worktree] {
            std::fs::create_dir_all(root.join("packages").join("p")).expect("mkdir");
            std::fs::write(
                root.join("package.json"),
                r#"{"workspaces":["packages/*"]}"#,
            )
            .expect("write");
            std::fs::write(
                root.join("packages").join("p").join("package.json"),
                r#"{"name":"p"}"#,
            )
            .expect("write");
            std::fs::write(root.join(".gitignore"), "node_modules\n").expect("write");
            StdCommand::new("git")
                .args(["init", "-q"])
                .current_dir(root)
                .status()
                .expect("git init");
            StdCommand::new("git")
                .args(["add", "-A"])
                .current_dir(root)
                .status()
                .expect("git add");
        }
        let noble = main
            .join("packages")
            .join("p")
            .join("node_modules")
            .join("@noble")
            .join("curves");
        std::fs::create_dir_all(&noble).expect("mkdir noble");
        std::fs::write(noble.join("index.js"), "main checkout package").expect("write");
        std::fs::create_dir_all(main.join("node_modules").join("left-pad")).expect("mkdir");

        TestLayout {
            base,
            main,
            worktree,
        }
    }

    #[cfg(unix)]
    fn make_symlink(src: &Path, dst: &Path) {
        std::os::unix::fs::symlink(src, dst).expect("symlink");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn worktree_package_node_modules_linked_to_main_checkout_is_unlinked() {
        let layout = setup_layout();
        make_symlink(
            &layout.main.join("packages").join("p").join("node_modules"),
            &layout
                .worktree
                .join("packages")
                .join("p")
                .join("node_modules"),
        );
        let removed = remove_escaping_dependency_links(&layout.worktree)
            .await
            .expect("remove");
        assert_eq!(
            removed.iter().map(|e| e.link.as_str()).collect::<Vec<_>>(),
            vec!["packages/p/node_modules"]
        );
        assert!(
            !layout
                .worktree
                .join("packages")
                .join("p")
                .join("node_modules")
                .exists()
        );
        assert_eq!(
            std::fs::read_to_string(
                layout
                    .main
                    .join("packages")
                    .join("p")
                    .join("node_modules")
                    .join("@noble")
                    .join("curves")
                    .join("index.js")
            )
            .expect("read"),
            "main checkout package"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn single_package_and_scoped_package_links_out_of_worktree_are_removed_workspace_links_stay()
     {
        let layout = setup_layout();
        let modules = layout.worktree.join("node_modules");
        std::fs::create_dir_all(modules.join("@noble")).expect("mkdir");
        std::fs::create_dir_all(modules.join("@praxis")).expect("mkdir");
        make_symlink(
            &layout.main.join("node_modules").join("left-pad"),
            &modules.join("left-pad"),
        );
        make_symlink(
            &layout
                .main
                .join("packages")
                .join("p")
                .join("node_modules")
                .join("@noble")
                .join("curves"),
            &modules.join("@noble").join("curves"),
        );
        make_symlink(
            Path::new("../../packages/p"),
            &modules.join("@praxis").join("p"),
        );
        make_symlink(
            &layout.worktree.join("packages").join("p"),
            &modules.join("p-absolute"),
        );

        let mut removed = remove_escaping_dependency_links(&layout.worktree)
            .await
            .expect("remove");
        removed.sort_by(|a, b| a.link.cmp(&b.link));
        assert_eq!(
            removed.iter().map(|e| e.link.as_str()).collect::<Vec<_>>(),
            vec!["node_modules/@noble/curves", "node_modules/left-pad"]
        );
        assert!(
            std::fs::symlink_metadata(modules.join("@praxis").join("p"))
                .expect("meta")
                .file_type()
                .is_symlink()
        );
        assert!(
            std::fs::symlink_metadata(modules.join("p-absolute"))
                .expect("meta")
                .file_type()
                .is_symlink()
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn whole_node_modules_and_dangling_links_are_unlinked() {
        let layout = setup_layout();
        make_symlink(
            &layout.main.join("node_modules"),
            &layout.worktree.join("node_modules"),
        );
        make_symlink(
            &layout.main.join("gone"),
            &layout
                .worktree
                .join("packages")
                .join("p")
                .join("node_modules"),
        );
        let mut removed = remove_escaping_dependency_links(&layout.worktree)
            .await
            .expect("remove");
        removed.sort_by(|a, b| a.link.cmp(&b.link));
        assert_eq!(
            removed.iter().map(|e| e.link.as_str()).collect::<Vec<_>>(),
            vec!["node_modules", "packages/p/node_modules"]
        );
    }
}
