//! Drives the real fixture agent (`@agentclientprotocol/sdk` over stdio) through
//! [`AcpConnection`]: the same wire the e2e specs use, with no mock in between.

use std::path::PathBuf;
use std::time::Duration;

use praxis_ai::acp::connection::{AcpConnection, AcpSpawn, Incoming};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::timeout;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/praxis-desktop/e2e/fixtures")
        .join(name)
}

async fn start(
    name: &str,
    env: Vec<(String, String)>,
) -> (AcpConnection, UnboundedReceiver<Incoming>) {
    let script = fixture(name);
    AcpConnection::spawn(AcpSpawn {
        command: "node".into(),
        args: vec![script.to_string_lossy().into_owned()],
        cwd: None,
        env,
    })
    .await
    .expect("node must be installed to run the ACP fixture agents")
}

/// Collects the agent text streamed for one prompt, until the prompt reply arrives.
async fn prompt(
    connection: &AcpConnection,
    updates: &mut UnboundedReceiver<Incoming>,
    session: &str,
    text: &str,
) -> (Value, String) {
    let reply = connection.request(
        "session/prompt",
        json!({ "sessionId": session, "prompt": [{ "type": "text", "text": text }] }),
    );
    tokio::pin!(reply);
    let mut streamed = String::new();
    loop {
        tokio::select! {
            outcome = &mut reply => {
                // Updates sent before the reply are already queued.
                while let Ok(Incoming::Notification { params, .. }) = updates.try_recv() {
                    streamed.push_str(params["update"]["content"]["text"].as_str().unwrap_or_default());
                }
                return (outcome.expect("prompt reply"), streamed);
            }
            Some(message) = updates.recv() => {
                if let Incoming::Notification { method, params } = message {
                    assert_eq!(method, "session/update");
                    streamed.push_str(params["update"]["content"]["text"].as_str().unwrap_or_default());
                }
            }
        }
    }
}

#[tokio::test]
async fn completes_a_turn_with_a_real_acp_agent() {
    let (connection, mut updates) = start("fakeAcpAgent.mjs", vec![]).await;
    let init = timeout(
        Duration::from_secs(20),
        connection.request(
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": {} }),
        ),
    )
    .await
    .expect("initialize in time")
    .expect("initialize");
    assert_eq!(init["protocolVersion"], 1);
    let session = connection
        .request(
            "session/new",
            json!({ "cwd": std::env::temp_dir(), "mcpServers": [] }),
        )
        .await
        .expect("session/new");
    assert_eq!(session["modes"]["currentModeId"], "ask");
    let id = session["sessionId"]
        .as_str()
        .expect("session id")
        .to_owned();

    let (reply, text) = timeout(
        Duration::from_secs(20),
        prompt(&connection, &mut updates, &id, "Say hello via ACP"),
    )
    .await
    .expect("prompt in time");
    assert_eq!(reply["stopReason"], "end_turn");
    assert!(
        text.contains("Hello from the fake ACP agent"),
        "streamed: {text:?}"
    );

    // Switching mode is a request that the agent confirms with a notification.
    connection
        .request(
            "session/set_mode",
            json!({ "sessionId": id, "modeId": "code" }),
        )
        .await
        .expect("set_mode");
    let confirmed = timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Incoming::Notification { params, .. }) = updates.recv().await
                && params["update"]["sessionUpdate"] == "current_mode_update"
            {
                return params["update"]["currentModeId"].clone();
            }
        }
    })
    .await
    .expect("mode confirmation");
    assert_eq!(confirmed, "code");
    connection.shutdown().await;
}

#[tokio::test]
async fn surfaces_the_agents_permission_request_and_honours_the_answer() {
    let (connection, mut updates) = start("fakeAcpAgent.mjs", vec![]).await;
    connection
        .request(
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": {} }),
        )
        .await
        .expect("initialize");
    let id = connection
        .request(
            "session/new",
            json!({ "cwd": std::env::temp_dir(), "mcpServers": [] }),
        )
        .await
        .expect("new")["sessionId"]
        .as_str()
        .expect("id")
        .to_owned();

    let connection = std::sync::Arc::new(connection);
    let asking = {
        let connection = std::sync::Arc::clone(&connection);
        let id = id.clone();
        tokio::spawn(async move {
            connection.request("session/prompt", json!({ "sessionId": id, "prompt": [{ "type": "text", "text": "PERMISSION_KIND_MATRIX" }] })).await
        })
    };

    // The agent asks eight permission questions; cancel every one (the options offer no rejection).
    let mut asked = 0;
    while asked < 8 {
        let message = timeout(Duration::from_secs(10), updates.recv())
            .await
            .expect("a request arrives")
            .expect("open");
        if let Incoming::Request {
            id: request_id,
            method,
            params,
        } = message
        {
            assert_eq!(method, "session/request_permission");
            assert!(params["toolCall"]["toolCallId"].as_str().is_some());
            connection
                .respond(
                    &request_id,
                    json!({ "outcome": { "outcome": "cancelled" } }),
                )
                .await
                .expect("respond");
            asked += 1;
        }
    }
    let reply = asking.await.expect("join").expect("prompt reply");
    assert_eq!(reply["stopReason"], "end_turn");
    connection.shutdown().await;
}

#[tokio::test]
async fn reports_a_closed_agent_instead_of_hanging() {
    let (connection, mut updates) = start("fakeAcpAgent.mjs", vec![]).await;
    connection.shutdown().await;
    let closed = timeout(Duration::from_secs(5), async {
        loop {
            if matches!(updates.recv().await, Some(Incoming::Closed) | None) {
                return true;
            }
        }
    })
    .await
    .expect("close is observed");
    assert!(closed);
    assert!(
        connection.request("initialize", json!({})).await.is_err(),
        "requests on a closed connection fail fast"
    );
}
