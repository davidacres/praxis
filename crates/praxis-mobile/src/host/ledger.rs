//! The command ledger and bounded event log (`packages/core/src/host/mobileCommandLedger.ts` port).
//!
//! A command id is admitted once: a retry with the same payload digest replays the recorded
//! outcome; the same id with a different payload is a `duplicate-command`. Events are appended
//! with their own sequence and replayed to phones after a cursor.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::protocol::{MobileEventEnvelope, MobileProtocolError, MobileProtocolErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MobileCommandState {
    Accepted,
    Completed,
    Unknown,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileCommandRecord {
    pub command_id: String,
    pub payload_digest: String,
    pub state: MobileCommandState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Value>,
    pub updated_at: String,
}

/// The ledger the LAN listener and host services share. Methods take `&self`; an implementation
/// supplies its own interior locking.
pub trait MobileCommandLedger: Send + Sync {
    /// Atomically checks and reserves a command id before its handler can await.
    /// Rust listener tasks may dispatch on different threads; get/put is not an admission lock.
    fn admit(
        &self,
        command_id: &str,
        payload_digest: &str,
        issued_at: &str,
    ) -> Result<(MobileCommandRecord, bool), MobileProtocolError>;
    fn get(&self, command_id: &str) -> Option<MobileCommandRecord>;
    fn put(&self, record: MobileCommandRecord);
    fn append_event(&self, event: MobileEventEnvelope);
    /// Events after `after_sequence`, at most `limit`.
    fn replay(&self, after_sequence: u64, limit: usize) -> Vec<MobileEventEnvelope>;
    /// Highest sequence appended so far (0 when none).
    fn latest_sequence(&self) -> u64;
    /// Lowest sequence still retained; a replay starting before `oldest - 1` has lost events.
    fn oldest_retained_sequence(&self) -> u64;
}

/// Streamed sessions append a full snapshot per change, so the event log is bounded.
pub const MOBILE_EVENT_RETENTION: usize = 5000;
/// The TS `replay` default limit.
pub const MOBILE_REPLAY_LIMIT: usize = 100;

#[derive(Default)]
struct LedgerState {
    commands: HashMap<String, MobileCommandRecord>,
    events: VecDeque<MobileEventEnvelope>,
}

pub struct InMemoryMobileCommandLedger {
    retention: usize,
    state: Mutex<LedgerState>,
}

impl Default for InMemoryMobileCommandLedger {
    fn default() -> Self {
        Self::new(MOBILE_EVENT_RETENTION)
    }
}

impl InMemoryMobileCommandLedger {
    pub fn new(retention: usize) -> Self {
        Self {
            retention,
            state: Mutex::default(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, LedgerState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl MobileCommandLedger for InMemoryMobileCommandLedger {
    fn admit(
        &self,
        command_id: &str,
        payload_digest: &str,
        issued_at: &str,
    ) -> Result<(MobileCommandRecord, bool), MobileProtocolError> {
        let mut state = self.lock();
        if let Some(existing) = state.commands.get(command_id) {
            if existing.payload_digest != payload_digest {
                return Err(MobileProtocolError::for_command(
                    MobileProtocolErrorCode::DuplicateCommand,
                    "The command ID was already used with a different payload.",
                    false,
                    command_id,
                ));
            }
            return Ok((existing.clone(), true));
        }
        let record = MobileCommandRecord {
            command_id: command_id.into(),
            payload_digest: payload_digest.into(),
            state: MobileCommandState::Accepted,
            outcome: None,
            updated_at: issued_at.into(),
        };
        state.commands.insert(command_id.into(), record.clone());
        Ok((record, false))
    }
    fn get(&self, command_id: &str) -> Option<MobileCommandRecord> {
        self.lock().commands.get(command_id).cloned()
    }

    fn put(&self, record: MobileCommandRecord) {
        self.lock()
            .commands
            .insert(record.command_id.clone(), record);
    }

    fn append_event(&self, event: MobileEventEnvelope) {
        let mut state = self.lock();
        state.events.push_back(event);
        while state.events.len() > self.retention {
            state.events.pop_front();
        }
    }

    fn replay(&self, after_sequence: u64, limit: usize) -> Vec<MobileEventEnvelope> {
        self.lock()
            .events
            .iter()
            .filter(|event| event.sequence > after_sequence)
            .take(limit)
            .cloned()
            .collect()
    }

    fn latest_sequence(&self) -> u64 {
        self.lock().events.back().map_or(0, |event| event.sequence)
    }

    fn oldest_retained_sequence(&self) -> u64 {
        let state = self.lock();
        match state.events.front() {
            Some(event) => event.sequence,
            None => state.events.back().map_or(0, |event| event.sequence) + 1,
        }
    }
}

/// `admitMobileCommand`: `Ok((record, replay))`, or a `duplicate-command` error.
pub fn admit_mobile_command(
    ledger: &dyn MobileCommandLedger,
    command_id: &str,
    payload_digest: &str,
    issued_at: &str,
) -> Result<(MobileCommandRecord, bool), MobileProtocolError> {
    ledger.admit(command_id, payload_digest, issued_at)
}

pub fn mark_mobile_command_unknown(
    ledger: &dyn MobileCommandLedger,
    command_id: &str,
    updated_at: &str,
) -> Option<MobileCommandRecord> {
    let mut record = ledger.get(command_id)?;
    record.state = MobileCommandState::Unknown;
    record.updated_at = updated_at.to_owned();
    ledger.put(record.clone());
    Some(record)
}

pub fn complete_mobile_command(
    ledger: &dyn MobileCommandLedger,
    command_id: &str,
    outcome: Value,
    updated_at: &str,
) -> Option<MobileCommandRecord> {
    let mut record = ledger.get(command_id)?;
    record.state = MobileCommandState::Completed;
    record.outcome = Some(outcome);
    record.updated_at = updated_at.to_owned();
    ledger.put(record.clone());
    Some(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::protocol::MobileTarget;
    use serde_json::json;

    fn event(sequence: u64) -> MobileEventEnvelope {
        MobileEventEnvelope {
            protocol_version: 1,
            event_id: format!("e{sequence}"),
            sequence,
            emitted_at: "2026-09-22T09:00:00.000Z".into(),
            target: MobileTarget::host("h"),
            event: json!({}),
        }
    }

    #[test]
    fn replays_an_identical_command_and_refuses_a_changed_payload() {
        let ledger = InMemoryMobileCommandLedger::default();
        let (first, replay) = admit_mobile_command(&ledger, "c1", "d1", "t").expect("admitted");
        assert!(!replay);
        assert_eq!(first.state, MobileCommandState::Accepted);
        complete_mobile_command(&ledger, "c1", json!({ "ok": true }), "t2");
        let (again, replay) = admit_mobile_command(&ledger, "c1", "d1", "t3").expect("replayed");
        assert!(replay);
        assert_eq!(again.outcome, Some(json!({ "ok": true })));
        let duplicate = admit_mobile_command(&ledger, "c1", "d2", "t4").expect_err("dup");
        assert_eq!(duplicate.code, MobileProtocolErrorCode::DuplicateCommand);
        assert_eq!(
            mark_mobile_command_unknown(&ledger, "c1", "t5").map(|r| r.state),
            Some(MobileCommandState::Unknown)
        );
        assert!(mark_mobile_command_unknown(&ledger, "missing", "t").is_none());
    }

    #[test]
    fn the_event_log_is_bounded_and_reports_what_it_lost() {
        let ledger = InMemoryMobileCommandLedger::new(3);
        assert_eq!(ledger.latest_sequence(), 0);
        assert_eq!(ledger.oldest_retained_sequence(), 1);
        for sequence in 1..=5 {
            ledger.append_event(event(sequence));
        }
        assert_eq!(ledger.latest_sequence(), 5);
        assert_eq!(ledger.oldest_retained_sequence(), 3);
        let sequences: Vec<u64> = ledger.replay(3, 100).iter().map(|e| e.sequence).collect();
        assert_eq!(sequences, vec![4, 5]);
        assert_eq!(ledger.replay(0, 1).len(), 1);
    }
}
