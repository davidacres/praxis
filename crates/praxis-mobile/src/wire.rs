//! The frames carried inside an open Noise channel, and the connection status vocabulary both
//! ends share (`packages/mobile-protocol/src/wire.ts` port).
//!
//! Every frame is one UTF-8 JSON object per encrypted record. Field names and order match what
//! the TypeScript writes with `JSON.stringify`, so a frame encoded here is the same bytes the
//! desktop or phone would produce: requests are `{id, kind, payload}`, replies
//! `{id, kind:"reply", ok, value?, code?, error?}`, events `{kind:"event", envelope}` and
//! statuses `{kind:"status", status:{code, message, retryable}}`. Operation payloads stay opaque.
//!
//! Every accepted channel starts with one `status` frame: `ready` for a paired device,
//! `pairing-required` for an unknown one, or a refusal sent *before* the listener closes.

use std::fmt;

use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MobileRequestKind {
    Read,
    Command,
    Replay,
    /// Presents an invitation token for an unknown device (payload `{ tokenId }`).
    Pair,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MobileRequestFrame {
    pub id: String,
    pub kind: MobileRequestKind,
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileReplyErrorCode {
    PairingPending,
    NotAuthorised,
    UnsupportedOperation,
    CursorExpired,
    Rejected,
    /// A code this build does not know; the TS passes such codes through untyped.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MobileReplyFrame {
    pub id: String,
    pub ok: bool,
    /// `Some(Value::Null)` is an explicit `null`; `None` means the field was absent.
    #[serde(default, deserialize_with = "present")]
    pub value: Option<Value>,
    #[serde(default)]
    pub code: Option<MobileReplyErrorCode>,
    #[serde(default)]
    pub error: Option<String>,
}

fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// An event envelope: `{ sequence, ...rest }`, kept as an ordered JSON object.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MobileEventFrame {
    pub envelope: Map<String, Value>,
}

impl MobileEventFrame {
    pub fn sequence(&self) -> Option<u64> {
        self.envelope.get("sequence").and_then(Value::as_u64)
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MobileStatusFrame {
    pub status: MobileConnectionStatus,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MobileServerFrame {
    Reply(MobileReplyFrame),
    Event(MobileEventFrame),
    Status(MobileStatusFrame),
}

#[derive(Debug, thiserror::Error)]
#[error("Malformed mobile frame: {0}")]
pub struct FrameDecodeError(String);

impl MobileServerFrame {
    /// Decodes one frame. `Ok(None)` is a well-formed frame of a kind this build does not know,
    /// which the TS client ignores.
    pub fn decode(bytes: &[u8]) -> Result<Option<Self>, FrameDecodeError> {
        let value: Value =
            serde_json::from_slice(bytes).map_err(|e| FrameDecodeError(e.to_string()))?;
        let kind = value.get("kind").and_then(Value::as_str).map(str::to_owned);
        let parse = |what: &str| FrameDecodeError(format!("bad {what} frame"));
        Ok(match kind.as_deref() {
            Some("reply") => Some(Self::Reply(
                serde_json::from_value(value).map_err(|_| parse("reply"))?,
            )),
            Some("event") => Some(Self::Event(
                serde_json::from_value(value).map_err(|_| parse("event"))?,
            )),
            Some("status") => Some(Self::Status(
                serde_json::from_value(value).map_err(|_| parse("status"))?,
            )),
            Some(_) => None,
            None => return Err(FrameDecodeError("frame has no kind".into())),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("a mobile frame always serialises")
    }
}

impl Serialize for MobileServerFrame {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match self {
            Self::Reply(reply) => {
                map.serialize_entry("id", &reply.id)?;
                map.serialize_entry("kind", "reply")?;
                map.serialize_entry("ok", &reply.ok)?;
                if let Some(value) = &reply.value {
                    map.serialize_entry("value", value)?;
                }
                if let Some(code) = &reply.code {
                    map.serialize_entry("code", code)?;
                }
                if let Some(error) = &reply.error {
                    map.serialize_entry("error", error)?;
                }
            }
            Self::Event(event) => {
                map.serialize_entry("kind", "event")?;
                map.serialize_entry("envelope", &event.envelope)?;
            }
            Self::Status(status) => {
                map.serialize_entry("kind", "status")?;
                map.serialize_entry("status", &status.status)?;
            }
        }
        map.end()
    }
}

/// Result of a `replay` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileReplayResult {
    pub replaying: bool,
    pub latest_sequence: u64,
    /// Events after the requested cursor already left the desktop's bounded log; re-read state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileConnectionStatusCode {
    /// Paired and authorised: requests may flow.
    Ready,
    /// Unknown device: present an invitation token with a `pair` frame.
    PairingRequired,
    /// Token accepted; waiting for someone to confirm this phone on the desktop.
    PairingPending,
    PairingRejected,
    InvitationExpired,
    InvitationInvalid,
    InvitationUsed,
    DeviceRevoked,
    HostKeyReset,
    AccessDisabled,
    AccessDenied,
    HostShutdown,
}

impl MobileConnectionStatusCode {
    pub const ALL: [Self; 12] = [
        Self::Ready,
        Self::PairingRequired,
        Self::PairingPending,
        Self::PairingRejected,
        Self::InvitationExpired,
        Self::InvitationInvalid,
        Self::InvitationUsed,
        Self::DeviceRevoked,
        Self::HostKeyReset,
        Self::AccessDisabled,
        Self::AccessDenied,
        Self::HostShutdown,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::PairingRequired => "pairing-required",
            Self::PairingPending => "pairing-pending",
            Self::PairingRejected => "pairing-rejected",
            Self::InvitationExpired => "invitation-expired",
            Self::InvitationInvalid => "invitation-invalid",
            Self::InvitationUsed => "invitation-used",
            Self::DeviceRevoked => "device-revoked",
            Self::HostKeyReset => "host-key-reset",
            Self::AccessDisabled => "access-disabled",
            Self::AccessDenied => "access-denied",
            Self::HostShutdown => "host-shutdown",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|code| code.as_str() == value)
    }

    /// The default message and whether simply reconnecting later may succeed.
    fn defaults(self) -> (&'static str, bool) {
        match self {
            Self::Ready => ("Connected.", true),
            Self::PairingRequired => (
                "This phone is not paired with the desktop. Scan a current pairing invitation from Settings → Mobile access.",
                false,
            ),
            Self::PairingPending => (
                "Waiting for this phone to be confirmed in Settings → Mobile access on the desktop.",
                true,
            ),
            Self::PairingRejected => ("The desktop declined this pairing request.", false),
            Self::InvitationExpired => (
                "The pairing invitation has expired. Create a new invitation in Settings → Mobile access and scan it again.",
                false,
            ),
            Self::InvitationInvalid => (
                "The pairing invitation does not match the one the desktop is offering. Scan the invitation currently shown in Settings → Mobile access.",
                false,
            ),
            Self::InvitationUsed => (
                "That pairing invitation has already been used. Create a new invitation on the desktop to pair this phone.",
                false,
            ),
            Self::DeviceRevoked => (
                "The desktop revoked this phone’s access. Pair it again with a new invitation from Settings → Mobile access.",
                false,
            ),
            Self::HostKeyReset => (
                "The desktop reset its host key, so every phone must pair again. Scan a new invitation from Settings → Mobile access.",
                false,
            ),
            Self::AccessDisabled => (
                "Mobile access is turned off on the desktop. Turn it on in Settings → Mobile access.",
                false,
            ),
            Self::AccessDenied => (
                "The desktop’s mobile access policy does not allow connections from this network.",
                false,
            ),
            Self::HostShutdown => ("The Praxis desktop stopped its mobile listener.", true),
        }
    }

    /// A status code that ends the connection (anything but ready / pairing in progress).
    pub fn is_terminal(self) -> bool {
        !matches!(
            self,
            Self::Ready | Self::PairingRequired | Self::PairingPending
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MobileConnectionStatus {
    pub code: MobileConnectionStatusCode,
    #[serde(default)]
    pub message: String,
    /// True when simply reconnecting later may succeed without user action.
    #[serde(default)]
    pub retryable: bool,
}

/// The status for `code`, with `message` (trimmed) replacing the default when non-blank.
/// `retryable` always comes from the code, never from the peer.
pub fn mobile_connection_status(
    code: MobileConnectionStatusCode,
    message: Option<&str>,
) -> MobileConnectionStatus {
    let (fallback, retryable) = code.defaults();
    let message = message
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(fallback);
    MobileConnectionStatus {
        code,
        message: message.to_owned(),
        retryable,
    }
}

/// Where a connection failed, when the listener could not say why itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MobileTransportFailureCode {
    Unreachable,
    HandshakeRejected,
    HandshakeFailed,
    ConnectionLost,
    TimedOut,
    ProtocolError,
}

impl MobileTransportFailureCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unreachable => "unreachable",
            Self::HandshakeRejected => "handshake-rejected",
            Self::HandshakeFailed => "handshake-failed",
            Self::ConnectionLost => "connection-lost",
            Self::TimedOut => "timed-out",
            Self::ProtocolError => "protocol-error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MobileConnectionErrorCode {
    Status(MobileConnectionStatusCode),
    Transport(MobileTransportFailureCode),
}

impl MobileConnectionErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Status(code) => code.as_str(),
            Self::Transport(code) => code.as_str(),
        }
    }
}

impl fmt::Display for MobileConnectionErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A connection failure with a stable code the UI can act on and a message it can show.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct MobileConnectionError {
    pub code: MobileConnectionErrorCode,
    pub message: String,
    pub retryable: bool,
    pub detail: Option<String>,
}

impl MobileConnectionError {
    pub fn transport(
        code: MobileTransportFailureCode,
        message: impl Into<String>,
        retryable: bool,
        detail: Option<String>,
    ) -> Self {
        Self {
            code: MobileConnectionErrorCode::Transport(code),
            message: message.into(),
            retryable,
            detail,
        }
    }

    pub fn from_status(status: &MobileConnectionStatus) -> Self {
        Self {
            code: MobileConnectionErrorCode::Status(status.code),
            message: status.message.clone(),
            retryable: status.retryable,
            detail: None,
        }
    }
}

/// How far a failed connection got: no TCP connection, TCP open without a completed Noise
/// handshake, or an open channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportStage {
    Connect,
    Handshake,
    Session,
}

/// Classifies a socket that failed without a status frame.
pub fn classify_mobile_transport_failure(
    stage: TransportStage,
    endpoint: &str,
    cause: Option<&dyn fmt::Display>,
    timed_out: bool,
) -> MobileConnectionError {
    use MobileTransportFailureCode::*;
    let detail = cause.map(ToString::to_string);
    if timed_out {
        let message = match stage {
            TransportStage::Session => {
                "The Praxis desktop stopped responding. Reconnecting…".to_owned()
            }
            _ => format!(
                "No answer from the Praxis desktop at {endpoint}. Check that the phone and desktop are on the same network and that Mobile access is on."
            ),
        };
        return MobileConnectionError::transport(TimedOut, message, true, detail);
    }
    match stage {
        TransportStage::Connect => {
            let reason = detail
                .as_deref()
                .filter(|d| !d.is_empty())
                .map(|d| format!(" ({d})"))
                .unwrap_or_default();
            let message = format!(
                "Couldn’t reach the Praxis desktop at {endpoint}{reason}. Check that Praxis is running with Mobile access on, and that the phone is on the same network."
            );
            MobileConnectionError::transport(Unreachable, message, true, detail)
        }
        TransportStage::Handshake => MobileConnectionError::transport(
            HandshakeRejected,
            "The desktop closed the secure handshake. Its host key may have been reset, or this phone pinned a different desktop — scan a current pairing invitation from Settings → Mobile access.",
            false,
            detail,
        ),
        TransportStage::Session => MobileConnectionError::transport(
            ConnectionLost,
            "The connection to the Praxis desktop was lost. Reconnecting…",
            true,
            detail,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_defaults_fill_blank_messages_and_retryable_follows_the_code() {
        let status =
            mobile_connection_status(MobileConnectionStatusCode::HostShutdown, Some("   "));
        assert_eq!(
            status.message,
            "The Praxis desktop stopped its mobile listener."
        );
        assert!(status.retryable);
        let custom =
            mobile_connection_status(MobileConnectionStatusCode::PairingRejected, Some("  No.  "));
        assert_eq!(custom.message, "No.");
        assert!(!custom.retryable);
    }

    #[test]
    fn only_ready_and_pairing_in_progress_keep_the_connection() {
        let open: Vec<_> = MobileConnectionStatusCode::ALL
            .into_iter()
            .filter(|c| !c.is_terminal())
            .collect();
        assert_eq!(
            open,
            [
                MobileConnectionStatusCode::Ready,
                MobileConnectionStatusCode::PairingRequired,
                MobileConnectionStatusCode::PairingPending
            ]
        );
    }

    #[test]
    fn status_codes_round_trip_through_their_wire_names() {
        for code in MobileConnectionStatusCode::ALL {
            assert_eq!(MobileConnectionStatusCode::parse(code.as_str()), Some(code));
            assert_eq!(
                serde_json::to_value(code).expect("serialise"),
                json!(code.as_str())
            );
        }
        assert_eq!(MobileConnectionStatusCode::parse("nope"), None);
    }

    #[test]
    fn a_reply_keeps_null_distinct_from_absent() {
        let explicit =
            MobileServerFrame::decode(br#"{"id":"a","kind":"reply","ok":true,"value":null}"#)
                .expect("decode");
        let absent =
            MobileServerFrame::decode(br#"{"id":"a","kind":"reply","ok":true}"#).expect("decode");
        let Some(MobileServerFrame::Reply(explicit)) = explicit else {
            panic!("reply expected")
        };
        let Some(MobileServerFrame::Reply(absent)) = absent else {
            panic!("reply expected")
        };
        assert_eq!(explicit.value, Some(Value::Null));
        assert_eq!(absent.value, None);
        assert_eq!(
            MobileServerFrame::Reply(explicit).encode(),
            br#"{"id":"a","kind":"reply","ok":true,"value":null}"#
        );
        assert_eq!(
            MobileServerFrame::Reply(absent).encode(),
            br#"{"id":"a","kind":"reply","ok":true}"#
        );
    }

    #[test]
    fn an_unknown_frame_kind_is_ignored_and_an_unknown_reply_code_tolerated() {
        assert_eq!(
            MobileServerFrame::decode(br#"{"kind":"future-thing"}"#).expect("decode"),
            None
        );
        let decoded = MobileServerFrame::decode(
            br#"{"id":"x","kind":"reply","ok":false,"code":"brand-new","error":"e"}"#,
        )
        .expect("decode");
        let Some(MobileServerFrame::Reply(reply)) = decoded else {
            panic!("reply expected")
        };
        assert_eq!(reply.code, Some(MobileReplyErrorCode::Unknown));
    }

    #[test]
    fn an_unknown_status_code_is_a_decode_error() {
        assert!(
            MobileServerFrame::decode(
                br#"{"kind":"status","status":{"code":"nope","message":"","retryable":true}}"#
            )
            .is_err()
        );
        assert!(MobileServerFrame::decode(b"not json").is_err());
    }

    #[test]
    fn replay_results_use_camel_case() {
        let result: MobileReplayResult = serde_json::from_value(
            json!({"replaying": true, "latestSequence": 9, "truncated": true}),
        )
        .expect("decode");
        assert_eq!(result.latest_sequence, 9);
        assert_eq!(result.truncated, Some(true));
    }
}
