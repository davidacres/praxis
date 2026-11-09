use super::*;
#[test]
fn relay_urls_require_tls_except_loopback() {
    for url in [
        "wss://relay.example",
        "ws://localhost:9000",
        "ws://127.0.0.1:9000",
        "ws://[::1]:9000",
    ] {
        assert!(is_allowed_relay_url(url), "{url}");
    }
    for url in [
        "ws://relay.example",
        "http://localhost",
        "garbage",
        "ws://localhost.evil",
    ] {
        assert!(!is_allowed_relay_url(url), "{url}");
    }
}

use super::super::access::{MobileAccessMode, MobileAccessPolicy, MobilePeerContext};
use super::super::lan_server::tests::{app, closed, grant, phone, read};
use super::super::lan_server::{MobileLanServer, MobileLanServerDeps};
use crate::MobileSecureClient;
use crate::noise::KeyPair;
use crate::relay::{RelayServer, RelayServerOptions};
use crate::wire::{MobileConnectionStatusCode, mobile_connection_status};
use tokio_tungstenite::connect_async;

async fn registered(client: &MobileRelayClient) -> String {
    let mut state = client.subscribe();
    timeout(Duration::from_secs(3), async {
        loop {
            if let Some(channel) = state.borrow().channel.clone() {
                return channel;
            }
            state.changed().await.expect("state");
        }
    })
    .await
    .expect("registered")
}
async fn relay_phone(
    port: u16,
    channel: String,
    key: &KeyPair,
) -> (
    MobileSecureClient,
    tokio::sync::mpsc::UnboundedReceiver<crate::MobileClientNotice>,
) {
    let (phone, notices) = phone(key);
    phone
        .connect(move || async move {
            let (ws, _) = connect_async(format!(
                "ws://127.0.0.1:{port}/v1/connect?channel={channel}"
            ))
            .await
            .map_err(std::io::Error::other)?;
            let (stream, bridge) = tokio::io::duplex(65536);
            tokio::spawn(async move {
                let _ = run_relay_stream(ws, bridge).await;
            });
            Ok(stream)
        })
        .await
        .expect("relay phone");
    (phone, notices)
}
async fn fixture(
    mode: MobileAccessMode,
) -> (RelayServer, MobileRelayClient, MobileLanServer, KeyPair) {
    let relay = RelayServer::start(RelayServerOptions {
        address: Some("127.0.0.1:0".parse().expect("address")),
        ..RelayServerOptions::default()
    })
    .await
    .expect("relay");
    let host = KeyPair::generate();
    let mut deps = MobileLanServerDeps::new(app(), host.clone());
    deps.authorize_peer = Some(Arc::new(|_| Some(grant())));
    let server = MobileLanServer::new(deps);
    server.apply_policy(MobileAccessPolicy::with_mode(mode), false);
    let serving = server.clone();
    let mut options = MobileRelayClientOptions::new(
        format!("ws://127.0.0.1:{}", relay.port()),
        MobileRelayIdentity::generate(),
        Arc::new(move |stream| {
            serving.accept_stream(
                stream,
                MobilePeerContext {
                    remote_address: "relay".into(),
                    relay_route: true,
                    ..MobilePeerContext::default()
                },
            );
        }),
    );
    options.min_backoff = Duration::from_millis(30);
    options.max_backoff = Duration::from_millis(100);
    let client = MobileRelayClient::new(options).expect("client");
    client.start().await;
    registered(&client).await;
    (relay, client, server, host)
}
#[tokio::test]
async fn registers_by_signature_and_serves_noise_over_outbound_relay_streams() {
    let (mut relay, client, server, host) = fixture(MobileAccessMode::Internet).await;
    assert!(
        server.port().await.is_none(),
        "no inbound listener required"
    );
    let channel = registered(&client).await;
    let (phone, _) = relay_phone(relay.port(), channel, &host).await;
    let value = phone
        .read(read("work.list", Some("p1")))
        .await
        .expect("read");
    assert_eq!(value["deviceId"], "paired-phone");
    assert!(phone.read(read("work.list", Some("p2"))).await.is_err());
    phone.close();
    client.stop().await;
    server.stop().await;
    relay.stop();
    assert_eq!(client.snapshot().state, MobileRelayState::Stopped);
}
#[tokio::test]
async fn local_only_and_off_refuse_relay_streams_after_the_noise_handshake() {
    for mode in [MobileAccessMode::LocalOnly, MobileAccessMode::Off] {
        let (mut relay, client, server, host) = fixture(mode).await;
        let channel = registered(&client).await;
        let (phone, _) = phone(&host);
        let port = relay.port();
        let result = phone
            .connect(move || async move {
                let (ws, _) = connect_async(format!(
                    "ws://127.0.0.1:{port}/v1/connect?channel={channel}"
                ))
                .await
                .map_err(std::io::Error::other)?;
                let (stream, bridge) = tokio::io::duplex(65536);
                tokio::spawn(async move {
                    let _ = run_relay_stream(ws, bridge).await;
                });
                Ok(stream)
            })
            .await;
        assert!(result.is_err());
        assert_eq!(
            phone.status().expect("status").code,
            if mode == MobileAccessMode::Off {
                MobileConnectionStatusCode::AccessDisabled
            } else {
                MobileConnectionStatusCode::AccessDenied
            }
        );
        client.stop().await;
        server.stop().await;
        relay.stop();
    }
}
#[tokio::test]
async fn stopping_the_relay_and_revoking_a_device_close_established_phones() {
    let (mut relay, client, server, host) = fixture(MobileAccessMode::Internet).await;
    let channel = registered(&client).await;
    let (phone1, mut notices1) = relay_phone(relay.port(), channel.clone(), &host).await;
    assert_eq!(
        server.drop_device(
            "paired-phone",
            mobile_connection_status(MobileConnectionStatusCode::DeviceRevoked, None)
        ),
        1
    );
    closed(&mut notices1).await;
    assert!(!phone1.is_ready());
    let (phone2, mut notices2) = relay_phone(relay.port(), channel, &host).await;
    client.stop().await;
    closed(&mut notices2).await;
    assert!(!phone2.is_ready());
    server.stop().await;
    relay.stop();
}
#[tokio::test]
async fn re_registers_after_relay_restart_and_stop_cancels_backoff() {
    let (mut relay, client, server, _) = fixture(MobileAccessMode::Internet).await;
    let port = relay.port();
    let original = registered(&client).await;
    let mut state = client.subscribe();
    relay.stop();
    timeout(Duration::from_secs(3), async {
        loop {
            if state.borrow().channel.is_none() {
                break;
            }
            state.changed().await.expect("state");
        }
    })
    .await
    .expect("lost registration");
    // The old listener task has been aborted; wait for its socket to leave the runtime.
    tokio::task::yield_now().await;
    let mut relay = RelayServer::start(RelayServerOptions {
        address: Some(([127, 0, 0, 1], port).into()),
        ..RelayServerOptions::default()
    })
    .await
    .expect("restart");
    assert_eq!(registered(&client).await, original);
    relay.stop();
    client.stop().await;
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(client.snapshot().state, MobileRelayState::Stopped);
    server.stop().await;
}
