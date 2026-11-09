//! The host's read/command dispatch (`packages/core/src/host/mobileHostApplication.ts` and
//! `mobileExecutionBoundary.ts` port).
//!
//! A [`MobileHostApplication`] is a table of read handlers, a table of command handlers, the
//! shared ledger and a payload digest. [`handle_mobile_read`] checks the caller's capability;
//! [`handle_mobile_command`] validates the envelope, admits the command id through the ledger
//! (a retry replays the recorded outcome) and records the outcome or marks it unknown.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::Value;

use super::ledger::{
    MobileCommandLedger, admit_mobile_command, complete_mobile_command, mark_mobile_command_unknown,
};
use super::protocol::{
    MobileCommand, MobileCommandOperation, MobileProtocolError, MobileReadOperation,
    MobileReadRequest, now_iso, validate_mobile_command,
};

/// A handler refused or failed; the message reaches the phone as the reply's `error`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct MobileHostError(pub String);

impl MobileHostError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl From<MobileProtocolError> for MobileHostError {
    fn from(error: MobileProtocolError) -> Self {
        Self(error.message)
    }
}

impl From<String> for MobileHostError {
    fn from(message: String) -> Self {
        Self(message)
    }
}

impl From<&str> for MobileHostError {
    fn from(message: &str) -> Self {
        Self(message.to_owned())
    }
}

pub type HostResult<T = Value> = Result<T, MobileHostError>;
pub type HostFuture = Pin<Box<dyn Future<Output = HostResult> + Send>>;
pub type ReadHandler = Arc<dyn Fn(MobileReadRequest) -> HostFuture + Send + Sync>;
pub type CommandHandler = Arc<dyn Fn(MobileCommand) -> HostFuture + Send + Sync>;
pub type PayloadDigest = Arc<dyn Fn(&MobileCommand) -> String + Send + Sync>;

/// Wraps an async closure as a [`ReadHandler`].
pub fn read_handler<F, Fut>(handler: F) -> ReadHandler
where
    F: Fn(MobileReadRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = HostResult> + Send + 'static,
{
    Arc::new(move |request| Box::pin(handler(request)))
}

/// Wraps an async closure as a [`CommandHandler`].
pub fn command_handler<F, Fut>(handler: F) -> CommandHandler
where
    F: Fn(MobileCommand) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = HostResult> + Send + 'static,
{
    Arc::new(move |command| Box::pin(handler(command)))
}

pub type MobileHostReads = IndexMap<MobileReadOperation, ReadHandler>;
pub type MobileExecutionHandlers = IndexMap<MobileCommandOperation, CommandHandler>;

#[derive(Clone)]
pub struct MobileHostApplication {
    pub reads: MobileHostReads,
    pub commands: MobileExecutionHandlers,
    pub ledger: Arc<dyn MobileCommandLedger>,
    pub payload_digest: PayloadDigest,
}

/// The composition's digest: `JSON.stringify(command.payload ?? null)`.
pub fn default_payload_digest() -> PayloadDigest {
    Arc::new(|command: &MobileCommand| {
        serde_json::to_string(&command.payload).unwrap_or_else(|_| "null".to_owned())
    })
}

pub async fn handle_mobile_read(
    app: &MobileHostApplication,
    request: MobileReadRequest,
) -> HostResult {
    if !request.caller.has(request.operation.capability()) {
        return Err("The caller is not authorised for this operation.".into());
    }
    let Some(handler) = app.reads.get(&request.operation).cloned() else {
        return Err("Read operation is not available.".into());
    };
    handler(request).await
}

/// `dispatchMobileCommand`: capability, then a registered handler; a handler error is a
/// retryable `command-conflict` carrying the handler's message.
pub async fn dispatch_mobile_command(
    command: MobileCommand,
    handlers: &MobileExecutionHandlers,
) -> Result<Value, MobileProtocolError> {
    use super::protocol::MobileProtocolErrorCode as Code;
    let id = command.command_id.clone();
    if !command.caller.has(command.operation.capability()) {
        return Err(MobileProtocolError::for_command(
            Code::Forbidden,
            "The caller is not authorised for this operation.",
            false,
            &id,
        ));
    }
    let Some(handler) = handlers.get(&command.operation).cloned() else {
        return Err(MobileProtocolError::for_command(
            Code::NotFound,
            format!(
                "No execution handler is registered for {}.",
                command.operation.as_str()
            ),
            false,
            &id,
        ));
    };
    handler(command).await.map_err(|error| {
        MobileProtocolError::for_command(Code::CommandConflict, error.0, true, &id)
    })
}

pub async fn handle_mobile_command(
    app: &MobileHostApplication,
    command: MobileCommand,
) -> HostResult {
    validate_mobile_command(&command)?;
    let digest = (app.payload_digest)(&command);
    let ledger = app.ledger.as_ref();
    let (record, replay) =
        admit_mobile_command(ledger, &command.command_id, &digest, &command.issued_at)?;
    if replay {
        return Ok(record.outcome.unwrap_or(Value::Null));
    }
    let command_id = command.command_id.clone();
    match dispatch_mobile_command(command, &app.commands).await {
        Ok(value) => {
            complete_mobile_command(ledger, &command_id, value.clone(), &now_iso());
            Ok(value)
        }
        Err(error) => {
            mark_mobile_command_unknown(ledger, &command_id, &now_iso());
            Err(error.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::ledger::{InMemoryMobileCommandLedger, MobileCommandState};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn app(calls: Arc<AtomicUsize>) -> MobileHostApplication {
        let mut commands = MobileExecutionHandlers::new();
        commands.insert(
            MobileCommandOperation::SessionsCreate,
            command_handler(move |command: MobileCommand| {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    if command.payload_field("fail").is_some() {
                        return Err("boom".into());
                    }
                    Ok(json!({ "created": true }))
                }
            }),
        );
        let mut reads = MobileHostReads::new();
        reads.insert(
            MobileReadOperation::HostsList,
            read_handler(|_| async { Ok(json!([])) }),
        );
        MobileHostApplication {
            reads,
            commands,
            ledger: Arc::new(InMemoryMobileCommandLedger::default()),
            payload_digest: default_payload_digest(),
        }
    }

    fn command(id: &str, payload: Value) -> MobileCommand {
        serde_json::from_value(json!({
            "protocolVersion": 1, "commandId": id, "issuedAt": "2026-09-22T09:00:00.000Z",
            "caller": { "deviceId": "phone-1", "capabilities": ["view", "execute"] },
            "target": { "hostId": "host", "projectId": "p1" },
            "operation": "sessions.create", "payload": payload
        }))
        .expect("command")
    }

    #[tokio::test]
    async fn a_retried_command_replays_its_outcome_without_running_twice() {
        let calls = Arc::new(AtomicUsize::new(0));
        let app = app(calls.clone());
        let first = handle_mobile_command(&app, command("command-0001", json!({})))
            .await
            .expect("ok");
        let again = handle_mobile_command(&app, command("command-0001", json!({})))
            .await
            .expect("ok");
        assert_eq!(first, again);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let changed = handle_mobile_command(&app, command("command-0001", json!({ "x": 1 })))
            .await
            .expect_err("duplicate");
        assert_eq!(
            changed.0,
            "The command ID was already used with a different payload."
        );
    }

    #[tokio::test]
    async fn a_failed_command_is_marked_unknown_and_its_message_reaches_the_phone() {
        let app = app(Arc::new(AtomicUsize::new(0)));
        let error = handle_mobile_command(&app, command("command-0002", json!({ "fail": 1 })))
            .await
            .expect_err("fails");
        assert_eq!(error.0, "boom");
        assert_eq!(
            app.ledger.get("command-0002").map(|r| r.state),
            Some(MobileCommandState::Unknown)
        );
    }

    #[tokio::test]
    async fn reads_check_capability_and_registration() {
        let app = app(Arc::new(AtomicUsize::new(0)));
        let read = |operation: &str, capabilities: Value| -> MobileReadRequest {
            serde_json::from_value(json!({
                "protocolVersion": 1, "requestId": "r", "operation": operation,
                "caller": { "deviceId": "phone-1", "capabilities": capabilities },
                "target": { "hostId": "host" }
            }))
            .expect("read")
        };
        assert_eq!(
            handle_mobile_read(&app, read("hosts.list", json!(["view"]))).await,
            Ok(json!([]))
        );
        assert_eq!(
            handle_mobile_read(&app, read("hosts.list", json!(["execute"]))).await,
            Err("The caller is not authorised for this operation.".into())
        );
        assert_eq!(
            handle_mobile_read(&app, read("work.list", json!(["view"]))).await,
            Err("Read operation is not available.".into())
        );
    }
}
