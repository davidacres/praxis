//! Portable folder path helpers for `.workspace.praxis.json` files (`FX-BE-049`).

use std::path::{Component, Path, PathBuf};

fn is_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Shapes an absolute folder path for storage in a workspace file living in `workspace_file_dir`.
/// In-tree paths come back as `.` or `./`-prefixed POSIX; paths outside the tree are returned unchanged.
#[must_use]
pub fn to_portable_folder_path(absolute_path: &str, workspace_file_dir: &str) -> String {
    if absolute_path.is_empty()
        || workspace_file_dir.is_empty()
        || !Path::new(absolute_path).is_absolute()
    {
        return absolute_path.to_string();
    }
    let root = normalize_lexical(Path::new(workspace_file_dir));
    let target = normalize_lexical(Path::new(absolute_path));
    let Ok(rel) = target.strip_prefix(&root) else {
        return absolute_path.to_string();
    };
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        ".".to_string()
    } else {
        format!("./{}", parts.join("/"))
    }
}

/// Resolves a stored folder path back to an absolute path against `workspace_file_dir`.
/// Already-absolute paths (including Windows drive paths on POSIX) pass through untouched.
#[must_use]
pub fn resolve_portable_folder_path(stored_path: &str, workspace_file_dir: &str) -> String {
    if stored_path.is_empty() {
        return String::new();
    }
    if Path::new(stored_path).is_absolute() || is_windows_drive_path(stored_path) {
        return stored_path.to_string();
    }
    if workspace_file_dir.is_empty() {
        return stored_path.to_string();
    }
    let joined = Path::new(workspace_file_dir).join(stored_path);
    normalize_lexical(&joined).to_string_lossy().into_owned()
}

/// Returns `true` when `stored_path` is relative/portable rather than machine-specific.
#[must_use]
pub fn is_portable_folder_path(stored_path: &str) -> bool {
    !Path::new(stored_path).is_absolute() && !is_windows_drive_path(stored_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/someone/dev/praxis";

    #[test]
    fn folder_inside_workspace_tree_is_stored_relative_with_posix_separators() {
        assert_eq!(to_portable_folder_path(HOME, HOME), ".");
        assert_eq!(
            to_portable_folder_path("/Users/someone/dev/praxis/apps/web", HOME),
            "./apps/web"
        );
        assert_eq!(
            to_portable_folder_path("/Users/someone/dev/praxis/docs", HOME),
            "./docs"
        );
        let stored = to_portable_folder_path("/Users/someone/dev/praxis/a/b/c", HOME);
        assert_eq!(stored, "./a/b/c");
        assert!(!stored.contains('\\'));
    }

    #[test]
    fn folder_outside_tree_stays_absolute() {
        let elsewhere = "/Users/someone/other/repo";
        assert_eq!(to_portable_folder_path(elsewhere, HOME), elsewhere);
        let sibling = "/Users/someone/dev/praxis-tools";
        assert_eq!(to_portable_folder_path(sibling, HOME), sibling);
    }

    #[test]
    fn relative_path_resolves_against_new_workspace_location_and_absolute_passes_through() {
        let moved = "/somewhere/else/praxis";
        assert_eq!(
            resolve_portable_folder_path("./apps/web", moved),
            "/somewhere/else/praxis/apps/web"
        );
        assert_eq!(resolve_portable_folder_path(".", moved), moved);

        let elsewhere = "/Users/someone/other/repo";
        assert_eq!(resolve_portable_folder_path(elsewhere, HOME), elsewhere);
        assert_eq!(
            resolve_portable_folder_path("C:\\work\\repo", HOME),
            "C:\\work\\repo"
        );
    }

    #[test]
    fn round_tripping_empty_and_is_portable_checks_match_ts_suite() {
        let original = "/Users/someone/dev/praxis/apps/web";
        let stored = to_portable_folder_path(original, HOME);
        let cloned_to = "/build/agent/checkout";
        assert_eq!(
            resolve_portable_folder_path(&stored, cloned_to),
            "/build/agent/checkout/apps/web"
        );

        assert_eq!(to_portable_folder_path("", HOME), "");
        assert_eq!(to_portable_folder_path("./already", HOME), "./already");
        assert_eq!(resolve_portable_folder_path("", HOME), "");

        assert!(is_portable_folder_path("./apps/web"));
        assert!(is_portable_folder_path("."));
        assert!(!is_portable_folder_path("/Users/someone/repo"));
        assert!(!is_portable_folder_path("C:\\work\\repo"));
    }
}
