//! Cross-platform folder path normalization and diagnostics (`packages/core/src/folder/pathUtils.ts`).

/// Target OS path convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupportedPathPlatform {
    Win32,
    Linux,
    Darwin,
}

impl SupportedPathPlatform {
    /// Returns the host platform.
    #[must_use]
    pub const fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Win32
        } else if cfg!(target_os = "macos") {
            Self::Darwin
        } else {
            Self::Linux
        }
    }
}

fn normalize_posix(raw: &str) -> String {
    let forward = raw.replace('\\', "/");
    let is_abs = forward.starts_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for part in forward.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if let Some(last) = stack.last()
                && *last != ".."
            {
                stack.pop();
                continue;
            }
            if !is_abs {
                stack.push("..");
            }
        } else {
            stack.push(part);
        }
    }
    let joined = stack.join("/");
    if is_abs {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

/// Normalizes a configured folder path for the given platform.
#[must_use]
pub fn normalize_configured_folder_path(
    file_path: &str,
    platform: SupportedPathPlatform,
) -> String {
    let trimmed = file_path.trim();
    if platform == SupportedPathPlatform::Win32 {
        normalize_posix(trimmed).replace('/', "\\")
    } else {
        normalize_posix(trimmed)
    }
}

/// Normalizes a filesystem path into canonical stored forward-slash form.
#[must_use]
pub fn to_stored_folder_path(fs_path: &str, _platform: SupportedPathPlatform) -> String {
    normalize_posix(fs_path.trim())
}

/// Checks whether `file_path` looks like a Windows drive path missing its separator (`C:plans`).
#[must_use]
pub fn looks_like_malformed_windows_path(file_path: &str) -> bool {
    let trimmed = file_path.trim();
    let bytes = trimmed.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] != b'\\'
        && bytes[2] != b'/'
        && !trimmed.contains('\\')
        && !trimmed.contains('/')
}

/// Builds the standard error message for an unreadable plans folder path.
#[must_use]
pub fn build_unreadable_path_error(file_path: &str, platform: SupportedPathPlatform) -> String {
    let guidance = if platform == SupportedPathPlatform::Win32
        && looks_like_malformed_windows_path(file_path)
    {
        " This looks like a malformed Windows path. If it was entered in JSON settings, use forward slashes like C:/path/to/plans, double backslashes like C:\\\\path\\\\to\\\\plans, or reselect the folder with Browse."
    } else {
        ""
    };
    format!("Selected path is not readable: {file_path}{guidance}")
}
