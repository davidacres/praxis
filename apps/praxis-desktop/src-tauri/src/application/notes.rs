//! Notes and note-group storage under `<userData>/notes.json`.
use std::collections::HashSet;
use std::path::Path;

use praxis_host::HostContext;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{Catalog, Result, failure, now, storage};

const NOTES_SCHEMA_VERSION: i64 = 1;
const NOTE_TITLE_MAX_LENGTH: usize = 200;
const NOTE_BODY_MAX_LENGTH: usize = 1_000_000;

fn error_result(code: &str, path: &str, message: &str) -> Value {
    json!({
        "ok": false,
        "error": {
            "code": code,
            "message": message,
            "issues": [{ "path": path, "message": message }]
        }
    })
}

fn ok_result(value: Value) -> Value {
    json!({
        "ok": true,
        "value": value
    })
}

fn validate_project<'a>(
    catalog: &'a Catalog,
    project_id: Option<&'a str>,
) -> std::result::Result<&'a str, Value> {
    let Some(id) = project_id.filter(|s| !s.trim().is_empty()) else {
        return Err(error_result(
            "VALIDATION_ERROR",
            "projectId",
            "Project ID is required.",
        ));
    };
    if catalog.get(storage::PROJECTS, id).is_none() {
        return Err(error_result(
            "PROJECT_NOT_FOUND",
            "projectId",
            "Project was not found.",
        ));
    }
    Ok(id)
}

fn load_document(file_path: &Path) -> Result<Value> {
    let raw = storage::read(file_path)?;
    let doc = storage::parse(file_path, raw.as_deref())?;
    if doc.as_object().is_none_or(|o| o.is_empty()) {
        Ok(json!({
            "schemaVersion": NOTES_SCHEMA_VERSION,
            "notes": [],
            "groups": []
        }))
    } else {
        Ok(doc)
    }
}

pub fn dispatch(
    host: &HostContext,
    catalog: &Catalog,
    root: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    let file_path = root.join("notes.json");
    let project_arg = args.first().and_then(Value::as_str);

    let project_id = match validate_project(catalog, project_arg) {
        Ok(id) => id,
        Err(err_val) => return Ok(err_val),
    };

    let mut doc = load_document(&file_path)?;

    match channel {
        "notes:list" => {
            let notes: Vec<Value> = doc["notes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|n| n["projectId"].as_str() == Some(project_id))
                .cloned()
                .collect();
            let groups: Vec<Value> = doc["groups"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|g| g["projectId"].as_str() == Some(project_id))
                .cloned()
                .collect();
            Ok(ok_result(json!({
                "notes": notes,
                "groups": groups
            })))
        }
        "notes:createNote" => {
            let input = match args.get(1) {
                Some(Value::Object(map)) => map,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "$",
                        "Expected an input object.",
                    ));
                }
            };
            let title = match input.get("title").and_then(Value::as_str) {
                Some(t) if !t.trim().is_empty() && t.trim().len() <= NOTE_TITLE_MAX_LENGTH => {
                    t.trim()
                }
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "title",
                        "Invalid field value.",
                    ));
                }
            };
            let body = match input.get("body").and_then(Value::as_str) {
                Some(b) if b.len() <= NOTE_BODY_MAX_LENGTH => b,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "body",
                        "Invalid field value.",
                    ));
                }
            };

            let at = now();
            let id = Uuid::new_v4().to_string();
            let new_note = json!({
                "id": id,
                "projectId": project_id,
                "title": title,
                "body": body,
                "createdAt": at,
                "updatedAt": at
            });

            if let Some(notes) = doc["notes"].as_array_mut() {
                notes.push(new_note.clone());
            }

            let encoded = storage::encoded(&doc)?;
            storage::write_atomic(&file_path, &encoded, false)?;
            host.events().emit("notes:changed", Some(json!(project_id)));

            Ok(ok_result(new_note))
        }
        "notes:updateNote" => {
            let note_id = match args.get(1).and_then(Value::as_str) {
                Some(id) if !id.trim().is_empty() => id,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "id",
                        "Project and entity IDs are required.",
                    ));
                }
            };
            let input = match args.get(2) {
                Some(Value::Object(map)) => map,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "$",
                        "Expected an input object.",
                    ));
                }
            };

            let maybe_title = if let Some(v) = input.get("title") {
                match v.as_str() {
                    Some(t) if !t.trim().is_empty() && t.trim().len() <= NOTE_TITLE_MAX_LENGTH => {
                        Some(t.trim())
                    }
                    _ => {
                        return Ok(error_result(
                            "VALIDATION_ERROR",
                            "title",
                            "Invalid field value.",
                        ));
                    }
                }
            } else {
                None
            };
            let maybe_body = if let Some(v) = input.get("body") {
                match v.as_str() {
                    Some(b) if b.len() <= NOTE_BODY_MAX_LENGTH => Some(b),
                    _ => {
                        return Ok(error_result(
                            "VALIDATION_ERROR",
                            "body",
                            "Invalid field value.",
                        ));
                    }
                }
            } else {
                None
            };

            let notes = doc["notes"]
                .as_array_mut()
                .ok_or_else(|| failure("Invalid notes document."))?;
            let mut updated_note = None;
            for note in notes.iter_mut() {
                if note["id"].as_str() == Some(note_id) {
                    if note["projectId"].as_str() != Some(project_id) {
                        return Ok(error_result(
                            "PROJECT_MISMATCH",
                            "projectId",
                            "Entity belongs to another project.",
                        ));
                    }
                    if let Some(t) = maybe_title {
                        note["title"] = json!(t);
                    }
                    if let Some(b) = maybe_body {
                        note["body"] = json!(b);
                    }
                    note["updatedAt"] = json!(now());
                    updated_note = Some(note.clone());
                    break;
                }
            }

            let Some(res) = updated_note else {
                return Ok(error_result(
                    "NOTE_NOT_FOUND",
                    "id",
                    "Entity was not found.",
                ));
            };

            let encoded = storage::encoded(&doc)?;
            storage::write_atomic(&file_path, &encoded, false)?;
            host.events().emit("notes:changed", Some(json!(project_id)));

            Ok(ok_result(res))
        }
        "notes:deleteNote" => {
            let note_id = match args.get(1).and_then(Value::as_str) {
                Some(id) if !id.trim().is_empty() => id,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "id",
                        "Project and entity IDs are required.",
                    ));
                }
            };

            let notes = doc["notes"]
                .as_array_mut()
                .ok_or_else(|| failure("Invalid notes document."))?;
            let before_count = notes.len();
            let mut found_mismatch = false;
            notes.retain(|n| {
                if n["id"].as_str() == Some(note_id) {
                    if n["projectId"].as_str() != Some(project_id) {
                        found_mismatch = true;
                        return true;
                    }
                    return false;
                }
                true
            });

            if found_mismatch {
                return Ok(error_result(
                    "PROJECT_MISMATCH",
                    "projectId",
                    "Entity belongs to another project.",
                ));
            }
            if notes.len() == before_count {
                return Ok(error_result(
                    "NOTE_NOT_FOUND",
                    "id",
                    "Entity was not found.",
                ));
            }

            if let Some(groups) = doc["groups"].as_array_mut() {
                for group in groups.iter_mut() {
                    if group["projectId"].as_str() == Some(project_id)
                        && let Some(note_ids) = group["noteIds"].as_array_mut()
                    {
                        note_ids.retain(|id| id.as_str() != Some(note_id));
                    }
                }
            }

            let encoded = storage::encoded(&doc)?;
            storage::write_atomic(&file_path, &encoded, false)?;
            host.events().emit("notes:changed", Some(json!(project_id)));

            Ok(ok_result(Value::Null))
        }
        "notes:createGroup" => {
            let input = match args.get(1) {
                Some(Value::Object(map)) => map,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "$",
                        "Expected an input object.",
                    ));
                }
            };
            let title = match input.get("title").and_then(Value::as_str) {
                Some(t) if !t.trim().is_empty() && t.trim().len() <= NOTE_TITLE_MAX_LENGTH => {
                    t.trim()
                }
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "title",
                        "Invalid field value.",
                    ));
                }
            };
            let raw_ids = match input.get("noteIds").and_then(Value::as_array) {
                Some(ids) => ids,
                None => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "noteIds",
                        "Expected unique note IDs and a project ID.",
                    ));
                }
            };

            let mut note_ids = Vec::new();
            let mut seen = HashSet::new();
            for item in raw_ids {
                let Some(id) = item.as_str() else {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "noteIds",
                        "Invalid field value.",
                    ));
                };
                if !seen.insert(id) {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "noteIds",
                        "Expected unique note IDs and a project ID.",
                    ));
                }
                // Verify note exists in project
                let exists = doc["notes"].as_array().into_iter().flatten().any(|n| {
                    n["id"].as_str() == Some(id) && n["projectId"].as_str() == Some(project_id)
                });
                if !exists {
                    return Ok(error_result(
                        "NOTE_NOT_FOUND",
                        "id",
                        "Entity was not found.",
                    ));
                }
                note_ids.push(id.to_string());
            }

            let at = now();
            let new_group = json!({
                "id": Uuid::new_v4().to_string(),
                "projectId": project_id,
                "title": title,
                "noteIds": note_ids,
                "createdAt": at,
                "updatedAt": at
            });

            if let Some(groups) = doc["groups"].as_array_mut() {
                groups.push(new_group.clone());
            }

            let encoded = storage::encoded(&doc)?;
            storage::write_atomic(&file_path, &encoded, false)?;
            host.events().emit("notes:changed", Some(json!(project_id)));

            Ok(ok_result(new_group))
        }
        "notes:updateGroup" => {
            let group_id = match args.get(1).and_then(Value::as_str) {
                Some(id) if !id.trim().is_empty() => id,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "id",
                        "Project and entity IDs are required.",
                    ));
                }
            };
            let input = match args.get(2) {
                Some(Value::Object(map)) => map,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "$",
                        "Expected an input object.",
                    ));
                }
            };
            let title = match input.get("title").and_then(Value::as_str) {
                Some(t) if !t.trim().is_empty() && t.trim().len() <= NOTE_TITLE_MAX_LENGTH => {
                    t.trim()
                }
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "title",
                        "Invalid field value.",
                    ));
                }
            };

            let groups = doc["groups"]
                .as_array_mut()
                .ok_or_else(|| failure("Invalid notes document."))?;
            let mut updated_group = None;
            for group in groups.iter_mut() {
                if group["id"].as_str() == Some(group_id) {
                    if group["projectId"].as_str() != Some(project_id) {
                        return Ok(error_result(
                            "PROJECT_MISMATCH",
                            "projectId",
                            "Entity belongs to another project.",
                        ));
                    }
                    group["title"] = json!(title);
                    group["updatedAt"] = json!(now());
                    updated_group = Some(group.clone());
                    break;
                }
            }

            let Some(res) = updated_group else {
                return Ok(error_result(
                    "GROUP_NOT_FOUND",
                    "id",
                    "Entity was not found.",
                ));
            };

            let encoded = storage::encoded(&doc)?;
            storage::write_atomic(&file_path, &encoded, false)?;
            host.events().emit("notes:changed", Some(json!(project_id)));

            Ok(ok_result(res))
        }
        "notes:deleteGroup" => {
            let group_id = match args.get(1).and_then(Value::as_str) {
                Some(id) if !id.trim().is_empty() => id,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "id",
                        "Project and entity IDs are required.",
                    ));
                }
            };

            let groups = doc["groups"]
                .as_array_mut()
                .ok_or_else(|| failure("Invalid notes document."))?;
            let before_count = groups.len();
            let mut found_mismatch = false;
            groups.retain(|g| {
                if g["id"].as_str() == Some(group_id) {
                    if g["projectId"].as_str() != Some(project_id) {
                        found_mismatch = true;
                        return true;
                    }
                    return false;
                }
                true
            });

            if found_mismatch {
                return Ok(error_result(
                    "PROJECT_MISMATCH",
                    "projectId",
                    "Entity belongs to another project.",
                ));
            }
            if groups.len() == before_count {
                return Ok(error_result(
                    "GROUP_NOT_FOUND",
                    "id",
                    "Entity was not found.",
                ));
            }

            let encoded = storage::encoded(&doc)?;
            storage::write_atomic(&file_path, &encoded, false)?;
            host.events().emit("notes:changed", Some(json!(project_id)));

            Ok(ok_result(Value::Null))
        }
        "notes:replaceMemberships" => {
            let group_id = match args.get(1).and_then(Value::as_str) {
                Some(id) if !id.trim().is_empty() => id,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "id",
                        "Project and entity IDs are required.",
                    ));
                }
            };
            let raw_ids = match args.get(2).and_then(Value::as_array) {
                Some(ids) => ids,
                None => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "noteIds",
                        "Expected unique note IDs and a project ID.",
                    ));
                }
            };

            let mut note_ids = Vec::new();
            let mut seen = HashSet::new();
            for item in raw_ids {
                let Some(id) = item.as_str() else {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "noteIds",
                        "Invalid field value.",
                    ));
                };
                if !seen.insert(id) {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "noteIds",
                        "Expected unique note IDs and a project ID.",
                    ));
                }
                let exists = doc["notes"].as_array().into_iter().flatten().any(|n| {
                    n["id"].as_str() == Some(id) && n["projectId"].as_str() == Some(project_id)
                });
                if !exists {
                    return Ok(error_result(
                        "NOTE_NOT_FOUND",
                        "id",
                        "Entity was not found.",
                    ));
                }
                note_ids.push(id.to_string());
            }

            let groups = doc["groups"]
                .as_array_mut()
                .ok_or_else(|| failure("Invalid notes document."))?;
            let mut updated_group = None;
            for group in groups.iter_mut() {
                if group["id"].as_str() == Some(group_id) {
                    if group["projectId"].as_str() != Some(project_id) {
                        return Ok(error_result(
                            "PROJECT_MISMATCH",
                            "projectId",
                            "Entity belongs to another project.",
                        ));
                    }
                    group["noteIds"] = json!(note_ids);
                    group["updatedAt"] = json!(now());
                    updated_group = Some(group.clone());
                    break;
                }
            }

            let Some(res) = updated_group else {
                return Ok(error_result(
                    "GROUP_NOT_FOUND",
                    "id",
                    "Entity was not found.",
                ));
            };

            let encoded = storage::encoded(&doc)?;
            storage::write_atomic(&file_path, &encoded, false)?;
            host.events().emit("notes:changed", Some(json!(project_id)));

            Ok(ok_result(res))
        }
        "notes:prepareSnapshot" => {
            let source = match args.get(1) {
                Some(Value::Object(map)) => map,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "source",
                        "Invalid note source.",
                    ));
                }
            };
            let kind = match source.get("kind").and_then(Value::as_str) {
                Some(k) if k == "note" || k == "group" => k,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "source",
                        "Invalid note source.",
                    ));
                }
            };
            let source_id = match source.get("id").and_then(Value::as_str) {
                Some(id) if !id.trim().is_empty() => id,
                _ => {
                    return Ok(error_result(
                        "VALIDATION_ERROR",
                        "source",
                        "Invalid note source.",
                    ));
                }
            };

            let (title, note_list) = if kind == "note" {
                let note = doc["notes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|n| n["id"].as_str() == Some(source_id));
                let Some(note) = note else {
                    return Ok(error_result(
                        "NOTE_NOT_FOUND",
                        "id",
                        "Entity was not found.",
                    ));
                };
                if note["projectId"].as_str() != Some(project_id) {
                    return Ok(error_result(
                        "PROJECT_MISMATCH",
                        "projectId",
                        "Entity belongs to another project.",
                    ));
                }
                (
                    note["title"].as_str().unwrap_or("").to_string(),
                    vec![note.clone()],
                )
            } else {
                let group = doc["groups"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|g| g["id"].as_str() == Some(source_id));
                let Some(group) = group else {
                    return Ok(error_result(
                        "GROUP_NOT_FOUND",
                        "id",
                        "Entity was not found.",
                    ));
                };
                if group["projectId"].as_str() != Some(project_id) {
                    return Ok(error_result(
                        "PROJECT_MISMATCH",
                        "projectId",
                        "Entity belongs to another project.",
                    ));
                }
                let member_ids = group["noteIds"].as_array().into_iter().flatten();
                let mut resolved = Vec::new();
                for member_id_val in member_ids {
                    let member_id = member_id_val.as_str().unwrap_or("");
                    let note = doc["notes"].as_array().into_iter().flatten().find(|n| {
                        n["id"].as_str() == Some(member_id)
                            && n["projectId"].as_str() == Some(project_id)
                    });
                    let Some(note) = note else {
                        return Ok(error_result(
                            "NOTE_NOT_FOUND",
                            "id",
                            "Entity was not found.",
                        ));
                    };
                    resolved.push(note.clone());
                }
                if resolved.is_empty() {
                    return Ok(error_result("EMPTY_GROUP", "source", "Group has no notes."));
                }
                (group["title"].as_str().unwrap_or("").to_string(), resolved)
            };

            let snapshot_entries: Vec<Value> = note_list
                .into_iter()
                .map(|n| {
                    json!({
                        "id": n["id"],
                        "title": n["title"],
                        "body": n["body"],
                        "createdAt": n["createdAt"],
                        "updatedAt": n["updatedAt"]
                    })
                })
                .collect();

            Ok(ok_result(json!({
                "projectId": project_id,
                "capturedAt": now(),
                "source": {
                    "kind": kind,
                    "id": source_id,
                    "title": title
                },
                "notes": snapshot_entries
            })))
        }
        _ => Err(failure(format!("Unsupported notes channel: {channel}"))),
    }
}
