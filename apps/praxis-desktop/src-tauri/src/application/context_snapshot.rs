//! Bounded context snapshots and handover validation. Ports `contextSnapshot.ts` (core) and
//! `contextSnapshotHost.ts` (the Git and file facts the desktop gathers).
//!
//! A handover envelope says what the last AI concluded; the snapshot says what the work stood on:
//! the commit, which files were handed over and which deliberately left out, and what the task
//! depends on. It is bounded so it can never become the prompt, and persisted as evidence.

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const SCHEMA_VERSION: u64 = 1;
/// Bumped whenever what a snapshot includes, or how it decides, changes.
pub const GENERATOR: &str = "praxis-context-snapshot@1";
/// At most this many files are listed as included; the rest are excluded with reason `limit`.
pub const MAX_FILES: usize = 40;
/// A file larger than this is excluded as `too-large`: the next AI can open it itself.
pub const MAX_FILE_BYTES: u64 = 512 * 1024;

static SECRET_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(^|/)(\.env(\..+)?|\.npmrc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|keystore)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$").expect("static pattern")
});
static SECRET_VALUE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(ghp|gho|github_pat|glpat|sk-ant|sk-)[A-Za-z0-9_-]{16,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----").expect("static pattern"));

/// A candidate file as the host found it.
#[derive(Debug, Clone)]
pub struct FileFact {
    pub path: String,
    /// `declared`, `touched` or `changed`.
    pub reason: &'static str,
    /// Absent when the file does not exist.
    pub bytes: Option<u64>,
    pub binary: bool,
    pub outside: bool,
}

#[derive(Debug, Clone, Default)]
pub struct GitFacts {
    pub head: Option<String>,
    pub branch: Option<String>,
    pub dirty: bool,
    pub changed: Vec<String>,
}

/// Issue keys under a "depends on" / "blocked by" heading or line of a ticket context.
pub fn extract_dependency_keys(ticket_context: Option<&str>) -> Vec<String> {
    static MENTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(depend\w*|blocked by|blockers?|prerequisites?)\b").expect("static pattern"));
    static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#{1,6}\s").expect("static pattern"));
    static BOLD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\*\*[^*]+\*\*:?\s*$").expect("static pattern"));
    static KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b[A-Z][A-Z0-9]+-\d+\b").expect("static pattern"));
    let mut keys = BTreeSet::new();
    let mut in_section = false;
    for line in ticket_context.unwrap_or_default().lines() {
        let heading = HEADING.is_match(line) || BOLD.is_match(line.trim());
        let mentions = MENTION.is_match(line);
        if heading {
            in_section = mentions;
        }
        if in_section || mentions {
            keys.extend(KEY.find_iter(line).map(|m| m.as_str().to_owned()));
        }
    }
    keys.into_iter().collect()
}

pub fn build_snapshot(session_key: &str, created_at: &str, git: &GitFacts, workspace: Option<&str>, files: &[FileFact], ticket_context: Option<&str>) -> Value {
    let order = |reason: &str| match reason {
        "declared" => 0,
        "touched" => 1,
        _ => 2,
    };
    let mut sorted: Vec<&FileFact> = files.iter().collect();
    sorted.sort_by(|a, b| order(a.reason).cmp(&order(b.reason)).then_with(|| a.path.cmp(&b.path)));
    let mut included: Vec<Value> = Vec::new();
    let mut excluded: Vec<Value> = Vec::new();
    let mut seen = BTreeSet::new();
    for file in sorted {
        let path = file.path.replace('\\', "/");
        let path = path.strip_prefix("./").unwrap_or(&path).to_owned();
        if path.is_empty() || !seen.insert(path.clone()) {
            continue;
        }
        let exclusion = if SECRET_PATH.is_match(&path) {
            Some("secret")
        } else if file.outside || path.starts_with("../") || path.starts_with('/') {
            Some("outside-workspace")
        } else if file.bytes.is_none() {
            Some("missing")
        } else if file.binary {
            Some("binary")
        } else if file.bytes.is_some_and(|b| b > MAX_FILE_BYTES) {
            Some("too-large")
        } else if included.len() >= MAX_FILES {
            Some("limit")
        } else {
            None
        };
        match exclusion {
            Some(reason) => excluded.push(json!({ "path": path, "reason": reason })),
            None => included.push(json!({ "path": path, "reason": file.reason, "bytes": file.bytes })),
        }
    }
    let mut body = json!({ "schemaVersion": SCHEMA_VERSION, "generator": GENERATOR, "sessionKey": session_key });
    if let Some(head) = &git.head {
        body["sourceCommit"] = json!(head);
    }
    if let Some(branch) = &git.branch {
        body["branch"] = json!(branch);
    }
    if git.dirty {
        body["dirty"] = json!(true);
    }
    if let Some(workspace) = workspace.filter(|w| !w.is_empty()) {
        body["workspace"] = json!(workspace);
    }
    body["includedFiles"] = json!(included);
    body["excludedFiles"] = json!(excluded);
    body["dependencies"] = json!(extract_dependency_keys(ticket_context));
    // `createdAt` stays out of the fingerprint: the same state snapshotted twice is the same context.
    let digest = Sha256::digest(body.to_string().as_bytes());
    body["createdAt"] = json!(created_at);
    body["fingerprint"] = json!(digest.iter().map(|b| format!("{b:02x}")).collect::<String>());
    body
}

/// The snapshot as the next AI reads it, inside the handover text.
pub fn format_snapshot(snapshot: &Value) -> String {
    let list = |field: &str, render: &dyn Fn(&Value) -> String| snapshot[field].as_array().map(|items| items.iter().map(render).collect::<Vec<_>>().join("\n")).unwrap_or_default();
    let included = list("includedFiles", &|f| format!("- {} ({})", f["path"].as_str().unwrap_or_default(), f["reason"].as_str().unwrap_or_default()));
    let excluded = list("excludedFiles", &|f| format!("- {} ({})", f["path"].as_str().unwrap_or_default(), f["reason"].as_str().unwrap_or_default()));
    let dependencies: Vec<&str> = snapshot["dependencies"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let fingerprint = snapshot["fingerprint"].as_str().unwrap_or_default();
    let lines = [
        "## Context snapshot".to_owned(),
        format!("Generated by {} ({}).", snapshot["generator"].as_str().unwrap_or_default(), fingerprint.chars().take(12).collect::<String>()),
        match snapshot["sourceCommit"].as_str() {
            Some(commit) => format!(
                "Source commit: {commit}{}{}. Check out or diff against it before trusting anything below.",
                snapshot["branch"].as_str().map(|b| format!(" on {b}")).unwrap_or_default(),
                if snapshot["dirty"] == true { " (with uncommitted changes)" } else { "" }
            ),
            None => "Not a Git repository: there is no commit to anchor this context to.".to_owned(),
        },
        if included.is_empty() { "No files were handed over.".to_owned() } else { format!("Files to read first:\n{included}") },
        if excluded.is_empty() { String::new() } else { format!("Deliberately left out:\n{excluded}") },
        if dependencies.is_empty() { String::new() } else { format!("Depends on: {}", dependencies.join(", ")) },
    ];
    lines.into_iter().filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n")
}

/// Checks a handover before it proceeds. Each entry is `(blocks, message)`: a block stops the
/// handover, a warning is shown but lets it go on.
pub fn validate_handover(purpose: &Value, brief: &Value, text: &str, snapshot: Option<&Value>, session_key: &str, head: Option<&str>) -> Vec<(bool, String)> {
    let mut issues: Vec<(bool, String)> = Vec::new();
    let mut block = |message: String| issues.push((true, message));
    if purpose["goal"].as_str().is_none_or(|g| g.trim().is_empty()) {
        block("The handover has no goal: the next AI would not know what it is continuing.".into());
    }
    let mut warnings: Vec<String> = Vec::new();
    if !brief.is_object() {
        block("The handover brief is missing.".into());
    } else {
        for field in ["progress", "nextSteps"] {
            if !brief[field].is_string() {
                block(format!("The handover brief's \"{field}\" is not text."));
            }
        }
        if !brief["touchedFiles"].is_array() {
            block("The handover brief's touched files are not a list.".into());
        }
        if brief["nextSteps"].as_str().is_some_and(|n| n.trim().is_empty()) {
            warnings.push("The brief names no next steps; the next AI will have to work them out.".into());
        }
    }
    if text.trim().is_empty() {
        block("The handover text is empty.".into());
    } else if SECRET_VALUE.is_match(text) {
        block("The handover text still contains something that looks like a secret; remove it from the brief before handing over.".into());
    }
    let Some(snapshot) = snapshot else {
        block("The handover has no context snapshot.".into());
        issues.extend(warnings.into_iter().map(|w| (false, w)));
        return issues;
    };
    if snapshot["schemaVersion"] != SCHEMA_VERSION {
        block(format!("The context snapshot is schema {}; this build reads {SCHEMA_VERSION}.", snapshot["schemaVersion"]));
    }
    if snapshot["generator"] != GENERATOR {
        block(format!("The context snapshot was made by {}, not {GENERATOR}.", snapshot["generator"].as_str().unwrap_or_default()));
    }
    if snapshot["sessionKey"] != session_key {
        block("The context snapshot belongs to a different session.".into());
    }
    if let (Some(head), Some(source)) = (head, snapshot["sourceCommit"].as_str())
        && head != source
    {
        block(format!("The work has moved since the snapshot ({} → {}); take a new snapshot.", source.chars().take(7).collect::<String>(), head.chars().take(7).collect::<String>()));
    }
    if snapshot["sourceCommit"].is_null() {
        warnings.push("The snapshot has no source commit, so the next AI cannot check what changed since.".into());
    }
    if let Some(leaked) = snapshot["includedFiles"].as_array().into_iter().flatten().find(|f| SECRET_PATH.is_match(f["path"].as_str().unwrap_or_default())) {
        block(format!("The snapshot hands over {}, which looks like a secrets file.", leaked["path"].as_str().unwrap_or_default()));
    }
    issues.extend(warnings.into_iter().map(|w| (false, w)));
    issues
}

/// Where a snapshot was persisted, for the session's evidence.
pub fn manifest(snapshot: &Value, stored_at: &str) -> Value {
    let mut manifest = json!({
        "sessionKey": snapshot["sessionKey"], "createdAt": snapshot["createdAt"], "fingerprint": snapshot["fingerprint"], "path": stored_at,
        "included": snapshot["includedFiles"].as_array().map_or(0, Vec::len), "excluded": snapshot["excludedFiles"].as_array().map_or(0, Vec::len),
    });
    if !snapshot["sourceCommit"].is_null() {
        manifest["sourceCommit"] = snapshot["sourceCommit"].clone();
    }
    manifest
}

fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).current_dir(cwd).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The session's working tree right now: the commit, branch and changed paths.
pub fn read_workspace_git(root: &Path) -> GitFacts {
    let head = git(root, &["rev-parse", "HEAD"]).map(|h| h.trim().to_owned()).filter(|h| !h.is_empty());
    let branch = git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|b| b.trim().to_owned()).filter(|b| !b.is_empty() && b != "HEAD");
    let status = git(root, &["status", "--porcelain", "--untracked-files=all"]).unwrap_or_default();
    let changed: Vec<String> = status
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| line.get(3..).unwrap_or_default().rsplit(" -> ").next().unwrap_or_default().trim_matches('"').to_owned())
        .collect();
    GitFacts { head, branch, dirty: !changed.is_empty(), changed }
}

fn file_fact(root: &Path, relative: &str, reason: &'static str) -> FileFact {
    let fact = |path: String| FileFact { path, reason, bytes: None, binary: false, outside: false };
    let joined = root.join(relative);
    let normalised = normalise(&joined);
    let Ok(inside) = normalised.strip_prefix(normalise(root)) else {
        return FileFact { outside: true, ..fact(relative.to_owned()) };
    };
    let path = inside.to_string_lossy().replace('\\', "/");
    let Ok(metadata) = std::fs::metadata(&normalised) else { return fact(path) };
    if !metadata.is_file() {
        return fact(path);
    }
    let mut head = vec![0u8; metadata.len().min(8192) as usize];
    let binary = std::fs::File::open(&normalised).and_then(|mut f| std::io::Read::read_exact(&mut f, &mut head)).is_ok() && head.contains(&0);
    FileFact { bytes: Some(metadata.len()), binary, ..fact(path) }
}

fn normalise(path: &Path) -> std::path::PathBuf {
    let mut out = std::path::PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// Takes a snapshot of a session record and persists it under `<store_root>/handover-snapshots`.
/// Returns the snapshot, its manifest when it could be saved, and the commit it stood on.
pub fn take_snapshot(record: &Value, store_root: &Path, created_at: &str) -> (Value, Option<Value>, Option<String>) {
    let key = record["issueKey"].as_str().unwrap_or_default();
    let root = ["worktreePath", "workingDirectory"].iter().find_map(|f| record[*f].as_str().filter(|v| !v.is_empty()));
    let facts = root.map(|r| read_workspace_git(Path::new(r))).unwrap_or_default();
    let files: Vec<FileFact> = root
        .map(|root| {
            let root = Path::new(root);
            let touched = record["handoverBrief"]["touchedFiles"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|f| file_fact(root, f, "touched"));
            let changed = facts.changed.iter().map(|f| file_fact(root, f, "changed"));
            touched.chain(changed).collect()
        })
        .unwrap_or_default();
    let snapshot = build_snapshot(key, created_at, &facts, root, &files, record["taskDefinition"]["ticketContext"].as_str());
    let safe: String = key.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect();
    let dir = store_root.join("handover-snapshots").join(safe);
    let file = dir.join(format!("{}-{}.json", created_at.replace([':', '.'], "-"), snapshot["fingerprint"].as_str().unwrap_or_default().chars().take(12).collect::<String>()));
    let saved = std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&file, format!("{}\n", serde_json::to_string_pretty(&snapshot).unwrap_or_default())));
    // A snapshot that could not be persisted still travels in the handover; it just has no evidence file.
    let manifest = saved.ok().map(|()| manifest(&snapshot, &file.to_string_lossy()));
    (snapshot, manifest, facts.head)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(path: &str, reason: &'static str, bytes: Option<u64>) -> FileFact {
        FileFact { path: path.into(), reason, bytes, binary: false, outside: false }
    }

    #[test]
    fn files_are_included_or_excluded_with_a_reason() {
        let git = GitFacts { head: Some("abc1234def".into()), branch: Some("main".into()), dirty: true, changed: vec![] };
        let files = vec![
            fact("src/a.rs", "changed", Some(10)),
            fact(".env", "touched", Some(5)),
            fact("gone.rs", "touched", None),
            fact("big.bin", "touched", Some(MAX_FILE_BYTES + 1)),
            FileFact { binary: true, ..fact("logo.png", "touched", Some(10)) },
            FileFact { outside: true, ..fact("../x", "touched", Some(1)) },
            fact("src/b.rs", "declared", Some(1)),
            fact("./src/b.rs", "changed", Some(1)),
        ];
        let snapshot = build_snapshot("K-1", "now", &git, Some("/w"), &files, Some("## Depends on\nBlocked by ABC-12 and XY-3"));
        let included: Vec<&str> = snapshot["includedFiles"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
        assert_eq!(included, ["src/b.rs", "src/a.rs"]);
        let reasons: Vec<(&str, &str)> = snapshot["excludedFiles"].as_array().unwrap().iter().map(|f| (f["path"].as_str().unwrap(), f["reason"].as_str().unwrap())).collect();
        for expected in [(".env", "secret"), ("gone.rs", "missing"), ("big.bin", "too-large"), ("logo.png", "binary"), ("../x", "outside-workspace")] {
            assert!(reasons.contains(&expected), "{expected:?} in {reasons:?}");
        }
        assert_eq!(snapshot["dependencies"], json!(["ABC-12", "XY-3"]));
        assert_eq!(snapshot["dirty"], true);
        assert_eq!(snapshot["fingerprint"].as_str().unwrap().len(), 64);
        // The fingerprint ignores when the snapshot was taken.
        let later = build_snapshot("K-1", "later", &git, Some("/w"), &files, Some("## Depends on\nBlocked by ABC-12 and XY-3"));
        assert_eq!(snapshot["fingerprint"], later["fingerprint"]);
    }

    #[test]
    fn the_file_budget_is_enforced() {
        let files: Vec<FileFact> = (0..MAX_FILES + 3).map(|i| fact(&format!("f{i:03}.rs"), "changed", Some(1))).collect();
        let snapshot = build_snapshot("K", "t", &GitFacts::default(), None, &files, None);
        assert_eq!(snapshot["includedFiles"].as_array().unwrap().len(), MAX_FILES);
        assert!(snapshot["excludedFiles"].as_array().unwrap().iter().all(|f| f["reason"] == "limit"));
    }

    #[test]
    fn formatting_anchors_the_next_ai_to_the_commit() {
        let git = GitFacts { head: Some("abc".into()), branch: Some("main".into()), dirty: true, changed: vec![] };
        let text = format_snapshot(&build_snapshot("K", "t", &git, None, &[fact("a.rs", "touched", Some(1))], None));
        assert!(text.contains("Source commit: abc on main (with uncommitted changes)"));
        assert!(text.contains("- a.rs (touched)"));
        let none = format_snapshot(&build_snapshot("K", "t", &GitFacts::default(), None, &[], None));
        assert!(none.contains("Not a Git repository") && none.contains("No files were handed over."));
    }

    #[test]
    fn validation_blocks_a_stale_or_foreign_snapshot() {
        let purpose = json!({ "goal": "g" });
        let brief = json!({ "progress": "p", "nextSteps": "n", "touchedFiles": [] });
        let git = GitFacts { head: Some("aaaaaaa1".into()), ..GitFacts::default() };
        let snapshot = build_snapshot("K", "t", &git, None, &[], None);
        assert!(validate_handover(&purpose, &brief, "text", Some(&snapshot), "K", Some("aaaaaaa1")).iter().all(|(blocks, _)| !blocks));
        let moved = validate_handover(&purpose, &brief, "text", Some(&snapshot), "K", Some("bbbbbbb2"));
        assert!(moved.iter().any(|(b, m)| *b && m.contains("moved since the snapshot")));
        let foreign = validate_handover(&purpose, &brief, "text", Some(&snapshot), "OTHER", None);
        assert!(foreign.iter().any(|(b, m)| *b && m.contains("different session")));
        let missing = validate_handover(&purpose, &brief, "text", None, "K", None);
        assert!(missing.iter().any(|(b, m)| *b && m.contains("no context snapshot")));
        let secret = validate_handover(&purpose, &brief, "token ghp_abcdefghijklmnopqrstuvwxyz", Some(&snapshot), "K", None);
        assert!(secret.iter().any(|(b, m)| *b && m.contains("secret")));
        let no_goal = validate_handover(&json!({}), &brief, "text", Some(&snapshot), "K", None);
        assert!(no_goal.iter().any(|(b, m)| *b && m.contains("no goal")));
    }

    #[test]
    fn a_snapshot_of_a_real_repository_is_persisted() {
        let root = std::env::temp_dir().join(format!("praxis-snapshot-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&repo).output().unwrap().status.success());
        run(&["init", "-q", "--initial-branch=main"]);
        std::fs::write(repo.join("a.txt"), "one").unwrap();
        run(&["add", "."]);
        run(&["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "init"]);
        std::fs::write(repo.join("b.txt"), "two").unwrap();
        let record = json!({ "issueKey": "SESSION-9", "workingDirectory": repo.to_string_lossy(), "handoverBrief": { "touchedFiles": ["a.txt"] } });
        let (snapshot, manifest, head) = take_snapshot(&record, &root.join("store"), "2026-01-01T00:00:00.000Z");
        assert_eq!(snapshot["dirty"], true);
        assert_eq!(snapshot["sourceCommit"].as_str(), head.as_deref());
        let included: Vec<&str> = snapshot["includedFiles"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
        assert_eq!(included, ["a.txt", "b.txt"]);
        let manifest = manifest.expect("persisted");
        assert!(std::fs::read_to_string(manifest["path"].as_str().unwrap()).unwrap().contains("SESSION-9"));
        std::fs::remove_dir_all(&root).ok();
    }
}
