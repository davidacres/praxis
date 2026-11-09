//! Pairing invitations and paired-device records (`packages/core/src/host/mobilePairingHandshake.ts`
//! and the device half of `mobileAccessAdministration.ts` port).
//!
//! An invitation is a versioned QR / paste payload holding a single-use, expiring token — never
//! a host private key. A paired device is what `mobile-pairing.json` persists; its field order
//! matches what the TS writes, and fields this build does not know are carried through.

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::protocol::MobileCapability;
use crate::relay::hex;

pub const MOBILE_PAIRING_INVITATION_VERSION: u64 = 1;
/// Ten minutes.
pub const MOBILE_PAIRING_TTL: Duration = Duration::minutes(10);

/// In-memory only; never persisted or sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MobilePairingToken {
    pub token_id: String,
    pub host_id: String,
    pub endpoint_hint: Option<String>,
    pub expires_at: String,
    pub consumed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MobileEndpoint {
    pub address: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MobileRelayRoute {
    pub url: String,
    pub channel: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairingInvitation {
    pub version: u64,
    pub host_id: String,
    pub display_name: String,
    pub public_key_hex: String,
    pub endpoints: Vec<MobileEndpoint>,
    pub token_id: String,
    pub expires_at: String,
    /// Where a phone off the LAN can reach this desktop: the relay URL and this desktop's
    /// channel on it — a route, not a credential.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<MobileRelayRoute>,
}

/// What a host publishes in an invitation besides the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MobileInvitationDetails {
    pub display_name: String,
    pub public_key_hex: String,
    pub endpoints: Vec<MobileEndpoint>,
    pub relay: Option<MobileRelayRoute>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairingPendingRequest {
    pub request_id: String,
    pub token_id: String,
    pub host_id: String,
    pub device_id: String,
    pub device_public_key: String,
    pub device_label: String,
    pub requested_at: String,
}

pub(crate) fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn issue_mobile_pairing_token(
    host_id: &str,
    token_id: &str,
    now: DateTime<Utc>,
    ttl: Duration,
    endpoint_hint: Option<&str>,
) -> MobilePairingToken {
    MobilePairingToken {
        token_id: token_id.to_owned(),
        host_id: host_id.to_owned(),
        endpoint_hint: endpoint_hint.filter(|h| !h.is_empty()).map(str::to_owned),
        expires_at: iso(now + ttl),
        consumed_at: None,
    }
}

pub fn create_mobile_pairing_invitation(
    token: &MobilePairingToken,
    details: &MobileInvitationDetails,
) -> MobilePairingInvitation {
    MobilePairingInvitation {
        version: MOBILE_PAIRING_INVITATION_VERSION,
        host_id: token.host_id.clone(),
        display_name: details.display_name.clone(),
        public_key_hex: details.public_key_hex.clone(),
        endpoints: details.endpoints.clone(),
        token_id: token.token_id.clone(),
        expires_at: token.expires_at.clone(),
        relay: details.relay.clone(),
    }
}

/// Compact alphanumeric payload for a QR; same fields as the JSON invitation. The relay parts
/// trail, so a phone that predates the relay ignores them.
pub fn compact_mobile_pairing_payload(invitation: &MobilePairingInvitation) -> String {
    let host = invitation
        .endpoints
        .first()
        .map(|endpoint| format!("{}:{}", endpoint.address, endpoint.port))
        .unwrap_or_default();
    let mut parts = vec![
        format!("P{}", invitation.version),
        invitation.host_id.clone(),
        invitation.public_key_hex.clone(),
        host,
        invitation.token_id.clone(),
        invitation.expires_at.clone(),
    ];
    if let Some(relay) = &invitation.relay {
        parts.push(relay.url.clone());
        parts.push(relay.channel.clone());
    }
    parts.join("|")
}

/// Unconsumed and not yet expired (ISO strings compare chronologically, as in the TS).
pub fn is_active_pairing_token(token: Option<&MobilePairingToken>, now: &str) -> bool {
    token.is_some_and(|token| token.consumed_at.is_none() && token.expires_at.as_str() > now)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MobilePairingRequest {
    pub token_id: String,
    pub host_id: String,
    pub device_id: String,
    pub device_public_key: String,
    pub project_ids: Vec<String>,
    pub proof: String,
    pub requested_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MobilePairingFailure {
    Expired,
    Replayed,
    HostMismatch,
    Unconfirmed,
    InvalidProof,
}

impl MobilePairingFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Expired => "expired",
            Self::Replayed => "replayed",
            Self::HostMismatch => "host-mismatch",
            Self::Unconfirmed => "unconfirmed",
            Self::InvalidProof => "invalid-proof",
        }
    }
}

/// `consumeMobilePairing`: checks the token, then the verifier, then marks the token consumed.
/// Returns the device id and granted projects.
pub fn consume_mobile_pairing(
    token: &mut Option<MobilePairingToken>,
    verify: impl FnOnce(&MobilePairingRequest, &MobilePairingToken) -> bool,
    confirm_device: impl FnOnce(&MobilePairingRequest) -> bool,
    request: &MobilePairingRequest,
    now: &str,
) -> Result<(String, Vec<String>), MobilePairingFailure> {
    let Some(current) = token.as_mut().filter(|t| t.token_id == request.token_id) else {
        return Err(MobilePairingFailure::Replayed);
    };
    if current.consumed_at.is_some() {
        return Err(MobilePairingFailure::Replayed);
    }
    if current.expires_at.as_str() <= now {
        return Err(MobilePairingFailure::Expired);
    }
    if current.host_id != request.host_id {
        return Err(MobilePairingFailure::HostMismatch);
    }
    if !verify(request, current) {
        return Err(MobilePairingFailure::InvalidProof);
    }
    if !confirm_device(request) {
        return Err(MobilePairingFailure::Unconfirmed);
    }
    current.consumed_at = Some(now.to_owned());
    Ok((request.device_id.clone(), request.project_ids.clone()))
}

/// A device in `mobile-pairing.json`. Field order is the order the TS produces (confirm, then
/// `lastSeenAt` on use, then `revokedAt`); unknown fields are kept and written back.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairedDevice {
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub paired_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key_hex: Option<String>,
    /// Kept as strings so a capability this build does not know never makes the file unreadable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl MobilePairedDevice {
    /// The granted capabilities this build knows; `view` when the record has none.
    pub fn granted_capabilities(&self) -> Vec<MobileCapability> {
        match &self.capabilities {
            None => vec![MobileCapability::View],
            Some(list) => list
                .iter()
                .filter_map(|c| serde_json::from_value(Value::String(c.clone())).ok())
                .collect(),
        }
    }
}

pub fn revoke_mobile_device(
    devices: &[MobilePairedDevice],
    device_id: &str,
    revoked_at: &str,
) -> Vec<MobilePairedDevice> {
    devices
        .iter()
        .map(|device| {
            let mut device = device.clone();
            if device.device_id == device_id && device.revoked_at.is_none() {
                device.revoked_at = Some(revoked_at.to_owned());
            }
            device
        })
        .collect()
}

pub fn is_mobile_device_trusted(device: &MobilePairedDevice, now: &str) -> bool {
    device.revoked_at.is_none() && device.paired_at.as_str() <= now
}

/// The trusted device whose key this is, if any.
pub fn authorize_mobile_peer<'a>(
    devices: &'a [MobilePairedDevice],
    public_key_hex: &str,
    now: &str,
) -> Option<&'a MobilePairedDevice> {
    let needle = public_key_hex.trim().to_lowercase();
    devices
        .iter()
        .find(|candidate| {
            candidate
                .public_key_hex
                .as_deref()
                .is_some_and(|key| key.trim().to_lowercase() == needle)
        })
        .filter(|device| is_mobile_device_trusted(device, now))
}

fn sha256_hex(text: &str) -> String {
    hex(&Sha256::digest(text.trim().to_lowercase().as_bytes()))
}

/// The 16-hex fingerprint shown beside the host key.
pub fn fingerprint_mobile_host_key(public_key_hex: &str) -> String {
    let mut digest = sha256_hex(public_key_hex);
    digest.truncate(16);
    digest
}

/// `device:` + the first 24 hex of the key's SHA-256.
pub fn mobile_device_id_for_public_key(public_key_hex: &str) -> String {
    let mut digest = sha256_hex(public_key_hex);
    digest.truncate(24);
    format!("device:{digest}")
}

/// Compares a presented secret with the expected one in time independent of where they differ.
/// (The length is not hidden; neither is it in the TS `timingSafeEqual` guard.)
pub fn constant_time_eq(expected: &[u8], presented: &[u8]) -> bool {
    if expected.len() != presented.len() {
        return false;
    }
    expected
        .iter()
        .zip(presented)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().expect("timestamp")
    }

    fn token() -> MobilePairingToken {
        MobilePairingToken {
            token_id: "qr-1".into(),
            host_id: "host-mac".into(),
            endpoint_hint: None,
            expires_at: "2026-09-09T13:00:00.000Z".into(),
            consumed_at: None,
        }
    }

    fn request() -> MobilePairingRequest {
        MobilePairingRequest {
            token_id: "qr-1".into(),
            host_id: "host-mac".into(),
            device_id: "phone-1".into(),
            device_public_key: "pk".into(),
            project_ids: vec!["praxis".into()],
            proof: "valid".into(),
            requested_at: "2026-09-09T12:00:00.000Z".into(),
        }
    }

    fn valid(request: &MobilePairingRequest, _: &MobilePairingToken) -> bool {
        request.proof == "valid"
    }

    #[test]
    fn consumes_a_valid_token_once() {
        let mut slot = Some(token());
        let ok = consume_mobile_pairing(
            &mut slot,
            valid,
            |_| true,
            &request(),
            "2026-09-09T12:01:00.000Z",
        );
        assert_eq!(ok, Ok(("phone-1".into(), vec!["praxis".into()])));
        let replay = consume_mobile_pairing(
            &mut slot,
            valid,
            |_| true,
            &request(),
            "2026-09-09T12:02:00.000Z",
        );
        assert_eq!(replay, Err(MobilePairingFailure::Replayed));
    }

    #[test]
    fn issues_a_single_use_expiring_invitation_without_a_private_key() {
        let token = issue_mobile_pairing_token(
            "host-mac",
            "qr-1",
            at("2026-09-09T12:00:00.000Z"),
            Duration::milliseconds(60_000),
            None,
        );
        assert_eq!(token.expires_at, "2026-09-09T12:01:00.000Z");
        assert!(is_active_pairing_token(
            Some(&token),
            "2026-09-09T12:00:30.000Z"
        ));
        let consumed = MobilePairingToken {
            consumed_at: Some("2026-09-09T12:00:10.000Z".into()),
            ..token.clone()
        };
        assert!(!is_active_pairing_token(
            Some(&consumed),
            "2026-09-09T12:00:30.000Z"
        ));
        let details = MobileInvitationDetails {
            display_name: "Dave Mac".into(),
            public_key_hex: "aa".into(),
            endpoints: vec![MobileEndpoint {
                address: "192.168.1.2".into(),
                port: 43100,
            }],
            relay: None,
        };
        let invitation = create_mobile_pairing_invitation(&token, &details);
        assert_eq!(invitation.version, 1);
        assert!(
            compact_mobile_pairing_payload(&invitation)
                .starts_with("P1|host-mac|aa|192.168.1.2:43100|qr-1|")
        );
        assert_eq!(
            serde_json::to_string(&invitation).expect("json"),
            r#"{"version":1,"hostId":"host-mac","displayName":"Dave Mac","publicKeyHex":"aa","endpoints":[{"address":"192.168.1.2","port":43100}],"tokenId":"qr-1","expiresAt":"2026-09-09T12:01:00.000Z"}"#
        );
    }

    #[test]
    fn rejects_expiry_host_substitution_proof_failure_and_missing_confirmation() {
        let consume = |request: MobilePairingRequest, verify: bool, confirm: bool, now: &str| {
            consume_mobile_pairing(
                &mut Some(token()),
                |_, _| verify,
                |_| confirm,
                &request,
                now,
            )
        };
        let now = "2026-09-09T12:01:00.000Z";
        assert_eq!(
            consume(request(), true, true, "2026-09-09T14:00:00.000Z"),
            Err(MobilePairingFailure::Expired)
        );
        let other = MobilePairingRequest {
            host_id: "other".into(),
            ..request()
        };
        assert_eq!(
            consume(other, true, true, now),
            Err(MobilePairingFailure::HostMismatch)
        );
        assert_eq!(
            consume(request(), false, true, now),
            Err(MobilePairingFailure::InvalidProof)
        );
        assert_eq!(
            consume(request(), true, false, now),
            Err(MobilePairingFailure::Unconfirmed)
        );
    }

    #[test]
    fn an_invitation_carries_an_optional_relay_route_as_trailing_qr_parts() {
        let token = issue_mobile_pairing_token(
            "host-mac",
            "qr-1",
            at("2026-09-09T12:00:00.000Z"),
            Duration::milliseconds(60_000),
            None,
        );
        let mut details = MobileInvitationDetails {
            display_name: "Dave Mac".into(),
            public_key_hex: "aa".into(),
            endpoints: vec![MobileEndpoint {
                address: "192.168.1.2".into(),
                port: 43100,
            }],
            relay: None,
        };
        let without =
            compact_mobile_pairing_payload(&create_mobile_pairing_invitation(&token, &details));
        details.relay = Some(MobileRelayRoute {
            url: "wss://relay.example.com".into(),
            channel: "0123456789abcdef0123456789abcdef".into(),
        });
        let with_relay =
            compact_mobile_pairing_payload(&create_mobile_pairing_invitation(&token, &details));
        let parts: Vec<&str> = with_relay.split('|').collect();
        assert_eq!(without.split('|').count(), 6);
        assert_eq!(parts[..6].join("|"), without);
        assert_eq!(
            parts[6..],
            [
                "wss://relay.example.com",
                "0123456789abcdef0123456789abcdef"
            ]
        );
    }

    #[test]
    fn ids_and_fingerprints_hash_the_normalised_key() {
        assert_eq!(
            mobile_device_id_for_public_key(" AA "),
            mobile_device_id_for_public_key("aa")
        );
        assert_eq!(fingerprint_mobile_host_key("aa").len(), 16);
        // sha256("aa") = 961b6dd3ede3cb8ecbaacbd68de040cd78eb2ed5889130cceb4c49268ea4d506
        assert_eq!(fingerprint_mobile_host_key("aa"), "961b6dd3ede3cb8e");
        assert_eq!(
            mobile_device_id_for_public_key("aa"),
            "device:961b6dd3ede3cb8ecbaacbd6"
        );
    }

    #[test]
    fn a_device_record_keeps_its_ts_shape_and_unknown_fields() {
        let raw = r#"{"deviceId":"device:1","label":"Phone","pairedAt":"t","publicKeyHex":"bb","capabilities":["view","teleport"],"projectIds":["p1"],"lastSeenAt":"t2","futureField":{"x":1}}"#;
        let device: MobilePairedDevice = serde_json::from_str(raw).expect("device");
        assert_eq!(device.granted_capabilities(), vec![MobileCapability::View]);
        assert_eq!(serde_json::to_string(&device).expect("json"), raw);
    }

    #[test]
    fn constant_time_eq_compares_bytes() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
