//! Keeps a workflow stage attached while an intentional provider interruption is in progress.
//! Ports `stageHandoverGuard.ts`: a handover aborts the stage's live session on purpose, and the
//! stage waiter must not read that abort as the stage ending.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

fn held() -> &'static Mutex<HashSet<String>> {
    static HELD: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    HELD.get_or_init(Default::default)
}

pub fn is_held(key: &str) -> bool {
    held().lock().is_ok_and(|all| all.contains(key))
}

/// Holds `key` until dropped.
pub struct Hold {
    key: String,
}

/// `None` when a handover for the key is already in progress.
pub fn hold(key: &str) -> Option<Hold> {
    let mut all = held().lock().ok()?;
    all.insert(key.to_owned()).then(|| Hold {
        key: key.to_owned(),
    })
}

impl Drop for Hold {
    fn drop(&mut self) {
        if let Ok(mut all) = held().lock() {
            all.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_held_until_dropped_and_cannot_be_held_twice() {
        let first = hold("guard-test").expect("first hold");
        assert!(is_held("guard-test"));
        assert!(hold("guard-test").is_none());
        drop(first);
        assert!(!is_held("guard-test"));
        assert!(hold("guard-test").is_some());
    }
}
