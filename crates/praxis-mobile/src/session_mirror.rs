//! Keeps a phone's copy of desktop sessions consistent across streaming, replay and reconnect
//! (`packages/mobile-protocol/src/sessionMirror.ts` port).
//!
//! Every snapshot carries the host event sequence it is current as of, and each one replaces the
//! whole session, so applying the higher-sequence snapshot is idempotent: a replayed or re-read
//! snapshot can neither duplicate a message nor roll a streamed reply back. A desktop restart
//! restarts its sequence at zero; the caller detects that with `host.info.hostEpoch` and starts
//! a fresh mirror.

use std::collections::HashMap;

pub trait SequencedSnapshot {
    fn session_id(&self) -> &str;
    fn sequence(&self) -> u64;
}

/// Stores `incoming` unless the mirror already holds a newer snapshot of that session.
/// Returns whether it was applied (an equal sequence replaces, as in the TS).
pub fn merge_sequenced_snapshot<T: SequencedSnapshot>(
    current: &mut HashMap<String, T>,
    incoming: T,
) -> bool {
    if current
        .get(incoming.session_id())
        .is_some_and(|existing| existing.sequence() > incoming.sequence())
    {
        return false;
    }
    current.insert(incoming.session_id().to_owned(), incoming);
    true
}

/// Tracks the highest event sequence applied, so a replay can resume after it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MobileEventCursor {
    latest: u64,
}

impl MobileEventCursor {
    pub fn new(start: u64) -> Self {
        Self { latest: start }
    }

    pub fn sequence(&self) -> u64 {
        self.latest
    }

    /// Records an envelope; false when it was already seen (a duplicate delivery).
    pub fn observe(&mut self, sequence: u64) -> bool {
        if sequence <= self.latest {
            return false;
        }
        self.latest = sequence;
        true
    }

    pub fn reset(&mut self, start: u64) {
        self.latest = start;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq)]
    struct Session {
        id: &'static str,
        sequence: u64,
        messages: Vec<&'static str>,
    }

    impl SequencedSnapshot for Session {
        fn session_id(&self) -> &str {
            self.id
        }
        fn sequence(&self) -> u64 {
            self.sequence
        }
    }

    fn session(sequence: u64, messages: &[&'static str]) -> Session {
        Session {
            id: "s1",
            sequence,
            messages: messages.to_vec(),
        }
    }

    #[test]
    fn snapshots_merge_by_sequence_so_replay_never_duplicates_or_regresses_a_session() {
        let mut sessions = HashMap::new();
        assert!(merge_sequenced_snapshot(
            &mut sessions,
            session(5, &["hi", "streamed reply"])
        ));
        let before = sessions.clone();
        assert!(!merge_sequenced_snapshot(
            &mut sessions,
            session(3, &["hi"])
        ));
        assert_eq!(sessions, before, "an older replayed snapshot is ignored");
        assert!(merge_sequenced_snapshot(
            &mut sessions,
            session(5, &["hi", "streamed reply"])
        ));
        assert_eq!(
            sessions["s1"].messages,
            ["hi", "streamed reply"],
            "a re-delivered snapshot replaces rather than appends"
        );
        merge_sequenced_snapshot(&mut sessions, session(9, &["hi", "streamed reply", "next"]));
        assert_eq!(sessions["s1"].messages.len(), 3);

        let mut cursor = MobileEventCursor::new(4);
        assert!(cursor.observe(5));
        assert!(!cursor.observe(5));
        assert!(!cursor.observe(2));
        assert_eq!(cursor.sequence(), 5);
        cursor.reset(0);
        assert_eq!(cursor.sequence(), 0);
    }
}
