//! Ports of `mobilePairingRegistry.test.ts`, plus the file shape and the unpaired-peer decision.

use std::sync::{Arc, Mutex};

use super::*;
use crate::host::pairing::MobileEndpoint;

#[derive(Clone, Default)]
struct MemoryPersist {
    devices: Arc<Mutex<Vec<MobilePairedDevice>>>,
}

impl MobilePairingPersist for MemoryPersist {
    fn load(&self) -> Vec<MobilePairedDevice> {
        self.devices.lock().expect("devices").clone()
    }

    fn save(&self, devices: &[MobilePairedDevice]) {
        *self.devices.lock().expect("devices") = devices.to_vec();
    }
}

fn registry() -> MobilePairingRegistry {
    MobilePairingRegistry::new(Box::new(MemoryPersist::default()))
}

fn details() -> MobileInvitationDetails {
    MobileInvitationDetails {
        display_name: "Dave Mac".into(),
        public_key_hex: "aa".repeat(32),
        endpoints: vec![MobileEndpoint {
            address: "192.168.1.2".into(),
            port: 43100,
        }],
        relay: None,
    }
}

fn at(text: &str) -> DateTime<Utc> {
    text.parse().expect("timestamp")
}

fn grant(capabilities: &[MobileCapability]) -> MobilePairingGrant {
    MobilePairingGrant {
        label: None,
        capabilities: capabilities.to_vec(),
        project_ids: vec!["p1".into()],
    }
}

const VIEW: &[MobileCapability] = &[MobileCapability::View];

#[test]
fn issues_one_active_invitation_and_consumes_it_on_confirm() {
    let mut registry = registry();
    let invitation =
        registry.issue_invitation("host-1", &details(), at("2026-09-22T10:00:00.000Z"));
    let pending = registry
        .submit_unpaired(
            &"bb".repeat(32),
            &invitation.token_id,
            "2026-09-22T10:00:01.000Z",
        )
        .expect("request");
    assert_eq!(pending.token_id, invitation.token_id);
    let device = registry
        .confirm(
            &pending.request_id,
            &grant(&[MobileCapability::View, MobileCapability::Execute]),
            "2026-09-22T10:00:02.000Z",
        )
        .expect("confirmed");
    assert_eq!(device.project_ids.as_deref(), Some(&["p1".to_owned()][..]));
    assert_eq!(
        registry
            .authorize(&"bb".repeat(32), &now_iso())
            .map(|d| d.device_id.clone()),
        Some(device.device_id.clone())
    );
    assert!(registry.list_pending().is_empty());
    assert_eq!(
        registry.active_invitation("2026-09-22T10:00:03.000Z", &details()),
        None
    );
}

#[test]
fn a_forged_later_confirm_cannot_reuse_a_consumed_token() {
    let mut registry = registry();
    let invitation =
        registry.issue_invitation("host-1", &details(), at("2026-09-22T10:00:00.000Z"));
    let pending = registry
        .submit_unpaired(
            &"bb".repeat(32),
            &invitation.token_id,
            "2026-09-22T10:00:01.000Z",
        )
        .expect("request");
    assert!(
        registry
            .confirm(
                &pending.request_id,
                &grant(VIEW),
                "2026-09-22T10:00:02.000Z"
            )
            .is_ok()
    );
    assert!(
        registry
            .confirm(
                &pending.request_id,
                &grant(VIEW),
                "2026-09-22T10:00:03.000Z"
            )
            .is_err()
    );
}

#[test]
fn revoke_and_host_key_reset_drop_trust() {
    let mut registry = registry();
    let first = registry.issue_invitation("host-1", &details(), at("2026-09-22T10:00:00.000Z"));
    let pending = registry
        .submit_unpaired(
            &"bb".repeat(32),
            &first.token_id,
            "2026-09-22T10:00:01.000Z",
        )
        .expect("request");
    let device = registry
        .confirm(
            &pending.request_id,
            &grant(VIEW),
            "2026-09-22T10:00:02.000Z",
        )
        .expect("confirmed");
    registry.revoke(&device.device_id, "2026-09-22T10:01:00.000Z");
    assert!(registry.authorize(&"bb".repeat(32), &now_iso()).is_none());
    assert!(registry.was_revoked(&"bb".repeat(32)));
    let second = registry.issue_invitation("host-1", &details(), at("2026-09-22T10:02:00.000Z"));
    let other = registry
        .submit_unpaired(
            &"cc".repeat(32),
            &second.token_id,
            "2026-09-22T10:02:01.000Z",
        )
        .expect("request");
    assert!(
        registry
            .confirm(&other.request_id, &grant(VIEW), "2026-09-22T10:02:02.000Z")
            .is_ok()
    );
    registry.revoke_all("2026-09-22T10:03:00.000Z");
    assert!(registry.authorize(&"cc".repeat(32), &now_iso()).is_none());
}

#[test]
fn unpaired_peers_without_an_invitation_are_ignored() {
    let mut registry = registry();
    assert_eq!(
        registry.submit_unpaired(&"bb".repeat(32), "anything", &now_iso()),
        Err(MobileSubmitRefusal::NoInvitation)
    );
}

#[test]
fn only_the_current_invitation_token_creates_a_request_and_never_after_expiry_or_use() {
    let mut registry = registry();
    let bb = "bb".repeat(32);
    let invitation =
        registry.issue_invitation("host-1", &details(), at("2026-09-22T10:00:00.000Z"));
    assert_eq!(
        registry.submit_unpaired(&bb, "not-the-token", "2026-09-22T10:00:01.000Z"),
        Err(MobileSubmitRefusal::InvalidToken)
    );
    assert!(
        registry.list_pending().is_empty(),
        "knowing the host key alone does not queue a request"
    );
    assert_eq!(
        registry.submit_unpaired(&bb, &invitation.token_id, "2026-09-22T10:10:00.001Z"),
        Err(MobileSubmitRefusal::Expired)
    );

    let fresh = registry.issue_invitation("host-1", &details(), at("2026-09-22T11:00:00.000Z"));
    assert_eq!(
        registry.submit_unpaired(&bb, &invitation.token_id, "2026-09-22T11:00:01.000Z"),
        Err(MobileSubmitRefusal::InvalidToken),
        "a replaced invitation is dead"
    );
    let phone_a = registry
        .submit_unpaired(
            &"aa".repeat(32),
            &fresh.token_id,
            "2026-09-22T11:00:01.000Z",
        )
        .expect("a");
    let again = registry
        .submit_unpaired(
            &"aa".repeat(32),
            &fresh.token_id,
            "2026-09-22T11:00:02.000Z",
        )
        .expect("again");
    assert_eq!(
        again.request_id, phone_a.request_id,
        "reconnecting while pending keeps the same request"
    );
    let phone_b = registry
        .submit_unpaired(&bb, &fresh.token_id, "2026-09-22T11:00:03.000Z")
        .expect("b");
    assert!(
        registry
            .confirm(
                &phone_a.request_id,
                &grant(VIEW),
                "2026-09-22T11:00:04.000Z"
            )
            .is_ok()
    );
    assert_eq!(
        registry
            .take_superseded()
            .into_iter()
            .map(|r| r.request_id)
            .collect::<Vec<_>>(),
        vec![phone_b.request_id],
        "the single-use token voids the other request"
    );
    assert!(registry.list_pending().is_empty());
    assert_eq!(
        registry.submit_unpaired(
            &"cc".repeat(32),
            &fresh.token_id,
            "2026-09-22T11:00:05.000Z"
        ),
        Err(MobileSubmitRefusal::Used)
    );
}

#[test]
fn a_padded_token_is_trimmed_before_the_comparison() {
    let mut registry = registry();
    let invitation = registry.issue_invitation("host-1", &details(), Utc::now());
    let padded = format!("  {}\n", invitation.token_id);
    assert!(
        registry
            .submit_unpaired(&"bb".repeat(32), &padded, &now_iso())
            .is_ok()
    );
}

#[test]
fn the_file_round_trips_in_the_ts_shape() {
    let dir = crate::host::test_support::temp_dir("pairing-file");
    let path = dir.join("mobile-pairing.json");
    let persist = JsonFilePairingPersist::new(&path);
    assert!(persist.load().is_empty(), "a missing file is no devices");
    let mut registry = MobilePairingRegistry::new(Box::new(JsonFilePairingPersist::new(&path)));
    let invitation = registry.issue_invitation("host-1", &details(), Utc::now());
    let request = registry
        .submit_unpaired(&"bb".repeat(32), &invitation.token_id, &now_iso())
        .expect("request");
    let device = registry
        .confirm(
            &request.request_id,
            &MobilePairingGrant {
                label: Some("  Dave’s phone ".into()),
                capabilities: vec![MobileCapability::View, MobileCapability::Approve],
                project_ids: vec!["p1".into()],
            },
            "2026-09-22T10:00:02.000Z",
        )
        .expect("confirmed");
    let text = fs::read_to_string(&path).expect("written");
    let expected = format!(
        "{{\n  \"devices\": [\n    {{\n      \"deviceId\": \"{}\",\n      \"label\": \"Dave’s phone\",\n      \"pairedAt\": \"2026-09-22T10:00:02.000Z\",\n      \"publicKeyHex\": \"{}\",\n      \"capabilities\": [\n        \"view\",\n        \"approve\"\n      ],\n      \"projectIds\": [\n        \"p1\"\n      ]\n    }}\n  ]\n}}",
        device.device_id,
        "bb".repeat(32)
    );
    assert_eq!(text, expected);
    let reloaded = MobilePairingRegistry::new(Box::new(JsonFilePairingPersist::new(&path)));
    assert_eq!(reloaded.list_devices(), &[device]);
    fs::write(&path, "not json").expect("overwrite");
    assert!(
        persist.load().is_empty(),
        "an unreadable file is no devices"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn the_unpaired_peer_decision_matches_the_desktop() {
    let mut registry = registry();
    let key = "bb".repeat(32);
    let status = |registry: &mut MobilePairingRegistry, mode, token: Option<&str>| {
        unpaired_peer_status(registry, mode, "Dave Mac", &key, token).code
    };
    use MobileConnectionStatusCode as Code;
    assert_eq!(
        status(&mut registry, MobileAccessMode::Off, None),
        Code::AccessDisabled
    );
    assert_eq!(
        status(&mut registry, MobileAccessMode::LocalOnly, None),
        Code::PairingRequired
    );
    assert_eq!(
        status(&mut registry, MobileAccessMode::LocalOnly, Some("x")),
        Code::InvitationExpired
    );
    let invitation = registry.issue_invitation("host-1", &details(), Utc::now());
    assert_eq!(
        status(&mut registry, MobileAccessMode::LocalOnly, Some("wrong")),
        Code::InvitationInvalid
    );
    let pending = unpaired_peer_status(
        &mut registry,
        MobileAccessMode::LocalOnly,
        "Dave Mac",
        &key,
        Some(&invitation.token_id),
    );
    assert_eq!(pending.code, Code::PairingPending);
    assert!(
        pending
            .message
            .starts_with("Waiting for confirmation on Dave Mac.")
    );
    let request = registry.list_pending().remove(0);
    let device = registry
        .confirm(&request.request_id, &grant(VIEW), &now_iso())
        .expect("confirmed");
    assert_eq!(
        status(
            &mut registry,
            MobileAccessMode::LocalOnly,
            Some(&invitation.token_id)
        ),
        Code::InvitationUsed
    );
    registry.revoke(&device.device_id, &now_iso());
    assert_eq!(
        status(&mut registry, MobileAccessMode::LocalOnly, None),
        Code::DeviceRevoked
    );
}
