//! Byte-for-byte interop with `@praxis/mobile-protocol`.
//!
//! `fixtures/ts_vectors.json` was produced by running the compiled TypeScript package with fixed
//! static and ephemeral keys (its `ephemeralKeyPair` injection point): the framed IK handshake
//! messages, every transport record in both directions, the JSON each record carries, a rekey,
//! the status defaults and the transport-failure messages. Rust must reproduce every byte and
//! must read every TS-produced byte.

use praxis_mobile::{
    CipherState, Handshake, HandshakeInit, KeyPair, MobileConnectionErrorCode,
    MobileConnectionStatusCode, MobileRequestFrame, MobileServerFrame, NoisePattern,
    RecordAssembler, SecureChannel, SecureChannelOptions, TransportStage,
    classify_mobile_transport_failure, frame, mobile_connection_status,
};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/ts_vectors.json")).expect("vector file is JSON")
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn key32(text: &str) -> [u8; 32] {
    unhex(text).try_into().expect("32-byte key")
}

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is a string"))
}

fn key_pair(keys: &Value, name: &str) -> KeyPair {
    let pair = KeyPair::from_private_key(key32(s(keys, &format!("{name}Private"))));
    assert_eq!(
        hex(&pair.public_key()),
        s(keys, &format!("{name}Public")),
        "{name} public key"
    );
    pair
}

/// Strips the 4-byte length prefix, asserting the record is exactly one frame.
fn unframe(record: &[u8]) -> Vec<u8> {
    let mut records = RecordAssembler::new().push(record).expect("assemble");
    assert_eq!(records.len(), 1, "one framed record");
    records.remove(0)
}

struct Ends {
    phone: SecureChannel,
    desktop: SecureChannel,
}

fn ends(keys: &Value, prologue: Option<&str>) -> Ends {
    let mut phone = SecureChannelOptions::new(key_pair(keys, "phoneStatic"));
    phone.remote_static_public_key = Some(key_pair(keys, "desktopStatic").public_key());
    phone.ephemeral_key_pair = Some(key_pair(keys, "phoneEphemeral"));
    phone.prologue = prologue.map(|p| p.as_bytes().to_vec());
    let mut desktop = SecureChannelOptions::new(key_pair(keys, "desktopStatic"));
    desktop.ephemeral_key_pair = Some(key_pair(keys, "desktopEphemeral"));
    desktop.prologue = prologue.map(|p| p.as_bytes().to_vec());
    Ends {
        phone: SecureChannel::initiator(phone).expect("phone"),
        desktop: SecureChannel::responder(desktop).expect("desktop"),
    }
}

#[test]
fn ik_handshake_and_transport_records_match_the_typescript_byte_for_byte() {
    let vectors = vectors();
    let keys = &vectors["keys"];
    let channels = vectors["channels"].as_array().expect("channels");
    assert_eq!(channels.len(), 2);
    for channel in channels {
        let name = s(channel, "name");
        let mut ends = ends(keys, channel["prologue"].as_str());

        // Rust writes the TS handshake bytes; Rust reads the TS handshake bytes.
        let hello = ends
            .phone
            .next_handshake_message(s(channel, "msg1Payload").as_bytes())
            .expect("write 1");
        assert_eq!(hex(&hello), s(channel, "handshake1"), "{name}: handshake 1");
        let payload = ends
            .desktop
            .read_handshake_message(&unframe(&unhex(s(channel, "handshake1"))))
            .expect("read TS handshake 1");
        assert_eq!(
            payload,
            s(channel, "msg1Payload").as_bytes(),
            "{name}: handshake 1 payload"
        );
        let reply = ends
            .desktop
            .next_handshake_message(s(channel, "msg2Payload").as_bytes())
            .expect("write 2");
        assert_eq!(hex(&reply), s(channel, "handshake2"), "{name}: handshake 2");
        let payload = ends
            .phone
            .read_handshake_message(&unframe(&unhex(s(channel, "handshake2"))))
            .expect("read TS handshake 2");
        assert_eq!(
            payload,
            s(channel, "msg2Payload").as_bytes(),
            "{name}: handshake 2 payload"
        );
        assert!(ends.phone.is_open() && ends.desktop.is_open());

        for (index, record) in channel["phoneToDesktop"]
            .as_array()
            .expect("phone frames")
            .iter()
            .enumerate()
        {
            let json = s(record, "json");
            let request: MobileRequestFrame = serde_json::from_str(json).expect("request frame");
            let encoded = serde_json::to_vec(&request).expect("encode");
            assert_eq!(
                std::str::from_utf8(&encoded).expect("utf8"),
                json,
                "{name}: request {index} JSON"
            );
            assert_eq!(
                hex(&ends.phone.encrypt(&encoded).expect("encrypt")),
                s(record, "record"),
                "{name}: request {index} record"
            );
            let plain = ends
                .desktop
                .decrypt(&unframe(&unhex(s(record, "record"))))
                .expect("decrypt TS request");
            assert_eq!(plain, json.as_bytes(), "{name}: request {index} plaintext");
        }

        for (index, record) in channel["desktopToPhone"]
            .as_array()
            .expect("desktop frames")
            .iter()
            .enumerate()
        {
            let json = s(record, "json");
            let server = MobileServerFrame::decode(json.as_bytes())
                .expect("decode")
                .expect("known kind");
            let encoded = server.encode();
            assert_eq!(
                std::str::from_utf8(&encoded).expect("utf8"),
                json,
                "{name}: server frame {index} JSON"
            );
            assert_eq!(
                hex(&ends.desktop.encrypt(&encoded).expect("encrypt")),
                s(record, "record"),
                "{name}: server frame {index} record"
            );
            let plain = ends
                .phone
                .decrypt(&unframe(&unhex(s(record, "record"))))
                .expect("decrypt TS server frame");
            assert_eq!(
                plain,
                json.as_bytes(),
                "{name}: server frame {index} plaintext"
            );
        }
    }
}

#[test]
fn the_handshake_hash_matches_the_typescript() {
    let vectors = vectors();
    let keys = &vectors["keys"];
    let channel = &vectors["channels"][0];
    let prologue = s(channel, "prologue").as_bytes().to_vec();

    let mut init = HandshakeInit::new(NoisePattern::IK, true);
    init.prologue = prologue.clone();
    init.static_key_pair = Some(key_pair(keys, "phoneStatic"));
    init.remote_static_public_key = Some(key_pair(keys, "desktopStatic").public_key());
    init.ephemeral_key_pair = Some(key_pair(keys, "phoneEphemeral"));
    let mut phone = Handshake::new(init).expect("phone");
    let mut init = HandshakeInit::new(NoisePattern::IK, false);
    init.prologue = prologue;
    init.static_key_pair = Some(key_pair(keys, "desktopStatic"));
    init.ephemeral_key_pair = Some(key_pair(keys, "desktopEphemeral"));
    let mut desktop = Handshake::new(init).expect("desktop");

    desktop
        .read_message(&phone.write_message(&[]).expect("write 1"))
        .expect("read 1");
    phone
        .read_message(&desktop.write_message(&[]).expect("write 2"))
        .expect("read 2");
    let hash = phone.finished().expect("finished").handshake_hash;
    assert_eq!(hex(&hash), s(channel, "handshakeHash"));
    assert_eq!(desktop.finished().expect("finished").handshake_hash, hash);
}

#[test]
fn rekey_matches_the_typescript() {
    let vectors = vectors();
    let rekey = &vectors["rekey"];
    let mut cipher = CipherState::new(key32(s(rekey, "key")));
    assert_eq!(
        hex(&cipher
            .encrypt_with_ad(b"ad", b"before rekey")
            .expect("encrypt")),
        s(rekey, "beforeRekey")
    );
    cipher.rekey().expect("rekey");
    assert_eq!(cipher.nonce_value(), 1, "rekey leaves the nonce alone");
    assert_eq!(
        hex(&cipher
            .encrypt_with_ad(&[], b"after rekey")
            .expect("encrypt")),
        s(rekey, "afterRekey")
    );
}

#[test]
fn framing_matches_the_typescript() {
    let vectors = vectors();
    let framed = &vectors["frame"];
    assert_eq!(
        hex(&frame(s(framed, "payload").as_bytes()).expect("frame")),
        s(framed, "framed")
    );
    assert_eq!(hex(&frame(&[]).expect("frame")), s(framed, "empty"));
}

#[test]
fn status_defaults_and_json_match_the_typescript() {
    let vectors = vectors();
    let statuses = vectors["statuses"].as_array().expect("statuses");
    assert_eq!(statuses.len(), MobileConnectionStatusCode::ALL.len());
    for expected in statuses {
        let code = MobileConnectionStatusCode::parse(s(expected, "code")).expect("known code");
        let status = mobile_connection_status(code, None);
        assert_eq!(status.message, s(expected, "message"), "{code:?} message");
        assert_eq!(
            Some(status.retryable),
            expected["retryable"].as_bool(),
            "{code:?} retryable"
        );
        assert_eq!(
            Some(code.is_terminal()),
            expected["terminal"].as_bool(),
            "{code:?} terminal"
        );
        assert_eq!(
            serde_json::to_string(&status).expect("json"),
            s(expected, "json"),
            "{code:?} JSON"
        );
    }
    let custom = mobile_connection_status(MobileConnectionStatusCode::Ready, Some("  Custom.  "));
    assert_eq!(
        serde_json::to_value(&custom).expect("json"),
        vectors["statusOverride"]
    );
    let blank = mobile_connection_status(MobileConnectionStatusCode::HostShutdown, Some("   "));
    assert_eq!(
        serde_json::to_value(&blank).expect("json"),
        vectors["statusBlankOverride"]
    );
}

#[test]
fn transport_failure_classification_matches_the_typescript() {
    let vectors = vectors();
    let failures = vectors["transportFailures"].as_array().expect("failures");
    assert_eq!(failures.len(), 12);
    for expected in failures {
        let stage = match s(expected, "stage") {
            "connect" => TransportStage::Connect,
            "handshake" => TransportStage::Handshake,
            _ => TransportStage::Session,
        };
        let cause = expected["cause"].as_str().map(str::to_owned);
        let timed_out = expected["timedOut"].as_bool().expect("timedOut");
        let error = classify_mobile_transport_failure(
            stage,
            "192.168.1.20:47120",
            cause.as_ref().map(|c| c as &dyn std::fmt::Display),
            timed_out,
        );
        let label = format!("{stage:?} timedOut={timed_out} cause={cause:?}");
        assert!(
            matches!(error.code, MobileConnectionErrorCode::Transport(_)),
            "{label}"
        );
        assert_eq!(error.code.as_str(), s(expected, "code"), "{label}");
        assert_eq!(error.message, s(expected, "message"), "{label}");
        assert_eq!(
            Some(error.retryable),
            expected["retryable"].as_bool(),
            "{label}"
        );
        assert_eq!(
            error.detail.as_deref(),
            expected["detail"].as_str(),
            "{label}"
        );
    }
}
