//! Deterministic validation of an untrusted gadget envelope (a port of core's `validation.ts`).
//!
//! A gadget request is untrusted input - a model, a workflow template a user wrote, or an older
//! client. Validation runs host-side before anything is persisted or sent to a renderer, and it
//! normalises as well as checks: oversized collections are trimmed or refused, secrets are masked.
//! What reaches a renderer is always in-bounds. [`coerce_gadget_block`] is the boundary the chat
//! pipeline uses: a refused gadget becomes a `fallback` block carrying the reason.

use serde_json::{Map, Value, json};

use super::contracts::{GADGET_CONTRACT_VERSION, GadgetEnvelope, GadgetError};
use super::fallback::gadget_fallback_text;
use super::limits::{
    ACTIONS, APPROVAL_EVIDENCE, ARTIFACTS, CHART_POINTS, CHART_SERIES, CHOICE_OPTIONS, CONFLICTS, DIFF_FILES, DIFF_PREVIEW_LENGTH,
    ENVELOPE_BYTES, FORM_FIELDS, HANDOFF_ITEMS, IMAGES, PROGRESS_STEPS, STRING_LENGTH, TABLE_COLUMNS, TABLE_ROWS,
};
use super::redaction::redact_deep;

pub const GADGET_KINDS: [&str; 12] = ["choice", "confirmation", "form", "table", "chart", "progress", "diff", "artifact", "image", "handoff", "conflict", "approval"];

type Fail<T> = Result<T, GadgetError>;

fn err<T>(code: &str, message: impl Into<String>, path: Option<String>) -> Fail<T> {
    Err(GadgetError { code: code.to_owned(), message: message.into(), path, retryable: Some(false) })
}

fn record<'a>(value: &'a Value, path: &str) -> Fail<&'a Map<String, Value>> {
    match value.as_object() {
        Some(map) => Ok(map),
        None => err("schema-invalid", format!("\"{path}\" must be an object."), Some(path.to_owned())),
    }
}

#[derive(Default, Clone, Copy)]
struct Str {
    required: bool,
    max: Option<usize>,
    allow_empty: bool,
}

fn read_string(source: &Map<String, Value>, key: &str, path: &str, options: Str) -> Fail<Option<String>> {
    let full = format!("{path}.{key}");
    let Some(value) = source.get(key).filter(|v| !v.is_null()) else {
        return if options.required { err("schema-invalid", format!("\"{full}\" is required."), Some(full)) } else { Ok(None) };
    };
    let Some(text) = value.as_str() else { return err("schema-invalid", format!("\"{full}\" must be a string."), Some(full)) };
    if !options.allow_empty && options.required && text.trim().is_empty() {
        return err("schema-invalid", format!("\"{full}\" must not be empty."), Some(full));
    }
    let max = options.max.unwrap_or(STRING_LENGTH);
    if text.encode_utf16().count() > max {
        return err("payload-too-large", format!("\"{full}\" exceeds {max} characters."), Some(full));
    }
    Ok(Some(text.to_owned()))
}

fn req(max: usize) -> Str {
    Str { required: true, max: Some(max), allow_empty: false }
}
fn opt(max: usize) -> Str {
    Str { required: false, max: Some(max), allow_empty: false }
}
const REQ: Str = Str { required: true, max: None, allow_empty: false };
const OPT: Str = Str { required: false, max: None, allow_empty: false };

fn read_number(source: &Map<String, Value>, key: &str, path: &str, required: bool, min: Option<f64>, max: Option<f64>) -> Fail<Option<Value>> {
    let full = format!("{path}.{key}");
    let Some(value) = source.get(key).filter(|v| !v.is_null()) else {
        return if required { err("schema-invalid", format!("\"{full}\" is required."), Some(full)) } else { Ok(None) };
    };
    let Some(number) = value.as_f64().filter(|n| n.is_finite()) else { return err("schema-invalid", format!("\"{full}\" must be a finite number."), Some(full)) };
    if let Some(min) = min.filter(|m| number < *m) {
        return err("schema-invalid", format!("\"{full}\" must be at least {min}."), Some(full));
    }
    if let Some(max) = max.filter(|m| number > *m) {
        return err("schema-invalid", format!("\"{full}\" must be at most {max}."), Some(full));
    }
    Ok(Some(value.clone()))
}

fn read_bool(source: &Map<String, Value>, key: &str, path: &str) -> Fail<Option<bool>> {
    match source.get(key).filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => err("schema-invalid", format!("\"{path}.{key}\" must be a boolean."), Some(format!("{path}.{key}"))),
    }
}

/// An array trimmed to `max` (data collections keep a usable surface and flag `truncated`).
fn read_trimmed(source: &Map<String, Value>, key: &str, path: &str, max: usize, required: bool) -> Fail<(Vec<Value>, bool)> {
    let full = format!("{path}.{key}");
    match source.get(key).filter(|v| !v.is_null()) {
        None if required => err("schema-invalid", format!("\"{full}\" is required."), Some(full)),
        None => Ok((Vec::new(), false)),
        Some(Value::Array(items)) => Ok((items.iter().take(max).cloned().collect(), items.len() > max)),
        Some(_) => err("schema-invalid", format!("\"{full}\" must be an array."), Some(full)),
    }
}

/// An array that must fit (controls are refused, never silently dropped).
fn read_bounded(source: &Map<String, Value>, key: &str, path: &str, max: usize, required: bool, min_length: usize) -> Fail<Vec<Value>> {
    let full = format!("{path}.{key}");
    let items = match source.get(key).filter(|v| !v.is_null()) {
        None if required => return err("schema-invalid", format!("\"{full}\" is required."), Some(full)),
        None => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return err("schema-invalid", format!("\"{full}\" must be an array."), Some(full)),
    };
    if items.len() > max {
        return err("payload-too-large", format!("\"{full}\" has {} entries; the limit is {max}.", items.len()), Some(full));
    }
    if items.len() < min_length {
        return err("schema-invalid", format!("\"{full}\" needs at least {min_length} entr{}.", if min_length == 1 { "y" } else { "ies" }), Some(full));
    }
    Ok(items.clone())
}

fn put(out: &mut Map<String, Value>, key: &str, value: Option<impl Into<Value>>) {
    if let Some(value) = value {
        out.insert(key.to_owned(), value.into());
    }
}

fn parse_millis(raw: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw).ok().map(|d| d.timestamp_millis())
}

fn read_timestamp(source: &Map<String, Value>, key: &str, required: bool) -> Fail<Option<String>> {
    let Some(raw) = read_string(source, key, "", Str { required, ..Str::default() })? else { return Ok(None) };
    if parse_millis(&raw).is_none() {
        return err("schema-invalid", format!("\".{key}\" must be an ISO timestamp."), Some(format!(".{key}")));
    }
    Ok(Some(raw))
}

// -- image detection ---------------------------------------------------------------------------

const IMAGE_MEDIA_TYPES: [&str; 8] = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp", "image/avif", "image/svg+xml"];
const IMAGE_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"];

/// Whether an artifact is an image, judged by its media type or - without one - its extension.
pub fn is_image_artifact(path: &str, media_type: Option<&str>) -> bool {
    if let Some(media) = media_type.filter(|m| !m.is_empty()) {
        return IMAGE_MEDIA_TYPES.contains(&media.to_lowercase().as_str());
    }
    let bare = path.split(['?', '#']).next().unwrap_or_default().to_lowercase();
    bare.rsplit_once('.').is_some_and(|(_, ext)| IMAGE_EXTENSIONS.contains(&ext) || ext == "svg")
}

/// An artifact gadget holding nothing but images is a picture, not a file list: it is rewritten as
/// an `image` gadget (identity, scope, actions and fallback text carry over). Handover metadata
/// keeps it an artifact - that is a receipt about a body of work, not a gallery.
pub fn promote_artifact_gadget_to_image(input: &Value) -> Value {
    let Some(envelope) = input.as_object().filter(|e| e.get("kind").and_then(Value::as_str) == Some("artifact")) else { return input.clone() };
    let Some(payload) = envelope.get("payload").and_then(Value::as_object) else { return input.clone() };
    if payload.get("handover").is_some_and(|h| !h.is_null()) {
        return input.clone();
    }
    let Some(artifacts) = payload.get("artifacts").and_then(Value::as_array).filter(|a| !a.is_empty()) else { return input.clone() };
    let all_images = artifacts.iter().all(|a| is_image_artifact(a["path"].as_str().unwrap_or_default(), a["mediaType"].as_str()));
    if !all_images {
        return input.clone();
    }
    let images: Vec<Value> = artifacts
        .iter()
        .map(|artifact| {
            let mut image = Map::new();
            for key in ["name", "path", "mediaType", "sizeBytes", "description", "content"] {
                if let Some(value) = artifact.get(key).filter(|v| !v.is_null() && v.as_str() != Some("")) {
                    image.insert(key.to_owned(), value.clone());
                }
            }
            Value::Object(image)
        })
        .collect();
    let mut promoted = envelope.clone();
    promoted.insert("kind".into(), json!("image"));
    promoted.insert("payload".into(), json!({ "title": payload.get("title").and_then(Value::as_str).unwrap_or("Images"), "images": images }));
    Value::Object(promoted)
}

// -- per-kind payloads -------------------------------------------------------------------------

fn choice_option(raw: &Value, path: &str) -> Fail<Value> {
    let option = record(raw, path)?;
    let mut out = Map::new();
    put(&mut out, "value", read_string(option, "value", path, req(200))?);
    put(&mut out, "label", read_string(option, "label", path, req(400))?);
    put(&mut out, "description", read_string(option, "description", path, opt(2_000))?);
    put(&mut out, "disabledReason", read_string(option, "disabledReason", path, opt(400))?);
    Ok(Value::Object(out))
}

fn image_like(raw: &Value, path: &str, require_image: bool) -> Fail<Value> {
    let item = record(raw, path)?;
    let file_path = read_string(item, "path", path, req(1_000))?.unwrap_or_default();
    // Resolved against the session's folder by the host; refusing traversal keeps that from seeing `..`.
    if file_path.contains("..") {
        return err("schema-invalid", format!("\"{path}.path\" must not traverse outside the workspace."), Some(format!("{path}.path")));
    }
    let mut out = Map::new();
    let media_type = read_string(item, "mediaType", path, opt(200))?.filter(|m| !m.is_empty());
    let content = read_string(item, "content", path, opt(STRING_LENGTH))?;
    if require_image && !is_image_artifact(&file_path, media_type.as_deref()) {
        return err("schema-invalid", format!("\"{path}\" must be an image (an image media type, or a known image file extension)."), Some(format!("{path}.mediaType")));
    }
    let mut category = None;
    let mut verdict = None;
    if !require_image {
        category = read_string(item, "category", path, opt(50))?;
        if let Some(c) = category.as_deref().filter(|c| !["deliverable", "evidence", "report", "diff", "log"].contains(c)) {
            let _ = c;
            return err("schema-invalid", format!("\"{path}.category\" must be one of: deliverable, evidence, report, diff, log."), Some(format!("{path}.category")));
        }
        verdict = read_string(item, "verdict", path, opt(50))?;
        if verdict.as_deref().is_some_and(|v| !["passed", "failed", "needs-review"].contains(&v)) {
            return err("schema-invalid", format!("\"{path}.verdict\" must be one of: passed, failed, needs-review."), Some(format!("{path}.verdict")));
        }
    }
    let size = read_number(item, "sizeBytes", path, false, Some(0.0), None)?;
    let description = read_string(item, "description", path, OPT)?;
    let language = if require_image { None } else { read_string(item, "language", path, opt(100))? };
    let version = if require_image { None } else { read_number(item, "version", path, false, Some(1.0), None)? };
    let identifier = if require_image { None } else { read_string(item, "identifier", path, opt(200))? };
    put(&mut out, "name", read_string(item, "name", path, req(400))?);
    out.insert("path".into(), json!(file_path));
    put(&mut out, "mediaType", media_type);
    put(&mut out, "description", description);
    put(&mut out, "sizeBytes", size);
    put(&mut out, "category", category.filter(|c| !c.is_empty()));
    put(&mut out, "verdict", verdict.filter(|v| !v.is_empty()));
    put(&mut out, "content", content);
    put(&mut out, "language", language.filter(|l| !l.is_empty()));
    put(&mut out, "version", version);
    put(&mut out, "identifier", identifier.filter(|i| !i.is_empty()));
    Ok(Value::Object(out))
}

fn validate_payload(kind: &str, payload: &Map<String, Value>) -> Fail<Map<String, Value>> {
    let p = "payload";
    let mut out = Map::new();
    match kind {
        "choice" => {
            let options = read_bounded(payload, "options", p, CHOICE_OPTIONS, true, 1)?
                .iter()
                .enumerate()
                .map(|(i, o)| choice_option(o, &format!("payload.options[{i}]")))
                .collect::<Fail<Vec<_>>>()?;
            let default_value = read_string(payload, "defaultValue", p, opt(200))?;
            if let Some(default) = &default_value
                && !options.iter().any(|o| o["value"] == default.as_str())
            {
                return err("schema-invalid", "\"payload.defaultValue\" must name one of the options.", Some("payload.defaultValue".into()));
            }
            let mut seen = std::collections::HashSet::new();
            for option in &options {
                let value = option["value"].as_str().unwrap_or_default();
                if !seen.insert(value.to_owned()) {
                    return err("schema-invalid", format!("Duplicate option value \"{value}\"."), Some("payload.options".into()));
                }
            }
            put(&mut out, "question", read_string(payload, "question", p, req(2_000))?);
            put(&mut out, "detail", read_string(payload, "detail", p, OPT)?);
            put(&mut out, "multiple", read_bool(payload, "multiple", p)?);
            put(&mut out, "defaultValue", default_value);
            out.insert("options".into(), Value::Array(options));
        }
        "confirmation" => {
            let consequences = read_bounded(payload, "consequences", p, 20, false, 0)?;
            for (i, entry) in consequences.iter().enumerate() {
                if !entry.is_string() {
                    return err("schema-invalid", format!("\"payload.consequences[{i}]\" must be a string."), Some(format!("payload.consequences[{i}]")));
                }
            }
            put(&mut out, "question", read_string(payload, "question", p, req(2_000))?);
            put(&mut out, "detail", read_string(payload, "detail", p, OPT)?);
            put(&mut out, "confirmLabel", read_string(payload, "confirmLabel", p, opt(80))?);
            put(&mut out, "cancelLabel", read_string(payload, "cancelLabel", p, opt(80))?);
            if !consequences.is_empty() {
                out.insert("consequences".into(), Value::Array(consequences));
            }
        }
        "form" => {
            let mut fields = Vec::new();
            for (i, raw) in read_bounded(payload, "fields", p, FORM_FIELDS, true, 1)?.iter().enumerate() {
                let path = format!("payload.fields[{i}]");
                let field = record(raw, &path)?;
                let field_type = read_string(field, "type", &path, req(20))?.unwrap_or_default();
                if !["text", "textarea", "number", "boolean", "select"].contains(&field_type.as_str()) {
                    return err("schema-invalid", format!("\"{path}.type\" is not a supported field type."), Some(format!("{path}.type")));
                }
                let options = read_bounded(field, "options", &path, CHOICE_OPTIONS, false, 0)?
                    .iter()
                    .enumerate()
                    .map(|(j, o)| choice_option(o, &format!("{path}.options[{j}]")))
                    .collect::<Fail<Vec<_>>>()?;
                if field_type == "select" && options.is_empty() {
                    return err("schema-invalid", format!("\"{path}.options\" is required for a select field."), Some(format!("{path}.options")));
                }
                if let Some(default) = field.get("defaultValue").filter(|d| !d.is_null())
                    && !(default.is_string() || default.is_number() || default.is_boolean())
                {
                    return err("schema-invalid", format!("\"{path}.defaultValue\" must be a string, number or boolean."), Some(format!("{path}.defaultValue")));
                }
                let mut entry = Map::new();
                put(&mut entry, "name", read_string(field, "name", &path, req(120))?);
                put(&mut entry, "label", read_string(field, "label", &path, req(400))?);
                entry.insert("type".into(), json!(field_type));
                put(&mut entry, "required", read_bool(field, "required", &path)?);
                put(&mut entry, "placeholder", read_string(field, "placeholder", &path, opt(200))?);
                put(&mut entry, "help", read_string(field, "help", &path, opt(2_000))?);
                put(&mut entry, "defaultValue", field.get("defaultValue").filter(|d| !d.is_null()).cloned());
                put(&mut entry, "min", read_number(field, "min", &path, false, None, None)?);
                put(&mut entry, "max", read_number(field, "max", &path, false, None, None)?);
                put(&mut entry, "maxLength", read_number(field, "maxLength", &path, false, Some(1.0), Some(STRING_LENGTH as f64))?);
                if !options.is_empty() {
                    entry.insert("options".into(), Value::Array(options));
                }
                fields.push(Value::Object(entry));
            }
            let mut names = std::collections::HashSet::new();
            for field in &fields {
                let name = field["name"].as_str().unwrap_or_default();
                if !names.insert(name.to_owned()) {
                    return err("schema-invalid", format!("Duplicate field name \"{name}\"."), Some("payload.fields".into()));
                }
            }
            put(&mut out, "title", read_string(payload, "title", p, req(400))?);
            put(&mut out, "description", read_string(payload, "description", p, OPT)?);
            out.insert("fields".into(), Value::Array(fields));
        }
        "table" => {
            let mut columns = Vec::new();
            for (i, raw) in read_bounded(payload, "columns", p, TABLE_COLUMNS, true, 1)?.iter().enumerate() {
                let path = format!("payload.columns[{i}]");
                let column = record(raw, &path)?;
                let align = read_string(column, "align", &path, opt(10))?;
                if align.as_deref().is_some_and(|a| a != "start" && a != "end") {
                    return err("schema-invalid", format!("\"{path}.align\" must be \"start\" or \"end\"."), Some(format!("{path}.align")));
                }
                let mut entry = Map::new();
                put(&mut entry, "key", read_string(column, "key", &path, req(120))?);
                put(&mut entry, "label", read_string(column, "label", &path, req(200))?);
                put(&mut entry, "align", align);
                put(&mut entry, "mono", read_bool(column, "mono", &path)?);
                columns.push(Value::Object(entry));
            }
            let (items, trimmed) = read_trimmed(payload, "rows", p, TABLE_ROWS, true)?;
            let mut rows = Vec::new();
            for (i, raw) in items.iter().enumerate() {
                let path = format!("payload.rows[{i}]");
                let row = record(raw, &path)?;
                let mut cells = Map::new();
                for column in &columns {
                    let key = column["key"].as_str().unwrap_or_default();
                    let cell = match row.get(key) {
                        None | Some(Value::Null) => Value::Null,
                        Some(Value::String(text)) if text.chars().count() > 1_000 => json!(format!("{}…", text.chars().take(1_000).collect::<String>())),
                        Some(v @ (Value::String(_) | Value::Number(_) | Value::Bool(_))) => v.clone(),
                        Some(_) => return err("schema-invalid", format!("\"{path}.{key}\" must be a string, number, boolean or null."), Some(format!("{path}.{key}"))),
                    };
                    cells.insert(key.to_owned(), cell);
                }
                rows.push(Value::Object(cells));
            }
            put(&mut out, "title", read_string(payload, "title", p, opt(400))?);
            put(&mut out, "caption", read_string(payload, "caption", p, OPT)?);
            put(&mut out, "emptyText", read_string(payload, "emptyText", p, opt(400))?);
            out.insert("columns".into(), Value::Array(columns));
            out.insert("rows".into(), Value::Array(rows));
            out.insert("truncated".into(), json!(trimmed || read_bool(payload, "truncated", p)? == Some(true)));
        }
        "chart" => {
            let chart_kind = read_string(payload, "chartKind", p, req(20))?.unwrap_or_default();
            if chart_kind != "bar" && chart_kind != "line" {
                return err("schema-invalid", "\"payload.chartKind\" must be \"bar\" or \"line\".", Some("payload.chartKind".into()));
            }
            let mut series = Vec::new();
            for (i, raw) in read_bounded(payload, "series", p, CHART_SERIES, true, 1)?.iter().enumerate() {
                let path = format!("payload.series[{i}]");
                let entry = record(raw, &path)?;
                let (points, _) = read_trimmed(entry, "points", &path, CHART_POINTS, true)?;
                let mut checked = Vec::new();
                for (j, raw_point) in points.iter().enumerate() {
                    let point_path = format!("{path}.points[{j}]");
                    let point = record(raw_point, &point_path)?;
                    let x = point.get("x").cloned().unwrap_or(Value::Null);
                    if !(x.is_string() || x.is_number()) {
                        return err("schema-invalid", format!("\"{point_path}.x\" must be a string or number."), Some(format!("{point_path}.x")));
                    }
                    checked.push(json!({ "x": x, "y": read_number(point, "y", &point_path, true, None, None)? }));
                }
                series.push(json!({ "label": read_string(entry, "label", &path, req(200))?, "points": checked }));
            }
            put(&mut out, "title", read_string(payload, "title", p, opt(400))?);
            put(&mut out, "xLabel", read_string(payload, "xLabel", p, opt(200))?);
            put(&mut out, "yLabel", read_string(payload, "yLabel", p, opt(200))?);
            put(&mut out, "summary", read_string(payload, "summary", p, OPT)?);
            out.insert("chartKind".into(), json!(chart_kind));
            out.insert("series".into(), Value::Array(series));
        }
        "progress" => {
            let status = read_string(payload, "status", p, req(20))?.unwrap_or_default();
            if !["running", "blocked", "succeeded", "failed", "cancelled"].contains(&status.as_str()) {
                return err("schema-invalid", "\"payload.status\" is not a supported progress status.", Some("payload.status".into()));
            }
            let mut steps = Vec::new();
            for (i, raw) in read_bounded(payload, "steps", p, PROGRESS_STEPS, false, 0)?.iter().enumerate() {
                let path = format!("payload.steps[{i}]");
                let step = record(raw, &path)?;
                let state = read_string(step, "state", &path, req(20))?.unwrap_or_default();
                if !["pending", "running", "done", "failed"].contains(&state.as_str()) {
                    return err("schema-invalid", format!("\"{path}.state\" is not a supported step state."), Some(format!("{path}.state")));
                }
                steps.push(json!({ "label": read_string(step, "label", &path, req(400))?, "state": state }));
            }
            put(&mut out, "title", read_string(payload, "title", p, req(400))?);
            put(&mut out, "detail", read_string(payload, "detail", p, OPT)?);
            put(&mut out, "percent", read_number(payload, "percent", p, false, Some(0.0), Some(100.0))?);
            out.insert("status".into(), json!(status));
            if !steps.is_empty() {
                out.insert("steps".into(), Value::Array(steps));
            }
        }
        "diff" => {
            let (items, trimmed) = read_trimmed(payload, "files", p, DIFF_FILES, true)?;
            let mut files = Vec::new();
            for (i, raw) in items.iter().enumerate() {
                let path = format!("payload.files[{i}]");
                let file = record(raw, &path)?;
                let status = read_string(file, "status", &path, req(20))?.unwrap_or_default();
                if !["added", "modified", "deleted", "renamed"].contains(&status.as_str()) {
                    return err("schema-invalid", format!("\"{path}.status\" is not a supported file status."), Some(format!("{path}.status")));
                }
                let mut entry = Map::new();
                put(&mut entry, "path", read_string(file, "path", &path, req(1_000))?);
                put(&mut entry, "previousPath", read_string(file, "previousPath", &path, opt(1_000))?);
                put(&mut entry, "additions", read_number(file, "additions", &path, true, Some(0.0), None)?);
                put(&mut entry, "deletions", read_number(file, "deletions", &path, true, Some(0.0), None)?);
                put(&mut entry, "preview", read_string(file, "preview", &path, opt(DIFF_PREVIEW_LENGTH))?);
                entry.insert("status".into(), json!(status));
                files.push(Value::Object(entry));
            }
            put(&mut out, "title", read_string(payload, "title", p, opt(400))?);
            put(&mut out, "summary", read_string(payload, "summary", p, OPT)?);
            put(&mut out, "openInChangesRef", read_string(payload, "openInChangesRef", p, opt(400))?);
            out.insert("files".into(), Value::Array(files));
            out.insert("truncated".into(), json!(trimmed || read_bool(payload, "truncated", p)? == Some(true)));
        }
        "artifact" => {
            let artifacts = read_bounded(payload, "artifacts", p, ARTIFACTS, true, 1)?
                .iter()
                .enumerate()
                .map(|(i, a)| image_like(a, &format!("payload.artifacts[{i}]"), false))
                .collect::<Fail<Vec<_>>>()?;
            let mut handover = Map::new();
            if let Some(raw) = payload.get("handover").filter(|h| !h.is_null()) {
                let hp = "payload.handover";
                let raw = record(raw, hp)?;
                let verdict = read_string(raw, "verdict", hp, opt(50))?;
                if verdict.as_deref().is_some_and(|v| !["passed", "failed", "needs-review"].contains(&v)) {
                    return err("schema-invalid", "\"payload.handover.verdict\" must be one of: passed, failed, needs-review.", Some("payload.handover.verdict".into()));
                }
                put(&mut handover, "verdict", verdict.filter(|v| !v.is_empty()));
                if let Some(summary) = raw.get("testSummary").filter(|t| !t.is_null()) {
                    let tp = "payload.handover.testSummary";
                    let summary = record(summary, tp)?;
                    let mut tests = Map::new();
                    put(&mut tests, "total", read_number(summary, "total", tp, true, Some(0.0), None)?);
                    put(&mut tests, "passed", read_number(summary, "passed", tp, true, Some(0.0), None)?);
                    put(&mut tests, "failed", read_number(summary, "failed", tp, true, Some(0.0), None)?);
                    put(&mut tests, "skipped", read_number(summary, "skipped", tp, false, Some(0.0), None)?);
                    handover.insert("testSummary".into(), Value::Object(tests));
                }
                put(&mut handover, "gitRef", read_string(raw, "gitRef", hp, opt(120))?.filter(|v| !v.is_empty()));
                put(&mut handover, "nextSteps", read_string(raw, "nextSteps", hp, opt(2_000))?.filter(|v| !v.is_empty()));
                put(&mut handover, "requiresSignoff", read_bool(raw, "requiresSignoff", hp)?);
            }
            put(&mut out, "title", read_string(payload, "title", p, req(400))?);
            out.insert("artifacts".into(), Value::Array(artifacts));
            if !handover.is_empty() {
                out.insert("handover".into(), Value::Object(handover));
            }
        }
        "image" => {
            let images = read_bounded(payload, "images", p, IMAGES, true, 1)?
                .iter()
                .enumerate()
                .map(|(i, a)| image_like(a, &format!("payload.images[{i}]"), true))
                .collect::<Fail<Vec<_>>>()?;
            put(&mut out, "title", read_string(payload, "title", p, req(400))?);
            out.insert("images".into(), Value::Array(images));
        }
        "handoff" => {
            let mut item_lists = Vec::new();
            for key in ["includedItems", "excludedItems"] {
                let mut items = Vec::new();
                for (i, raw) in read_bounded(payload, key, p, HANDOFF_ITEMS, false, 0)?.iter().enumerate() {
                    let path = format!("payload.{key}[{i}]");
                    let item = record(raw, &path)?;
                    let mut entry = Map::new();
                    put(&mut entry, "label", read_string(item, "label", &path, req(400))?);
                    put(&mut entry, "detail", read_string(item, "detail", &path, OPT)?);
                    put(&mut entry, "reason", read_string(item, "reason", &path, OPT)?);
                    items.push(Value::Object(entry));
                }
                item_lists.push(items);
            }
            put(&mut out, "title", read_string(payload, "title", p, req(400))?);
            put(&mut out, "fromProvider", read_string(payload, "fromProvider", p, req(120))?);
            put(&mut out, "toProvider", read_string(payload, "toProvider", p, req(120))?);
            put(&mut out, "contextSummary", read_string(payload, "contextSummary", p, REQ)?);
            put(&mut out, "warning", read_string(payload, "warning", p, OPT)?);
            for (key, items) in ["includedItems", "excludedItems"].into_iter().zip(item_lists) {
                if !items.is_empty() {
                    out.insert(key.into(), Value::Array(items));
                }
            }
        }
        "conflict" => {
            let mut conflicts = Vec::new();
            let empty_ok = Str { required: true, max: None, allow_empty: true };
            for (i, raw) in read_bounded(payload, "conflicts", p, CONFLICTS, true, 1)?.iter().enumerate() {
                let path = format!("payload.conflicts[{i}]");
                let conflict = record(raw, &path)?;
                let mut entry = Map::new();
                put(&mut entry, "id", read_string(conflict, "id", &path, req(200))?);
                put(&mut entry, "label", read_string(conflict, "label", &path, req(400))?);
                put(&mut entry, "ours", read_string(conflict, "ours", &path, empty_ok)?);
                put(&mut entry, "theirs", read_string(conflict, "theirs", &path, empty_ok)?);
                put(&mut entry, "path", read_string(conflict, "path", &path, opt(1_000))?);
                conflicts.push(Value::Object(entry));
            }
            put(&mut out, "title", read_string(payload, "title", p, req(400))?);
            put(&mut out, "description", read_string(payload, "description", p, OPT)?);
            out.insert("conflicts".into(), Value::Array(conflicts));
        }
        "approval" => {
            let mut evidence = Vec::new();
            for (i, raw) in read_bounded(payload, "evidence", p, APPROVAL_EVIDENCE, false, 0)?.iter().enumerate() {
                let path = format!("payload.evidence[{i}]");
                let entry = record(raw, &path)?;
                evidence.push(json!({
                    "label": read_string(entry, "label", &path, req(200))?,
                    "value": read_string(entry, "value", &path, Str { required: true, max: Some(2_000), allow_empty: true })?,
                }));
            }
            put(&mut out, "title", read_string(payload, "title", p, req(400))?);
            put(&mut out, "summary", read_string(payload, "summary", p, REQ)?);
            put(&mut out, "gate", read_string(payload, "gate", p, req(200))?);
            put(&mut out, "requestedBy", read_string(payload, "requestedBy", p, opt(200))?);
            put(&mut out, "effect", read_string(payload, "effect", p, OPT)?);
            put(&mut out, "nodeId", read_string(payload, "nodeId", p, opt(200))?);
            if !evidence.is_empty() {
                out.insert("evidence".into(), Value::Array(evidence));
            }
        }
        _ => return err("unsupported-kind", format!("\"{kind}\" is not a gadget kind this version knows."), None),
    }
    Ok(out)
}

// -- envelope ----------------------------------------------------------------------------------

fn validate_scope(raw: Option<&Value>) -> Fail<Value> {
    let scope = record(raw.unwrap_or(&Value::Null), "scope")?;
    let mut out = Map::new();
    put(&mut out, "hostId", read_string(scope, "hostId", "scope", req(200))?);
    put(&mut out, "projectId", read_string(scope, "projectId", "scope", opt(200))?);
    put(&mut out, "sessionId", read_string(scope, "sessionId", "scope", req(200))?);
    put(&mut out, "workId", read_string(scope, "workId", "scope", opt(200))?);
    put(&mut out, "revision", read_number(scope, "revision", "scope", false, Some(0.0), None)?);
    Ok(Value::Object(out))
}

fn validate_actions(raw: Option<&Value>, kind: &str) -> Fail<Vec<Value>> {
    let Some(raw) = raw.filter(|r| !r.is_null()) else { return Ok(Vec::new()) };
    let holder = json!({ "actions": raw });
    let actions = read_bounded(holder.as_object().unwrap_or(&Map::new()), "actions", "", ACTIONS, false, 0)?;
    let mut seen = std::collections::HashSet::new();
    let mut descriptors = Vec::new();
    for (i, entry) in actions.iter().enumerate() {
        let path = format!("actions[{i}]");
        let action = record(entry, &path)?;
        let effect = read_string(action, "effect", &path, req(20))?.unwrap_or_default();
        if !["informational", "mutating", "approval"].contains(&effect.as_str()) {
            return err("schema-invalid", format!("\"{path}.effect\" is not a supported effect."), Some(format!("{path}.effect")));
        }
        let gate = read_string(action, "gate", &path, opt(200))?.filter(|g| !g.is_empty());
        // Anything that changes state or grants approval must name the gate it satisfies.
        if (effect == "mutating" || effect == "approval") && gate.is_none() {
            return err("gate-required", format!("\"{path}\" is {effect} and must declare a workflow gate."), Some(format!("{path}.gate")));
        }
        let action_id = read_string(action, "actionId", &path, req(200))?.unwrap_or_default();
        if !seen.insert(action_id.clone()) {
            return err("schema-invalid", format!("Duplicate action ID \"{action_id}\"."), Some(path));
        }
        let mut descriptor = Map::new();
        descriptor.insert("actionId".into(), json!(action_id));
        put(&mut descriptor, "label", read_string(action, "label", &path, req(200))?);
        put(&mut descriptor, "description", read_string(action, "description", &path, opt(2_000))?);
        put(&mut descriptor, "danger", read_bool(action, "danger", &path)?);
        descriptor.insert("effect".into(), json!(effect));
        put(&mut descriptor, "gate", gate);
        descriptors.push(Value::Object(descriptor));
    }
    if kind == "approval" && !descriptors.is_empty() && !descriptors.iter().any(|d| d["effect"] == "approval") {
        return err("schema-invalid", "An approval gadget must offer at least one approval action.", Some("actions".into()));
    }
    Ok(descriptors)
}

/// Validate, bound and redact one gadget envelope. On success the result is a fresh object.
pub fn validate_raw_envelope(input: &Value) -> Fail<Value> {
    let Some(source) = input.as_object() else { return err("schema-invalid", "A gadget envelope must be an object.", None) };
    // Size is checked before anything else: a hostile payload is cheapest to reject early.
    let bytes = serde_json::to_string(input).map(|s| s.len()).unwrap_or(usize::MAX);
    if bytes > ENVELOPE_BYTES {
        return err("payload-too-large", format!("The gadget payload is {}KB; the limit is {}KB.", (bytes as f64 / 1024.0).round(), ENVELOPE_BYTES / 1024), None);
    }
    let version = read_number(source, "version", "", true, Some(1.0), None)?.and_then(|v| v.as_f64()).unwrap_or(0.0);
    if version > f64::from(GADGET_CONTRACT_VERSION) {
        return err("unsupported-version", format!("This gadget needs contract version {version}; this client supports {GADGET_CONTRACT_VERSION}."), None);
    }
    let kind = read_string(source, "kind", "", req(50))?.unwrap_or_default();
    if !GADGET_KINDS.contains(&kind.as_str()) {
        return err("unsupported-kind", format!("\"{kind}\" is not a gadget kind this version knows."), None);
    }
    let payload_source = record(source.get("payload").unwrap_or(&Value::Null), "payload")?;
    let mut payload = Value::Object(validate_payload(&kind, payload_source)?);
    let redactions = redact_deep(&mut payload);

    let mut envelope = Map::new();
    envelope.insert("version".into(), json!(version as u64));
    envelope.insert("kind".into(), json!(kind));
    put(&mut envelope, "gadgetId", read_string(source, "gadgetId", "", req(200))?);
    envelope.insert("scope".into(), validate_scope(source.get("scope"))?);
    let issued_at = read_timestamp(source, "issuedAt", true)?.unwrap_or_default();
    envelope.insert("issuedAt".into(), json!(issued_at));
    let expires_at = read_timestamp(source, "expiresAt", false)?;
    put(&mut envelope, "expiresAt", expires_at.clone());
    let supersedes = read_string(source, "supersedes", "", opt(200))?.filter(|s| !s.is_empty());
    put(&mut envelope, "supersedes", supersedes.clone());
    envelope.insert("fallbackText".into(), json!(read_string(source, "fallbackText", "", opt(STRING_LENGTH))?.unwrap_or_default()));
    envelope.insert("payload".into(), payload);
    envelope.insert("actions".into(), Value::Array(validate_actions(source.get("actions"), &kind)?));
    envelope.insert("state".into(), json!(read_string(source, "state", "", opt(30))?.unwrap_or_else(|| "active".into())));

    if let Some(expires) = &expires_at
        && parse_millis(expires) <= parse_millis(&issued_at)
    {
        return err("schema-invalid", "\"expiresAt\" must be after \"issuedAt\".", Some("expiresAt".into()));
    }
    if supersedes.is_some() && supersedes.as_deref() == envelope["gadgetId"].as_str() {
        return err("schema-invalid", "A gadget cannot supersede itself.", Some("supersedes".into()));
    }
    if redactions > 0 {
        envelope.insert("redacted".into(), json!(true));
    }
    // Every gadget is representable as text, so a producer that omitted the fallback gets one derived.
    if envelope["fallbackText"].as_str().is_none_or(|t| t.trim().is_empty())
        && let Ok(typed) = serde_json::from_value::<GadgetEnvelope>(Value::Object(envelope.clone()))
    {
        envelope.insert("fallbackText".into(), json!(gadget_fallback_text(&typed)));
    }
    Ok(Value::Object(envelope))
}

/// Validate a gadget and always return a renderable block (a refusal becomes a `fallback` block).
pub fn coerce_gadget_block(input: &Value, block_id: &str) -> Value {
    match validate_raw_envelope(&promote_artifact_gadget_to_image(input)) {
        Ok(envelope) => json!({ "type": "gadget", "blockId": block_id, "gadget": envelope }),
        Err(error) => {
            let declared = input.get("fallbackText").and_then(Value::as_str).map(str::trim).unwrap_or_default();
            json!({
                "type": "fallback",
                "blockId": block_id,
                // Prefer the producer's own words; they describe the decision, ours only why the surface failed.
                "text": if declared.is_empty() { error.message.clone() } else { declared.to_owned() },
                "reason": error,
            })
        }
    }
}

// -- text -> blocks ----------------------------------------------------------------------------

const FENCE_LANGUAGE: &str = "praxis-gadget";

static FENCE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    // Models are loose about where the fence goes: the opening one may follow prose on the same
    // line, and the closing one must end its line (which keeps a "```" inside a JSON string from
    // ending the block early).
    regex::Regex::new(r"(?m)```[ \t]*praxis-gadget[ \t]*\r?\n([\s\S]*?)```[ \t]*$").expect("valid fence regex")
});

/// Cheap pre-check so a caller can skip parsing text that cannot contain a gadget.
pub fn may_contain_gadget(text: &str) -> bool {
    text.contains(FENCE_LANGUAGE) || text.contains("\"kind\"")
}

fn clamp_text(value: &mut Value, max: usize) {
    if let Some(text) = value.as_str().filter(|t| t.encode_utf16().count() > max) {
        let kept: String = text.chars().take(max.saturating_sub(1)).collect();
        *value = json!(format!("{}…", kept.trim_end()));
    }
}

/// A choice's display-only text is shortened rather than the whole decision refused.
fn clamp_choice_text(gadget: &mut Value) {
    if gadget["kind"] != "choice" || !gadget["payload"].is_object() {
        return;
    }
    clamp_text(&mut gadget["payload"]["question"], 2_000);
    if let Some(options) = gadget["payload"]["options"].as_array_mut() {
        for option in options.iter_mut().filter(|o| o.is_object()) {
            clamp_text(&mut option["label"], 400);
            clamp_text(&mut option["description"], 2_000);
            clamp_text(&mut option["disabledReason"], 400);
        }
    }
}

fn is_gadget_shaped(value: &Value) -> bool {
    value["kind"].as_str().is_some_and(|k| GADGET_KINDS.contains(&k)) && value["payload"].is_object()
}

/// Models sometimes write a gadget's JSON bare on its own line; wrap it so it takes the fenced path.
/// Lines inside any other code fence are left alone.
fn fence_bare_gadget_lines(text: &str) -> String {
    let mut in_code_fence = false;
    text.split('\n')
        .map(|line| {
            if line.contains("```") {
                in_code_fence = !in_code_fence;
                return line.to_owned();
            }
            let trimmed = line.trim();
            if in_code_fence || !trimmed.starts_with('{') || !trimmed.ends_with('}') {
                return line.to_owned();
            }
            match super::json_repair::parse_lenient_json(trimmed) {
                Ok((value, _)) if is_gadget_shaped(&value) => format!("```{FENCE_LANGUAGE}\n{trimmed}\n```"),
                _ => line.to_owned(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub struct CoercedBlocks {
    pub blocks: Vec<Value>,
    pub contains_gadget: bool,
    pub malformed: usize,
}

fn push_markdown(blocks: &mut Vec<Value>, slice: &str, id_prefix: &str, md_index: &mut usize) {
    let trimmed = slice.trim();
    if !trimmed.is_empty() {
        blocks.push(json!({ "type": "markdown", "markdown": trimmed, "blockId": format!("{id_prefix}-md-{md_index}") }));
    }
    *md_index += 1;
}

/// Splits a provider message into ordered markdown, gadget and fallback blocks. Identity, scope
/// and issue time are stamped here - a model that could name its own scope could aim an approval
/// at another project - and a fence whose body is not JSON survives as visible code.
pub fn parse_and_coerce_blocks(raw: &str, scope: &Value, issued_at: &str, id_prefix: &str) -> CoercedBlocks {
    let text = fence_bare_gadget_lines(raw);
    let mut blocks = Vec::new();
    let (mut last_index, mut found, mut malformed, mut md_index) = (0usize, 0usize, 0usize, 0usize);
    for captures in FENCE.captures_iter(&text) {
        let whole = captures.get(0).expect("whole match");
        push_markdown(&mut blocks, &text[last_index..whole.start()], id_prefix, &mut md_index);
        last_index = whole.end();
        found += 1;
        let body = captures.get(1).map_or("", |m| m.as_str());
        let Ok((mut parsed, _)) = super::json_repair::parse_lenient_json(body) else {
            malformed += 1;
            push_markdown(&mut blocks, &format!("```json\n{}\n```", body.trim()), id_prefix, &mut md_index);
            continue;
        };
        clamp_choice_text(&mut parsed);
        let mut gadget = parsed.as_object().cloned().unwrap_or_default();
        let supplied = gadget.get("gadgetId").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
        let gadget_id = supplied.clone().unwrap_or_else(|| format!("{id_prefix}-{found}"));
        // The block id follows the gadget id so re-parsing a message republishes over the same block.
        let block_id = format!("{id_prefix}-{}", supplied.unwrap_or_else(|| found.to_string()));
        gadget.entry("version").or_insert_with(|| json!(GADGET_CONTRACT_VERSION));
        // Overwritten last, so a producer cannot set them.
        gadget.insert("gadgetId".into(), json!(gadget_id));
        gadget.insert("scope".into(), scope.clone());
        gadget.insert("issuedAt".into(), json!(issued_at));
        blocks.push(coerce_gadget_block(&Value::Object(gadget), &block_id));
    }
    push_markdown(&mut blocks, &text[last_index..], id_prefix, &mut md_index);
    CoercedBlocks { blocks, contains_gadget: found > 0, malformed }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gadget(kind: &str, payload: Value) -> Value {
        json!({ "version": 1, "kind": kind, "gadgetId": "g1", "scope": { "hostId": "h", "sessionId": "s" }, "issuedAt": "2026-01-01T00:00:00Z", "payload": payload, "actions": [] })
    }

    #[test]
    fn an_artifact_of_only_images_becomes_an_image_gadget() {
        let block = coerce_gadget_block(&gadget("artifact", json!({ "title": "Shots", "artifacts": [{ "name": "a.png", "path": "a.png", "mediaType": "image/png" }] })), "b");
        assert_eq!(block["type"], "gadget");
        assert_eq!(block["gadget"]["kind"], "image");
        assert_eq!(block["gadget"]["payload"]["images"][0]["path"], "a.png");
    }

    #[test]
    fn a_mixed_artifact_list_stays_an_artifact() {
        let block = coerce_gadget_block(&gadget("artifact", json!({ "title": "Files", "artifacts": [{ "name": "a.png", "path": "a.png" }, { "name": "n.md", "path": "n.md" }] })), "b");
        assert_eq!(block["gadget"]["kind"], "artifact");
    }

    #[test]
    fn refusals_carry_their_reason_into_a_fallback_block() {
        let unknown = coerce_gadget_block(&gadget("teleporter", json!({})), "b");
        assert_eq!(unknown["type"], "fallback");
        assert!(unknown["text"].as_str().unwrap().contains("not a gadget kind"));
        let mut future = gadget("choice", json!({ "question": "q", "options": [{ "value": "a", "label": "A" }] }));
        future["version"] = json!(99);
        assert!(coerce_gadget_block(&future, "b")["text"].as_str().unwrap().contains("contract version"));
        let traversal = coerce_gadget_block(&gadget("artifact", json!({ "title": "f", "artifacts": [{ "name": "p", "path": "../../etc/passwd" }] })), "b");
        assert!(traversal["text"].as_str().unwrap().contains("traverse outside the workspace"));
        let mut ungated = gadget("confirmation", json!({ "question": "Delete?" }));
        ungated["actions"] = json!([{ "actionId": "delete", "label": "Delete", "effect": "mutating" }]);
        assert!(coerce_gadget_block(&ungated, "b")["text"].as_str().unwrap().contains("workflow gate"));
        let oversized = gadget("table", json!({ "columns": [{ "key": "a", "label": "A" }], "rows": [{ "a": "x".repeat(200_000) }] }));
        assert!(coerce_gadget_block(&oversized, "b")["text"].as_str().unwrap().contains("limit is"));
    }

    #[test]
    fn a_mixed_evidence_gadget_with_descriptions_is_published() {
        let envelope = gadget("artifact", json!({ "title": "Login fix evidence", "artifacts": [
            { "name": "Login verification", "path": ".praxis/session-artifacts/login-report.md", "mediaType": "text/markdown", "description": "What was checked after the fix" },
            { "name": "Login screen", "path": ".praxis/session-artifacts/login-screen.png", "mediaType": "image/png" }
        ] }));
        let block = coerce_gadget_block(&envelope, "b");
        assert_eq!(block["type"], "gadget", "{block}");
        assert_eq!(block["gadget"]["kind"], "artifact");
        assert_eq!(block["gadget"]["payload"]["artifacts"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_fenced_evidence_message_is_parsed() {
        let message = "Evidence attached.\n\n```praxis-gadget\n{\n  \"version\": 1,\n  \"kind\": \"artifact\",\n  \"gadgetId\": \"artifacts-page-evidence\",\n  \"payload\": {\n    \"title\": \"Login fix evidence\",\n    \"artifacts\": [\n      {\n        \"name\": \"Login verification\",\n        \"path\": \".praxis/session-artifacts/login-report.md\",\n        \"mediaType\": \"text/markdown\"\n      }\n    ]\n  },\n  \"actions\": []\n}\n```";
        let parsed = parse_and_coerce_blocks(message, &json!({ "hostId": "h", "sessionId": "s" }), "2026-01-01T00:00:00Z", "msg-3");
        assert!(parsed.contains_gadget, "{:?}", parsed.blocks);
        assert_eq!(parsed.blocks.len(), 2);
        assert_eq!(parsed.blocks[1]["type"], "gadget", "{}", parsed.blocks[1]);
    }
}
