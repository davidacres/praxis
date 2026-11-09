//! Host-to-Electron request channel layered on the stdio bridge.
//!
//! The host writes [`HostWireFrame::Call`] lines and Electron answers with
//! `callResponse` lines. Calls time out, and every outstanding call fails when the
//! channel is closed (stdin EOF or shutdown) so no caller waits forever.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use thiserror::Error;
use tokio::sync::oneshot;

use crate::stdio::{HostInboundReply, HostWireFrame};

/// Failure of a host-to-Electron call.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum HostCallError {
    #[error("host call timed out")]
    TimedOut,
    #[error("host call channel closed")]
    Closed,
    #[error("host call failed: {0}")]
    Remote(String),
}

type Sink = Arc<dyn Fn(HostWireFrame) -> bool + Send + Sync>;
type Pending = HashMap<String, oneshot::Sender<Result<Value, HostCallError>>>;

struct Inner {
    sink: Sink,
    next_id: AtomicU64,
    pending: Mutex<Pending>,
    closed: Mutex<bool>,
}

/// Cloneable handle for issuing calls to Electron.
#[derive(Clone)]
pub struct HostCallClient {
    inner: Arc<Inner>,
}

impl HostCallClient {
    /// `sink` writes one frame to the wire and returns `false` if it could not.
    pub fn new(sink: impl Fn(HostWireFrame) -> bool + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(Inner {
                sink: Arc::new(sink),
                next_id: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                closed: Mutex::new(false),
            }),
        }
    }

    /// Sends `method` with `params` and waits up to `timeout` for the reply.
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, HostCallError> {
        let id = format!(
            "host-call-{}",
            self.inner.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = oneshot::channel();
        {
            // Check `closed` and insert under one ordering so a concurrent close cannot
            // miss this call: close() sets the flag before draining the map.
            let closed = self.inner.closed.lock().expect("closed lock");
            if *closed {
                return Err(HostCallError::Closed);
            }
            self.inner
                .pending
                .lock()
                .expect("pending lock")
                .insert(id.clone(), tx);
        }
        let frame = HostWireFrame::Call {
            id: id.clone(),
            method: method.to_string(),
            params,
        };
        if !(self.inner.sink)(frame) {
            self.inner.pending.lock().expect("pending lock").remove(&id);
            return Err(HostCallError::Closed);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(HostCallError::Closed),
            Err(_) => {
                self.inner.pending.lock().expect("pending lock").remove(&id);
                Err(HostCallError::TimedOut)
            }
        }
    }

    /// Routes an inbound reply to its waiting caller. Unknown ids (late replies after a
    /// timeout) are ignored.
    pub fn handle_reply(&self, reply: HostInboundReply) {
        let HostInboundReply::CallResponse {
            id,
            ok,
            result,
            error,
        } = reply;
        let sender = self.inner.pending.lock().expect("pending lock").remove(&id);
        if let Some(sender) = sender {
            let outcome = if ok {
                Ok(result.unwrap_or(Value::Null))
            } else {
                Err(HostCallError::Remote(
                    error.unwrap_or_else(|| "unknown error".into()),
                ))
            };
            let _ = sender.send(outcome);
        }
    }

    /// Fails all outstanding calls and rejects future ones.
    pub fn close(&self) {
        *self.inner.closed.lock().expect("closed lock") = true;
        let drained: Vec<_> = self
            .inner
            .pending
            .lock()
            .expect("pending lock")
            .drain()
            .map(|(_, tx)| tx)
            .collect();
        for tx in drained {
            let _ = tx.send(Err(HostCallError::Closed));
        }
    }

    #[cfg(test)]
    fn pending_len(&self) -> usize {
        self.inner.pending.lock().expect("pending lock").len()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::json;

    fn client_with_log() -> (HostCallClient, Arc<Mutex<Vec<HostWireFrame>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink_log = Arc::clone(&log);
        let client = HostCallClient::new(move |f| {
            sink_log.lock().unwrap().push(f);
            true
        });
        (client, log)
    }

    fn only_call_id(log: &Arc<Mutex<Vec<HostWireFrame>>>) -> String {
        match log.lock().unwrap().last() {
            Some(HostWireFrame::Call { id, .. }) => id.clone(),
            other => panic!("expected call frame, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn resolves_with_matching_reply() {
        let (client, log) = client_with_log();
        let c2 = client.clone();
        let task = tokio::spawn(async move {
            c2.call("mobile.read", json!({"a": 1}), Duration::from_secs(5))
                .await
        });
        tokio::task::yield_now().await;
        while log.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        let id = only_call_id(&log);
        client.handle_reply(HostInboundReply::CallResponse {
            id,
            ok: true,
            result: Some(json!({"b": 2})),
            error: None,
        });
        assert_eq!(task.await.unwrap().unwrap(), json!({"b": 2}));
        assert_eq!(client.pending_len(), 0);
    }

    #[tokio::test]
    async fn remote_error_and_unknown_reply() {
        let (client, log) = client_with_log();
        let c2 = client.clone();
        let task =
            tokio::spawn(async move { c2.call("m", Value::Null, Duration::from_secs(5)).await });
        while log.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        client.handle_reply(HostInboundReply::CallResponse {
            id: "nope".into(),
            ok: true,
            result: None,
            error: None,
        });
        client.handle_reply(HostInboundReply::CallResponse {
            id: only_call_id(&log),
            ok: false,
            result: None,
            error: Some("boom".into()),
        });
        assert_eq!(
            task.await.unwrap(),
            Err(HostCallError::Remote("boom".into()))
        );
    }

    #[tokio::test]
    async fn times_out_and_ignores_late_reply() {
        let (client, log) = client_with_log();
        let result = client
            .call("m", Value::Null, Duration::from_millis(20))
            .await;
        assert_eq!(result, Err(HostCallError::TimedOut));
        assert_eq!(client.pending_len(), 0);
        client.handle_reply(HostInboundReply::CallResponse {
            id: only_call_id(&log),
            ok: true,
            result: None,
            error: None,
        });
    }

    #[tokio::test]
    async fn close_fails_outstanding_and_future_calls() {
        let (client, log) = client_with_log();
        let c2 = client.clone();
        let task =
            tokio::spawn(async move { c2.call("m", Value::Null, Duration::from_secs(5)).await });
        while log.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        client.close();
        assert_eq!(task.await.unwrap(), Err(HostCallError::Closed));
        assert_eq!(
            client.call("m", Value::Null, Duration::from_secs(1)).await,
            Err(HostCallError::Closed)
        );
    }

    #[tokio::test]
    async fn failed_write_is_closed_and_leaves_nothing_pending() {
        let client = HostCallClient::new(|_| false);
        assert_eq!(
            client.call("m", Value::Null, Duration::from_secs(1)).await,
            Err(HostCallError::Closed)
        );
        assert_eq!(client.pending_len(), 0);
    }

    #[test]
    fn wire_shapes_are_stable() {
        let frame = HostWireFrame::Call {
            id: "x".into(),
            method: "m".into(),
            params: json!(1),
        };
        assert_eq!(
            serde_json::to_value(&frame).unwrap(),
            json!({"kind":"call","id":"x","method":"m","params":1})
        );
        let reply: HostInboundReply =
            serde_json::from_value(json!({"kind":"callResponse","id":"x","ok":true,"result":2}))
                .unwrap();
        assert_eq!(
            reply,
            HostInboundReply::CallResponse {
                id: "x".into(),
                ok: true,
                result: Some(json!(2)),
                error: None
            }
        );
    }
}
