//! The phone side of the desktop LAN transport (`packages/mobile-protocol/src/client.ts` port).
//!
//! Independent of any socket type: [`MobileSecureClient::connect`] takes a connector that opens
//! any `AsyncRead + AsyncWrite` stream. It runs the Noise IK handshake (pinning the desktop key),
//! follows the listener's status frames through pairing, correlates request ids with replies,
//! and turns every failure into a [`MobileConnectionError`] that says what went wrong.
//!
//! Where the TS registers `onStatus` / `onEvent` / `onClose` listeners, this hands back one
//! notice receiver from [`MobileSecureClient::new`]. Request ids keep the TS shape
//! `m-<epoch ms base36>-<sequence base36>`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, WriteHalf};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::noise::{CipherState, DHLEN, KeyPair};
use crate::secure_channel::{RecordAssembler, SecureChannel, SecureChannelOptions, frame};
use crate::wire::{
    MobileConnectionError, MobileConnectionErrorCode, MobileConnectionStatus,
    MobileConnectionStatusCode, MobileReplayResult, MobileReplyErrorCode, MobileReplyFrame,
    MobileRequestFrame, MobileRequestKind, MobileServerFrame, MobileTransportFailureCode,
    TransportStage, classify_mobile_transport_failure, mobile_connection_status,
};

pub struct MobileSecureClientOptions {
    /// `address:port`, used only in messages.
    pub endpoint: String,
    pub static_key_pair: KeyPair,
    /// The desktop host key pinned at pairing.
    pub remote_static_public_key: [u8; DHLEN],
    /// Invitation token presented when the desktop does not know this phone yet.
    pub pairing_token_id: Option<String>,
    pub prologue: Option<Vec<u8>>,
    /// TCP connect + handshake + first status, excluding time spent awaiting desktop confirmation.
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    /// A desktop from before status frames never sends one: after the handshake, silence this
    /// long means "ready" (zero disables the fallback).
    pub legacy_ready_after: Duration,
}

impl MobileSecureClientOptions {
    pub fn new(
        endpoint: impl Into<String>,
        static_key_pair: KeyPair,
        remote_static_public_key: [u8; DHLEN],
    ) -> Self {
        Self {
            endpoint: endpoint.into(),
            static_key_pair,
            remote_static_public_key,
            pairing_token_id: None,
            prologue: None,
            connect_timeout: Duration::from_millis(15_000),
            request_timeout: Duration::from_millis(30_000),
            legacy_ready_after: Duration::from_millis(3_000),
        }
    }
}

/// What the TS delivers to its `onStatus`, `onEvent` and `onClose` listeners.
#[derive(Debug, Clone, PartialEq)]
pub enum MobileClientNotice {
    /// Every status frame, including `pairing-pending` while the desktop has not confirmed yet.
    Status(MobileConnectionStatus),
    Event(Map<String, Value>),
    /// Sent once when an established or pending connection ends; not after [`MobileSecureClient::close`].
    Closed(MobileConnectionError),
}

/// A request the desktop answered with an error.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct MobileRequestError {
    pub message: String,
    pub code: Option<MobileReplyErrorCode>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MobileRequestFailure {
    #[error(transparent)]
    Connection(#[from] MobileConnectionError),
    #[error(transparent)]
    Rejected(#[from] MobileRequestError),
}

type ReplySender = oneshot::Sender<Result<Value, MobileRequestFailure>>;

struct Outbound {
    send: CipherState,
    records: mpsc::UnboundedSender<Vec<u8>>,
}

#[derive(Default)]
struct State {
    started: bool,
    closed: bool,
    ready: bool,
    last_status: Option<MobileConnectionStatus>,
    /// `Some` until `connect` has resolved or rejected.
    settle: Option<oneshot::Sender<Result<(), MobileConnectionError>>>,
    pending: HashMap<String, ReplySender>,
    outbound: Option<Outbound>,
    driver: Option<JoinHandle<()>>,
}

struct Shared {
    options: MobileSecureClientOptions,
    notices: mpsc::UnboundedSender<MobileClientNotice>,
    state: Mutex<State>,
    request_sequence: AtomicU64,
}

enum Flow {
    Continue,
    DisarmDeadline,
    Stop,
}

fn not_connected() -> MobileConnectionError {
    MobileConnectionError::transport(
        MobileTransportFailureCode::ConnectionLost,
        "The Praxis desktop is not connected.",
        true,
        None,
    )
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_closed(&self) -> bool {
        self.lock().closed
    }

    fn notify(&self, notice: MobileClientNotice) {
        let _ = self.notices.send(notice);
    }

    /// Ends the connection once: drops the socket, rejects pending requests, then either rejects
    /// `connect` or (when `notify`) reports the close.
    fn fail(&self, error: MobileConnectionError, notify: bool) {
        let (pending, settle) = {
            let mut state = self.lock();
            if state.closed {
                return;
            }
            state.closed = true;
            state.outbound = None;
            (std::mem::take(&mut state.pending), state.settle.take())
        };
        for (_, waiting) in pending {
            let _ = waiting.send(Err(error.clone().into()));
        }
        match settle {
            Some(settle) => {
                let _ = settle.send(Err(error));
            }
            None if notify => self.notify(MobileClientNotice::Closed(error)),
            None => {}
        }
    }

    /// Marks the connection ready; true when this resolved a still-waiting `connect`.
    fn resolve_connect(&self) -> bool {
        let settle = {
            let mut state = self.lock();
            if state.closed {
                return false;
            }
            state.ready = true;
            state.settle.take()
        };
        match settle {
            Some(settle) => {
                let _ = settle.send(Ok(()));
                true
            }
            None => false,
        }
    }

    /// The reason a socket ended: the last terminal status if there was one, otherwise by stage.
    fn closing_error(
        &self,
        stage: TransportStage,
        cause: Option<&dyn std::fmt::Display>,
    ) -> MobileConnectionError {
        match self
            .lock()
            .last_status
            .as_ref()
            .filter(|s| s.code.is_terminal())
        {
            Some(status) => MobileConnectionError::from_status(status),
            None => classify_mobile_transport_failure(stage, &self.options.endpoint, cause, false),
        }
    }

    fn send_frame(&self, request: &MobileRequestFrame) -> Result<(), MobileConnectionError> {
        let mut state = self.lock();
        if state.closed {
            return Err(not_connected());
        }
        let outbound = state.outbound.as_mut().ok_or_else(not_connected)?;
        let plaintext = serde_json::to_vec(request).expect("a request frame always serialises");
        let record = outbound
            .send
            .encrypt_with_ad(&[], &plaintext)
            .map_err(|e| e.to_string())
            .and_then(|ciphertext| frame(&ciphertext).map_err(|e| e.to_string()))
            .map_err(|detail| {
                MobileConnectionError::transport(
                    MobileTransportFailureCode::ProtocolError,
                    "The request could not be encrypted.",
                    true,
                    Some(detail),
                )
            })?;
        outbound.records.send(record).map_err(|_| not_connected())
    }

    fn on_status(&self, status: MobileConnectionStatus) -> Flow {
        self.lock().last_status = Some(status.clone());
        self.notify(MobileClientNotice::Status(status.clone()));
        if status.code.is_terminal() {
            self.fail(MobileConnectionError::from_status(&status), true);
            return Flow::Stop;
        }
        match status.code {
            MobileConnectionStatusCode::Ready => {
                self.resolve_connect();
                Flow::DisarmDeadline
            }
            MobileConnectionStatusCode::PairingRequired => {
                let token = self
                    .options
                    .pairing_token_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty());
                let Some(token) = token else {
                    self.fail(MobileConnectionError::from_status(&status), true);
                    return Flow::Stop;
                };
                let pair = MobileRequestFrame {
                    id: "pair".into(),
                    kind: MobileRequestKind::Pair,
                    payload: json!({ "tokenId": token }),
                };
                match self.send_frame(&pair) {
                    Ok(()) => Flow::Continue,
                    Err(error) => {
                        self.fail(error, true);
                        Flow::Stop
                    }
                }
            }
            // pairing-pending: someone has to act on the desktop, so no deadline applies.
            _ => Flow::DisarmDeadline,
        }
    }

    fn on_reply(&self, reply: MobileReplyFrame) -> Flow {
        let message = reply.error.filter(|e| !e.is_empty());
        if reply.id == "pair" {
            if reply.ok {
                return Flow::Continue;
            }
            self.fail(
                MobileConnectionError {
                    code: MobileConnectionErrorCode::Status(
                        MobileConnectionStatusCode::InvitationInvalid,
                    ),
                    message: message
                        .unwrap_or_else(|| "The desktop refused the pairing invitation.".into()),
                    retryable: false,
                    detail: None,
                },
                true,
            );
            return Flow::Stop;
        }
        let Some(waiting) = self.lock().pending.remove(&reply.id) else {
            return Flow::Continue;
        };
        let outcome = if reply.ok {
            Ok(reply.value.unwrap_or(Value::Null))
        } else {
            Err(MobileRequestError {
                message: message.unwrap_or_else(|| "The desktop rejected the request.".into()),
                code: reply.code,
            }
            .into())
        };
        let _ = waiting.send(outcome);
        Flow::Continue
    }
}

async fn sleep_until_some(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

async fn write_records<S: AsyncWrite>(
    mut writer: WriteHalf<S>,
    mut records: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    while let Some(record) = records.recv().await {
        if writer.write_all(&record).await.is_err() {
            break;
        }
    }
    let _ = writer.shutdown().await;
}

async fn drive<C, Fut, S>(shared: Arc<Shared>, connector: C)
where
    C: FnOnce() -> Fut,
    Fut: Future<Output = std::io::Result<S>>,
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let options = &shared.options;
    let endpoint = options.endpoint.as_str();
    let mut stage = TransportStage::Connect;
    let mut deadline = Some(Instant::now() + options.connect_timeout);
    let timed_out = |stage| classify_mobile_transport_failure(stage, endpoint, None, true);

    let stream = tokio::select! {
        stream = connector() => stream,
        () = sleep_until_some(deadline) => return shared.fail(timed_out(stage), true),
    };
    let stream = match stream {
        Ok(stream) => stream,
        Err(error) => {
            return shared.fail(
                classify_mobile_transport_failure(stage, endpoint, Some(&error), false),
                true,
            );
        }
    };
    if shared.is_closed() {
        return;
    }
    stage = TransportStage::Handshake;
    let (mut reader, mut writer) = tokio::io::split(stream);

    let mut channel_options = SecureChannelOptions::new(options.static_key_pair.clone());
    channel_options.remote_static_public_key = Some(options.remote_static_public_key);
    channel_options.prologue = options.prologue.clone();
    let hello = SecureChannel::initiator(channel_options)
        .and_then(|mut channel| Ok((channel.next_handshake_message(&[])?, channel)));
    let (hello, channel) = match hello {
        Ok(started) => started,
        Err(error) => {
            let error = MobileConnectionError::transport(
                MobileTransportFailureCode::ProtocolError,
                "The secure handshake could not start.",
                false,
                Some(error.to_string()),
            );
            return shared.fail(error, true);
        }
    };
    let written = tokio::select! {
        written = writer.write_all(&hello) => written,
        () = sleep_until_some(deadline) => return shared.fail(timed_out(stage), true),
    };
    if let Err(error) = written {
        return shared.fail(shared.closing_error(stage, Some(&error)), true);
    }

    let mut channel = Some(channel);
    let mut writer = Some(writer);
    let mut receive: Option<CipherState> = None;
    let mut legacy: Option<Instant> = None;
    let mut assembler = RecordAssembler::new();
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        let read = tokio::select! {
            read = reader.read(&mut buffer) => read,
            () = sleep_until_some(deadline) => return shared.fail(timed_out(stage), true),
            () = sleep_until_some(legacy) => {
                legacy = None;
                if shared.resolve_connect() {
                    deadline = None;
                }
                continue;
            }
        };
        let count = match read {
            Ok(0) => return shared.fail(shared.closing_error(stage, None), true),
            Ok(count) => count,
            Err(error) => return shared.fail(shared.closing_error(stage, Some(&error)), true),
        };
        let records = match assembler.push(&buffer[..count]) {
            Ok(records) => records,
            Err(error) => {
                let error = MobileConnectionError::transport(
                    MobileTransportFailureCode::ProtocolError,
                    "The desktop sent a malformed record.",
                    true,
                    Some(error.to_string()),
                );
                return shared.fail(error, true);
            }
        };
        for record in records {
            if shared.is_closed() {
                return;
            }
            if let Some(handshake) = channel.as_mut() {
                if let Err(error) = handshake.read_handshake_message(&record) {
                    let error = MobileConnectionError::transport(
                        MobileTransportFailureCode::HandshakeFailed,
                        "The desktop’s identity did not match the host key this phone pinned. If the desktop reset its key, scan a new pairing invitation.",
                        false,
                        Some(error.to_string()),
                    );
                    return shared.fail(error, true);
                }
                if handshake.is_open() {
                    stage = TransportStage::Session;
                    let Some(Ok((send, recv))) = channel.take().map(SecureChannel::into_ciphers)
                    else {
                        return;
                    };
                    receive = Some(recv);
                    let (records, outgoing) = mpsc::unbounded_channel();
                    if let Some(writer) = writer.take() {
                        tokio::spawn(write_records(writer, outgoing));
                    }
                    shared.lock().outbound = Some(Outbound { send, records });
                    if !options.legacy_ready_after.is_zero() {
                        legacy = Some(Instant::now() + options.legacy_ready_after);
                    }
                }
                continue;
            }
            let Some(receive) = receive.as_mut() else {
                continue;
            };
            let decoded = receive
                .decrypt_with_ad(&[], &record)
                .map_err(|e| e.to_string())
                .and_then(|plaintext| {
                    MobileServerFrame::decode(&plaintext).map_err(|e| e.to_string())
                });
            let flow = match decoded {
                Err(detail) => {
                    let error = MobileConnectionError::transport(
                        MobileTransportFailureCode::ProtocolError,
                        "A message from the desktop could not be decrypted.",
                        true,
                        Some(detail),
                    );
                    return shared.fail(error, true);
                }
                Ok(None) => Flow::Continue,
                Ok(Some(MobileServerFrame::Status(frame))) => {
                    legacy = None;
                    shared.on_status(mobile_connection_status(
                        frame.status.code,
                        Some(&frame.status.message),
                    ))
                }
                Ok(Some(MobileServerFrame::Event(frame))) => {
                    shared.notify(MobileClientNotice::Event(frame.envelope));
                    Flow::Continue
                }
                Ok(Some(MobileServerFrame::Reply(reply))) => shared.on_reply(reply),
            };
            match flow {
                Flow::Continue => {}
                Flow::DisarmDeadline => deadline = None,
                Flow::Stop => return,
            }
        }
    }
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).expect("base36 digits are ASCII")
}

/// One phone-to-desktop connection. Cheap to clone; every clone drives the same connection.
#[derive(Clone)]
pub struct MobileSecureClient {
    shared: Arc<Shared>,
}

impl MobileSecureClient {
    pub fn new(
        options: MobileSecureClientOptions,
    ) -> (Self, mpsc::UnboundedReceiver<MobileClientNotice>) {
        let (notices, receiver) = mpsc::unbounded_channel();
        let shared = Shared {
            options,
            notices,
            state: Mutex::new(State::default()),
            request_sequence: AtomicU64::new(0),
        };
        (
            Self {
                shared: Arc::new(shared),
            },
            receiver,
        )
    }

    pub fn is_ready(&self) -> bool {
        let state = self.shared.lock();
        state.ready && !state.closed
    }

    pub fn status(&self) -> Option<MobileConnectionStatus> {
        self.shared.lock().last_status.clone()
    }

    /// Opens the stream through `connector` and resolves once the desktop reports `ready`.
    /// May be called once.
    pub async fn connect<C, Fut, S>(&self, connector: C) -> Result<(), MobileConnectionError>
    where
        C: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = std::io::Result<S>> + Send + 'static,
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let (settle, settled) = oneshot::channel();
        {
            let mut state = self.shared.lock();
            if state.started {
                return Err(MobileConnectionError::transport(
                    MobileTransportFailureCode::ProtocolError,
                    "MobileSecureClient.connect() may only be called once.",
                    false,
                    None,
                ));
            }
            state.started = true;
            if state.closed {
                return Err(not_connected());
            }
            state.settle = Some(settle);
        }
        let driver = tokio::spawn(drive(self.shared.clone(), connector));
        self.shared.lock().driver = Some(driver);
        settled.await.unwrap_or_else(|_| Err(not_connected()))
    }

    pub async fn request(
        &self,
        kind: MobileRequestKind,
        payload: Value,
    ) -> Result<Value, MobileRequestFailure> {
        if !self.is_ready() {
            return Err(not_connected().into());
        }
        let sequence = self.shared.request_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or_default();
        let id = format!("m-{}-{}", base36(now), base36(sequence));
        let (reply, replied) = oneshot::channel();
        self.shared.lock().pending.insert(id.clone(), reply);
        let request = MobileRequestFrame {
            id: id.clone(),
            kind,
            payload,
        };
        if let Err(error) = self.shared.send_frame(&request) {
            self.shared.lock().pending.remove(&id);
            return Err(error.into());
        }
        match tokio::time::timeout(self.shared.options.request_timeout, replied).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err(not_connected().into()),
            Err(_) => {
                self.shared.lock().pending.remove(&id);
                let error = MobileConnectionError::transport(
                    MobileTransportFailureCode::TimedOut,
                    "The Praxis desktop did not answer in time.",
                    true,
                    None,
                );
                Err(error.into())
            }
        }
    }

    pub async fn read(&self, request: Value) -> Result<Value, MobileRequestFailure> {
        self.request(MobileRequestKind::Read, request).await
    }

    pub async fn command(&self, command: Value) -> Result<Value, MobileRequestFailure> {
        self.request(MobileRequestKind::Command, command).await
    }

    /// Asks the desktop to stream every retained event after `after_sequence`.
    pub async fn replay(
        &self,
        after_sequence: u64,
    ) -> Result<MobileReplayResult, MobileRequestFailure> {
        let value = self
            .request(
                MobileRequestKind::Replay,
                json!({ "afterSequence": after_sequence }),
            )
            .await?;
        serde_json::from_value(value).map_err(|error| {
            MobileConnectionError::transport(
                MobileTransportFailureCode::ProtocolError,
                "The desktop sent a malformed replay result.",
                true,
                Some(error.to_string()),
            )
            .into()
        })
    }

    /// Closes without a [`MobileClientNotice::Closed`] (the caller chose to close).
    pub fn close(&self) {
        let (started, driver) = {
            let mut state = self.shared.lock();
            (state.started, state.driver.take())
        };
        if started {
            let error = MobileConnectionError::transport(
                MobileTransportFailureCode::ConnectionLost,
                "The connection was closed on this phone.",
                true,
                None,
            );
            self.shared.fail(error, false);
        } else {
            self.shared.lock().closed = true;
        }
        if let Some(driver) = driver {
            driver.abort();
        }
    }
}

#[cfg(test)]
mod tests;
