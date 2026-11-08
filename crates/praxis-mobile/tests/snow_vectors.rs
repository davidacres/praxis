//! The canonical `snow` Noise vectors for IK / NK / XX (port of `noise.test.ts`; same fixture as
//! `packages/mobile-protocol/src/noiseVectors.fixture.json`).

use praxis_mobile::{Handshake, HandshakeInit, KeyPair, NoisePattern};
use serde_json::Value;

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn key_pair(value: &Value) -> Option<KeyPair> {
    value
        .as_str()
        .map(|text| KeyPair::from_private_key(unhex(text).try_into().expect("32-byte key")))
}

#[test]
fn every_snow_vector_matches() {
    let file: Value =
        serde_json::from_str(include_str!("fixtures/snow_vectors.json")).expect("fixture is JSON");
    let vectors = file["vectors"].as_array().expect("vectors");
    assert!(vectors.len() >= 3);
    for vector in vectors {
        let name = vector["protocol_name"].as_str().expect("name");
        let pattern = match name.split('_').nth(1) {
            Some("IK") => NoisePattern::IK,
            Some("NK") => NoisePattern::NK,
            Some("XX") => NoisePattern::XX,
            other => panic!("unexpected pattern {other:?}"),
        };
        let prologue = unhex(vector["init_prologue"].as_str().expect("prologue"));

        let mut init = HandshakeInit::new(pattern, true);
        init.prologue = prologue.clone();
        init.static_key_pair = key_pair(&vector["init_static"]);
        init.remote_static_public_key = vector["init_remote_static"]
            .as_str()
            .map(|k| unhex(k).try_into().expect("32-byte key"));
        init.ephemeral_key_pair = key_pair(&vector["init_ephemeral"]);
        let mut initiator = Handshake::new(init).expect("initiator");
        let mut init = HandshakeInit::new(pattern, false);
        init.prologue = prologue;
        init.static_key_pair = key_pair(&vector["resp_static"]);
        init.ephemeral_key_pair = key_pair(&vector["resp_ephemeral"]);
        let mut responder = Handshake::new(init).expect("responder");

        let handshake_messages = if pattern == NoisePattern::XX { 3 } else { 2 };
        let mut results = None;
        for (i, message) in vector["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .enumerate()
        {
            let payload = unhex(message["payload"].as_str().expect("payload"));
            let ciphertext = message["ciphertext"].as_str().expect("ciphertext");
            let initiator_sends = i % 2 == 0;
            if i < handshake_messages {
                let (writer, reader) = if initiator_sends {
                    (&mut initiator, &mut responder)
                } else {
                    (&mut responder, &mut initiator)
                };
                let produced = writer.write_message(&payload).expect("write");
                assert_eq!(hex(&produced), ciphertext, "{name}: message {i} ciphertext");
                assert_eq!(
                    reader.read_message(&produced).expect("read"),
                    payload,
                    "{name}: message {i} payload"
                );
                continue;
            }
            let (a, b) = results.get_or_insert_with(|| {
                let a = initiator.take_result().expect("initiator finished");
                let b = responder.take_result().expect("responder finished");
                assert_eq!(
                    a.handshake_hash, b.handshake_hash,
                    "{name}: both sides agree on the handshake hash"
                );
                if pattern != NoisePattern::NK {
                    let init_static = key_pair(&vector["init_static"])
                        .expect("init static")
                        .public_key();
                    let resp_static = key_pair(&vector["resp_static"])
                        .expect("resp static")
                        .public_key();
                    assert_eq!(
                        a.remote_static_public_key,
                        Some(resp_static),
                        "{name}: initiator learned the responder key"
                    );
                    assert_eq!(
                        b.remote_static_public_key,
                        Some(init_static),
                        "{name}: responder learned the initiator key"
                    );
                }
                (a, b)
            });
            let (writer, reader) = if initiator_sends {
                (&mut *a, &mut *b)
            } else {
                (&mut *b, &mut *a)
            };
            let produced = writer.send.encrypt_with_ad(&[], &payload).expect("encrypt");
            assert_eq!(
                hex(&produced),
                ciphertext,
                "{name}: transport message {i} ciphertext"
            );
            assert_eq!(
                reader
                    .receive
                    .decrypt_with_ad(&[], &produced)
                    .expect("decrypt"),
                payload,
                "{name}: transport message {i} payload"
            );
        }
        assert!(
            results.is_some(),
            "{name}: vector carried transport messages"
        );
    }
}
