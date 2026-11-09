//! Outbound Ed25519 relay registration and bounded WebSocket/byte-stream adaptation.
//! The Noise responder receives the resulting stream exactly as it receives a LAN socket.

use super::identity::MobileRelayIdentity;
use super::lan_server::MobileTransportLog;
use crate::relay::{RELAY_SIGNATURE_CONTEXT, channel_id_for_key, hex};
use ed25519_dalek::Signer;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::sync::{Mutex, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{Instant, timeout};
use tokio_tungstenite::{
    WebSocketStream, connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use url::Url;

pub fn is_allowed_relay_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "wss"
        || (url.scheme() == "ws"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MobileRelayState {
    Stopped,
    Connecting,
    Registered,
    Error,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MobileRelaySnapshot {
    pub state: MobileRelayState,
    pub channel: Option<String>,
    pub error: Option<String>,
}
impl Default for MobileRelaySnapshot {
    fn default() -> Self {
        Self {
            state: MobileRelayState::Stopped,
            channel: None,
            error: None,
        }
    }
}
pub struct MobileRelayClientOptions {
    pub relay_url: String,
    pub identity: MobileRelayIdentity,
    pub on_stream: Arc<dyn Fn(DuplexStream) + Send + Sync>,
    pub on_log: Option<MobileTransportLog>,
    pub min_backoff: Duration,
    pub max_backoff: Duration,
    pub connect_timeout: Duration,
}
impl MobileRelayClientOptions {
    pub fn new(
        relay_url: String,
        identity: MobileRelayIdentity,
        on_stream: Arc<dyn Fn(DuplexStream) + Send + Sync>,
    ) -> Self {
        Self {
            relay_url,
            identity,
            on_stream,
            on_log: None,
            min_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(10),
        }
    }
}
struct Running {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}
pub struct MobileRelayClient {
    options: Arc<MobileRelayClientOptions>,
    state: watch::Sender<MobileRelaySnapshot>,
    running: Mutex<Option<Running>>,
}
impl MobileRelayClient {
    pub fn new(options: MobileRelayClientOptions) -> Result<Self, String> {
        if !is_allowed_relay_url(&options.relay_url) {
            return Err("A relay URL must use wss:, or ws: on this machine only.".into());
        }
        let (state, _) = watch::channel(MobileRelaySnapshot::default());
        Ok(Self {
            options: Arc::new(options),
            state,
            running: Mutex::new(None),
        })
    }
    pub fn snapshot(&self) -> MobileRelaySnapshot {
        self.state.borrow().clone()
    }
    pub fn subscribe(&self) -> watch::Receiver<MobileRelaySnapshot> {
        self.state.subscribe()
    }
    pub async fn start(&self) {
        let mut running = self.running.lock().await;
        if running.as_ref().is_some_and(|run| !run.task.is_finished()) {
            return;
        }
        let (stop, stopping) = watch::channel(false);
        let options = self.options.clone();
        let state = self.state.clone();
        let task = tokio::spawn(run(options, state, stopping));
        *running = Some(Running { stop, task });
    }
    pub async fn stop(&self) {
        let mut running = self.running.lock().await;
        if let Some(run) = running.take() {
            let _ = run.stop.send(true);
            let _ = run.task.await;
        }
        self.state.send_replace(MobileRelaySnapshot::default());
    }
}
impl Drop for MobileRelayClient {
    fn drop(&mut self) {
        if let Some(run) = self.running.get_mut().take() {
            let _ = run.stop.send(true);
        }
    }
}
fn endpoint(base: &str, route: &str, params: &[(&str, &str)]) -> Result<String, String> {
    let mut url =
        Url::parse(&format!("{}{route}", base.trim_end_matches('/'))).map_err(|e| e.to_string())?;
    url.query_pairs_mut().extend_pairs(params.iter().copied());
    Ok(url.into())
}
async fn run(
    options: Arc<MobileRelayClientOptions>,
    state: watch::Sender<MobileRelaySnapshot>,
    mut stopping: watch::Receiver<bool>,
) {
    let mut attempt = 0u32;
    loop {
        state.send_modify(|state| {
            state.state = MobileRelayState::Connecting;
            state.channel = None;
        });
        let result = tokio::select! {
            biased;
            _ = stopping.changed() => break,
            result = session(&options, &state) => result,
        };
        // A successful registration resets the reconnect backoff even if the relay later closes.
        if state.borrow().state == MobileRelayState::Registered {
            attempt = 0;
        }
        state.send_replace(MobileRelaySnapshot {
            state: MobileRelayState::Error,
            channel: None,
            error: Some(
                result
                    .err()
                    .unwrap_or_else(|| "The relay closed the connection.".into()),
            ),
        });
        if let Some(log) = &options.on_log {
            log("[mobile] relay connection lost; retrying.");
        }
        let min = options.min_backoff.max(Duration::from_millis(1));
        let max = options.max_backoff.max(min);
        let delay = min
            .saturating_mul(2u32.saturating_pow(attempt.min(31)))
            .min(max);
        attempt = attempt.saturating_add(1);
        tokio::select! { biased; _ = stopping.changed() => break, _ = tokio::time::sleep(delay) => {} }
    }
    state.send_replace(MobileRelaySnapshot::default());
}
async fn session(
    options: &MobileRelayClientOptions,
    state: &watch::Sender<MobileRelaySnapshot>,
) -> Result<(), String> {
    let url = endpoint(
        &options.relay_url,
        "/v1/host",
        &[("key", &options.identity.public_key_hex)],
    )?;
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(64 * 1024);
    config.max_frame_size = Some(64 * 1024);
    let (mut control, _) = timeout(
        options.connect_timeout,
        connect_async_with_config(url, Some(config), false),
    )
    .await
    .map_err(|_| "Relay connection timed out.".to_owned())?
    .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + options.connect_timeout;
    let mut registered = false;
    let mut streams = JoinSet::new();
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline), if !registered => return Err("Relay registration timed out.".into()),
            _ = streams.join_next(), if !streams.is_empty() => {},
            message = control.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue; };
                        match value["type"].as_str() {
                            Some("challenge") => if let Some(nonce) = value["nonce"].as_str() {
                                let signature = options.identity.signing_key.sign(format!("{RELAY_SIGNATURE_CONTEXT}{nonce}").as_bytes());
                                control.send(Message::Text(json!({"type": "auth", "signature": hex(&signature.to_bytes())}).to_string().into())).await.map_err(|e| e.to_string())?;
                            },
                            Some("registered") => if let Some(channel) = value["channel"].as_str() {
                                if channel_id_for_key(&options.identity.public_key_hex).as_deref() != Some(channel) { return Err("The relay registered an unexpected channel.".into()); }
                                registered = true;
                                state.send_replace(MobileRelaySnapshot { state: MobileRelayState::Registered, channel: Some(channel.into()), error: None });
                                if let Some(log) = &options.on_log { log("[mobile] registered with the relay."); }
                            },
                            Some("incoming") if registered && streams.len() < 128 => if let Some(conn) = value["conn"].as_str() {
                                let channel = state.borrow().channel.clone().ok_or("Missing relay channel.")?;
                                let url = endpoint(&options.relay_url, "/v1/accept", &[("channel", &channel), ("conn", conn)])?;
                                let on_stream = options.on_stream.clone(); let connect_timeout = options.connect_timeout;
                                streams.spawn(async move {
                                    let mut config = WebSocketConfig::default(); config.max_message_size = Some((1 << 20) + 1024);
                                    if let Ok(Ok((websocket, _))) = timeout(connect_timeout, connect_async_with_config(url, Some(config), false)).await {
                                        let (stream, bridge) = tokio::io::duplex(64 * 1024);
                                        on_stream(stream);
                                        let _ = run_relay_stream(websocket, bridge).await;
                                    }
                                });
                            },
                            _ => {},
                        }
                    }
                    Some(Ok(Message::Ping(bytes))) => control.send(Message::Pong(bytes)).await.map_err(|e| e.to_string())?,
                    Some(Ok(Message::Close(_))) | None => return Err("The relay closed the connection.".into()),
                    Some(Err(error)) => return Err(error.to_string()),
                    _ => {},
                }
            }
        }
    }
}
/// Bounded WebSocket-to-stream pump. A caller owns this future so stopping it closes both ends.
/// Message boundaries carry no meaning: the Noise record assembler reconstructs the byte stream.
pub async fn run_relay_stream<S>(
    websocket: WebSocketStream<S>,
    stream: DuplexStream,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut source) = websocket.split();
    let (mut reader, mut writer) = tokio::io::split(stream);
    let incoming = async {
        while let Some(message) = source.next().await {
            match message.map_err(|e| e.to_string())? {
                Message::Binary(bytes) => {
                    writer.write_all(&bytes).await.map_err(|e| e.to_string())?
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        Ok::<_, String>(())
    };
    let outgoing = async {
        let mut buffer = [0; 16384];
        loop {
            let count = reader.read(&mut buffer).await.map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            sink.send(Message::Binary(buffer[..count].to_vec().into()))
                .await
                .map_err(|e| e.to_string())?;
        }
        let _ = sink.close().await;
        Ok::<_, String>(())
    };
    tokio::select! { result = incoming => result, result = outgoing => result }
}
#[cfg(test)]
mod tests;
