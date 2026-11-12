//! Artifact library and details storage under `<artifactsFolder>/.praxis-artifacts.json`.
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{DateTime, SecondsFormat, Utc};
use praxis_host::HostContext;
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{Catalog, Result, failure, now, storage};

const DEFAULT_ARTIFACTS_FOLDER: &str = "docs/published-artifacts";
const ARTIFACT_DETAILS_FILE: &str = ".praxis-artifacts.json";
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 12 * 1024 * 1024;

fn normalize_folder(raw: Option<&str>) -> String {
    let raw = raw.unwrap_or("").trim().replace('\\', "/");
    let segments: Vec<&str> = raw
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if segments.is_empty() || segments.contains(&"..") || segments[0].eq_ignore_ascii_case(".git") {
        DEFAULT_ARTIFACTS_FOLDER.to_string()
    } else {
        segments.join("/")
    }
}

fn find_repository_root(start: &Path) -> PathBuf {
    let mut current = start.to_path_buf();
    loop {
        if current.join(".git").exists() {
            return current;
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            return start.to_path_buf();
        }
    }
}

struct ProjectLocation {
    root: PathBuf,
    folder: String,
}

fn locate_project(catalog: &Catalog, project_id: &str) -> Result<Option<ProjectLocation>> {
    let project = catalog.require(storage::PROJECTS, project_id)?;
    let Some(ws_folder) = project["workspaceFolder"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    else {
        return Ok(None);
    };
    let ws_path = PathBuf::from(ws_folder);
    let root = find_repository_root(&ws_path);
    let folder = normalize_folder(project["artifactsFolder"].as_str());
    Ok(Some(ProjectLocation { root, folder }))
}

fn is_inside_folder(folder: &str, path: &str) -> bool {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') {
        return false;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments
        .iter()
        .any(|s| s.is_empty() || *s == "." || *s == "..")
    {
        return false;
    }
    path.starts_with(&format!("{folder}/"))
}

fn artifact_kind(path: &str, media_type: Option<&str>) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let m = media_type.unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "svg" => "image",
        "html" | "htm" => "page",
        "md" | "markdown" | "txt" | "log" | "patch" | "diff" | "pdf" | "rtf" => "document",
        "json" | "csv" | "tsv" | "yaml" | "yml" | "xml" | "toml" => "data",
        _ if m.starts_with("image/") => "image",
        _ if m == "text/html" => "page",
        _ if m == "text/markdown" || m == "text/plain" => "document",
        _ if m == "application/json" => "data",
        _ => "other",
    }
}

fn extract_html_title(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 64 * 1024];
    let n = file.read(&mut buf).ok()?;
    let s = String::from_utf8_lossy(&buf[..n]);
    let re = Regex::new(r"(?i)<title\b[^>]*>([\s\S]*?)</title\s*>").ok()?;
    let cap = re.captures(&s)?;
    let raw_title = cap.get(1)?.as_str();
    let unescaped = raw_title
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ");
    let collapsed = unescaped.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed.chars().take(300).collect())
    }
}

fn read_details_file(details_path: &Path, project_id: &str) -> (Vec<Value>, Vec<Value>) {
    let Ok(Some(raw)) = storage::read(details_path) else {
        return (Vec::new(), Vec::new());
    };
    let Ok(doc) = serde_json::from_str::<Value>(&raw) else {
        return (Vec::new(), Vec::new());
    };
    let mut records = Vec::new();
    if let Some(arr) = doc["records"].as_array() {
        for mut r in arr.iter().cloned() {
            r["projectId"] = json!(project_id);
            records.push(r);
        }
    }
    let mut groups = Vec::new();
    if let Some(arr) = doc["groups"].as_array() {
        for mut g in arr.iter().cloned() {
            g["projectId"] = json!(project_id);
            groups.push(g);
        }
    }
    (records, groups)
}

fn write_details_file(details_path: &Path, records: &[Value], groups: &[Value]) -> Result<()> {
    let stripped_records: Vec<Value> = records
        .iter()
        .map(|r| {
            let mut obj = r.clone();
            if let Some(m) = obj.as_object_mut() {
                m.remove("projectId");
            }
            obj
        })
        .collect();
    let stripped_groups: Vec<Value> = groups
        .iter()
        .map(|g| {
            let mut obj = g.clone();
            if let Some(m) = obj.as_object_mut() {
                m.remove("projectId");
            }
            obj
        })
        .collect();

    let doc = json!({
        "$comment": "Praxis artifact details: titles, descriptions, groups and the session each file was saved from. Paths are repository-relative. Safe to edit or delete.",
        "version": 1,
        "records": stripped_records,
        "groups": stripped_groups
    });
    let encoded = storage::encoded(&doc)?;
    storage::write_atomic(details_path, &encoded, false)
}

const MAX_PUBLISHED_ARTIFACT_BYTES: u64 = 25 * 1024 * 1024;

fn trimmed_text(value: &Value, max: usize) -> Option<String> {
    value.as_str().map(str::trim).filter(|v| !v.is_empty()).map(|v| v.chars().take(max).collect())
}

/// `ai:saveArtifactToWorkspace`: publishes a session's artifact into its project's artifacts folder.
///
/// The copy lands in the project's main checkout, never a worktree, so it shows on the Artifacts page
/// straight away and outlives the run. An existing file is never overwritten: an identical copy is
/// reused and a different one with the same name pushes the new file to the first free `name-N.ext`.
pub fn save_session_artifact(host: &HostContext, catalog: &Catalog, user_data_dir: &Path, args: &[Value]) -> Result<Value> {
    use super::session_store::store;
    let key = args.first().and_then(Value::as_str).unwrap_or_default();
    let input = args.get(1).and_then(Value::as_str).map(str::trim).unwrap_or_default();
    let sessions = store(user_data_dir);
    let record = sessions
        .get(key)?
        .or_else(|| sessions.all().ok().and_then(|all| all.into_values().find(|r| r["sessionId"] == key)));
    let field = |record: &Value, name: &str| record[name].as_str().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned);
    let working = record.as_ref().and_then(|r| field(r, "worktreePath").or_else(|| field(r, "workingDirectory")));
    let has_scheme = input.split_once(':').is_some_and(|(scheme, _)| scheme.len() > 1 && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)));
    let (Some(record), Some(working)) = (record, working) else { return Err(failure("Invalid workspace path for saving artifact.")) };
    if input.is_empty() || Path::new(input).is_absolute() || has_scheme {
        return Err(failure("Invalid workspace path for saving artifact."));
    }
    let bytes: Vec<u8> = match args.get(2).and_then(Value::as_str) {
        Some(content) => content.as_bytes().to_vec(),
        None => {
            let absolute = praxis_ai::mcp::builtin::read_only_files::resolve_sandboxed_path(Path::new(&working), input).map_err(failure)?;
            let meta = fs::metadata(&absolute).map_err(|_| failure("Artifact file was not found in the session folder."))?;
            if !meta.is_file() || meta.len() > MAX_PUBLISHED_ARTIFACT_BYTES {
                return Err(failure("Artifact must be a file no larger than 25 MB."));
            }
            fs::read(&absolute).map_err(failure)?
        }
    };
    let session_folder = field(&record, "workingDirectory").unwrap_or_else(|| working.clone());
    // The session's own project, else the one whose repository holds the session's folder.
    let projects = catalog.list(storage::PROJECTS);
    let session_root = find_repository_root(Path::new(&session_folder));
    let project = field(&record, "projectId")
        .and_then(|id| projects.iter().find(|p| p["id"] == id.as_str()).cloned())
        .or_else(|| {
            projects
                .iter()
                .find(|p| p["workspaceFolder"].as_str().map(str::trim).filter(|f| !f.is_empty()).is_some_and(|f| find_repository_root(Path::new(f)) == session_root))
                .cloned()
        });
    let base = project.as_ref().and_then(|p| field(p, "workspaceFolder")).unwrap_or_else(|| session_folder.clone());
    let root = find_repository_root(Path::new(&base));
    let folder = normalize_folder(project.as_ref().and_then(|p| p["artifactsFolder"].as_str()));

    let file_name = Path::new(&input.replace('\\', "/"))
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_owned)
        .filter(|n| !n.is_empty() && n != "." && n != "..")
        .ok_or_else(|| failure("Artifact has no file name to publish under."))?;
    let extension = Path::new(&file_name).extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let stem = file_name.strip_suffix(&extension).filter(|s| !s.is_empty()).unwrap_or(&file_name).to_owned();
    let mut outcome = None;
    for attempt in 1..=999 {
        let name = if attempt == 1 { file_name.clone() } else { format!("{stem}-{attempt}{extension}") };
        let relative = format!("{folder}/{name}");
        let absolute = root.join(&relative);
        match fs::read(&absolute) {
            Ok(existing) if existing == bytes => {
                outcome = Some((relative, true));
                break;
            }
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Some(parent) = absolute.parent() {
                    fs::create_dir_all(parent).map_err(failure)?;
                }
                fs::write(&absolute, &bytes).map_err(failure)?;
                outcome = Some((relative, false));
                break;
            }
            Err(error) => return Err(failure(error)),
        }
    }
    let (saved_path, unchanged) = outcome.ok_or_else(|| failure(format!("Too many artifacts named {file_name} in {folder}.")))?;

    if let Some(project) = project {
        let details = args.get(3).cloned().unwrap_or(Value::Null);
        let project_id = project["id"].as_str().unwrap_or_default().to_owned();
        let details_path = root.join(&folder).join(ARTIFACT_DETAILS_FILE);
        let (mut records, groups) = read_details_file(&details_path, &project_id);
        let mut saved = json!({ "path": saved_path, "savedAt": now(), "sessionKey": record["issueKey"] });
        for (name, max) in [("title", 400), ("description", 2000), ("mediaType", 200)] {
            if let Some(text) = trimmed_text(&details[name], max) {
                saved[name] = json!(text);
            }
        }
        let first_goal_line = record["taskDefinition"]["goal"].as_str().and_then(|g| g.lines().next()).map(str::to_owned);
        let session_title = trimmed_text(&record["title"], 400).or_else(|| first_goal_line.and_then(|g| trimmed_text(&json!(g), 400)));
        if let Some(title) = session_title {
            saved["sessionTitle"] = json!(title);
        }
        records.retain(|r| r["path"] != saved["path"]);
        records.push(saved);
        write_details_file(&details_path, &records, &groups)?;
        host.events().emit("artifacts:changed", Some(json!(project_id)));
    }
    Ok(json!({ "savedPath": saved_path, "unchanged": unchanged }))
}

pub fn dispatch(
    host: &HostContext,
    catalog: &Catalog,
    user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    let project_id = args
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| failure("Project ID is required."))?;

    let Some(location) = locate_project(catalog, project_id)? else {
        return Ok(json!({
            "available": false,
            "folder": DEFAULT_ARTIFACTS_FOLDER,
            "items": [],
            "groups": [],
            "truncated": false
        }));
    };

    let artifacts_dir = location.root.join(&location.folder);
    let details_path = artifacts_dir.join(ARTIFACT_DETAILS_FILE);

    match channel {
        "artifacts:list" => {
            let mut entries = Vec::new();
            let mut truncated = false;

            if artifacts_dir.is_dir() {
                walk_folder(
                    &artifacts_dir,
                    &location.folder,
                    1,
                    4,
                    1000,
                    &mut entries,
                    &mut truncated,
                );
            }

            let (records, groups) = read_details_file(&details_path, project_id);
            let existing_paths: HashSet<&str> =
                entries.iter().filter_map(|e| e["path"].as_str()).collect();

            let mut items = Vec::new();
            for entry in &entries {
                let path = entry["path"].as_str().unwrap_or("");
                let record = records.iter().find(|r| r["path"].as_str() == Some(path));
                let kind = artifact_kind(path, record.and_then(|r| r["mediaType"].as_str()));
                let title = if kind == "page" && entry["documentTitle"].is_string() {
                    entry["documentTitle"].as_str().unwrap_or("")
                } else if let Some(t) = record
                    .and_then(|r| r["title"].as_str())
                    .filter(|s| !s.is_empty())
                {
                    t
                } else {
                    entry["name"].as_str().unwrap_or("")
                };

                let mut item = entry.clone();
                item["kind"] = json!(kind);
                item["title"] = json!(title);
                if let Some(r) = record {
                    if let Some(desc) = r.get("description").filter(|v| !v.is_null()) {
                        item["description"] = desc.clone();
                    }
                    if let Some(mt) = r.get("mediaType").filter(|v| !v.is_null()) {
                        item["mediaType"] = mt.clone();
                    }
                    if let Some(sk) = r.get("sessionKey").filter(|v| !v.is_null()) {
                        item["sessionKey"] = sk.clone();
                    }
                    if let Some(st) = r.get("sessionTitle").filter(|v| !v.is_null()) {
                        item["sessionTitle"] = st.clone();
                    }
                    if let Some(sa) = r.get("savedAt").filter(|v| !v.is_null()) {
                        item["savedAt"] = sa.clone();
                    }
                }
                items.push(item);
            }

            items.sort_by(|a, b| {
                let sort_a = a["savedAt"]
                    .as_str()
                    .unwrap_or_else(|| a["modifiedAt"].as_str().unwrap_or(""));
                let sort_b = b["savedAt"]
                    .as_str()
                    .unwrap_or_else(|| b["modifiedAt"].as_str().unwrap_or(""));
                sort_b.cmp(sort_a).then_with(|| {
                    a["path"]
                        .as_str()
                        .unwrap_or("")
                        .cmp(b["path"].as_str().unwrap_or(""))
                })
            });

            let visible_groups: Vec<Value> = groups
                .into_iter()
                .filter_map(|mut g| {
                    let filtered_paths: Vec<Value> = g["paths"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|p| p.as_str().is_some_and(|path| existing_paths.contains(path)))
                        .cloned()
                        .collect();
                    if filtered_paths.is_empty() {
                        None
                    } else {
                        g["paths"] = json!(filtered_paths);
                        Some(g)
                    }
                })
                .collect();

            Ok(json!({
                "available": true,
                "folder": location.folder,
                "root": location.root.to_string_lossy(),
                "items": items,
                "groups": visible_groups,
                "truncated": truncated
            }))
        }
        "artifacts:readText" => {
            let path = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Artifact path required."))?;
            if !is_inside_folder(&location.folder, path) {
                return Err(failure(
                    "Artifact is outside the project's artifacts folder.",
                ));
            }
            let abs_path = location.root.join(path);
            let metadata = fs::metadata(&abs_path)
                .map_err(|_| failure(format!("Artifact file was not found: {path}")))?;
            if metadata.len() > MAX_TEXT_BYTES {
                return Err(failure(
                    "Artifact is larger than 2 MB, too large to preview.",
                ));
            }
            let content = fs::read_to_string(&abs_path)
                .map_err(|e| failure(format!("Cannot read artifact text: {e}")))?;
            Ok(json!(content))
        }
        "artifacts:loadImage" => {
            let path = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Artifact path required."))?;
            if !is_inside_folder(&location.folder, path) {
                return Err(failure(
                    "Artifact is outside the project's artifacts folder.",
                ));
            }
            let abs_path = location.root.join(path);
            let ext = abs_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let mime = match ext.as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "bmp" => "image/bmp",
                "avif" => "image/avif",
                _ => return Ok(Value::Null),
            };
            let _metadata = match fs::metadata(&abs_path) {
                Ok(m) if m.is_file() && m.len() <= MAX_IMAGE_BYTES => m,
                _ => return Ok(Value::Null),
            };
            let bytes = fs::read(&abs_path).map_err(failure)?;
            let b64 = BASE64.encode(&bytes);
            Ok(json!(format!("data:{mime};base64,{b64}")))
        }
        "artifacts:pageThumbnail" => {
            let path = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Artifact path required."))?;
            if !is_inside_folder(&location.folder, path) {
                return Ok(Value::Null);
            }
            let abs_path = location.root.join(path);
            let Ok(meta) = fs::metadata(&abs_path) else {
                return Ok(Value::Null);
            };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let mut hasher = Sha256::new();
            hasher.update(format!(
                "{}\0{}\0{}",
                abs_path.display(),
                meta.len(),
                mtime_ms
            ));
            let hash_hex = format!("{:x}", hasher.finalize());
            let key = &hash_hex[..40.min(hash_hex.len())];

            let cache_file = user_data_dir
                .join("artifact-thumbnails")
                .join(format!("{key}.jpg"));
            if let Ok(bytes) = fs::read(&cache_file) {
                let b64 = BASE64.encode(&bytes);
                return Ok(json!(format!("data:image/jpeg;base64,{b64}")));
            }
            // The shell that drew the page offers its JPEG (a `data:` URL) for the cache, keyed
            // by the same path/size/mtime so an edit to the page refreshes it.
            if let Some(drawn) = args.get(2).and_then(Value::as_str).and_then(|d| d.strip_prefix("data:image/jpeg;base64,"))
                && let Ok(bytes) = BASE64.decode(drawn)
                && bytes.len() <= 2 * 1024 * 1024
            {
                if let Some(dir) = cache_file.parent() {
                    fs::create_dir_all(dir).map_err(failure)?;
                }
                fs::write(&cache_file, &bytes).map_err(failure)?;
                return Ok(json!(format!("data:image/jpeg;base64,{drawn}")));
            }
            Ok(Value::Null)
        }
        "artifacts:createGroup" => {
            let name = args.get(1).and_then(Value::as_str).unwrap_or("").trim();
            let name = if name.is_empty() {
                "Untitled group"
            } else {
                &name[..120.min(name.len())]
            };
            let raw_paths = args
                .get(2)
                .and_then(Value::as_array)
                .ok_or_else(|| failure("Group paths required."))?;
            if raw_paths.len() > 500 {
                return Err(failure("A group holds up to 500 artifacts."));
            }
            let mut paths = Vec::new();
            for p in raw_paths {
                let s = p
                    .as_str()
                    .ok_or_else(|| failure("Invalid path in group."))?;
                if !is_inside_folder(&location.folder, s) {
                    return Err(failure(
                        "Artifact is outside the project's artifacts folder.",
                    ));
                }
                if !paths.contains(&s.to_string()) {
                    paths.push(s.to_string());
                }
            }
            if paths.is_empty() {
                return Err(failure("A group needs at least one artifact."));
            }

            let (records, mut groups) = read_details_file(&details_path, project_id);
            // Remove added paths from existing groups
            for g in groups.iter_mut() {
                if let Some(arr) = g["paths"].as_array_mut() {
                    arr.retain(|p| !paths.iter().any(|new_p| p.as_str() == Some(new_p)));
                }
            }
            groups.retain(|g| g["paths"].as_array().is_some_and(|a| !a.is_empty()));

            let new_group = json!({
                "id": Uuid::new_v4().to_string(),
                "projectId": project_id,
                "name": name,
                "paths": paths,
                "createdAt": now()
            });
            groups.push(new_group.clone());

            write_details_file(&details_path, &records, &groups)?;
            host.events()
                .emit("artifacts:changed", Some(json!(project_id)));

            Ok(new_group)
        }
        "artifacts:updateGroup" => {
            let group_id = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| failure("That group no longer exists."))?;
            let change = args.get(2).cloned().unwrap_or_else(|| json!({}));

            let (records, mut groups) = read_details_file(&details_path, project_id);
            let Some(group) = groups
                .iter_mut()
                .find(|g| g["id"].as_str() == Some(group_id))
            else {
                return Err(failure("That group no longer exists."));
            };

            if let Some(name) = change.get("name").and_then(Value::as_str) {
                let name = name.trim();
                let name = if name.is_empty() {
                    "Untitled group"
                } else {
                    &name[..120.min(name.len())]
                };
                group["name"] = json!(name);
            }
            if let Some(arr) = change.get("paths").and_then(Value::as_array) {
                let mut paths = Vec::new();
                for p in arr {
                    let s = p
                        .as_str()
                        .ok_or_else(|| failure("Invalid path in group."))?;
                    if !is_inside_folder(&location.folder, s) {
                        return Err(failure(
                            "Artifact is outside the project's artifacts folder.",
                        ));
                    }
                    if !paths.contains(&s.to_string()) {
                        paths.push(s.to_string());
                    }
                }
                group["paths"] = json!(paths);
            }

            let updated = group.clone();
            write_details_file(&details_path, &records, &groups)?;
            host.events()
                .emit("artifacts:changed", Some(json!(project_id)));

            Ok(updated)
        }
        "artifacts:deleteGroup" => {
            let group_id = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| failure("That group no longer exists."))?;
            let (records, mut groups) = read_details_file(&details_path, project_id);
            groups.retain(|g| g["id"].as_str() != Some(group_id));

            write_details_file(&details_path, &records, &groups)?;
            host.events()
                .emit("artifacts:changed", Some(json!(project_id)));

            Ok(Value::Null)
        }
        "artifacts:delete" => {
            let path = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Artifact path required."))?;
            if !is_inside_folder(&location.folder, path) {
                return Err(failure(
                    "Artifact is outside the project's artifacts folder.",
                ));
            }
            let abs_path = location.root.join(path);
            if abs_path.is_dir() {
                return Err(failure(
                    "Only files can be deleted from the artifacts folder.",
                ));
            }
            if abs_path.exists() {
                let _ = fs::remove_file(&abs_path);
            }

            let (mut records, mut groups) = read_details_file(&details_path, project_id);
            records.retain(|r| r["path"].as_str() != Some(path));
            for g in groups.iter_mut() {
                if let Some(arr) = g["paths"].as_array_mut() {
                    arr.retain(|p| p.as_str() != Some(path));
                }
            }
            groups.retain(|g| g["paths"].as_array().is_some_and(|a| !a.is_empty()));

            write_details_file(&details_path, &records, &groups)?;
            host.events()
                .emit("artifacts:changed", Some(json!(project_id)));

            Ok(Value::Null)
        }
        "artifacts:reveal" => {
            let path = args
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Artifact path required."))?;
            if !is_inside_folder(&location.folder, path) {
                return Err(failure(
                    "Artifact is outside the project's artifacts folder.",
                ));
            }
            let abs_path = location.root.join(path);
            #[cfg(target_os = "macos")]
            let _ = Command::new("open").arg("-R").arg(&abs_path).spawn();
            #[cfg(target_os = "windows")]
            let _ = Command::new("explorer")
                .arg(format!("/select,\"{}\"", abs_path.display()))
                .spawn();
            #[cfg(all(unix, not(target_os = "macos")))]
            let _ = Command::new("xdg-open")
                .arg(abs_path.parent().unwrap_or(&abs_path))
                .spawn();

            Ok(Value::Null)
        }
        _ => Err(failure(format!("Unsupported artifacts channel: {channel}"))),
    }
}

fn walk_folder(
    dir: &Path,
    folder_prefix: &str,
    depth: usize,
    max_depth: usize,
    max_files: usize,
    entries: &mut Vec<Value>,
    truncated: &mut bool,
) {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return;
    };
    let mut files = Vec::new();
    for entry in read_dir.flatten() {
        files.push(entry);
    }
    files.sort_by_key(|e| e.file_name());

    for entry in files {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_symlink() {
            continue;
        }
        if path.is_dir() {
            if depth < max_depth {
                let sub_prefix = format!("{folder_prefix}/{name}");
                walk_folder(
                    &path,
                    &sub_prefix,
                    depth + 1,
                    max_depth,
                    max_files,
                    entries,
                    truncated,
                );
            }
            continue;
        }
        if !path.is_file() {
            continue;
        }
        if entries.len() >= max_files {
            *truncated = true;
            return;
        }
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let mtime = meta
            .modified()
            .ok()
            .map(|t| {
                let dt: DateTime<Utc> = t.into();
                dt.to_rfc3339_opts(SecondsFormat::Millis, true)
            })
            .unwrap_or_else(now);

        let mut item = json!({
            "path": format!("{folder_prefix}/{name}"),
            "name": name,
            "sizeBytes": meta.len(),
            "modifiedAt": mtime
        });
        if (name.ends_with(".html") || name.ends_with(".htm"))
            && let Some(doc_title) = extract_html_title(&path)
        {
            item["documentTitle"] = json!(doc_title);
        }
        entries.push(item);
    }
}
