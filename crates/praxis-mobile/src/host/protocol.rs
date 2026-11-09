//! The mobile read/command contracts a desktop host serves (`packages/core/src/host/mobileProtocol.ts`
//! port, the parts the host side needs).
//!
//! Field names and order match what the TypeScript writes, so an envelope or reply built here is
//! byte-identical on the wire. Operation payloads and results stay `serde_json::Value`.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MOBILE_PROTOCOL_VERSION: u64 = 1;

/// Additive revision of the v1 read/command surface (see the TS doc comment for the history).
pub const MOBILE_HOST_SURFACE_REVISION: u64 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MobileCapability {
    View,
    Execute,
    Approve,
}

impl MobileCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::View => "view",
            Self::Execute => "execute",
            Self::Approve => "approve",
        }
    }
}

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum $name { $($variant),+ }

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }

            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some(Self::$variant),)+ _ => None }
            }
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = String::deserialize(deserializer)?;
                Self::parse(&text).ok_or_else(|| {
                    serde::de::Error::custom(format!("unknown {}: {text}", stringify!($name)))
                })
            }
        }
    };
}

string_enum!(
    /// A read a phone may make.
    MobileReadOperation {
        ScheduledRunsList = "scheduledRuns.list",
        HostsList = "hosts.list",
        HostInfo = "host.info",
        ProjectsSnapshot = "projects.snapshot",
        WorkList = "work.list",
        SessionsList = "sessions.list",
        SessionsGet = "sessions.get",
        SessionsUsage = "sessions.usage",
        WorkflowsList = "workflows.list",
        WorkflowRunsList = "workflowRuns.list",
        WorkflowRunsGet = "workflowRuns.get",
        ChangesGet = "changes.get",
        AttentionList = "attention.list",
        ProvidersList = "providers.list",
        ModelsList = "models.list",
        AccessGet = "access.get",
        SessionsImagePreview = "sessions.imagePreview",
    }
);

string_enum!(
    /// A command (a mutation) a phone may issue.
    MobileCommandOperation {
        ScheduledRunsSave = "scheduledRuns.save",
        ScheduledRunsSetArmed = "scheduledRuns.setArmed",
        ScheduledRunsResolveMissed = "scheduledRuns.resolveMissed",
        SessionsCreate = "sessions.create",
        SessionsContinue = "sessions.continue",
        SessionsCancel = "sessions.cancel",
        SessionsConfigure = "sessions.configure",
        WorkflowRunsStart = "workflowRuns.start",
        WorkflowRunsCancel = "workflowRuns.cancel",
        WorkflowRunsRetryStage = "workflowRuns.retryStage",
        PermissionsRespond = "permissions.respond",
        WorkflowGatesApprove = "workflowGates.approve",
        WorkflowGatesReject = "workflowGates.reject",
        GadgetsSubmit = "gadgets.submit",
    }
);

impl MobileReadOperation {
    /// Every read is a `view`.
    pub fn capability(self) -> MobileCapability {
        MobileCapability::View
    }

    /// Reads that need no project in a project-scoped grant (the LAN listener's `unscoped` list).
    pub fn is_unscoped(self) -> bool {
        matches!(
            self,
            Self::HostsList
                | Self::ProjectsSnapshot
                | Self::HostInfo
                | Self::ProvidersList
                | Self::ModelsList
                | Self::AccessGet
        )
    }
}

impl MobileCommandOperation {
    pub fn capability(self) -> MobileCapability {
        match self {
            Self::PermissionsRespond | Self::WorkflowGatesApprove | Self::WorkflowGatesReject => {
                MobileCapability::Approve
            }
            // Answering a gadget is a turn in the conversation; an approval-effect answer
            // additionally needs `approve`, checked by the host.
            _ => MobileCapability::Execute,
        }
    }

    /// Every command mutates, so every command must name a project.
    pub fn requires_mutation(self) -> bool {
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileCaller {
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<MobileCapability>,
}

impl MobileCaller {
    pub fn has(&self, capability: MobileCapability) -> bool {
        self.capabilities.contains(&capability)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileTarget {
    #[serde(default)]
    pub host_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl MobileTarget {
    pub fn host(host_id: impl Into<String>) -> Self {
        Self {
            host_id: host_id.into(),
            ..Self::default()
        }
    }

    /// The trimmed project id, `None` when absent or blank.
    pub fn project(&self) -> Option<&str> {
        trimmed(self.project_id.as_deref())
    }
}

pub(crate) fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileCommand {
    #[serde(default)]
    pub protocol_version: u64,
    pub command_id: String,
    pub issued_at: String,
    pub caller: MobileCaller,
    pub target: MobileTarget,
    pub operation: MobileCommandOperation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<i64>,
    #[serde(default)]
    pub payload: Value,
}

impl MobileCommand {
    /// A top-level payload field, `None` when the payload is not an object or lacks it.
    pub fn payload_field(&self, key: &str) -> Option<&Value> {
        self.payload
            .as_object()
            .and_then(|payload| payload.get(key))
    }
}

/// Operation-specific read arguments for model, diff, and image-preview reads.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Base64 character offset for a chunked `sessions.imagePreview` response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_index: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_index: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileReadRequest {
    #[serde(default)]
    pub protocol_version: u64,
    #[serde(default)]
    pub request_id: String,
    pub caller: MobileCaller,
    pub target: MobileTarget,
    pub operation: MobileReadOperation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<MobileReadParams>,
}

/// One entry in the host's event log, pushed to phones as `{kind:"event", envelope}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileEventEnvelope {
    pub protocol_version: u64,
    pub event_id: String,
    pub sequence: u64,
    pub emitted_at: String,
    pub target: MobileTarget,
    pub event: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileProtocolErrorCode {
    UnsupportedVersion,
    InvalidEnvelope,
    Unauthenticated,
    Forbidden,
    StaleVersion,
    DuplicateCommand,
    CommandConflict,
    NotFound,
    HostOffline,
    CursorExpired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct MobileProtocolError {
    pub code: MobileProtocolErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_version: Option<i64>,
}

impl MobileProtocolError {
    pub(crate) fn for_command(
        code: MobileProtocolErrorCode,
        message: impl Into<String>,
        retryable: bool,
        command_id: &str,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            command_id: Some(command_id.to_owned()),
            current_version: None,
        }
    }
}

static COMMAND_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$").expect("valid regex"));
static DEVICE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$").expect("valid regex"));
static ISO_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$").expect("valid regex")
});

/// `validateMobileCommand`: version, identity, capability and project scope, in that order.
pub fn validate_mobile_command(command: &MobileCommand) -> Result<(), MobileProtocolError> {
    let id = command.command_id.as_str();
    if command.protocol_version != MOBILE_PROTOCOL_VERSION {
        return Err(MobileProtocolError::for_command(
            MobileProtocolErrorCode::UnsupportedVersion,
            format!(
                "Protocol version {} is not supported.",
                command.protocol_version
            ),
            false,
            id,
        ));
    }
    if !COMMAND_ID.is_match(id) || !ISO_DATE.is_match(&command.issued_at) {
        return Err(MobileProtocolError::for_command(
            MobileProtocolErrorCode::InvalidEnvelope,
            "Command identity and issuedAt must be valid.",
            false,
            id,
        ));
    }
    if !DEVICE_ID.is_match(&command.caller.device_id) || command.target.host_id.trim().is_empty() {
        return Err(MobileProtocolError::for_command(
            MobileProtocolErrorCode::InvalidEnvelope,
            "Caller device and host identity are required.",
            false,
            id,
        ));
    }
    let capability = command.operation.capability();
    if !command.caller.has(capability) {
        return Err(MobileProtocolError::for_command(
            MobileProtocolErrorCode::Forbidden,
            format!("The caller lacks the {} capability.", capability.as_str()),
            false,
            id,
        ));
    }
    // TS checks truthiness, so an empty string is "missing" but whitespace is not.
    if command.operation.requires_mutation()
        && command
            .target
            .project_id
            .as_deref()
            .is_none_or(str::is_empty)
    {
        return Err(MobileProtocolError::for_command(
            MobileProtocolErrorCode::InvalidEnvelope,
            "Mutating commands must identify a project.",
            false,
            id,
        ));
    }
    Ok(())
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn command(operation: &str, capabilities: &[&str]) -> MobileCommand {
        serde_json::from_value(json!({
            "protocolVersion": 1,
            "commandId": "command-0001",
            "issuedAt": "2026-09-22T09:00:00.000Z",
            "caller": { "deviceId": "phone-1", "capabilities": capabilities },
            "target": { "hostId": "host", "projectId": "p1" },
            "operation": operation,
            "payload": {}
        }))
        .expect("command parses")
    }

    #[test]
    fn operations_round_trip_their_wire_names() {
        for operation in MobileReadOperation::ALL {
            assert_eq!(
                MobileReadOperation::parse(operation.as_str()),
                Some(*operation)
            );
        }
        for operation in MobileCommandOperation::ALL {
            assert_eq!(
                MobileCommandOperation::parse(operation.as_str()),
                Some(*operation)
            );
        }
        assert_eq!(MobileReadOperation::parse("nope"), None);
    }

    #[test]
    fn validation_checks_version_identity_capability_and_project() {
        assert!(validate_mobile_command(&command("sessions.create", &["execute"])).is_ok());
        let mut wrong = command("sessions.create", &["execute"]);
        wrong.protocol_version = 2;
        assert_eq!(
            validate_mobile_command(&wrong).map_err(|e| e.code),
            Err(MobileProtocolErrorCode::UnsupportedVersion)
        );
        let mut short = command("sessions.create", &["execute"]);
        short.command_id = "short".into();
        assert_eq!(
            validate_mobile_command(&short).map_err(|e| e.code),
            Err(MobileProtocolErrorCode::InvalidEnvelope)
        );
        let forbidden = validate_mobile_command(&command("permissions.respond", &["execute"]))
            .expect_err("needs approve");
        assert_eq!(
            forbidden.message,
            "The caller lacks the approve capability."
        );
        let mut unscoped = command("sessions.cancel", &["execute"]);
        unscoped.target.project_id = None;
        assert_eq!(
            validate_mobile_command(&unscoped).map_err(|e| e.message),
            Err("Mutating commands must identify a project.".to_owned())
        );
    }

    #[test]
    fn an_envelope_serialises_in_the_ts_field_order() {
        let envelope = MobileEventEnvelope {
            protocol_version: 1,
            event_id: "e".into(),
            sequence: 3,
            emitted_at: "t".into(),
            target: MobileTarget {
                host_id: "h".into(),
                project_id: Some("p".into()),
                session_id: Some("s".into()),
                ..MobileTarget::default()
            },
            event: json!({ "type": "x" }),
        };
        assert_eq!(
            serde_json::to_string(&envelope).expect("serialises"),
            r#"{"protocolVersion":1,"eventId":"e","sequence":3,"emittedAt":"t","target":{"hostId":"h","projectId":"p","sessionId":"s"},"event":{"type":"x"}}"#
        );
    }
}
