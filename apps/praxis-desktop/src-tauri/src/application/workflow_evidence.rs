//! Retained failure evidence for a workflow node attempt (`workflowEvidence.ts` port).
//!
//! Layout: `<userData>/workflow-evidence/<projectId>/<runId>/<nodeId>/<attempt>/bundle.json` plus
//! one text file per present entry. Three properties matter: missing is not empty (a command that
//! printed nothing and a capture that never happened must not look alike), unknown is not omitted
//! (the source commit is explicit), and ids that build a path are validated so a bundle cannot
//! escape its directory.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Value, json};

const SCHEMA_VERSION: u64 = 1;
/// Enough for a full check log without unbounded growth; the tail survives truncation.
const MAX_BYTES: usize = 200_000;
const RETENTION_DAYS: i64 = 30;

/// A bare filename / path-segment shape check: no `.`/`..`, no separators.
pub fn is_safe_segment(value: &str) -> bool {
    static SAFE: OnceLock<Regex> = OnceLock::new();
    let re = SAFE.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$").expect("regex"));
    value != "." && value != ".." && re.is_match(value)
}

pub struct EvidenceKey<'a> {
    pub project_id: &'a str,
    pub run_id: &'a str,
    pub node_id: &'a str,
    pub attempt: usize,
}

pub fn bundle_dir(root: &Path, key: &EvidenceKey) -> Result<PathBuf, String> {
    for (field, value) in [
        ("projectId", key.project_id),
        ("runId", key.run_id),
        ("nodeId", key.node_id),
    ] {
        if !is_safe_segment(value) {
            return Err(format!("Unsafe evidence {field}: {value}"));
        }
    }
    if key.attempt < 1 {
        return Err(format!("Unsafe evidence attempt: {}", key.attempt));
    }
    Ok(root
        .join(key.project_id)
        .join(key.run_id)
        .join(key.node_id)
        .join(key.attempt.to_string()))
}

/// Pattern-based redaction applied before evidence is captured: a check's raw output can echo a
/// secret from the environment or its command line. Best-effort: it catches recognisable shapes.
pub fn redact(content: &str) -> (String, bool) {
    static ASSIGNMENT: OnceLock<Regex> = OnceLock::new();
    static BEARER: OnceLock<Regex> = OnceLock::new();
    static BARE: OnceLock<Vec<Regex>> = OnceLock::new();
    let assignment = ASSIGNMENT.get_or_init(|| {
        Regex::new(r#"(?i)\b((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*)(["']?)([^\s"',]{4,})(["']?)"#)
            .expect("regex")
    });
    let bearer = BEARER
        .get_or_init(|| Regex::new(r"\b(Bearer\s+)([A-Za-z0-9._~+/=-]{10,})").expect("regex"));
    let bare = BARE.get_or_init(|| {
        vec![
            Regex::new(r"\bAKIA[0-9A-Z]{16}\b").expect("regex"),
            Regex::new(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b").expect("regex"),
            Regex::new(
                r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
            )
            .expect("regex"),
        ]
    });
    let mut redacted = false;
    let mut out = assignment
        .replace_all(content, |c: &regex::Captures| {
            redacted = true;
            format!("{}{}[REDACTED]{}", &c[1], &c[2], &c[2])
        })
        .into_owned();
    out = bearer
        .replace_all(&out, |c: &regex::Captures| {
            redacted = true;
            format!("{}[REDACTED]", &c[1])
        })
        .into_owned();
    for pattern in bare {
        out = pattern
            .replace_all(&out, |_: &regex::Captures| {
                redacted = true;
                "[REDACTED]".to_string()
            })
            .into_owned();
    }
    (out, redacted)
}

/// Keeps the tail: for a failing command the signal a person needs is usually at the end.
fn truncate_tail(content: &str, max_bytes: usize) -> String {
    if content.len() <= max_bytes {
        return content.to_string();
    }
    let mut start = content.len() - max_bytes;
    while start < content.len() && !content.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &content[start..])
}

fn file_name(label: &str) -> String {
    let mut safe = String::new();
    let mut dash = false;
    for c in label.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            safe.push(c);
            dash = false;
        } else if !dash {
            safe.push('-');
            dash = true;
        }
    }
    let safe = safe.trim_matches('-');
    format!("{}.txt", if safe.is_empty() { "entry" } else { safe })
}

pub struct Captured {
    /// `Some` content is stored (truncated); `None` means the capture itself failed.
    pub content: Option<String>,
    pub missing_reason: Option<String>,
    pub redacted: bool,
}

/// Writes one `combined` log entry and the manifest; returns the stored file when content exists.
pub fn write_log_bundle(
    root: &Path,
    key: &EvidenceKey,
    source_sha: Option<&str>,
    captured: &Captured,
) -> Result<Option<PathBuf>, String> {
    let dir = bundle_dir(root, key)?;
    let now = chrono::Utc::now();
    let captured_at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let expires = (now + chrono::Duration::days(RETENTION_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let bundle_id = format!("{}-{}-{}", key.run_id, key.node_id, key.attempt);
    let label = "combined";
    let mut entry = json!({
        "evidenceId": format!("{bundle_id}-{label}"),
        "kind": "log",
        "label": label,
        "capturedAt": captured_at,
        "redacted": captured.redacted,
        "retention": { "policy": "default", "expiresAt": expires },
        "truncated": false,
    });
    let mut stored: Option<(String, String)> = None;
    match &captured.content {
        None => {
            entry["presence"] = json!("missing");
            let reason = captured
                .missing_reason
                .as_deref()
                .map(str::trim)
                .filter(|r| !r.is_empty());
            entry["missingReason"] = json!(reason.unwrap_or("Not captured."));
        }
        Some(content) if content.is_empty() => {
            entry["presence"] = json!("empty");
        }
        Some(content) => {
            let truncated = content.len() > MAX_BYTES;
            let body = if truncated {
                truncate_tail(content, MAX_BYTES)
            } else {
                content.clone()
            };
            let name = file_name(label);
            entry["presence"] = json!("present");
            entry["path"] = json!(name);
            entry["storedBytes"] = json!(body.len());
            entry["originalBytes"] = json!(content.len());
            entry["truncated"] = json!(truncated);
            stored = Some((name, body));
        }
    }
    let source = match source_sha {
        Some(sha) => json!({ "kind": "commit", "sha": sha }),
        None => json!({ "kind": "unknown" }),
    };
    let bundle = json!({
        "schemaVersion": SCHEMA_VERSION,
        "bundleId": bundle_id,
        "projectId": key.project_id,
        "runId": key.run_id,
        "nodeId": key.node_id,
        "attempt": key.attempt,
        "source": source,
        "createdAt": captured_at,
        "entries": [entry],
    });
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = None;
    if let Some((name, body)) = stored {
        let path = dir.join(name);
        std::fs::write(&path, body).map_err(|e| e.to_string())?;
        file = Some(path);
    }
    let manifest = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("bundle.json"), format!("{manifest}\n")).map_err(|e| e.to_string())?;
    Ok(file)
}

fn is_expired(entry: &Value) -> bool {
    let retention = &entry["retention"];
    if retention["policy"] == "legal-hold" {
        return false;
    }
    retention["expiresAt"]
        .as_str()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| at <= chrono::Utc::now())
}

/// The `workflows:getEvidence` view of one attempt: its entry and, when present and unexpired, its content.
pub fn read_view(root: &Path, key: &EvidenceKey, project_id: &str) -> Value {
    let Ok(dir) = bundle_dir(root, key) else {
        return json!({ "expired": false });
    };
    let Some(bundle) = std::fs::read_to_string(dir.join("bundle.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    else {
        return json!({ "expired": false });
    };
    // A bundle that names another project is refused rather than attributed to this one.
    if bundle["projectId"] != project_id {
        return json!({ "expired": false });
    }
    let Some(entry) = bundle["entries"]
        .as_array()
        .and_then(|e| e.first())
        .cloned()
    else {
        return json!({ "expired": false });
    };
    let expired = is_expired(&entry);
    if entry["presence"] != "present" || expired {
        return json!({ "entry": entry, "expired": expired });
    }
    let content = entry["path"]
        .as_str()
        .filter(|p| is_safe_segment(p))
        .and_then(|p| std::fs::read_to_string(dir.join(p)).ok());
    match content {
        Some(content) => json!({ "entry": entry, "content": content, "expired": false }),
        None => json!({ "entry": entry, "expired": false }),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn echoed_secrets_are_redacted_but_the_key_stays() {
        let (out, redacted) = redact(
            "missing dependency, API_KEY=sk_live_abcdef1234567890 and Bearer abcdefghijklmnop",
        );
        assert!(redacted);
        assert!(out.contains("API_KEY=[REDACTED]"));
        assert!(out.contains("Bearer [REDACTED]"));
        assert!(!out.contains("sk_live"));
    }

    #[test]
    fn missing_empty_and_present_are_distinct() {
        let root = std::env::temp_dir().join(format!("praxis-evidence-{}", std::process::id()));
        let key = |attempt| EvidenceKey {
            project_id: "p",
            run_id: "r",
            node_id: "n",
            attempt,
        };
        write_log_bundle(
            &root,
            &key(1),
            None,
            &Captured {
                content: None,
                missing_reason: Some("never started".into()),
                redacted: false,
            },
        )
        .unwrap();
        write_log_bundle(
            &root,
            &key(2),
            None,
            &Captured {
                content: Some(String::new()),
                missing_reason: None,
                redacted: false,
            },
        )
        .unwrap();
        write_log_bundle(
            &root,
            &key(3),
            Some("abcdef1"),
            &Captured {
                content: Some("hi".into()),
                missing_reason: None,
                redacted: false,
            },
        )
        .unwrap();
        assert_eq!(
            read_view(&root, &key(1), "p")["entry"]["presence"],
            "missing"
        );
        assert_eq!(read_view(&root, &key(2), "p")["entry"]["presence"], "empty");
        assert_eq!(read_view(&root, &key(3), "p")["content"], "hi");
        assert_eq!(read_view(&root, &key(3), "other")["expired"], false);
        assert!(
            bundle_dir(
                &root,
                &EvidenceKey {
                    project_id: "..",
                    run_id: "r",
                    node_id: "n",
                    attempt: 1
                }
            )
            .is_err()
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
