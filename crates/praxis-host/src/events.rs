//! Broadcast event bus (`HostEventBus`) forwarding Rust domain events to Electron windows
//! and subscribed test listeners.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use praxis_contracts::RustEventEnvelope;
use tokio::sync::broadcast;

/// Subscription identifier returned by [`HostEventBus::on_event`].
pub type EventSubscriptionId = u64;

type EventCallback = Arc<dyn Fn(&RustEventEnvelope) + Send + Sync>;

/// Multi-consumer event bus for domain notifications (`settings:changed`, `workflows:*`,
/// `ai:*`, `terminal:*`, `runs:*`, etc.).
#[derive(Clone)]
pub struct HostEventBus {
    sender: broadcast::Sender<RustEventEnvelope>,
    callbacks: Arc<RwLock<Vec<(EventSubscriptionId, EventCallback)>>>,
    next_id: Arc<AtomicU64>,
}

impl std::fmt::Debug for HostEventBus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostEventBus")
            .field("receiver_count", &self.sender.receiver_count())
            .finish_non_exhaustive()
    }
}

impl Default for HostEventBus {
    fn default() -> Self {
        Self::new(256)
    }
}

impl HostEventBus {
    /// Creates a new [`HostEventBus`] with the given async broadcast channel capacity.
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity.max(16));
        Self {
            sender,
            callbacks: Arc::new(RwLock::new(Vec::new())),
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Emits a domain event to all async broadcast receivers and synchronous bridge callbacks.
    pub fn emit(
        &self,
        channel: impl Into<String>,
        payload: Option<serde_json::Value>,
    ) -> RustEventEnvelope {
        let envelope = RustEventEnvelope {
            channel: channel.into(),
            payload,
        };
        let _ = self.sender.send(envelope.clone());
        let listeners: Vec<EventCallback> = self
            .callbacks
            .read()
            .map(|guard| guard.iter().map(|(_, cb)| Arc::clone(cb)).collect())
            .unwrap_or_default();
        for listener in listeners {
            listener(&envelope);
        }
        envelope
    }

    /// Subscribes an async broadcast receiver to all emitted [`RustEventEnvelope`] events.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<RustEventEnvelope> {
        self.sender.subscribe()
    }

    /// Registers a synchronous callback invoked whenever an event is emitted.
    pub fn on_event<F>(&self, callback: F) -> EventSubscriptionId
    where
        F: Fn(&RustEventEnvelope) + Send + Sync + 'static,
    {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut guard) = self.callbacks.write() {
            guard.push((id, Arc::new(callback)));
        }
        id
    }

    /// Removes a previously registered callback by [`EventSubscriptionId`].
    pub fn off_event(&self, id: EventSubscriptionId) -> bool {
        let Ok(mut guard) = self.callbacks.write() else {
            return false;
        };
        let before = guard.len();
        guard.retain(|(entry_id, _)| *entry_id != id);
        guard.len() < before
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn event_bus_notifies_both_broadcast_and_sync_subscribers() {
        let bus = HostEventBus::default();
        let mut rx = bus.subscribe();
        let captured = Arc::new(RwLock::new(Vec::<RustEventEnvelope>::new()));
        let captured_clone = Arc::clone(&captured);

        let sub_id = bus.on_event(move |env| {
            if let Ok(mut guard) = captured_clone.write() {
                guard.push(env.clone());
            }
        });

        let emitted = bus.emit("settings:changed", Some(json!({ "theme": "dark" })));
        let received = rx.recv().await.expect("broadcast event");
        assert_eq!(received, emitted);

        let sync_events = captured.read().expect("lock").clone();
        assert_eq!(sync_events, vec![emitted]);

        assert!(bus.off_event(sub_id));
        bus.emit("workflows:runChanged", Some(json!("run-1")));
        assert_eq!(captured.read().expect("lock").len(), 1);
    }
}
