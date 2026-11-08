//! Sandboxed read-only files MCP server (`read_only_files.rs`).

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};

use crate::mcp::types::{CallToolResult, McpToolInfo};

pub const READ_ONLY_FILES_SERVER_NAME: &str = "praxis-review-files";
const CHUNK_SIZE: usize = 48_000;
const MAX_FILE_SIZE: u64 = 64 * 1024 * 1024;

/// Sandboxes a requested relative or absolute path within `root`.
/// Returns Err if the path attempts directory traversal outside `root`.
pub fn resolve_sandboxed_path(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let clean_requested = Path::new(requested);

    let mut relative_path = PathBuf::new();
    for comp in clean_requested.components() {
        match comp {
            Component::Normal(segment) => relative_path.push(segment),
            Component::CurDir => {}
            Component::ParentDir => {
                if !relative_path.pop() {
                    return Err(format!(
                        "Access denied: path '{requested}' traverses outside root"
                    ));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                // If it looks absolute, check if it already starts with root
                if let Ok(rel) = clean_requested.strip_prefix(root) {
                    relative_path = rel.to_path_buf();
                    break;
                }
            }
        }
    }

    let joined = root.join(&relative_path);
    Ok(joined)
}

/// Lists tool descriptors exposed by the read-only files server.
#[must_use]
pub fn list_read_only_file_tools() -> Vec<McpToolInfo> {
    vec![
        McpToolInfo {
            name: "read_file".to_string(),
            description: Some(
                "Read a UTF-8 file inside the review working folder, including .praxis-run artifacts. No commands or writes."
                    .to_string(),
            ),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "offset": { "type": "integer", "minimum": 0 }
                },
                "required": ["path"],
                "additionalProperties": false
            })),
        },
        McpToolInfo {
            name: "list_dir".to_string(),
            description: Some("List a directory inside the review working folder.".to_string()),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"],
                "additionalProperties": false
            })),
        },
    ]
}

/// Executes a tool in the read-only files server.
pub fn execute_read_only_file_tool(
    root: &Path,
    name: &str,
    args: &Value,
) -> Result<CallToolResult, String> {
    let path_str = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "path must be a string".to_string())?;

    let resolved_path = resolve_sandboxed_path(root, path_str)?;

    match name {
        "read_file" => {
            let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;

            let metadata = fs::metadata(&resolved_path)
                .map_err(|e| format!("Failed to read file metadata for '{path_str}': {e}"))?;
            if metadata.len() > MAX_FILE_SIZE {
                return Err(format!(
                    "File '{path_str}' size ({} bytes) exceeds maximum allowed {MAX_FILE_SIZE} bytes",
                    metadata.len()
                ));
            }

            let file_contents = fs::read_to_string(&resolved_path)
                .map_err(|e| format!("Failed to read file '{path_str}': {e}"))?;

            let total_chars = file_contents.chars().count();
            if offset >= total_chars && total_chars > 0 {
                return Ok(CallToolResult::success(""));
            }

            let end = (offset + CHUNK_SIZE).min(total_chars);
            let slice: String = file_contents
                .chars()
                .skip(offset)
                .take(CHUNK_SIZE)
                .collect();

            let result_text = if end < total_chars {
                format!("{slice}\n[More content: read_file with offset {end}]")
            } else {
                slice
            };

            Ok(CallToolResult::success(result_text))
        }
        "list_dir" => {
            let read_dir = fs::read_dir(&resolved_path)
                .map_err(|e| format!("Failed to read directory '{path_str}': {e}"))?;

            let mut entries = Vec::new();
            for entry in read_dir.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_string();
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if is_dir {
                    entries.push(format!("{file_name}/"));
                } else {
                    entries.push(file_name);
                }
            }
            entries.sort();

            Ok(CallToolResult::success(entries.join("\n")))
        }
        _ => Err(format!("Unknown tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_sandboxed_relative_paths() {
        let root = Path::new("/var/projects/repo");
        let resolved = resolve_sandboxed_path(root, "src/lib.rs").expect("valid path");
        assert_eq!(resolved, Path::new("/var/projects/repo/src/lib.rs"));
    }

    #[test]
    fn prevents_directory_traversal_outside_root() {
        let root = Path::new("/var/projects/repo");
        let err = resolve_sandboxed_path(root, "../../etc/passwd")
            .expect_err("traversal must be rejected");
        assert!(err.contains("traverses outside root"));
    }

    #[test]
    fn reads_and_paginates_file_chunks() {
        let temp_dir =
            std::env::temp_dir().join(format!("praxis-ro-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("temp dir");

        let test_file = temp_dir.join("sample.txt");
        let sample_content = "Hello, world! This is a test file for read-only files MCP.";
        fs::write(&test_file, sample_content).expect("write file");

        let args = json!({ "path": "sample.txt", "offset": 0 });
        let res = execute_read_only_file_tool(&temp_dir, "read_file", &args).expect("read tool");
        assert!(res.ok);
        assert_eq!(res.content, sample_content);

        // Clean up
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
