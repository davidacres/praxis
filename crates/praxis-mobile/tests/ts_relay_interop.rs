//! Relay authentication interop with `@praxis/mobile-relay`.
//!
//! `fixtures/ts_relay_vectors.json` came from the compiled TypeScript: a fixed Ed25519 key, a
//! nonce, Node's signature over `RELAY_SIGNATURE_CONTEXT + nonce`, `channelIdForKey`, the close
//! codes and the default limits.

use std::time::Duration;

use praxis_mobile::relay::{
    RELAY_PROTOCOL_VERSION, RELAY_SIGNATURE_CONTEXT, RelayLimits, channel_id_for_key, close_code,
    verify_host_signature,
};
use serde_json::Value;

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is a string"))
}

fn vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/ts_relay_vectors.json"))
        .expect("vector file is JSON")
}

#[test]
fn a_node_signature_verifies_and_the_channel_id_matches() {
    let v = vectors();
    let (key, nonce, signature) = (s(&v, "publicKeyHex"), s(&v, "nonce"), s(&v, "signature"));
    assert!(verify_host_signature(key, nonce, signature));
    assert_eq!(channel_id_for_key(key).as_deref(), Some(s(&v, "channelId")));

    // Ed25519 is deterministic: the same seed signs the same bytes in Rust.
    let seed: [u8; 32] = unhex(s(&v, "seed")).try_into().expect("seed");
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let ours = ed25519_dalek::Signer::sign(
        &signing,
        format!("{RELAY_SIGNATURE_CONTEXT}{nonce}").as_bytes(),
    );
    assert_eq!(ours.to_bytes().to_vec(), unhex(signature));

    let mut tampered = unhex(signature);
    tampered[0] ^= 1;
    let tampered: String = tampered.iter().map(|b| format!("{b:02x}")).collect();
    assert!(!verify_host_signature(key, nonce, &tampered));
    assert!(!verify_host_signature(
        key,
        &nonce.replace('9', "8"),
        signature
    ));
    assert!(!verify_host_signature(key, nonce, "not-hex"));
}

#[test]
fn constants_and_default_limits_match_the_typescript() {
    let v = vectors();
    assert_eq!(s(&v, "context"), RELAY_SIGNATURE_CONTEXT);
    assert_eq!(v["version"], RELAY_PROTOCOL_VERSION);
    let codes = &v["closeCodes"];
    for (name, ours) in [
        ("badRequest", close_code::BAD_REQUEST),
        ("authFailed", close_code::AUTH_FAILED),
        ("hostOffline", close_code::HOST_OFFLINE),
        ("waitTimeout", close_code::WAIT_TIMEOUT),
        ("replaced", close_code::REPLACED),
        ("tooManyPeers", close_code::TOO_MANY_PEERS),
        ("rateLimited", close_code::RATE_LIMITED),
        ("serverBusy", close_code::SERVER_BUSY),
    ] {
        assert_eq!(codes[name].as_u64(), Some(u64::from(ours)), "{name}");
    }
    let d = &v["defaults"];
    let limits = RelayLimits::default();
    let ms = |key: &str| Duration::from_millis(d[key].as_u64().expect("ms"));
    let n = |key: &str| d[key].as_u64().expect("count") as usize;
    assert_eq!(limits.max_channels, n("maxChannels"));
    assert_eq!(limits.max_devices_per_channel, n("maxDevicesPerChannel"));
    assert_eq!(limits.max_pending_per_channel, n("maxPendingPerChannel"));
    assert_eq!(limits.max_sockets_per_address, n("maxSocketsPerAddress"));
    assert_eq!(limits.max_connects_per_minute, n("maxConnectsPerMinute"));
    assert_eq!(limits.max_message_bytes, n("maxMessageBytes"));
    assert_eq!(limits.max_buffered_bytes, n("maxBufferedBytes"));
    assert_eq!(limits.auth_timeout, ms("authTimeoutMs"));
    assert_eq!(limits.accept_timeout, ms("acceptTimeoutMs"));
    assert_eq!(limits.heartbeat, ms("heartbeatMs"));
    assert_eq!(
        limits.bytes_per_second,
        d["bytesPerSecond"].as_f64().expect("rate")
    );
    assert_eq!(limits.burst_bytes, d["burstBytes"].as_f64().expect("burst"));
}
