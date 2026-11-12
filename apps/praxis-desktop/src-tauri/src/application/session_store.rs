//! The in-memory agent-session store, one per profile, shared by every `ai:*` handler and the
//! ACP host. Writes the same on-disk shape the Electron app did: `ai-sessions.json` holds the
//! index (records without their events) and `ai-transcripts/<session id>.json` holds each
//! session's events and text, so existing profiles load and sessions survive a restart.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Value, json};

use super::storage::{encoded, parse, read, write_atomic};
use super::{Result, failure};

const INDEX_FILE: &str = "ai-sessions.json";
const TRANSCRIPT_DIR: &str = "ai-transcripts";
/// Fields that live in the transcript file rather than the index.
const TRANSCRIPT_FIELDS: [&str; 5] = ["events", "planText", "reasoningText", "responseText", "conversationHistory"];

pub struct SessionStore {
    dir: PathBuf,
    state: Mutex<State>,
    /// A background write is already queued; further changes ride along with it.
    flush_queued: std::sync::atomic::AtomicBool,
}

/// How long changes are coalesced before they are written. Streaming updates arrive many times a
/// second; the original persisted asynchronously for the same reason.
const FLUSH_DELAY: std::time::Duration = std::time::Duration::from_millis(60);

#[derive(Default)]
struct State {
    loaded: bool,
    records: BTreeMap<String, Value>,
    /// Sessions whose transcript changed since it was last written.
    dirty: BTreeSet<String>,
}

/// The store for a profile directory.
pub fn store(user_data_dir: &Path) -> Arc<SessionStore> {
    static STORES: OnceLock<Mutex<HashMap<PathBuf, Arc<SessionStore>>>> = OnceLock::new();
    let mut all = STORES.get_or_init(Default::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    Arc::clone(all.entry(user_data_dir.to_path_buf()).or_insert_with(|| Arc::new(SessionStore { dir: user_data_dir.to_path_buf(), state: Mutex::default(), flush_queued: std::sync::atomic::AtomicBool::new(false) })))
}

fn transcript_path(dir: &Path, session_id: &str) -> PathBuf {
    let clean: String = session_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    dir.join(TRANSCRIPT_DIR).join(format!("{clean}.json"))
}

/// Whether the session's route can produce reasoning text. Derived for the renderer, never stored:
/// the answer depends on the route, which the renderer cannot work out itself.
pub fn stamp_reasoning(mut record: Value) -> Value {
    use praxis_ai::providers::reasoning_support::{ReasoningEffort, reasoning_availability};
    let effort = record["reasoningEffort"].as_str().and_then(|e| serde_json::from_value::<ReasoningEffort>(json!(e)).ok());
    let availability = reasoning_availability(record["provider"].as_str(), record["model"].as_str(), effort);
    record["reasoningAvailability"] = json!(availability);
    record
}

const INTERRUPTED_SUMMARY: &str = "Session interrupted by an app restart";

/// A restart kills every in-flight task, but the record on disk still says it is running. Left
/// alone it would show a ghost "running" session that Abort cannot touch, so it settles to
/// `aborted` and is flagged for the startup recovery offer.
fn settle_interrupted(mut record: Value) -> Value {
    if !matches!(record["state"].as_str(), Some("planning" | "executing" | "awaiting_approval" | "awaiting_input")) {
        return record;
    }
    record["state"] = json!("aborted");
    record["interruptedByRestart"] = json!(true);
    if record["completedAt"].is_null() {
        record["completedAt"] = json!(super::now());
    }
    // Sessions with a transcript get the event when it loads (see `hydrate`).
    if record["eventCount"].as_u64().unwrap_or(0) == 0 {
        let event = json!({ "timestamp": super::now(), "type": "aborted", "summary": INTERRUPTED_SUMMARY });
        let mut events = record["events"].as_array().cloned().unwrap_or_default();
        events.push(event);
        record["events"] = json!(events);
    }
    record
}

impl SessionStore {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>> {
        let mut state = self.state.lock().map_err(|_| failure("The session store is unavailable."))?;
        if !state.loaded {
            let path = self.dir.join(INDEX_FILE);
            if let Some(raw) = read(&path)? {
                let document = parse(&path, Some(&raw))?;
                let sessions = document.get("praxis.agentSessions").or_else(|| document.get("praxis.aiSessions.v1"));
                if let Some(map) = sessions.and_then(Value::as_object) {
                    state.records = map.iter().map(|(key, value)| (key.clone(), settle_interrupted(value.clone()))).collect();
                }
                // A restart kills every in-flight task, but the record still says planning/executing/awaiting.
                // Left alone it shows a ghost "running" session that nothing can abort: settle it to `aborted`.
                for record in state.records.values_mut() {
                    if matches!(record["state"].as_str(), Some("planning" | "executing" | "awaiting_approval" | "awaiting_input")) {
                        record["state"] = json!("aborted");
                        record["interruptedByRestart"] = json!(true);
                        if record["completedAt"].is_null() {
                            record["completedAt"] = json!(super::now());
                        }
                        if record["eventsLoaded"] != false && let Some(events) = record["events"].as_array_mut() {
                            events.push(json!({ "timestamp": super::now(), "type": "aborted", "summary": "Session interrupted by an app restart" }));
                        }
                    }
                }
            }
            state.loaded = true;
        }
        Ok(state)
    }

    /// Fills in a record's events from its transcript the first time they are needed.
    fn hydrate(&self, record: &mut Value) {
        let loaded = record["eventsLoaded"] != false && record["events"].as_array().is_some_and(|events| !events.is_empty() || record["eventCount"].as_u64().unwrap_or(0) == 0);
        if loaded {
            return;
        }
        let Some(id) = record["sessionId"].as_str() else { return };
        let path = transcript_path(&self.dir, id);
        let Ok(Some(raw)) = read(&path) else { return };
        let Ok(transcript) = parse(&path, Some(&raw)) else { return };
        for field in TRANSCRIPT_FIELDS {
            if !transcript[field].is_null() {
                record[field] = transcript[field].clone();
            }
        }
        record["eventsLoaded"] = json!(true);
        if record["interruptedByRestart"] == true {
            let mut events = record["events"].as_array().cloned().unwrap_or_default();
            if !events.iter().any(|event| event["summary"] == INTERRUPTED_SUMMARY) {
                events.push(json!({ "timestamp": super::now(), "type": "aborted", "summary": INTERRUPTED_SUMMARY }));
                record["events"] = json!(events);
            }
        }
    }

    /// Every record, as held (events only for sessions that have been opened or run).
    pub fn all(&self) -> Result<BTreeMap<String, Value>> {
        Ok(self.lock()?.records.clone())
    }

    /// One record with its events loaded.
    pub fn get(&self, issue_key: &str) -> Result<Option<Value>> {
        let state = self.lock()?;
        let mut record = state.records.get(issue_key).cloned();
        drop(state);
        if let Some(record) = record.as_mut() {
            self.hydrate(record);
        }
        Ok(record)
    }

    /// Replaces the whole map (used by handlers that rewrite several records) and persists it.
    pub fn replace_all(&self, records: BTreeMap<String, Value>) -> Result<()> {
        let mut state = self.lock()?;
        state.records = records;
        self.persist_locked(&mut state, None)
    }

    /// Inserts or replaces one record, persisting it.
    pub fn put(&self, issue_key: &str, record: Value) -> Result<Value> {
        let mut state = self.lock()?;
        state.records.insert(issue_key.to_owned(), record.clone());
        state.dirty.insert(issue_key.to_owned());
        self.persist_locked(&mut state, Some(issue_key))?;
        super::ai_usage_stats::track_session(&self.dir, &record);
        Ok(stamp_reasoning(record))
    }

    pub fn remove(&self, issue_key: &str) -> Result<()> {
        let mut state = self.lock()?;
        if let Some(record) = state.records.remove(issue_key)
            && let Some(id) = record["sessionId"].as_str()
        {
            let _ = std::fs::remove_file(transcript_path(&self.dir, id));
        }
        self.persist_locked(&mut state, None)
    }

    /// Applies `change` to a record and returns the result. `persist` writes it through to disk;
    /// streaming updates pass `false` and are written when the turn settles.
    pub fn mutate(self: &Arc<Self>, issue_key: &str, persist: bool, change: impl FnOnce(&mut Value)) -> Result<Option<Value>> {
        let mut state = self.lock()?;
        let Some(mut record) = state.records.get(issue_key).cloned() else { return Ok(None) };
        self.hydrate(&mut record);
        change(&mut record);
        state.records.insert(issue_key.to_owned(), record.clone());
        state.dirty.insert(issue_key.to_owned());
        drop(state);
        super::ai_usage_stats::track_session(&self.dir, &record);
        if persist {
            self.queue_flush();
        }
        Ok(Some(stamp_reasoning(record)))
    }

    /// Writes pending changes shortly, off the caller's thread, once for any burst of updates.
    fn queue_flush(self: &Arc<Self>) {
        if self.flush_queued.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(FLUSH_DELAY);
            store.flush_queued.store(false, std::sync::atomic::Ordering::SeqCst);
            if let Err(error) = store.flush() {
                eprintln!("[sessions] could not save: {}", error.message);
            }
        });
    }

    /// Writes the index, and the transcript of `only` (or every dirty one).
    pub fn flush(&self) -> Result<()> {
        let mut state = self.lock()?;
        self.persist_locked(&mut state, None)
    }

    fn persist_locked(&self, state: &mut State, only: Option<&str>) -> Result<()> {
        let to_write: Vec<String> = match only {
            Some(key) => vec![key.to_owned()],
            None => state.dirty.iter().cloned().collect(),
        };
        for key in &to_write {
            let Some(record) = state.records.get(key) else { continue };
            let Some(id) = record["sessionId"].as_str() else { continue };
            if record["eventsLoaded"] == false && record["events"].as_array().is_none_or(Vec::is_empty) {
                continue; // never opened; the transcript on disk is already current
            }
            let transcript: serde_json::Map<String, Value> = TRANSCRIPT_FIELDS.iter().filter(|field| !record[**field].is_null()).map(|field| ((*field).to_owned(), record[*field].clone())).collect();
            let path = transcript_path(&self.dir, id);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| failure(error.to_string()))?;
            }
            write_atomic(&path, &encoded(&Value::Object(transcript))?, false)?;
            state.dirty.remove(key);
        }
        // The index never carries events or the long text fields.
        let index: BTreeMap<String, Value> = state
            .records
            .iter()
            .map(|(key, record)| {
                let mut slim = record.clone();
                if let Some(object) = slim.as_object_mut() {
                    let count = object.get("events").and_then(Value::as_array).map(Vec::len).or_else(|| object.get("eventCount").and_then(Value::as_u64).map(|n| n as usize));
                    for field in TRANSCRIPT_FIELDS {
                        object.remove(field);
                    }
                    if let Some(count) = count {
                        object.insert("eventCount".into(), json!(count));
                    }
                    object.insert("eventsLoaded".into(), json!(false));
                    object.insert("events".into(), json!([]));
                }
                (key.clone(), slim)
            })
            .collect();
        let path = self.dir.join(INDEX_FILE);
        let raw = read(&path)?;
        let mut document = parse(&path, raw.as_deref())?;
        let slot = if document.get("praxis.agentSessions").is_some() || document.get("praxis.aiSessions.v1").is_none() { "praxis.agentSessions" } else { "praxis.aiSessions.v1" };
        document[slot] = json!(index);
        write_atomic(&path, &encoded(&document)?, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("praxis-sessions-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    #[test]
    fn records_round_trip_with_events_in_the_transcript_and_not_the_index() {
        let dir = temp("roundtrip");
        let s = store(&dir);
        s.put("SESSION-1", json!({ "issueKey": "SESSION-1", "sessionId": "abc-1", "state": "executing", "events": [{"type":"session_start"}], "eventsLoaded": true, "responseText": "hello" })).expect("put");
        s.mutate("SESSION-1", true, |record| {
            record["events"].as_array_mut().expect("events").push(json!({"type":"message"}));
            record["state"] = json!("completed");
        })
        .expect("mutate");
        s.flush().expect("flush");

        let index: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(INDEX_FILE)).expect("index")).expect("json");
        let slim = &index["praxis.agentSessions"]["SESSION-1"];
        assert_eq!((slim["state"].as_str(), slim["eventCount"].as_u64(), slim["eventsLoaded"].as_bool()), (Some("completed"), Some(2), Some(false)));
        assert!(slim.get("responseText").is_none(), "long text stays out of the index");
        let transcript: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("ai-transcripts/abc-1.json")).expect("transcript")).expect("json");
        assert_eq!((transcript["events"].as_array().map(Vec::len), transcript["responseText"].as_str()), (Some(2), Some("hello")));

        // A fresh store (a restart) rebuilds the record, hydrating events on demand.
        let reopened = Arc::new(SessionStore { dir: dir.clone(), state: Mutex::default(), flush_queued: std::sync::atomic::AtomicBool::new(false) });
        let record = reopened.get("SESSION-1").expect("get").expect("record");
        assert_eq!((record["events"].as_array().map(Vec::len), record["responseText"].as_str(), record["state"].as_str()), (Some(2), Some("hello"), Some("completed")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn non_persisting_updates_are_visible_at_once_but_written_only_on_flush() {
        let dir = temp("stream");
        let s = store(&dir);
        s.put("K", json!({ "issueKey": "K", "sessionId": "s1", "events": [], "eventsLoaded": true })).expect("put");
        s.mutate("K", false, |record| record["responseText"] = json!("partial")).expect("stream");
        assert_eq!(s.get("K").expect("get").expect("record")["responseText"], "partial");
        let on_disk = std::fs::read_to_string(dir.join("ai-transcripts/s1.json")).expect("initial transcript");
        assert!(!on_disk.contains("partial"));
        s.flush().expect("flush");
        assert!(std::fs::read_to_string(dir.join("ai-transcripts/s1.json")).expect("transcript").contains("partial"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn removing_a_session_deletes_its_transcript() {
        let dir = temp("remove");
        let s = store(&dir);
        s.put("R", json!({ "issueKey": "R", "sessionId": "gone", "events": [], "eventsLoaded": true })).expect("put");
        assert!(dir.join("ai-transcripts/gone.json").exists());
        s.remove("R").expect("remove");
        assert!(!dir.join("ai-transcripts/gone.json").exists() && s.get("R").expect("get").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
