//! Symlink-aware filesystem path sandboxing (`pathSandbox.ts` port).
//!
//! Ensures paths stay inside the canonicalized working directory root, rejects
//! symlinks and dangling symlinks that escape the root, and pins open file descriptors
//! by device/inode before reading or writing.

use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Error returned when a path violates sandbox containment or changes during I/O.
#[derive(Debug, Error)]
pub enum PathSandboxError {
    /// Lexical, symlink, or inode containment violation.
    #[error("{0}")]
    Violation(String),
    /// Underlying filesystem I/O error.
    #[error("{0}")]
    Io(#[from] io::Error),
}

impl PathSandboxError {
    /// Constructs a new [`PathSandboxError::Violation`].
    #[must_use]
    pub fn violation(message: impl Into<String>) -> Self {
        Self::Violation(message.into())
    }
}

/// Metadata entry returned by [`list_sandboxed_directory`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxedDirEntry {
    pub name: String,
    pub is_file: bool,
    pub is_directory: bool,
    pub is_symbolic_link: bool,
}

fn normalize_lexical_absolute(path: &Path) -> PathBuf {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };

    let mut out = PathBuf::new();
    for comp in abs.components() {
        match comp {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                // Pop the last normal component if present; never pop past RootDir.
                let can_pop = matches!(out.components().next_back(), Some(Component::Normal(_)));
                if can_pop {
                    out.pop();
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

fn contained(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/// Lexical containment check (equivalent to `resolveLexicallySandboxedPath`).
///
/// Note: lexical containment alone is not permission to read or write a path;
/// use [`resolve_sandboxed_path`] or [`open_sandboxed_file`] before I/O.
pub fn resolve_lexically_sandboxed_path(
    working_directory: impl AsRef<Path>,
    input_path: impl AsRef<Path>,
) -> Result<PathBuf, PathSandboxError> {
    let working_directory = working_directory.as_ref();
    let input_path = input_path.as_ref();
    let root = normalize_lexical_absolute(working_directory);
    let joined = if input_path.is_absolute() {
        input_path.to_path_buf()
    } else {
        root.join(input_path)
    };
    let candidate = normalize_lexical_absolute(&joined);
    if !contained(&root, &candidate) {
        return Err(PathSandboxError::violation(format!(
            "Path escapes working directory: {}",
            input_path.display()
        )));
    }
    Ok(candidate)
}

/// Resolves existing symlinks (including ancestors of new files) and verifies the
/// target stays inside the canonicalized `working_directory` root.
pub fn resolve_sandboxed_path(
    working_directory: impl AsRef<Path>,
    input_path: impl AsRef<Path>,
) -> Result<PathBuf, PathSandboxError> {
    let working_directory = working_directory.as_ref();
    let input_path = input_path.as_ref();
    let candidate = resolve_lexically_sandboxed_path(working_directory, input_path)?;
    let root = fs::canonicalize(working_directory)?;

    let mut ancestor = candidate;
    let mut missing: Vec<std::ffi::OsString> = Vec::new();

    loop {
        match fs::canonicalize(&ancestor) {
            Ok(resolved) => {
                if !contained(&root, &resolved) {
                    return Err(PathSandboxError::violation(format!(
                        "Path escapes working directory through a symlink: {}",
                        input_path.display()
                    )));
                }
                let mut final_path = resolved;
                for segment in missing.into_iter().rev() {
                    final_path.push(segment);
                }
                return Ok(final_path);
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {
                // A dangling symlink may point outside the root; never treat it as a new file.
                match fs::symlink_metadata(&ancestor) {
                    Ok(meta) if meta.file_type().is_symlink() => {
                        return Err(PathSandboxError::violation(format!(
                            "Unresolved symlink in working directory: {}",
                            input_path.display()
                        )));
                    }
                    Ok(_) => {}
                    Err(stat_err) if stat_err.kind() == ErrorKind::NotFound => {}
                    Err(stat_err) => return Err(PathSandboxError::Io(stat_err)),
                }

                let Some(file_name) = ancestor.file_name().map(std::ffi::OsStr::to_os_string)
                else {
                    return Err(PathSandboxError::Io(err));
                };
                let Some(parent) = ancestor.parent().map(Path::to_path_buf) else {
                    return Err(PathSandboxError::Io(err));
                };
                if parent == ancestor {
                    return Err(PathSandboxError::Io(err));
                }
                missing.push(file_name);
                ancestor = parent;
            }
            Err(err) => return Err(PathSandboxError::Io(err)),
        }
    }
}

#[cfg(unix)]
fn configure_no_follow(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    // The value differs per OS *and* architecture (e.g. aarch64 Linux), so take it from libc.
    options.custom_flags(libc::O_NOFOLLOW);
}

#[cfg(not(unix))]
fn configure_no_follow(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn same_inode(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(not(unix))]
fn same_inode(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.len() == b.len() && a.is_file() == b.is_file()
}

/// Pins a file descriptor inside `root` and validates its canonical path and inode
/// before exposing bytes or mutating content.
pub fn open_sandboxed_file(
    root: impl AsRef<Path>,
    input_path: impl AsRef<Path>,
    write: bool,
) -> Result<File, PathSandboxError> {
    let root = root.as_ref();
    let input_path = input_path.as_ref();
    let canonical_root = fs::canonicalize(root)?;
    let mut candidate = resolve_sandboxed_path(&canonical_root, input_path)?;
    if write {
        if let Some(parent) = candidate.parent() {
            fs::create_dir_all(parent)?;
        }
        candidate = resolve_sandboxed_path(&canonical_root, &candidate)?;
    }

    let mut open_opts = OpenOptions::new();
    open_opts.read(true).write(write);
    configure_no_follow(&mut open_opts);

    let file = match open_opts.open(&candidate) {
        Ok(f) => f,
        Err(err) if write && err.kind() == ErrorKind::NotFound => {
            let mut create_opts = OpenOptions::new();
            create_opts.read(true).write(true).create_new(true);
            configure_no_follow(&mut create_opts);
            create_opts.open(&candidate)?
        }
        Err(err) => return Err(PathSandboxError::Io(err)),
    };

    let resolved = fs::canonicalize(&candidate)?;
    if !contained(&canonical_root, &resolved) {
        return Err(PathSandboxError::violation(format!(
            "Path changed outside working directory: {}",
            input_path.display()
        )));
    }
    let opened_meta = file.metadata()?;
    let current_meta = fs::metadata(&resolved)?;
    if !opened_meta.is_file() || !same_inode(&opened_meta, &current_meta) {
        return Err(PathSandboxError::violation(format!(
            "File changed while opening: {}",
            input_path.display()
        )));
    }
    Ok(file)
}

/// Reads a sandboxed file inside `root`, enforcing `max_bytes`.
pub fn read_sandboxed_file(
    root: impl AsRef<Path>,
    input_path: impl AsRef<Path>,
    max_bytes: u64,
) -> Result<Vec<u8>, PathSandboxError> {
    let mut file = open_sandboxed_file(root, input_path, false)?;
    let info = file.metadata()?;
    if info.len() > max_bytes {
        return Err(PathSandboxError::violation(format!(
            "File too large ({} bytes). Max {} bytes.",
            info.len(),
            max_bytes
        )));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    if (bytes.len() as u64) > max_bytes {
        return Err(PathSandboxError::violation(format!(
            "File too large. Max {} bytes.",
            max_bytes
        )));
    }
    Ok(bytes)
}

/// Writes `content` to a sandboxed file inside `root` after verifying its descriptor.
pub fn write_sandboxed_file(
    root: impl AsRef<Path>,
    input_path: impl AsRef<Path>,
    content: &[u8],
) -> Result<(), PathSandboxError> {
    let mut file = open_sandboxed_file(root, input_path, true)?;
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(content)?;
    file.flush()?;
    Ok(())
}

/// Lists directory entries inside `root`, verifying canonical containment and inode stability.
pub fn list_sandboxed_directory(
    root: impl AsRef<Path>,
    input_path: impl AsRef<Path>,
) -> Result<Vec<SandboxedDirEntry>, PathSandboxError> {
    let root = root.as_ref();
    let input_path = input_path.as_ref();
    let canonical_root = fs::canonicalize(root)?;
    let lex = resolve_lexically_sandboxed_path(&canonical_root, input_path)?;
    let candidate = fs::canonicalize(&lex)?;
    if !contained(&canonical_root, &candidate) {
        return Err(PathSandboxError::violation(format!(
            "Path escapes working directory: {}",
            input_path.display()
        )));
    }
    let before = fs::metadata(&candidate)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&candidate)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        entries.push(SandboxedDirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_file: file_type.is_file(),
            is_directory: file_type.is_dir(),
            is_symbolic_link: file_type.is_symlink(),
        });
    }
    let after_path = fs::canonicalize(&candidate)?;
    let after = fs::metadata(&after_path)?;
    if !contained(&canonical_root, &after_path) || !same_inode(&before, &after) {
        return Err(PathSandboxError::violation(format!(
            "Directory changed while listing: {}",
            input_path.display()
        )));
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        // Parallel test threads can read the same timestamp; the counter keeps paths distinct.
        static NEXT_TEMP: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let sequence = NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "{prefix}-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[cfg(unix)]
    #[test]
    fn filesystem_sandbox_rejects_linked_files_dirs_dangling_links_and_permits_canonical_roots() {
        use std::os::unix::fs::symlink;

        let base = make_temp_dir("praxis-sandbox");
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(&root).expect("mkdir root");
        fs::create_dir_all(&outside).expect("mkdir outside");
        fs::write(outside.join("secret"), b"private").expect("write secret");
        fs::write(root.join("..notes"), b"allowed").expect("write ..notes");

        symlink(outside.join("secret"), root.join("file")).expect("symlink file");
        symlink(&outside, root.join("dir")).expect("symlink dir");
        symlink(outside.join("new"), root.join("dangling")).expect("symlink dangling");

        for bad in [
            "file",
            "dir/secret",
            "dir/new",
            "dangling",
            "../outside/secret",
        ] {
            let err = resolve_sandboxed_path(&root, bad).expect_err(bad);
            let msg = err.to_string();
            assert!(
                msg.contains("escapes") || msg.contains("symlink"),
                "unexpected error for {bad}: {msg}"
            );
        }

        let notes = resolve_sandboxed_path(&root, "..notes").expect("..notes");
        assert!(notes.ends_with("..notes"));

        let nested_new = resolve_sandboxed_path(&root, "nested/new").expect("nested/new");
        assert!(nested_new.ends_with("nested/new"));

        let linked_root = base.join("linked-root");
        symlink(&root, &linked_root).expect("symlink root");
        assert_eq!(
            resolve_sandboxed_path(&linked_root, "..notes").expect("linked ..notes"),
            notes
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sandboxed_read_write_and_directory_listing_roundtrip() {
        let base = make_temp_dir("praxis-sandbox-rw");
        let root = base.join("root");
        fs::create_dir_all(&root).expect("mkdir root");

        write_sandboxed_file(&root, "sub/hello.txt", b"hello world").expect("write");
        let content = read_sandboxed_file(&root, "sub/hello.txt", 1024).expect("read");
        assert_eq!(content, b"hello world");

        let too_large = read_sandboxed_file(&root, "sub/hello.txt", 4).expect_err("too large");
        assert!(too_large.to_string().contains("File too large"));

        let entries = list_sandboxed_directory(&root, "sub").expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "hello.txt");
        assert!(entries[0].is_file);

        let _ = fs::remove_dir_all(&base);
    }
}
