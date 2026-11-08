//! One holder at a time per resource (`exclusiveResource.ts` port).
//!
//! A parallel scheduled run keeps each ticket in its own worktree, so the only thing two tickets
//! share is the project's base checkout, which a merge stage writes to. Merges into one repository
//! take turns through this; different repositories never wait.
//!
//! In-process only: it serialises the work this Praxis instance starts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::Mutex as AsyncMutex;

/// The lock for one resource.
#[derive(Debug, Default)]
struct ResourceLock {
    gate: AsyncMutex<()>,
    /// How many callers hold or wait for this resource.
    users: Mutex<usize>,
}

/// Serialises work per resource name.
#[derive(Debug, Default)]
pub struct ExclusiveResources {
    locks: Mutex<HashMap<String, Arc<ResourceLock>>>,
}

impl ExclusiveResources {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Runs `work` once every earlier holder of `resource` has finished, whether it succeeded or
    /// threw.
    pub async fn with<T, F, Fut>(&self, resource: &str, work: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        let lock = {
            let mut locks = self.locks.lock().expect("exclusive resource map");
            let lock = locks
                .entry(resource.to_string())
                .or_insert_with(|| Arc::new(ResourceLock::default()))
                .clone();
            *lock.users.lock().expect("exclusive resource count") += 1;
            lock
        };

        let guard = lock.gate.lock().await;
        let result = work().await;
        drop(guard);

        {
            let mut locks = self.locks.lock().expect("exclusive resource map");
            let mut users = lock.users.lock().expect("exclusive resource count");
            *users -= 1;
            if *users == 0
                && locks
                    .get(resource)
                    .is_some_and(|held| Arc::ptr_eq(held, &lock))
            {
                locks.remove(resource);
            }
        }

        result
    }

    /// True while something holds or waits for `resource`.
    #[must_use]
    pub fn busy(&self, resource: &str) -> bool {
        self.locks
            .lock()
            .expect("exclusive resource map")
            .contains_key(resource)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn work_on_one_resource_never_overlaps_and_different_resources_run_side_by_side() {
        let locks = Arc::new(ExclusiveResources::new());
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let (started, started_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_first, wait) = tokio::sync::oneshot::channel::<()>();

        let first = {
            let locks = Arc::clone(&locks);
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                locks
                    .with("repo-a", move || async move {
                        log.lock().expect("log").push("a1 start".into());
                        let _ = started.send(());
                        let _ = wait.await;
                        log.lock().expect("log").push("a1 end".into());
                    })
                    .await
            })
        };
        let second = {
            let locks = Arc::clone(&locks);
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                locks
                    .with("repo-a", move || async move {
                        log.lock().expect("log").push("a2 start".into());
                        log.lock().expect("log").push("a2 end".into());
                    })
                    .await
            })
        };
        let other = {
            let locks = Arc::clone(&locks);
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                locks
                    .with("repo-b", move || async move {
                        log.lock().expect("log").push("b start".into());
                    })
                    .await
            })
        };

        // a1 holds repo-a and is waiting to be released.
        started_rx.await.ok();
        other.await.ok();
        tokio::time::sleep(Duration::from_millis(20)).await;

        let seen = log.lock().expect("log").clone();
        assert!(seen.contains(&"a1 start".to_string()), "{seen:?}");
        assert!(
            seen.contains(&"b start".to_string()),
            "repo-b waited for repo-a: {seen:?}"
        );
        assert!(
            !seen.contains(&"a2 start".to_string()),
            "a2 was not held behind a1: {seen:?}"
        );
        assert!(locks.busy("repo-a"));

        release_first.send(()).ok();
        first.await.ok();
        second.await.ok();

        let seen = log.lock().expect("log").clone();
        let index_of = |needle: &str| {
            seen.iter()
                .position(|line| line == needle)
                .unwrap_or_else(|| panic!("{needle} missing from {seen:?}"))
        };
        assert!(index_of("a1 end") < index_of("a2 start"), "{seen:?}");
        assert!(index_of("a2 start") < index_of("a2 end"), "{seen:?}");
        assert!(!locks.busy("repo-a"));
    }

    #[tokio::test]
    async fn a_holder_that_throws_still_lets_the_next_one_in() {
        let locks = ExclusiveResources::new();
        let result = locks
            .with("repo-a", || async { Err::<(), &str>("merge failed") })
            .await;
        assert_eq!(result, Err("merge failed"));
        assert!(!locks.busy("repo-a"));
        let next = locks.with("repo-a", || async { "next" }).await;
        assert_eq!(next, "next");
    }
}
