//! The Virtual Team assistant's durable team chat: storage, activation, the coordinator that
//! accepts and dispatches turns, and the execution adapter that runs a member's turn through the
//! AI session hosts. Ports `teamChatRepository.ts`, `teamChatServices.ts`, `teamChatCommands.ts`,
//! `teamChatCoordinator.ts`, `teamChatExecutionAdapter.ts`, `teamChatAttachments.ts` and the
//! `completeWithTools` half of `assistantIpc.ts`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use praxis_ai::providers::registry::{DescriptorKind, built_in_descriptors};
use praxis_host::HostContext;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::runtime::runtime;
use super::session_store::store;
use super::team_chat_core::*;
use super::now;

// ── fault injection (e2e only) ───────────────────────────────────────────

/// Controlled faults for the e2e suite, standing in for the Electron-era patches of the adapter and
/// of `fs.promises`. Nothing can arm one unless the process was started with `PRAXIS_E2E=1`
/// (the control channel is only registered then), so a shipped app never carries a live fault.
pub mod faults {
    use std::sync::Mutex;

    use serde_json::Value;

    #[derive(Default)]
    struct Faults {
        /// The next dispatch fails as if the provider may have accepted the request.
        unknown_once: bool,
        /// Every durable commit fails with this message (a full disk).
        fail_commits: Option<String>,
        /// Arms `fail_commits` once the next execution has finished and been accepted.
        fail_commits_after_execute: Option<String>,
        /// Dispatch waits until this is cleared.
        hold_dispatch: bool,
    }

    static FAULTS: Mutex<Faults> = Mutex::new(Faults {
        unknown_once: false,
        fail_commits: None,
        fail_commits_after_execute: None,
        hold_dispatch: false,
    });

    fn faults() -> std::sync::MutexGuard<'static, Faults> {
        FAULTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Applies a control message: a present key sets that fault (`null` clears it); `reset` clears all.
    pub fn control(message: &Value) {
        let mut state = faults();
        if message["reset"] == true {
            *state = Faults::default();
        }
        if let Some(flag) = message.get("unknownOnce") {
            state.unknown_once = flag == &Value::Bool(true);
        }
        if let Some(text) = message.get("failCommits") {
            state.fail_commits = text.as_str().map(str::to_owned);
        }
        if let Some(text) = message.get("failCommitsAfterExecute") {
            state.fail_commits_after_execute = text.as_str().map(str::to_owned);
        }
        if let Some(flag) = message.get("holdDispatch") {
            state.hold_dispatch = flag == &Value::Bool(true);
        }
    }

    pub fn take_unknown_once() -> bool {
        std::mem::take(&mut faults().unknown_once)
    }

    pub fn commit_failure() -> Option<String> {
        faults().fail_commits.clone()
    }

    /// Called when an execution has finished: arms the delayed commit failure.
    pub fn arm_after_execute() {
        let mut state = faults();
        if let Some(message) = state.fail_commits_after_execute.take() {
            state.fail_commits = Some(message);
        }
    }

    pub fn dispatch_held() -> bool {
        faults().hold_dispatch
    }
}

// ── storage (`teamChatRepository.ts`) ────────────────────────────────────

pub fn chats_file(dir: &Path) -> PathBuf {
    dir.join("team-chats.json")
}

fn write_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn empty_snapshot() -> Value {
    json!({ "schemaVersion": 2, "revision": 0, "teamChats": [], "conversations": [] })
}

fn is_text(value: &Value) -> bool {
    value.is_string()
}

/// Structural validation of a stored snapshot (`decode`); the file is never repaired.
fn decode(raw: &str) -> Fallible<Value> {
    let value: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if !value.is_object() || !value["teamChats"].is_array() {
        return Err("Missing teamChats array.".into());
    }
    for chat in arr_of(&value, "teamChats") {
        let ok = ["id", "projectId", "title", "createdAt", "updatedAt"].iter().all(|k| is_text(&chat[*k])) && chat["messages"].is_array();
        if !ok {
            return Err("Invalid chat record.".into());
        }
    }
    if value["schemaVersion"].is_null() && value.as_object().is_some_and(|o| o.keys().all(|k| k == "teamChats")) {
        return Ok(json!({ "schemaVersion": 2, "revision": 0, "teamChats": value["teamChats"], "conversations": [] }));
    }
    if value["schemaVersion"] != 2 || !value["revision"].is_i64() || !value["conversations"].is_array() {
        return Err("Invalid conversation envelope.".into());
    }
    let mut ids: HashSet<String> = HashSet::new();
    for conversation in arr_of(&value, "conversations") {
        let arrays = ["messages", "participants", "turns", "bindings", "summaries", "pinnedMessageIds", "commandReceipts"];
        if conversation["schemaVersion"] != 2 || !is_text(&conversation["id"]) || !conversation["revision"].is_i64() || !is_text(&conversation["coordinatorEpoch"]) || !arrays.iter().all(|k| conversation[*k].is_array()) {
            return Err("Invalid durable conversation.".into());
        }
        if !ids.insert(str_of(conversation, "id").to_owned()) {
            return Err("Duplicate conversation identity.".into());
        }
        let mut sequence = 0;
        for message in arr_of(conversation, "messages") {
            let next = message["sequence"].as_i64().unwrap_or(0);
            if next <= sequence || !is_text(&message["turnId"]) || !is_text(&message["text"]) || !is_text(&message["createdAt"]) || !message["attachments"].is_array() {
                return Err("Invalid conversation message.".into());
            }
            sequence = next;
        }
    }
    Ok(value)
}

pub fn read_snapshot(dir: &Path) -> Fallible<Value> {
    let path = chats_file(dir);
    match std::fs::read_to_string(&path) {
        Ok(raw) => decode(&raw).map_err(|e| format!("Cannot read team chat storage {}: Error: {e}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty_snapshot()),
        Err(error) => Err(format!("Cannot read team chat storage {}: {error}", path.display())),
    }
}

/// Temp file, fsync, rename: a reader sees the old file or the new one, never a torn write.
fn commit(path: &Path, serialized: &str) -> Fallible {
    use std::io::Write;
    if let Some(message) = faults::commit_failure() {
        return Err(message);
    }
    let directory = path.parent().ok_or("Team chat storage has no folder.")?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let temp = PathBuf::from(format!("{}.{}.tmp", path.display(), uuid::Uuid::new_v4()));
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(serialized.as_bytes())?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(error.to_string());
    }
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error.to_string());
    }
    Ok(())
}

/// One synchronous read-modify-write under the profile-wide commit lock.
pub fn transaction<T>(dir: &Path, mutate: impl FnOnce(&mut Value) -> Fallible<T>) -> Fallible<T> {
    let _guard = write_lock();
    let current = read_snapshot(dir)?;
    let mut draft = current.clone();
    let result = mutate(&mut draft)?;
    draft["revision"] = json!(current["revision"].as_i64().unwrap_or(0) + 1);
    let serialized = serde_json::to_string_pretty(&draft).map_err(|e| e.to_string())?;
    decode(&serialized)?;
    commit(&chats_file(dir), &serialized)?;
    Ok(result)
}

/// Pre-durable runtime session records, for migration to prove links from (read only).
fn legacy_evidence(dir: &Path) -> Vec<LegacyEvidence> {
    let sessions = store(dir);
    let Ok(all) = sessions.all() else { return Vec::new() };
    let mut evidence = Vec::new();
    for (key, summary) in all {
        if parse_legacy_key(&key).is_none() || !summary["teamChatExecution"].is_null() {
            continue;
        }
        let record = sessions.get(&key).ok().flatten().unwrap_or(summary);
        let checkpoints = arr_of(&record, "events")
            .iter()
            .filter(|e| e["type"] == "info" && e["summary"] == "Virtual Team transcript checkpoint" && !e["detail"].is_null())
            .filter_map(|e| e["detail"].as_str().map(str::to_owned))
            .collect();
        evidence.push(LegacyEvidence {
            issue_key: key,
            provider: record["provider"].as_str().filter(|p| !p.is_empty()).map(str::to_owned),
            definition_of_done: record["taskDefinition"]["definitionOfDone"].as_str().filter(|p| !p.is_empty()).map(str::to_owned),
            checkpoint_message_ids: checkpoints,
        });
    }
    evidence
}

/// Backup, migrate and cut over to durable chats. Idempotent once activated.
pub fn activate(dir: &Path) -> Fallible {
    let _guard = write_lock();
    let current = read_snapshot(dir)?;
    if current["activation"]["version"] == 1 {
        return Ok(());
    }
    let evidence = legacy_evidence(dir);
    let mut candidate = migrate_team_chats(&current, &evidence)?;
    candidate["revision"] = json!(current["revision"].as_i64().unwrap_or(0) + 1);
    let serialized = serde_json::to_string_pretty(&candidate).map_err(|e| e.to_string())?;
    decode(&serialized)?;
    let path = chats_file(dir);
    let original = std::fs::read_to_string(&path).unwrap_or_else(|_| json!({ "teamChats": [] }).to_string());
    let backup = json!({ "version": 1, "original": original }).to_string();
    let backup_path = PathBuf::from(format!("{}.v1-backup", path.display()));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&backup_path) {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(backup.as_bytes()).and_then(|()| file.sync_all()).map_err(|e| e.to_string())?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    if std::fs::read_to_string(&backup_path).map_err(|e| e.to_string())? != backup {
        return Err("Legacy backup does not match source.".into());
    }
    commit(&path, &serialized)
}

// ── attachments (`teamChatAttachments.ts`) ───────────────────────────────

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn attachment_location(dir: &Path, conversation_id: &str, digest: &str) -> Fallible<PathBuf> {
    if digest.len() != 64 || !digest.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return Err("Invalid attachment digest.".into());
    }
    Ok(dir.join("team-chat-attachments").join(sha256_hex(conversation_id.as_bytes())).join(digest))
}

pub fn stage_attachments(dir: &Path, conversation_id: &str, images: &[Value]) -> Fallible<Vec<Value>> {
    if images.len() > 8 {
        return Err("At most eight images may be attached.".into());
    }
    let mut refs = Vec::new();
    for image in images {
        let media = image["mimeType"].as_str().unwrap_or_default();
        if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&media) {
            return Err("Unsupported attachment media type.".into());
        }
        let encoded = image["dataBase64"].as_str().unwrap_or_default();
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap_or_default();
        if bytes.is_empty() || bytes.len() > 10 * 1024 * 1024 || base64::engine::general_purpose::STANDARD.encode(&bytes) != encoded {
            return Err("Invalid attachment bytes or size.".into());
        }
        let digest = sha256_hex(&bytes);
        let reference = json!({ "id": digest, "digest": digest, "mediaType": media, "size": bytes.len() });
        let file = attachment_location(dir, conversation_id, &digest)?;
        std::fs::create_dir_all(file.parent().unwrap_or(dir)).map_err(|e| e.to_string())?;
        let body = json!({ "ref": reference, "image": image }).to_string();
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&file) {
            Ok(mut handle) => {
                use std::io::Write;
                handle.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        resolve_attachments(dir, conversation_id, std::slice::from_ref(&reference))?;
        refs.push(reference);
    }
    Ok(refs)
}

pub fn resolve_attachments(dir: &Path, conversation_id: &str, refs: &[Value]) -> Fallible<Vec<Value>> {
    let mut images = Vec::new();
    for reference in refs {
        let file = attachment_location(dir, conversation_id, str_of(reference, "digest"))?;
        let raw = std::fs::read_to_string(&file).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "ENOENT".to_owned() } else { e.to_string() })?;
        let stored: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(stored["image"]["dataBase64"].as_str().unwrap_or_default()).unwrap_or_default();
        if stored["ref"]["id"] != reference["id"] || stored["ref"]["mediaType"] != reference["mediaType"] || bytes.len() as i64 != reference["size"].as_i64().unwrap_or(-1) || sha256_hex(&bytes) != str_of(reference, "digest") {
            return Err("Attachment integrity or ownership failure.".into());
        }
        images.push(stored["image"].clone());
    }
    Ok(images)
}

// ── the coordinator ──────────────────────────────────────────────────────

fn new_id() -> String {
    format!("id-{}", uuid::Uuid::new_v4().simple())
}

pub struct Abort {
    flag: AtomicBool,
    sender: tokio::sync::watch::Sender<bool>,
}

impl Abort {
    fn new() -> Arc<Self> {
        Arc::new(Self { flag: AtomicBool::new(false), sender: tokio::sync::watch::channel(false).0 })
    }
    fn trigger(&self) {
        self.flag.store(true, Ordering::SeqCst);
        let _ = self.sender.send(true);
    }
    pub fn aborted(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
    async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        let _ = receiver.wait_for(|aborted| *aborted).await;
    }
}

#[derive(Default)]
struct Loops {
    active: HashSet<String>,
    halted: HashMap<String, String>,
    aborts: HashMap<String, Arc<Abort>>,
    notified: HashMap<String, i64>,
}

pub struct Coordinator {
    pub host: HostContext,
    pub dir: PathBuf,
    loops: Mutex<Loops>,
    initialized: Mutex<bool>,
}

/// The coordinator for this profile; the process serves exactly one.
pub fn coordinator(host: &HostContext) -> Arc<Coordinator> {
    static ALL: OnceLock<Mutex<HashMap<PathBuf, Arc<Coordinator>>>> = OnceLock::new();
    let dir = host.config().user_data_dir.clone();
    let mut all = ALL.get_or_init(Default::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    Arc::clone(all.entry(dir.clone()).or_insert_with(|| Arc::new(Coordinator { host: host.clone(), dir, loops: Mutex::default(), initialized: Mutex::new(false) })))
}

struct ExecError {
    message: String,
    /// The provider may have accepted the request (`TeamChatAcceptanceUnknown`).
    unknown: bool,
}

impl ExecError {
    fn plain(message: impl ToString) -> Self {
        Self { message: message.to_string(), unknown: false }
    }
}

impl Coordinator {
    fn loops(&self) -> std::sync::MutexGuard<'_, Loops> {
        self.loops.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn notify(&self, update: Value) {
        if let (Some(id), Some(revision)) = (update["conversationId"].as_str(), update["revision"].as_i64()) {
            let mut loops = self.loops();
            let seen = loops.notified.entry(id.to_owned()).or_insert(-1);
            *seen = (*seen).max(revision);
        }
        self.host.events().emit("assistant:conversationUpdate", Some(update));
        self.host.events().emit("assistant:chatsChanged", None);
    }

    pub fn get_conversation(&self, id: &str) -> Fallible<Option<Value>> {
        Ok(arr_of(&read_snapshot(&self.dir)?, "conversations").iter().find(|c| c["id"] == id).cloned())
    }

    /// One validated conversation transition. `mutate` works on a copy; an error commits nothing.
    fn transition(self: &Arc<Self>, id: &str, touch_updated_at: bool, mutate: impl FnOnce(&mut Value) -> Fallible) -> Fallible<Value> {
        let clock = now();
        let committed = transaction(&self.dir, |snapshot| {
            let index = arr_of(snapshot, "conversations").iter().position(|c| c["id"] == id).ok_or_else(|| format!("Conversation {id} was not found."))?;
            let current = snapshot["conversations"][index].clone();
            let mut next = current.clone();
            mutate(&mut next)?;
            if touch_updated_at && next["revision"].as_i64() > current["revision"].as_i64() {
                next["updatedAt"] = json!(clock);
            }
            if snapshot["activation"].is_object() && arr_of(&next, "turns").len() > arr_of(&current, "turns").len() {
                snapshot["activation"]["acceptedNewTurns"] = json!(true);
            }
            snapshot["conversations"][index] = next.clone();
            Ok(next)
        })?;
        // Every committed revision must reach subscribers: a commit with no typed update would leave a
        // window on a stale revision whose next control is refused.
        let revision = committed["revision"].as_i64().unwrap_or(0);
        if revision > self.loops().notified.get(id).copied().unwrap_or(-1) {
            let (me, id) = (Arc::clone(self), id.to_owned());
            runtime().spawn(async move {
                tokio::time::sleep(Duration::from_millis(15)).await;
                if revision > me.loops().notified.get(&id).copied().unwrap_or(-1) {
                    me.notify(json!({ "conversationId": id, "revision": revision, "type": "revision_committed" }));
                }
            });
        }
        Ok(committed)
    }

    /// Persist a new generation once before accepting scheduling work (`initialize`).
    pub fn initialize(self: &Arc<Self>) -> Fallible {
        let mut done = self.initialized.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if *done {
            return Ok(());
        }
        let epoch = new_id();
        let snapshot = read_snapshot(&self.dir)?;
        for conversation in arr_of(&snapshot, "conversations") {
            let id = str_of(conversation, "id").to_owned();
            let mut updated = self.transition(&id, false, |c| {
                let revision = c["revision"].as_i64().unwrap_or(0);
                begin_epoch(c, revision, &epoch, &now())
            })?;
            for turn in arr_of(&updated, "turns").to_vec() {
                let Some(attempt) = arr_of(&turn, "attempts").last().cloned() else { continue };
                let recoverable = ["prepared", "dispatching", "running", "awaiting_approval", "interrupted", "outcome_unknown", "failed"].contains(&str_of(&attempt, "state"));
                if recoverable && arr_of(&attempt, "recoveryEvidence").iter().any(|e| e["kind"] == "final_result" && evidence_text(e).is_some()) {
                    self.import_recovered_result(&id, str_of(&turn, "id"), str_of(&attempt, "id"))?;
                }
            }
            updated = self.get_conversation(&id)?.unwrap_or(updated);
            for turn in arr_of(&updated, "turns").to_vec() {
                let Some(attempt) = arr_of(&turn, "attempts").last().cloned() else { continue };
                if attempt["pendingApproval"]["status"] != "invalidated" {
                    continue;
                }
                let request_id = str_of(&attempt["pendingApproval"], "runtimeRequestId").to_owned();
                let live = self.live_approvals(str_of(&attempt, "id"));
                if live.contains(&request_id) {
                    let restored = self.transition(&id, false, |c| {
                        let revision = c["revision"].as_i64().unwrap_or(0);
                        let epoch = str_of(c, "coordinatorEpoch").to_owned();
                        restore_approval(c, revision, str_of(&turn, "id"), str_of(&attempt, "id"), &epoch, &request_id, &now())
                    })?;
                    self.notify(json!({ "conversationId": id, "revision": restored["revision"], "type": "approval_restored", "turnId": turn["id"], "attemptId": attempt["id"] }));
                } else {
                    self.notify(json!({ "conversationId": id, "revision": updated["revision"], "type": "approval_invalidated", "turnId": turn["id"], "attemptId": attempt["id"] }));
                }
            }
            let updated = self.get_conversation(&id)?.unwrap_or(updated);
            if let Some(turn) = arr_of(&updated, "turns").iter().find(|t| matches!(str_of(t, "state"), "interrupted" | "outcome_unknown")) {
                self.notify(json!({ "conversationId": id, "revision": updated["revision"], "type": "turn_failed", "turnId": turn["id"], "state": turn["state"] }));
            }
        }
        *done = true;
        drop(done);
        for conversation in arr_of(&read_snapshot(&self.dir)?, "conversations") {
            self.spawn_process(str_of(conversation, "id"));
        }
        Ok(())
    }

    /// Live runtime permission requests for an attempt (a request survives only while its session waits).
    fn live_approvals(&self, attempt_id: &str) -> Vec<String> {
        let Ok(all) = store(&self.dir).all() else { return Vec::new() };
        all.values().filter(|r| r["teamChatExecution"]["attemptId"] == attempt_id).filter_map(approval_request_id).collect()
    }

    fn spawn_process(self: &Arc<Self>, id: &str) {
        let (me, id) = (Arc::clone(self), id.to_owned());
        runtime().spawn(async move { me.process_conversation(id).await });
    }

    fn abort_turn(&self, conversation_id: &str, turn_id: &str) {
        let prefix = format!("{conversation_id}:{turn_id}:");
        for (key, abort) in self.loops().aborts.iter() {
            if key.starts_with(&prefix) {
                abort.trigger();
            }
        }
    }

    pub fn remove_conversation(self: &Arc<Self>, id: &str) -> Fallible {
        for (key, abort) in self.loops().aborts.iter() {
            if key.starts_with(&format!("{id}:")) {
                abort.trigger();
            }
        }
        transaction(&self.dir, |snapshot| {
            for key in ["conversations", "teamChats"] {
                if let Some(items) = snapshot[key].as_array_mut() {
                    items.retain(|c| c["id"] != id);
                }
            }
            Ok(())
        })
    }

    /// `submitTurn`: durable acceptance, then detached dispatch.
    pub fn submit_turn(self: &Arc<Self>, command: &Value) -> Fallible<Value> {
        self.initialize()?;
        let blank = |key: &str| command[key].as_str().is_none_or(|s| s.trim().is_empty());
        if blank("conversationId") {
            return Err("A conversationId is required.".into());
        }
        if blank("commandId") {
            return Err("A commandId is required.".into());
        }
        if blank("text") {
            return Err("A message text is required.".into());
        }
        let options = &command["runtimeOptions"];
        let invalid = |key: &str, allowed: &[&str]| options.get(key).is_some_and(|v| !v.is_null() && !allowed.contains(&v.as_str().unwrap_or("\u{0}")));
        if invalid("permissionMode", &["manual", "auto", "bypass", "autopilot"]) {
            return Err("Invalid permission choice.".into());
        }
        if invalid("toolMode", &["full", "read-only", "project-only"]) {
            return Err("Invalid tool mode.".into());
        }
        if invalid("mode", &["chat", "analysis", "review"]) {
            return Err("Invalid execution mode.".into());
        }
        for attachment in command["attachmentRefs"].as_array().into_iter().flatten() {
            if attachment["digest"].as_str().is_none_or(str::is_empty) || attachment["mediaType"].as_str().is_none_or(str::is_empty) {
                return Err("Invalid attachment reference.".into());
            }
        }
        let conversation_id = str_of(command, "conversationId").to_owned();
        let command_id = str_of(command, "commandId").to_owned();
        let snapshot = read_snapshot(&self.dir)?;
        let conversation = arr_of(&snapshot, "conversations").iter().find(|c| c["id"] == conversation_id.as_str()).cloned().ok_or_else(|| format!("Conversation {conversation_id} was not found."))?;
        let payload_digest = payload_digest(command)?;
        if let Some(receipt) = arr_of(&conversation, "commandReceipts").iter().find(|r| r["commandId"] == command_id.as_str()) {
            if receipt["payloadDigest"] != payload_digest {
                return Err("Command payload conflict.".into());
            }
            let turn = arr_of(&conversation, "turns").iter().find(|t| t["id"] == receipt["turnId"]);
            return Ok(json!({ "turnId": receipt["turnId"], "revision": conversation["revision"], "state": turn.map_or(json!("completed"), |t| t["state"].clone()) }));
        }
        assert_known_participants(&conversation, command)?;
        let turn_id = new_id();
        let user_message_id = new_id();
        let runtime_options = self.capture_runtime_options(options);
        let updated = self.transition(&conversation_id, true, |conv| {
            if let Some(receipt) = arr_of(conv, "commandReceipts").iter().find(|r| r["commandId"] == command_id.as_str()) {
                if receipt["payloadDigest"] != payload_digest {
                    return Err("Command payload conflict.".into());
                }
                return Ok(());
            }
            assert_known_participants(conv, command)?;
            let plan_participants = resolve_plan_participants(conv, command);
            let sequence = arr_of(conv, "messages").last().and_then(|m| m["sequence"].as_i64()).unwrap_or(0) + 1;
            let mut plan = json!({ "participants": plan_participants, "runtimeOptions": runtime_options });
            if !command["context"].is_null() {
                plan["context"] = command["context"].clone();
            }
            let turn = json!({ "id": turn_id, "commandId": command_id, "payloadDigest": payload_digest, "userMessageId": user_message_id, "acceptedSequence": sequence,
                "plan": plan, "state": "queued", "completedParticipantIds": [], "attempts": [] });
            let mut message = json!({ "id": user_message_id, "turnId": turn_id, "role": "user", "text": command["text"], "createdAt": now(), "sequence": sequence,
                "attachments": command["attachmentRefs"].as_array().cloned().unwrap_or_default() });
            if !command["context"].is_null() {
                message["context"] = command["context"].clone();
                message["contextTitle"] = command["context"]["title"].clone();
            }
            for participant in plan_participants {
                if !arr_of(conv, "participants").iter().any(|p| p["id"] == participant["id"]) {
                    arr_mut(conv, "participants").push(participant);
                }
            }
            if conv["title"] == "New team chat" {
                conv["title"] = json!(str_of(command, "text").trim().chars().take(80).collect::<String>());
            }
            let revision = conv["revision"].as_i64().unwrap_or(0);
            submit_turn(conv, revision, command, &turn, &message)
        })?;
        let accepted_id = arr_of(&updated, "commandReceipts").iter().find(|r| r["commandId"] == command_id.as_str()).map(|r| r["turnId"].clone()).unwrap_or(Value::Null);
        let accepted = arr_of(&updated, "turns").iter().find(|t| t["id"] == accepted_id).cloned().ok_or("The accepted turn is missing.")?;
        if accepted["id"] != turn_id.as_str() {
            return Ok(json!({ "turnId": accepted["id"], "revision": updated["revision"], "state": accepted["state"] }));
        }
        let message = arr_of(&updated, "messages").iter().find(|m| m["id"] == accepted["userMessageId"]).cloned().unwrap_or(Value::Null);
        self.notify(json!({ "conversationId": conversation_id, "revision": updated["revision"], "type": "turn_accepted", "turnId": accepted["id"], "message": message, "state": "queued" }));
        self.spawn_process(&conversation_id);
        Ok(json!({ "turnId": accepted["id"], "revision": updated["revision"], "state": accepted["state"] }))
    }

    /// `captureRuntimeOptions`: fix the provider, model, tool mode and folder at acceptance.
    fn capture_runtime_options(&self, options: &Value) -> Value {
        let settings = self.host.settings().read();
        let ai = &settings.ai;
        let provider = options["provider"].as_str().map_or_else(|| ai.active_provider.clone(), str::to_owned);
        let configured = if provider == "vercel-gateway" { Some(ai.default_model.clone()) } else { ai.providers.get(&provider).and_then(|c| c.default_model.clone()) };
        let model = options["model"].as_str().filter(|m| !m.is_empty()).map(str::to_owned).or(configured.filter(|m| !m.is_empty()));
        let mut captured = options.as_object().cloned().unwrap_or_default();
        captured.insert("provider".into(), json!(provider));
        if let Some(model) = model {
            captured.insert("model".into(), json!(model));
        }
        captured.insert("toolMode".into(), if options["toolMode"].is_null() { json!("project-only") } else { options["toolMode"].clone() });
        captured.insert("workingDirectory".into(), if options["workingDirectory"].is_null() { json!(ai.working_directory) } else { options["workingDirectory"].clone() });
        Value::Object(captured)
    }

    /// Revision and target fencing plus the receipt commit in one transaction (`controlWithOutcome`).
    pub fn control_with_outcome(self: &Arc<Self>, command: &Value) -> Fallible<Value> {
        self.initialize()?;
        let action = str_of(command, "action").to_owned();
        if !["cancel", "retry", "pin", "unpin", "resume-context", "reconcile"].contains(&action.as_str()) {
            return Err("Invalid conversation control.".into());
        }
        let digest = payload_digest(command)?;
        let applied = std::cell::Cell::new(false);
        let rejection: std::cell::RefCell<Option<Value>> = std::cell::RefCell::new(None);
        let conversation_id = str_of(command, "conversationId").to_owned();
        let command_id = str_of(command, "commandId").to_owned();
        let updated = self.transition(&conversation_id, true, |conv| {
            let reject = |reason: &str| {
                *rejection.borrow_mut() = Some(json!({ "status": "conflict", "reason": reason }));
                Ok::<(), String>(())
            };
            if let Some(receipt) = arr_of(conv, "controlReceipts").iter().find(|r| r["commandId"] == command_id.as_str()) {
                if receipt["payloadDigest"] != digest {
                    return Err("Command payload conflict.".into());
                }
                *rejection.borrow_mut() = Some(json!({ "status": "duplicate" }));
                return Ok(());
            }
            if conv["revision"] != command["expectedRevision"] {
                return reject("stale-revision");
            }
            if command_id.trim().is_empty() {
                return Err("Command ID required.".into());
            }
            let turn_id = str_of(command, "turnId");
            let turn_index = arr_of(conv, "turns").iter().position(|t| t["id"] == turn_id);
            let attempt_snapshot = turn_index.and_then(|i| arr_of(&conv["turns"][i], "attempts").last().cloned());
            if !command["attemptId"].is_null() && attempt_snapshot.as_ref().is_none_or(|a| a["id"] != command["attemptId"]) {
                return reject("stale-target");
            }
            if action == "retry" && !command["participantId"].is_null() && attempt_snapshot.as_ref().is_none_or(|a| a["participantId"] != command["participantId"]) {
                return reject("stale-target");
            }
            if action == "pin" {
                pin_decision(conv, str_of(command, "messageId"), None)?;
            } else if action == "unpin" {
                let message_id = str_of(command, "messageId").to_owned();
                arr_mut(conv, "pinnedMessageIds").retain(|id| id != message_id.as_str());
            } else {
                let Some(turn_index) = turn_index else { return Err("Turn not found.".into()) };
                let conversation_id = str_of(conv, "id").to_owned();
                let turn = &mut conv["turns"][turn_index];
                let attempt_index = arr_of(turn, "attempts").len().checked_sub(1);
                match action.as_str() {
                    "cancel" => {
                        if matches!(str_of(turn, "state"), "completed" | "cancelled") {
                            return reject("not-actionable");
                        }
                        let active = attempt_snapshot.as_ref().filter(|a| ["dispatching", "running", "awaiting_approval"].contains(&str_of(a, "state"))).cloned();
                        turn["state"] = json!(if active.is_some() { "cancelling" } else if turn["state"] == "outcome_unknown" { "outcome_unknown" } else { "cancelled" });
                        let completed = arr_of(turn, "completedParticipantIds").to_vec();
                        let skipped: Vec<Value> = arr_of(&turn["plan"], "participants")
                            .iter()
                            .filter(|p| !completed.contains(&p["id"]) && active.as_ref().is_none_or(|a| a["participantId"] != p["id"]))
                            .map(|p| p["id"].clone())
                            .collect();
                        turn["skippedParticipantIds"] = json!(skipped);
                        if let Some(index) = attempt_index {
                            let attempt = &mut arr_mut(turn, "attempts")[index];
                            if attempt["state"] == "prepared" {
                                attempt["state"] = json!("cancelled");
                            }
                            settle_approval(attempt, "invalidated");
                        }
                    }
                    "reconcile" => {
                        let note = str_of(command, "reconciliationNote").trim().to_owned();
                        let Some(index) = attempt_index else { return Err("Describe the reconciliation for the unknown attempt.".into()) };
                        if turn["state"] != "outcome_unknown" || arr_of(turn, "attempts")[index]["id"] != command["attemptId"] || note.is_empty() {
                            return Err("Describe the reconciliation for the unknown attempt.".into());
                        }
                        let turn_id_value = turn["id"].clone();
                        let attempt = &mut arr_mut(turn, "attempts")[index];
                        let evidence = json!({ "id": command_id, "conversationId": conversation_id, "turnId": turn_id_value, "participantId": attempt["participantId"], "attemptId": attempt["id"],
                            "coordinatorEpoch": attempt["coordinatorEpoch"], "kind": "reconciliation", "observedAt": now(), "provenance": "user", "data": { "note": note } });
                        arr_mut(attempt, "recoveryEvidence").push(evidence);
                    }
                    "resume-context" => {
                        if turn["state"] != "context_required" {
                            return reject("not-actionable");
                        }
                        turn["state"] = json!("running");
                        turn.as_object_mut().map(|o| o.remove("contextRequiredReason"));
                    }
                    _ => {
                        // retry
                        let Some(index) = attempt_index else { return reject("stale-target") };
                        if arr_of(turn, "attempts")[index]["id"] != command["attemptId"] {
                            return reject("stale-target");
                        }
                        if !matches!(str_of(turn, "state"), "failed" | "interrupted" | "outcome_unknown") {
                            return reject("not-actionable");
                        }
                        let unknown = turn["state"] == "outcome_unknown";
                        let turn_id_value = turn["id"].clone();
                        let binding_id = arr_of(turn, "attempts")[index]["bindingId"].clone();
                        if unknown {
                            let attempt = &mut arr_mut(turn, "attempts")[index];
                            let acknowledged = command["acknowledgeDuplicateActionRisk"] == true
                                && arr_of(attempt, "recoveryEvidence").iter().any(|e| e["id"] == command["reconciliationEvidenceId"] && e["kind"] == "reconciliation");
                            if !acknowledged {
                                return Err("Acknowledge duplicate-action risk after reconciliation.".into());
                            }
                            let evidence = json!({ "id": command_id, "conversationId": conversation_id, "turnId": turn_id_value, "participantId": attempt["participantId"], "attemptId": attempt["id"],
                                "coordinatorEpoch": attempt["coordinatorEpoch"], "kind": "decision", "observedAt": now(), "provenance": "user",
                                "data": { "retryKind": "user-authorized-unknown", "acknowledgeDuplicateActionRisk": true, "reconciliationEvidenceId": command["reconciliationEvidenceId"] } });
                            arr_mut(attempt, "recoveryEvidence").push(evidence);
                        }
                        turn["state"] = json!("running");
                        if let Some(binding) = arr_mut(conv, "bindings").iter_mut().find(|b| b["id"] == binding_id) {
                            binding["status"] = json!("invalid");
                        }
                    }
                }
            }
            let revision = conv["revision"].as_i64().unwrap_or(0) + 1;
            conv["revision"] = json!(revision);
            arr_mut(conv, "controlReceipts").push(json!({ "commandId": command_id, "payloadDigest": digest, "revision": revision }));
            applied.set(true);
            Ok(())
        })?;
        if applied.get() {
            if action == "cancel" && !command["turnId"].is_null() {
                self.abort_turn(&conversation_id, str_of(command, "turnId"));
            }
            self.notify(json!({ "conversationId": updated["id"], "revision": updated["revision"], "type": "turn_accepted" }));
            self.spawn_process(&conversation_id);
        }
        let mut outcome = rejection.into_inner().unwrap_or_else(|| json!({ "status": "applied" }));
        outcome["conversation"] = updated;
        Ok(outcome)
    }

    fn import_recovered_result(self: &Arc<Self>, conversation_id: &str, turn_id: &str, attempt_id: &str) -> Fallible {
        self.transition(conversation_id, true, |conv| {
            let turn = arr_of(conv, "turns").iter().find(|t| t["id"] == turn_id).cloned();
            let attempt = turn.as_ref().and_then(|t| arr_of(t, "attempts").iter().find(|a| a["id"] == attempt_id).cloned());
            if let Some(a) = &attempt
                && a["state"] == "completed"
                && !a["resultMessageId"].is_null()
            {
                return Ok(());
            }
            let evidence = attempt.as_ref().and_then(|a| arr_of(a, "recoveryEvidence").iter().find(|e| e["kind"] == "final_result" && evidence_text(e).is_some()).cloned());
            let (Some(turn), Some(attempt), Some(evidence)) = (turn, attempt, evidence) else { return Err("Cannot accept an attempt without a recovered final result.".into()) };
            let result = if evidence["result"].is_object() { evidence["result"].clone() } else { json!({ "text": evidence_text(&evidence) }) };
            let role = arr_of(&turn["plan"], "participants").iter().find(|p| p["id"] == attempt["participantId"]).map(|p| p["role"].clone()).unwrap_or(Value::Null);
            let mut message = json!({ "id": new_id(), "turnId": turn_id, "participantId": attempt["participantId"], "role": role, "text": result["text"],
                "createdAt": now(), "sequence": arr_of(conv, "messages").last().and_then(|m| m["sequence"].as_i64()).unwrap_or(0) + 1, "attachments": [] });
            for key in ["choices", "proposedAction"] {
                if !result[key].is_null() {
                    message[key] = result[key].clone();
                }
            }
            if result["error"] == true {
                message["error"] = json!(true);
            }
            if !turn["plan"]["context"].is_null() {
                message["context"] = turn["plan"]["context"].clone();
            }
            let receipt = if result["contextDelivery"] == "native" { attempt["nativeContextReceipt"].clone() } else { attempt["contextReceipt"].clone() };
            let revision = conv["revision"].as_i64().unwrap_or(0);
            complete_attempt(conv, revision, turn_id, attempt_id, str_of(&attempt, "coordinatorEpoch"), &message, &receipt, &result, evidence["id"].as_str())
        })?;
        Ok(())
    }

    fn spawn_loop_guard(self: &Arc<Self>, id: &str) -> bool {
        let mut loops = self.loops();
        if loops.active.contains(id) {
            return false;
        }
        if let Some(message) = loops.halted.get(id).cloned() {
            drop(loops);
            self.report_loop_stop(id, &message);
            return false;
        }
        loops.active.insert(id.to_owned());
        true
    }

    async fn process_conversation(self: Arc<Self>, id: String) {
        if !self.spawn_loop_guard(&id) {
            return;
        }
        let loop_epoch = self.get_conversation(&id).ok().flatten().map(|c| c["coordinatorEpoch"].clone());
        let result = Arc::clone(&self).run_loop(&id).await;
        if let Err(message) = result {
            // A deleted conversation or a newer epoch fences this loop: late callbacks only drain.
            let current = self.get_conversation(&id).ok().flatten();
            if current.as_ref().map(|c| c["coordinatorEpoch"].clone()) == loop_epoch && current.is_some() {
                self.loops().halted.insert(id.clone(), message.clone());
                self.report_loop_stop(&id, &message);
            }
        }
        self.loops().active.remove(&id);
    }

    fn report_loop_stop(&self, id: &str, message: &str) {
        eprintln!("Team chat {id} stopped: {message}");
        let Ok(Some(current)) = self.get_conversation(id) else { return };
        let turn = arr_of(&current, "turns").iter().find(|t| !matches!(str_of(t, "state"), "queued" | "completed" | "cancelled")).cloned();
        let mut update = json!({ "conversationId": id, "revision": current["revision"], "type": "turn_failed", "error": format!("{message} Restart Praxis to recover this team chat.") });
        if let Some(turn) = turn {
            update["turnId"] = turn["id"].clone();
            update["state"] = turn["state"].clone();
        }
        self.notify(update);
    }

    async fn run_loop(self: Arc<Self>, id: &str) -> Fallible {
        loop {
            let Some(mut conversation) = self.get_conversation(id)? else { return Ok(()) };
            let mut active_turn = arr_of(&conversation, "turns").iter().find(|t| t["state"] == "running").cloned();
            if active_turn.is_none() {
                if arr_of(&conversation, "turns").iter().any(|t| !matches!(str_of(t, "state"), "queued" | "completed" | "cancelled")) {
                    return Ok(());
                }
                let Some(next) = arr_of(&conversation, "turns").iter().find(|t| t["state"] == "queued").cloned() else { return Ok(()) };
                let started = self.transition(id, true, |c| {
                    let revision = c["revision"].as_i64().unwrap_or(0);
                    start_turn(c, revision, str_of(&next, "id"))
                })?;
                self.notify(json!({ "conversationId": id, "revision": started["revision"], "type": "turn_started", "turnId": next["id"], "state": "running" }));
                active_turn = arr_of(&started, "turns").iter().find(|t| t["id"] == next["id"]).cloned();
                conversation = started;
            }
            let Some(turn) = active_turn.filter(|t| t["state"] == "running") else { return Ok(()) };
            let turn_id = str_of(&turn, "id").to_owned();
            let completed = arr_of(&turn, "completedParticipantIds").to_vec();
            let skipped = arr_of(&turn, "skippedParticipantIds").to_vec();
            let Some(participant) = arr_of(&turn["plan"], "participants").iter().find(|p| !completed.contains(&p["id"]) && !skipped.contains(&p["id"])).cloned() else {
                self.transition(id, true, |c| {
                    if let Some(t) = arr_mut(c, "turns").iter_mut().find(|t| t["id"] == turn_id.as_str())
                        && t["state"] != "completed"
                    {
                        t["state"] = json!("completed");
                        let revision = c["revision"].as_i64().unwrap_or(0);
                        c["revision"] = json!(revision + 1);
                    }
                    Ok(())
                })?;
                if let Some(updated) = self.get_conversation(id)? {
                    self.notify(json!({ "conversationId": id, "revision": updated["revision"], "type": "turn_completed", "turnId": turn_id, "state": "completed" }));
                }
                continue;
            };

            // Prepare the attempt.
            let attempt_id = new_id();
            let ordinal = arr_of(&turn, "attempts").iter().filter(|a| a["participantId"] == participant["id"]).count() + 1;
            let visible = eligible_messages(&conversation, &turn);
            let mut binding: Option<Value> = None;
            let mut context_limit: i64 = 32768;
            let prepared: Result<(PreparedContext, PreparedContext), (String, bool)> = (|| {
                let configuration = self.prepare_configuration(&conversation, &turn, &participant).map_err(|e| (e, false))?;
                if let Some(limit) = configuration["contextLimit"].as_i64() {
                    context_limit = limit;
                }
                let configuration_id = new_id();
                let mut resolved = None;
                self.transition(id, true, |c| {
                    resolved = Some(resolve_binding(arr_mut(c, "bindings"), &configuration, &configuration_id)?);
                    let revision = c["revision"].as_i64().unwrap_or(0);
                    c["revision"] = json!(revision + 1);
                    Ok(())
                })
                .map_err(|e| (e, false))?;
                binding = resolved;
                conversation = self.get_conversation(id).map_err(|e| (e, false))?.ok_or_else(|| ("The conversation was removed.".to_owned(), false))?;
                let first = prepare_context(&conversation, &turn, &participant, binding.as_ref(), false, context_limit, 12288).map_err(|e| (e.message, true))?;
                let native = if binding.as_ref().is_some_and(|b| !arr_of(b, "deliveredMessageIds").is_empty()) {
                    prepare_context(&conversation, &turn, &participant, binding.as_ref(), true, context_limit, 12288).map_err(|e| (e.message, true))?
                } else {
                    PreparedContext { prompt: first.prompt.clone(), receipt: first.receipt.clone() }
                };
                Ok((first, native))
            })();
            let _ = visible;
            let (prepared, native_prepared) = match prepared {
                Ok(both) => both,
                Err((message, _)) => {
                    let paused = self.transition(id, true, |c| {
                        if let Some(t) = arr_mut(c, "turns").iter_mut().find(|t| t["id"] == turn_id.as_str())
                            && t["state"] == "running"
                        {
                            t["state"] = json!("context_required");
                            t["contextRequiredReason"] = json!(message);
                            let revision = c["revision"].as_i64().unwrap_or(0);
                            c["revision"] = json!(revision + 1);
                        }
                        Ok(())
                    })?;
                    if arr_of(&paused, "turns").iter().any(|t| t["id"] == turn_id.as_str() && t["state"] == "context_required") {
                        self.notify(json!({ "conversationId": id, "revision": paused["revision"], "type": "context_required", "turnId": turn_id, "state": "context_required", "error": message }));
                    }
                    return Ok(());
                }
            };
            let epoch = str_of(&conversation, "coordinatorEpoch").to_owned();
            let mut attempt = json!({ "id": attempt_id, "turnId": turn_id, "participantId": participant["id"], "ordinal": ordinal, "coordinatorEpoch": epoch, "state": "prepared",
                "contextReceipt": prepared.receipt, "nativeContextReceipt": native_prepared.receipt, "createdAt": now(), "usageReferences": [], "toolEvidenceReferences": [] });
            if let Some(binding) = &binding {
                attempt["bindingId"] = binding["id"].clone();
            }
            let still_running = self.get_conversation(id)?.and_then(|c| arr_of(&c, "turns").iter().find(|t| t["id"] == turn_id.as_str()).map(|t| t["state"] == "running")).unwrap_or(false);
            if !still_running {
                return Ok(());
            }
            let reserved = self.transition(id, true, |c| {
                let running = arr_of(c, "turns").iter().any(|t| t["id"] == turn_id.as_str() && t["state"] == "running");
                if !running {
                    return Ok(());
                }
                let revision = c["revision"].as_i64().unwrap_or(0);
                reserve_attempt(c, revision, &attempt)
            });
            let current = match reserved {
                Ok(current) => current,
                // A refused reservation stops this pass quietly; a storage fault reaches the halting handler.
                Err(message) if message == "Invalid or fenced attempt." => return Ok(()),
                Err(message) => return Err(message),
            };
            if !arr_of(&current, "turns").iter().any(|t| t["id"] == turn_id.as_str() && t["state"] == "running") {
                return Ok(());
            }
            let dispatch_time = now();
            let current = self.transition(id, true, |c| {
                let revision = c["revision"].as_i64().unwrap_or(0);
                let epoch = str_of(c, "coordinatorEpoch").to_owned();
                advance_attempt(c, revision, &turn_id, &attempt_id, &epoch, "dispatching", &dispatch_time)
            })?;

            let abort = Abort::new();
            let abort_key = format!("{id}:{turn_id}:{attempt_id}");
            self.loops().aborts.insert(abort_key.clone(), Arc::clone(&abort));
            let context = Arc::new(ExecContext { coordinator: Arc::clone(&self), conversation_id: id.to_owned(), turn_id: turn_id.clone(), attempt_id: attempt_id.clone(), epoch: epoch.clone(), accepted: Mutex::new(false) });
            while faults::dispatch_held() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let outcome = Arc::clone(&self)
                .execute(Arc::clone(&context), &current, &turn, &attempt, &participant, &prepared.prompt, &native_prepared.prompt, Arc::clone(&abort))
                .await;
            let mut execution_error: Option<ExecError> = None;
            let mut result: Option<Value> = None;
            match outcome {
                Ok(value) => {
                    context.accepted();
                    faults::arm_after_execute();
                    result = Some(value);
                }
                Err(error) => execution_error = Some(error),
            }
            self.loops().aborts.remove(&abort_key);

            if abort.aborted() {
                self.transition(id, true, |c| {
                    let epoch_now = str_of(c, "coordinatorEpoch").to_owned();
                    let Some(turn) = arr_mut(c, "turns").iter_mut().find(|t| t["id"] == turn_id.as_str()) else { return Ok(()) };
                    let Some(index) = arr_of(turn, "attempts").iter().position(|a| a["id"] == attempt_id.as_str()) else { return Ok(()) };
                    if turn["state"] != "cancelling" || arr_of(turn, "attempts")[index]["coordinatorEpoch"] != epoch.as_str() || epoch_now != epoch {
                        return Ok(());
                    }
                    let turn_id_value = turn["id"].clone();
                    let conversation_id = id.to_owned();
                    let a = &mut arr_mut(turn, "attempts")[index];
                    let text_only = arr_of(a, "recoveryEvidence").iter().any(|e| e["kind"] == "runtime_identity" && e["data"]["toolCapable"] == false);
                    let (participant_value, origin_epoch) = (a["participantId"].clone(), a["coordinatorEpoch"].clone());
                    let base = |kind: &str, provenance: &str| json!({ "id": new_id(), "conversationId": conversation_id, "turnId": turn_id_value, "participantId": participant_value, "attemptId": attempt_id,
                        "coordinatorEpoch": origin_epoch, "kind": kind, "observedAt": now(), "provenance": provenance });
                    let mut reconciliation = base("reconciliation", "execution-settled-after-abort");
                    reconciliation["data"] = json!({ "executionSettled": true, "externalOutcomeUnknown": !text_only });
                    arr_mut(a, "recoveryEvidence").push(reconciliation);
                    if let Some(result) = &result {
                        let mut final_result = base("final_result", "execution-adapter-after-abort");
                        final_result["result"] = result.clone();
                        arr_mut(a, "recoveryEvidence").push(final_result);
                    }
                    a["state"] = json!(if text_only && result.is_none() { "cancelled" } else { "outcome_unknown" });
                    settle_approval(a, "invalidated");
                    a["completedAt"] = json!(now());
                    let state = a["state"].clone();
                    turn["state"] = state;
                    let revision = c["revision"].as_i64().unwrap_or(0);
                    c["revision"] = json!(revision + 1);
                    Ok(())
                })?;
                if result.is_some() {
                    self.import_recovered_result(id, &turn_id, &attempt_id)?;
                }
                if let Some(settled) = self.get_conversation(id)? {
                    let state = arr_of(&settled, "turns").iter().find(|t| t["id"] == turn_id.as_str()).map(|t| t["state"].clone());
                    self.notify(json!({ "conversationId": id, "revision": settled["revision"], "type": "turn_cancelled", "turnId": turn_id, "state": state }));
                }
                return Ok(());
            }

            let latest = self.get_conversation(id)?;
            let latest_turn = latest.as_ref().and_then(|c| arr_of(c, "turns").iter().find(|t| t["id"] == turn_id.as_str()).cloned());
            if latest_turn.as_ref().is_none_or(|t| t["state"] == "cancelled") {
                return Ok(());
            }

            if let Some(error) = execution_error {
                eprintln!("[team-chat] {id} {turn_id} failed: {}", error.message);
                self.transition(id, true, |c| {
                    let epoch_now = str_of(c, "coordinatorEpoch").to_owned();
                    let binding_updates: Vec<Value>;
                    {
                        let Some(turn) = arr_mut(c, "turns").iter_mut().find(|t| t["id"] == turn_id.as_str()) else { return Ok(()) };
                        let last_is_target = arr_of(turn, "attempts").last().is_some_and(|a| a["id"] == attempt_id.as_str());
                        let Some(index) = arr_of(turn, "attempts").iter().position(|a| a["id"] == attempt_id.as_str()) else { return Ok(()) };
                        if turn["state"] != "running" || arr_of(turn, "attempts")[index]["coordinatorEpoch"] != epoch.as_str() || epoch_now != epoch || !last_is_target {
                            return Ok(());
                        }
                        let a = &mut arr_mut(turn, "attempts")[index];
                        a["state"] = json!(if error.unknown { "outcome_unknown" } else { "failed" });
                        settle_approval(a, "invalidated");
                        a["error"] = json!(error.message);
                        a["completedAt"] = json!(now());
                        binding_updates = vec![a["bindingId"].clone()];
                        turn["state"] = json!(if error.unknown { "outcome_unknown" } else { "failed" });
                    }
                    for binding_id in binding_updates {
                        if let Some(binding) = arr_mut(c, "bindings").iter_mut().find(|b| b["id"] == binding_id) {
                            binding["status"] = json!("invalid");
                        }
                    }
                    let revision = c["revision"].as_i64().unwrap_or(0);
                    c["revision"] = json!(revision + 1);
                    Ok(())
                })?;
                if let Some(failed) = self.get_conversation(id)? {
                    self.notify(json!({ "conversationId": id, "revision": failed["revision"], "type": "turn_failed", "turnId": turn_id, "attemptId": attempt_id, "error": error.message,
                        "state": if error.unknown { "outcome_unknown" } else { "failed" } }));
                }
                return Ok(());
            }

            if let Some(result) = result {
                let latest = self.get_conversation(id)?;
                let check_turn = latest.as_ref().and_then(|c| arr_of(c, "turns").iter().find(|t| t["id"] == turn_id.as_str()).cloned());
                let check_attempt = check_turn.as_ref().and_then(|t| arr_of(t, "attempts").iter().find(|a| a["id"] == attempt_id.as_str()).cloned());
                if check_turn.as_ref().is_none_or(|t| t["state"] == "cancelled") || check_attempt.as_ref().is_none_or(|a| a["state"] == "cancelled") {
                    return Ok(());
                }
                let mut reply = json!({ "id": new_id(), "turnId": turn_id, "participantId": participant["id"], "role": participant["role"], "text": result["text"],
                    "createdAt": now(), "sequence": 0, "attachments": [] });
                for key in ["choices", "proposedAction"] {
                    if !result[key].is_null() {
                        reply[key] = result[key].clone();
                    }
                }
                if result["error"] == true {
                    reply["error"] = json!(true);
                }
                if !turn["plan"]["context"].is_null() {
                    reply["context"] = turn["plan"]["context"].clone();
                }
                self.transition(id, true, |c| {
                    let epoch_now = str_of(c, "coordinatorEpoch").to_owned();
                    let conversation_id = id.to_owned();
                    let Some(t) = arr_mut(c, "turns").iter_mut().find(|t| t["id"] == turn_id.as_str()) else { return Err("Fenced result.".into()) };
                    let Some(index) = arr_of(t, "attempts").iter().position(|a| a["id"] == attempt_id.as_str()) else { return Err("Fenced result.".into()) };
                    if epoch_now != epoch || arr_of(t, "attempts")[index]["coordinatorEpoch"] != epoch.as_str() {
                        return Err("Fenced result.".into());
                    }
                    let a = &mut arr_mut(t, "attempts")[index];
                    let evidence = json!({ "id": new_id(), "conversationId": conversation_id, "turnId": turn_id, "participantId": a["participantId"], "attemptId": attempt_id,
                        "coordinatorEpoch": a["coordinatorEpoch"], "kind": "final_result", "observedAt": now(), "provenance": "execution-adapter", "result": result });
                    arr_mut(a, "recoveryEvidence").push(evidence);
                    let revision = c["revision"].as_i64().unwrap_or(0);
                    c["revision"] = json!(revision + 1);
                    Ok(())
                })?;
                let delivery_native = result["contextDelivery"] == "native";
                let completed = self.transition(id, true, |c| {
                    reply["sequence"] = json!(arr_of(c, "messages").last().and_then(|m| m["sequence"].as_i64()).unwrap_or(0) + 1);
                    let receipt = if delivery_native { &native_prepared.receipt } else { &prepared.receipt };
                    let revision = c["revision"].as_i64().unwrap_or(0);
                    complete_attempt(c, revision, &turn_id, &attempt_id, &epoch, &reply, receipt, &result, None)
                })?;
                self.notify(json!({ "conversationId": id, "revision": completed["revision"], "type": "attempt_completed", "turnId": turn_id, "attemptId": attempt_id, "message": reply }));
                if arr_of(&completed, "turns").iter().any(|t| t["id"] == turn_id.as_str() && t["state"] == "completed") {
                    self.notify(json!({ "conversationId": id, "revision": completed["revision"], "type": "turn_completed", "turnId": turn_id, "state": "completed" }));
                }
            }
        }
    }
}

fn evidence_text(evidence: &Value) -> Option<String> {
    evidence["result"]["text"].as_str().or_else(|| evidence["data"]["text"].as_str()).map(str::to_owned)
}

fn assert_known_participants(conversation: &Value, command: &Value) -> Fallible {
    let ids = arr_of(command, "selectedParticipantIds");
    if ids.is_empty() {
        return Ok(());
    }
    if ids.iter().any(|id| !arr_of(conversation, "participants").iter().any(|p| p["id"] == *id)) {
        return Err("Invalid participant reference.".into());
    }
    Ok(())
}

/// An explicit mention selects only that member; none means the lead; else canonical role order.
fn resolve_plan_participants(conversation: &Value, command: &Value) -> Vec<Value> {
    let find = |role: &str| arr_of(conversation, "participants").iter().find(|p| p["role"] == role).cloned().unwrap_or_else(|| make_participant(role));
    if let Some(role) = parse_mention(str_of(command, "text")) {
        return vec![find(role)];
    }
    let selected = arr_of(command, "selectedParticipantIds");
    if selected.is_empty() {
        return vec![find("lead")];
    }
    let rank = |role: &str| CANONICAL_ROLE_ORDER.iter().position(|r| *r == role).unwrap_or(99);
    let mut members: Vec<Value> = selected.iter().filter_map(|id| arr_of(conversation, "participants").iter().find(|p| p["id"] == *id).cloned()).collect();
    members.sort_by_key(|p| rank(str_of(p, "role")));
    members
}

/// The head of a session's pending permission queue, as `<sessionId>:permission:<eventIndex>`.
fn approval_request_id(record: &Value) -> Option<String> {
    if record["state"] != "awaiting_approval" {
        return None;
    }
    let mut pending: Vec<usize> = Vec::new();
    for (index, event) in arr_of(record, "events").iter().enumerate() {
        match event["type"].as_str() {
            Some("permission_requested") => pending.push(index),
            Some("permission_completed") if !pending.is_empty() => {
                pending.remove(0);
            }
            _ => {}
        }
    }
    pending.first().map(|index| format!("{}:permission:{index}", str_of(record, "sessionId")))
}

// ── execution (`teamChatExecutionAdapter.ts`, `completeWithTools`) ───────

pub struct ExecContext {
    coordinator: Arc<Coordinator>,
    conversation_id: String,
    turn_id: String,
    attempt_id: String,
    epoch: String,
    accepted: Mutex<bool>,
}

impl ExecContext {
    /// Provider acceptance evidence: dispatching becomes running, once.
    fn accepted(&self) {
        let mut done = self.accepted.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if *done {
            return;
        }
        *done = true;
        drop(done);
        let result = self.coordinator.transition(&self.conversation_id, true, |c| {
            let target = arr_of(c, "turns").iter().find(|t| t["id"] == self.turn_id.as_str());
            let dispatching = target.is_some_and(|t| t["state"] == "running" && arr_of(t, "attempts").iter().any(|a| a["id"] == self.attempt_id.as_str() && a["state"] == "dispatching"));
            if !dispatching {
                return Ok(());
            }
            let revision = c["revision"].as_i64().unwrap_or(0);
            advance_attempt(c, revision, &self.turn_id, &self.attempt_id, &self.epoch, "running", &now())
        });
        if let Ok(conversation) = result
            && arr_of(&conversation, "turns").iter().any(|t| t["id"] == self.turn_id.as_str() && arr_of(t, "attempts").iter().any(|a| a["id"] == self.attempt_id.as_str() && a["state"] == "running"))
        {
            self.coordinator.notify(json!({ "conversationId": self.conversation_id, "revision": conversation["revision"], "type": "attempt_running", "turnId": self.turn_id, "attemptId": self.attempt_id }));
        }
    }

    fn evidence(&self, kind: &str, provenance: &str, data: Value) -> Fallible {
        self.coordinator
            .transition(&self.conversation_id, true, |c| {
                let epoch_now = str_of(c, "coordinatorEpoch").to_owned();
                let conversation_id = self.conversation_id.clone();
                let turn = arr_mut(c, "turns").iter_mut().find(|t| t["id"] == self.turn_id.as_str());
                let Some(turn) = turn else { return Err("Fenced runtime evidence.".into()) };
                let last_is_target = arr_of(turn, "attempts").last().is_some_and(|a| a["id"] == self.attempt_id.as_str());
                let running = matches!(str_of(turn, "state"), "running" | "cancelling");
                let Some(index) = arr_of(turn, "attempts").iter().position(|a| a["id"] == self.attempt_id.as_str()) else { return Err("Fenced runtime evidence.".into()) };
                if !running || epoch_now != self.epoch || arr_of(turn, "attempts")[index]["coordinatorEpoch"] != self.epoch.as_str() || !last_is_target {
                    return Err("Fenced runtime evidence.".into());
                }
                let turn_id = turn["id"].clone();
                let a = &mut arr_mut(turn, "attempts")[index];
                let evidence = json!({ "id": new_id(), "conversationId": conversation_id, "turnId": turn_id, "participantId": a["participantId"], "attemptId": self.attempt_id,
                    "coordinatorEpoch": a["coordinatorEpoch"], "observedAt": now(), "kind": kind, "provenance": provenance, "data": data });
                arr_mut(a, "recoveryEvidence").push(evidence);
                let revision = c["revision"].as_i64().unwrap_or(0);
                c["revision"] = json!(revision + 1);
                Ok(())
            })
            .map(|_| ())
    }

    /// A runtime permission request, or its resolution.
    fn approval(&self, request_id: &str, resolved: bool) {
        self.accepted();
        let _ = self.coordinator.transition(&self.conversation_id, true, |c| {
            let revision = c["revision"].as_i64().unwrap_or(0);
            if resolved {
                resolve_approval(c, revision, &self.turn_id, &self.attempt_id, &self.epoch, request_id)
            } else {
                record_approval(c, revision, &self.turn_id, &self.attempt_id, &self.epoch, request_id, &now())
            }
        });
    }
}

/// How a member's run is configured: the participant defaults overlaid by the turn's captured options.
fn merged_options(participant: &Value, turn: &Value) -> serde_json::Map<String, Value> {
    let mut options = participant["defaults"].as_object().cloned().unwrap_or_default();
    options.extend(turn["plan"]["runtimeOptions"].as_object().cloned().unwrap_or_default());
    options
}

fn provider_kind(host: &HostContext, provider: &str) -> Fallible<DescriptorKind> {
    if let Some(descriptor) = built_in_descriptors().into_iter().find(|d| d.id == provider) {
        return Ok(descriptor.kind);
    }
    if host.settings().read().ai.custom_providers.iter().flatten().any(|c| serde_json::to_value(c).is_ok_and(|v| v["id"] == provider)) {
        return Ok(DescriptorKind::Api);
    }
    Err(format!("Unknown AI provider \u{201c}{provider}\u{201d}."))
}

fn sha_json(value: &Value) -> String {
    sha256_hex(value.to_string().as_bytes())
}

impl Coordinator {
    /// The safe-reference configuration a binding is keyed on (`prepare`).
    fn prepare_configuration(&self, conversation: &Value, turn: &Value, participant: &Value) -> Fallible<Value> {
        let options = merged_options(participant, turn);
        if let Some(mode) = options.get("permissionMode").filter(|v| !v.is_null())
            && !["manual", "auto", "autopilot", "bypass"].contains(&mode.as_str().unwrap_or("\u{0}"))
        {
            return Err("Invalid permission choice.".into());
        }
        if let Some(mode) = options.get("toolMode").filter(|v| !v.is_null())
            && !["read-only", "full", "project-only"].contains(&mode.as_str().unwrap_or("\u{0}"))
        {
            return Err("Invalid tool mode.".into());
        }
        let settings = self.host.settings().read();
        let provider = options.get("provider").and_then(Value::as_str).map_or_else(|| settings.ai.active_provider.clone(), str::to_owned);
        let kind = provider_kind(&self.host, &provider)?;
        let api = kind == DescriptorKind::Api;
        let connection = if api { Some(super::ai_providers::api_connection(&self.host, &provider).map_err(|e| e.message)?) } else { None };
        let default_model = connection.as_ref().map(|(_, model)| model.clone()).unwrap_or_default();
        let model = options.get("model").and_then(Value::as_str).map_or(default_model, str::to_owned);
        let context_limit = praxis_ai::providers::model_pricing::get_known_context_length(Some(&model), Some(&provider));
        let working_directory = options.get("workingDirectory").and_then(Value::as_str).map_or_else(|| settings.ai.working_directory.trim().to_owned(), |w| w.trim().to_owned());
        let tool_mode = options.get("toolMode").and_then(Value::as_str);
        let runtime_label = if tool_mode.is_some_and(|m| m != "project-only") || !api { format!("{provider}:tools") } else { provider.clone() };
        let account = if api { connection.as_ref().and_then(|(c, _)| c.options.api_key.clone()).unwrap_or_else(|| provider.clone()) } else { format!("{provider}:unverified-account:{}", str_of(turn, "id")) };
        let base = connection.as_ref().map_or_else(|| settings.ai.providers.get(&provider).and_then(|c| c.cli_path.clone()).unwrap_or_else(|| provider.clone()), |(c, _)| c.options.url.clone());
        let mode = options.get("mode").and_then(Value::as_str).unwrap_or("chat");
        let canonical = if working_directory.is_empty() {
            String::new()
        } else {
            std::fs::canonicalize(&working_directory).map(|p| p.to_string_lossy().into_owned()).map_err(|e| format!("{e}, realpath '{working_directory}'"))?
        };
        let mut configuration = json!({
            "conversationId": conversation["id"], "participantId": participant["id"], "providerRuntime": runtime_label,
            "accountReference": sha256_hex(account.as_bytes()), "endpoint": sha_json(&json!([base])), "model": model,
            "reasoning": options.get("reasoningEffort").and_then(Value::as_str).unwrap_or("medium"),
            "instructionVersion": format!("{}:{}", str_of(participant, "instructionVersion"), sha256_hex(str_of(participant, "instructions").as_bytes())),
            "canonicalFolder": canonical, "executionMode": mode,
            "toolPolicy": if mode == "analysis" || mode == "review" { "read-only" } else { tool_mode.unwrap_or("project-only") },
            "permissionPolicy": options.get("permissionMode").and_then(Value::as_str).unwrap_or("manual"),
        });
        if let Some(limit) = context_limit {
            configuration["contextLimit"] = json!(limit);
        }
        Ok(configuration)
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute(self: Arc<Self>, context: Arc<ExecContext>, conversation: &Value, turn: &Value, attempt: &Value, participant: &Value, prepared_prompt: &str, native_prompt: &str, abort: Arc<Abort>) -> Result<Value, ExecError> {
        if abort.aborted() {
            return Err(ExecError::plain("Team chat execution cancelled."));
        }
        if faults::take_unknown_once() {
            return Err(ExecError { message: "Controlled unknown outcome".into(), unknown: true });
        }
        let current = self.prepare_configuration(conversation, turn, participant).map_err(ExecError::plain)?;
        let binding = arr_of(conversation, "bindings").iter().find(|b| b["id"] == attempt["bindingId"] && b["status"] == "valid");
        let expected = payload_digest(&current).map_err(ExecError::plain)?;
        if binding.is_none_or(|b| b["compatibilityDigest"] != expected) {
            return Err(ExecError::plain("Provider configuration or policy changed before dispatch."));
        }
        let settings = self.host.settings().read().clone();
        let options = merged_options(participant, turn);
        let provider = options.get("provider").and_then(Value::as_str).map_or_else(|| settings.ai.active_provider.clone(), str::to_owned);
        let kind = provider_kind(&self.host, &provider).map_err(ExecError::plain)?;
        let api = kind == DescriptorKind::Api;
        let mode = options.get("mode").and_then(Value::as_str).unwrap_or("chat").to_owned();
        let tool_mode = if mode == "analysis" || mode == "review" { "read-only".to_owned() } else { options.get("toolMode").and_then(Value::as_str).unwrap_or("project-only").to_owned() };
        let working_directory = options.get("workingDirectory").and_then(Value::as_str).map_or_else(|| settings.ai.working_directory.trim().to_owned(), |w| w.trim().to_owned());
        let working_directory = Some(working_directory).filter(|w| !w.is_empty());
        let reasoning = options.get("reasoningEffort").and_then(Value::as_str).unwrap_or("medium").to_owned();
        let refs = visible_attachment_refs(conversation, turn);
        let mut images: Vec<Value> = Vec::new();
        if !refs.is_empty() {
            if tool_mode == "project-only" {
                return Err(ExecError::plain("This provider path does not support images. Choose a runtime with image support."));
            }
            images = resolve_attachments(&self.dir, str_of(conversation, "id"), &refs).map_err(ExecError::plain)?;
        }
        let tool_capable = !(tool_mode == "project-only" && api);
        context.evidence("runtime_identity", "production-adapter", json!({ "toolCapable": tool_capable, "provider": provider })).map_err(ExecError::plain)?;
        let working_for_note = working_directory.as_deref();
        let system_prompt = format!("{}\n\n{PROTOCOL_PROMPT}\n\n{}", str_of(participant, "instructions"), capability_note(Some(&tool_mode), &mode, working_for_note));
        let turn_context = (!turn["plan"]["context"].is_null()).then(|| turn["plan"]["context"].clone());
        let parsed = |text: &str| {
            let mut reply = parse_assistant_reply(text);
            if !reply["proposedAction"].is_null() && !action_allowed_on(&reply["proposedAction"], turn_context.as_ref()) {
                reply.as_object_mut().map(|o| o.remove("proposedAction"));
            }
            reply
        };
        let attempt_id = str_of(attempt, "id").to_owned();
        if tool_mode == "project-only" && api {
            let (connection, default_model) = super::ai_providers::api_connection(&self.host, &provider).map_err(|e| ExecError::plain(e.message))?;
            let model = options.get("model").and_then(Value::as_str).map_or(default_model, str::to_owned);
            let accepted = Arc::clone(&context);
            let call = super::api_host::run_provider_prompt(&connection, &model, &system_prompt, prepared_prompt, Some(&reasoning), move |_| accepted.accepted());
            let outcome = tokio::select! {
                () = abort.cancelled() => return Err(ExecError::plain("Team chat execution cancelled.")),
                result = call => result,
            };
            let (text, usage) = outcome.map_err(|e| ExecError::plain(e))?;
            let mut reply = parsed(&text);
            let reported = usage.input_tokens.is_some() || usage.output_tokens.is_some() || usage.total_tokens.is_some();
            if reported {
                reply["usage"] = super::api_host::usage_json(&usage);
                reply["usageReferences"] = json!([format!("attempt:{attempt_id}")]);
            } else {
                reply["usageReferences"] = json!([]);
            }
            return Ok(reply);
        }
        let runtime = ToolRuntime {
            provider, model: options.get("model").and_then(Value::as_str).map(str::to_owned), reasoning_effort: reasoning,
            permission_mode: options.get("permissionMode").and_then(Value::as_str).map(str::to_owned), mode, tool_mode,
            working_directory, prefix: format!("ASSISTANT-{}", attempt["bindingId"].as_str().unwrap_or(&attempt_id)), persona: str_of(participant, "role").to_owned(),
            images, continuation: native_prompt.to_owned(), ownership: json!({ "conversationId": conversation["id"], "turnId": turn["id"], "participantId": participant["id"],
                "attemptId": attempt["id"], "bindingId": attempt["bindingId"], "coordinatorEpoch": attempt["coordinatorEpoch"] }),
        };
        match Arc::clone(&self).complete_with_tools(&context, &runtime, &system_prompt, prepared_prompt, &abort).await {
            Ok(done) => {
                let mut reply = parsed(&done.text);
                reply["contextDelivery"] = json!(done.delivery);
                if let Some(session) = done.session_id {
                    reply["providerSessionId"] = json!(session);
                }
                if !done.cost.is_null() {
                    reply["reportedCost"] = done.cost;
                }
                if !done.usage.is_null() {
                    reply["usage"] = done.usage.clone();
                    reply["usageReferences"] = json!([format!("attempt:{attempt_id}")]);
                } else {
                    reply["usageReferences"] = json!([]);
                }
                reply["toolEvidenceReferences"] = json!([format!("session:{}:attempt:{attempt_id}", done.session_key_id)]);
                Ok(reply)
            }
            Err(message) => Err(ExecError { message, unknown: true }),
        }
    }
}

/// The attachment references of the messages a turn can see.
fn visible_attachment_refs(conversation: &Value, turn: &Value) -> Vec<Value> {
    eligible_messages(conversation, turn).iter().flat_map(|m| arr_of(m, "attachments").to_vec()).collect()
}

pub struct ToolRuntime {
    provider: String,
    model: Option<String>,
    reasoning_effort: String,
    permission_mode: Option<String>,
    mode: String,
    tool_mode: String,
    working_directory: Option<String>,
    prefix: String,
    persona: String,
    images: Vec<Value>,
    continuation: String,
    ownership: Value,
}

struct ToolDone {
    text: String,
    delivery: &'static str,
    session_id: Option<String>,
    session_key_id: String,
    cost: Value,
    usage: Value,
}

/// One execution per chat and persona; a changed runtime or permission boundary gets its own.
pub fn tool_session_key(runtime: &ToolRuntime) -> String {
    let configuration = sha_json(&json!([
        runtime.provider, runtime.model, runtime.reasoning_effort, runtime.permission_mode.as_deref().unwrap_or("manual"), runtime.mode, runtime.tool_mode,
        runtime.working_directory.as_deref().map(str::trim)
    ]));
    format!("{}-{}-{}", runtime.prefix, runtime.persona, &configuration[..16])
}

const TERMINAL_SESSION: [&str; 3] = ["completed", "failed", "aborted"];

impl Coordinator {
    async fn complete_with_tools(self: Arc<Self>, context: &Arc<ExecContext>, runtime: &ToolRuntime, system_prompt: &str, user_prompt: &str, abort: &Arc<Abort>) -> Result<ToolDone, String> {
        let working_directory = runtime.working_directory.clone().filter(|w| !w.trim().is_empty()).ok_or("Choose a working folder before using assistant tools.")?;
        if !Path::new(&working_directory).is_absolute() || !Path::new(&working_directory).is_dir() {
            return Err("The selected assistant working folder is unavailable.".into());
        }
        let mode = runtime.mode.as_str();
        let tool_mode = if mode == "chat" { runtime.tool_mode.clone() } else { "read-only".to_owned() };
        let key = tool_session_key(runtime);
        let sessions = store(&self.dir);
        let existing = sessions.get(&key).map_err(|e| e.message)?;
        if existing.as_ref().is_some_and(|r| !TERMINAL_SESSION.contains(&str_of(r, "state"))) {
            return Err("This team member is still answering.".into());
        }
        let note = capability_note(Some(&tool_mode), mode, Some(&working_directory));
        let goal = format!("{system_prompt}\n\n{}\n\n{note}\n\n{user_prompt}", mode_instructions(mode));
        let issue = json!({ "key": key, "summary": "Virtual Team conversation", "status": "open", "issueType": "chat", "projectKey": "assistant", "projectName": "Praxis",
            "description": "This is not a real ticket. Ignore any request to review a ticket and respond to the user message given in the instructions above." });
        let task = json!({ "kind": if mode == "chat" { "general" } else { mode }, "sessionMode": mode, "goal": goal, "scope": format!("Work only in the selected folder: {working_directory}"),
            "definitionOfDone": LEGACY_DEFINITION_OF_DONE });
        let autonomous = matches!(runtime.permission_mode.as_deref(), Some("bypass" | "autopilot"));
        let continued = existing.is_some();
        let (host, dir) = (self.host.clone(), self.dir.clone());
        let launch = {
            let (key, working_directory, tool_mode) = (key.clone(), working_directory.clone(), tool_mode.clone());
            let images = runtime.images.clone();
            let message = user_prompt.to_owned();
            let input = json!({ "issue": issue, "task": task, "provider": runtime.provider, "model": runtime.model.clone().filter(|m| !m.trim().is_empty()), "workingDirectory": working_directory,
                "toolMode": tool_mode, "images": images, "permissionMode": runtime.permission_mode.clone().unwrap_or_else(|| "manual".into()), "reasoningEffort": runtime.reasoning_effort });
            let _ = autonomous;
            tokio::task::spawn_blocking(move || {
                if continued {
                    super::ai_delegate::dispatch(&host, &dir, "ai:continueSession", &[json!(key), json!(message), json!(images)]).unwrap_or(Ok(Value::Null)).map(|_| ())
                } else {
                    super::ai_delegate::dispatch(&host, &dir, "ai:delegate", &[input]).unwrap_or(Ok(Value::Null)).map(|_| ())
                }
            })
        };
        launch.await.map_err(|e| e.to_string())?.map_err(|e| e.message)?;
        let delivery = "reconstruction";
        let ownership = runtime.ownership.clone();
        if let Ok(Some(updated)) = sessions.mutate(&key, true, |record| {
            record["teamChatExecution"] = ownership;
            record["teamChatContextDelivery"] = json!(delivery);
        }) {
            self.host.events().emit("ai:sessionChanged", Some(updated));
        }

        // Wait for the session to settle, reporting permission requests as they appear.
        let started = Instant::now();
        let mut seen_active = false;
        let mut reported: Option<String> = None;
        let mut aborted = false;
        loop {
            if abort.aborted() && !aborted {
                aborted = true;
                let (host, dir, key) = (self.host.clone(), self.dir.clone(), key.clone());
                tokio::task::spawn_blocking(move || super::acp_host::abort_task(&host, &dir, &key));
            }
            let Some(record) = sessions.get(&key).map_err(|e| e.message)? else { return Err("The assistant session disappeared.".into()) };
            let state = str_of(&record, "state").to_owned();
            if !TERMINAL_SESSION.contains(&state.as_str()) {
                seen_active = true;
                if !str_of(&record, "responseText").is_empty() || state == "awaiting_approval" {
                    context.accepted();
                }
                let request = approval_request_id(&record);
                match (&request, &reported) {
                    (Some(request), reported_now) if reported_now.as_ref() != Some(request) => {
                        if let Some(previous) = reported_now {
                            context.approval(previous, true);
                        }
                        context.approval(request, false);
                        reported = Some(request.clone());
                    }
                    (None, Some(previous)) => {
                        context.approval(previous, true);
                        reported = None;
                    }
                    _ => {}
                }
            } else if seen_active || started.elapsed() > Duration::from_secs(3) {
                context.accepted();
                if let Some(previous) = reported.take() {
                    context.approval(&previous, true);
                }
                if state != "completed" {
                    return Err(record["lastError"].as_str().map_or_else(|| format!("Assistant tool turn {state}."), str::to_owned));
                }
                let reply_event = arr_of(&record, "events").iter().rev().find(|e| e["type"] == "message").cloned();
                let text = reply_event.as_ref().and_then(|e| e["detail"].as_str()).or_else(|| record["responseText"].as_str()).unwrap_or_default().trim().to_owned();
                if text.is_empty() {
                    return Err("The assistant tool turn returned no reply.".into());
                }
                let session_id = record["runtimeSessionId"].as_str().or_else(|| record["sessionId"].as_str()).map(str::to_owned);
                return Ok(ToolDone {
                    text, delivery, session_key_id: str_of(&record, "sessionId").to_owned(), session_id,
                    cost: reply_event.as_ref().map_or(Value::Null, |e| e["cost"].clone()),
                    usage: reply_event.as_ref().map_or(Value::Null, |e| e["tokenUsage"].clone()),
                });
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    }
}

// ── the legacy one-shot turn (`assistant:sessionTurn`, `assistant:teamReview`) ──

/// One text-only model call for the legacy single-persona and team-review paths.
pub async fn complete_text(host: &HostContext, request: &Value, system_prompt: &str, user_prompt: &str) -> Result<String, String> {
    let settings = host.settings().read().clone();
    let provider = request["provider"].as_str().filter(|p| !p.is_empty()).map_or_else(|| settings.ai.active_provider.clone(), str::to_owned);
    if provider_kind(host, &provider)? != DescriptorKind::Api {
        return Err("The Virtual Team needs an API provider for text-only turns.".into());
    }
    let (connection, default_model) = super::ai_providers::api_connection(host, &provider).map_err(|e| e.message)?;
    let model = request["model"].as_str().map(str::trim).filter(|m| !m.is_empty()).map_or(default_model, str::to_owned);
    let mode = request["mode"].as_str().unwrap_or("chat");
    let permission = request["permissionMode"].as_str().unwrap_or("manual");
    let system = format!("{system_prompt}\n\n{}\n\nPermission mode selected in the composer: {permission}. This Virtual Team chat is read-only and cannot execute tools.\n\n{}", mode_instructions(mode), capability_note(Some("project-only"), mode, None));
    let reasoning = request["reasoningEffort"].as_str().map(str::to_owned);
    let (text, _) = super::api_host::run_provider_prompt(&connection, &model, &system, user_prompt, reasoning.as_deref(), |_| {}).await?;
    Ok(text.strip_prefix("## AI Review by ").map_or(text.clone(), |rest| rest.split_once('\n').map_or(String::new(), |(_, tail)| tail.trim_start_matches('\n').to_owned())))
}

fn assistant_message(role: &str, raw: &str, context: Option<&Value>) -> Value {
    let parsed = parse_assistant_reply(raw);
    let text = parsed["text"].as_str().filter(|t| !t.is_empty()).unwrap_or("(no response)");
    let mut message = json!({ "id": format!("msg-{}", uuid::Uuid::new_v4().simple()), "role": role, "text": text, "createdAt": now() });
    if let Some(context) = context {
        message["contextTitle"] = context["title"].clone();
    }
    if !parsed["choices"].is_null() {
        message["choices"] = parsed["choices"].clone();
    }
    if !parsed["proposedAction"].is_null() && action_allowed_on(&parsed["proposedAction"], context) {
        message["proposedAction"] = parsed["proposedAction"].clone();
    }
    message
}

fn error_message(role: &str, error: &str) -> Value {
    json!({ "id": format!("msg-{}", uuid::Uuid::new_v4().simple()), "role": role, "text": format!("I couldn't answer: {error}"), "createdAt": now(), "error": true })
}

fn check_message(message: &str) -> Fallible<String> {
    let text = message.trim();
    if text.is_empty() {
        return Err("Ask the team something first.".into());
    }
    if text.chars().count() > MAX_ASSISTANT_MESSAGE_CHARS {
        return Err("Messages must be 4,000 characters or fewer.".into());
    }
    Ok(text.to_owned())
}

/// A single persona answers the user's message (`runAssistantTurn`).
pub async fn run_assistant_turn(host: &HostContext, request: &Value) -> Fallible<Value> {
    let text = check_message(request["message"].as_str().unwrap_or_default())?;
    let role = parse_mention(&text).or_else(|| request["personaId"].as_str().filter(|r| is_role(r)).map(|r| ROLES.iter().find(|x| **x == r).copied().unwrap_or("lead"))).unwrap_or("lead");
    let context = (!request["context"].is_null()).then(|| request["context"].clone());
    let prompt = [context.as_ref().map(serialize_page_context), Some(serialize_history(&request["history"])).filter(|h| !h.is_empty()), Some(format!("Current user message:\n{text}"))]
        .into_iter().flatten().collect::<Vec<_>>().join("\n\n");
    let system = format!("{}\n\n{PROTOCOL_PROMPT}", persona_prompt(role));
    Ok(match complete_text(host, request, &system, &prompt).await {
        Ok(raw) => json!({ "messages": [assistant_message(role, &raw, context.as_ref())] }),
        Err(error) => json!({ "messages": [error_message(role, &error)] }),
    })
}

/// Dev, QA, Security, then Lead, each seeing the earlier replies; stops at the first failure.
pub async fn run_team_review(host: &HostContext, request: &Value) -> Fallible<Value> {
    let prompt = request["prompt"].as_str().map(str::trim).filter(|p| !p.is_empty()).unwrap_or("Review what is on this page from your seat.").to_owned();
    if prompt.chars().count() > MAX_ASSISTANT_MESSAGE_CHARS {
        return Err("Messages must be 4,000 characters or fewer.".into());
    }
    let context = (!request["context"].is_null()).then(|| request["context"].clone());
    let mut produced: Vec<Value> = Vec::new();
    for role in TEAM_REVIEW_ORDER {
        let earlier = produced.iter().map(|m| format!("{}: {}", persona_name(str_of(m, "role")), str_of(m, "text"))).collect::<Vec<_>>().join("\n\n");
        let ask = if role == "lead" {
            format!("Team review request: {prompt}\nSynthesise the team's input into a concise verdict and ordered next steps.")
        } else {
            format!("Team review request: {prompt}\nGive your review from your seat only, in under 150 words.")
        };
        let user = [context.as_ref().map(serialize_page_context), Some(serialize_history(&request["history"])).filter(|h| !h.is_empty()), Some(format!("Team members who already spoke:\n{earlier}")).filter(|_| !earlier.is_empty()), Some(ask)]
            .into_iter().flatten().collect::<Vec<_>>().join("\n\n");
        let system = format!("{}\n\n{PROTOCOL_PROMPT}", persona_prompt(role));
        match complete_text(host, request, &system, &user).await {
            Ok(raw) => produced.push(assistant_message(role, &raw, context.as_ref())),
            Err(error) => {
                produced.push(error_message(role, &error));
                break;
            }
        }
    }
    Ok(json!({ "messages": produced }))
}

/// Reconcile and resume durable team chats at launch, before any window asks for one.
pub fn recover_on_startup(host: &HostContext) {
    let dir = host.config().user_data_dir.clone();
    if !chats_file(&dir).exists() || read_snapshot(&dir).is_ok_and(|s| s["activation"].is_null()) {
        return;
    }
    let coordinator = coordinator(host);
    if let Err(message) = coordinator.initialize() {
        eprintln!("Team chat recovery failed: {message}");
    }
}

#[cfg(test)]
mod fault_tests {
    use super::faults;
    use serde_json::json;

    #[test]
    fn an_unknown_outcome_fault_fires_once_and_dispatch_hold_follows_its_flag() {
        assert!(!faults::take_unknown_once());
        faults::control(&json!({ "unknownOnce": true }));
        assert!(faults::take_unknown_once());
        assert!(!faults::take_unknown_once(), "one failure per arming");
        faults::control(&json!({ "holdDispatch": true }));
        assert!(faults::dispatch_held());
        faults::control(&json!({ "holdDispatch": false }));
        assert!(!faults::dispatch_held());
    }
}
