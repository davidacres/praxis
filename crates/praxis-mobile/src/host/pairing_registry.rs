//! The desktop pairing ledger (`apps/praxis-desktop/main/src/main/mobilePairingRegistry.ts` port,
//! plus the file persistence and unpaired-peer decision from `mobilePairingInstance.ts`).
//!
//! Trusted devices live on disk (`mobile-pairing.json`, `{"devices":[…]}` pretty-printed with two
//! spaces, as the TS writes it); the one active single-use invitation and in-flight confirmation
//! requests live in memory. An unknown phone only becomes a confirmation request by presenting the
//! current invitation's token over its authenticated channel — knowing the host key is not
//! enough — and the token is compared in constant time. Confirming one request consumes the
//! token, so every other request made with it is void.

use std::fs;
use std::io::Write as _;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

use super::access::MobileAccessMode;
use super::pairing::{
    MOBILE_PAIRING_TTL, MobileInvitationDetails, MobilePairedDevice, MobilePairingInvitation,
    MobilePairingPendingRequest, MobilePairingRequest, MobilePairingToken, authorize_mobile_peer,
    constant_time_eq, consume_mobile_pairing, create_mobile_pairing_invitation,
    is_active_pairing_token, issue_mobile_pairing_token, mobile_device_id_for_public_key,
    revoke_mobile_device,
};
use super::protocol::{MobileCapability, now_iso};
use crate::relay::hex;
use crate::wire::{MobileConnectionStatus, MobileConnectionStatusCode, mobile_connection_status};

/// Where the trusted-device list is kept.
pub trait MobilePairingPersist: Send {
    fn load(&self) -> Vec<MobilePairedDevice>;
    fn save(&self, devices: &[MobilePairedDevice]);
}

/// `mobile-pairing.json` in the app's data directory, written exactly as the TS writes it.
pub struct JsonFilePairingPersist {
    pub path: PathBuf,
}

impl JsonFilePairingPersist {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

#[derive(Deserialize)]
struct PairingFile {
    #[serde(default)]
    devices: Value,
}

/// The file's JSON: `JSON.stringify({ devices }, null, 2)`.
pub fn encode_pairing_file(devices: &[MobilePairedDevice]) -> String {
    #[derive(serde::Serialize)]
    struct Out<'a> {
        devices: &'a [MobilePairedDevice],
    }
    serde_json::to_string_pretty(&Out { devices }).unwrap_or_else(|_| "{\"devices\": []}".into())
}

/// Reads the file's devices; anything unreadable is "no devices", as in the TS.
pub fn decode_pairing_file(text: &str) -> Vec<MobilePairedDevice> {
    let Ok(file) = serde_json::from_str::<PairingFile>(text) else {
        return Vec::new();
    };
    match file.devices {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| serde_json::from_value(item).ok())
            .collect(),
        _ => Vec::new(),
    }
}

impl MobilePairingPersist for JsonFilePairingPersist {
    fn load(&self) -> Vec<MobilePairedDevice> {
        fs::read_to_string(&self.path)
            .map(|text| decode_pairing_file(&text))
            .unwrap_or_default()
    }

    fn save(&self, devices: &[MobilePairedDevice]) {
        // Best effort, like the TS: a failed write leaves the in-memory list authoritative.
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let temp = self.path.with_extension("json.tmp");
        let written = fs::File::create(&temp)
            .and_then(|mut file| file.write_all(encode_pairing_file(devices).as_bytes()));
        if written.is_ok() {
            let _ = fs::rename(&temp, &self.path);
        } else {
            let _ = fs::remove_file(&temp);
        }
    }
}

/// Why an unknown peer's token did not create a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MobileSubmitRefusal {
    NoInvitation,
    Expired,
    Used,
    InvalidToken,
}

impl MobileSubmitRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoInvitation => "no-invitation",
            Self::Expired => "expired",
            Self::Used => "used",
            Self::InvalidToken => "invalid-token",
        }
    }
}

/// What the desktop grants when it confirms a phone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MobilePairingGrant {
    pub label: Option<String>,
    pub capabilities: Vec<MobileCapability>,
    pub project_ids: Vec<String>,
}

pub struct MobilePairingRegistry {
    persist: Box<dyn MobilePairingPersist>,
    devices: Vec<MobilePairedDevice>,
    token: Option<MobilePairingToken>,
    pending: IndexMap<String, MobilePairingPendingRequest>,
    superseded: Vec<MobilePairingPendingRequest>,
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::getrandom(&mut buffer).expect("the OS random source is available");
    hex(&buffer)
}

impl MobilePairingRegistry {
    pub fn new(persist: Box<dyn MobilePairingPersist>) -> Self {
        let devices = persist.load();
        Self {
            persist,
            devices,
            token: None,
            pending: IndexMap::new(),
            superseded: Vec::new(),
        }
    }

    pub fn list_devices(&self) -> &[MobilePairedDevice] {
        &self.devices
    }

    /// Waiting requests, oldest first.
    pub fn list_pending(&self) -> Vec<MobilePairingPendingRequest> {
        let mut pending: Vec<_> = self.pending.values().cloned().collect();
        pending.sort_by(|left, right| left.requested_at.cmp(&right.requested_at));
        pending
    }

    pub fn active_invitation(
        &self,
        now: &str,
        details: &MobileInvitationDetails,
    ) -> Option<MobilePairingInvitation> {
        let token = self.token.as_ref()?;
        is_active_pairing_token(Some(token), now)
            .then(|| create_mobile_pairing_invitation(token, details))
    }

    /// A new invitation voids the old one and every request waiting on it.
    pub fn issue_invitation(
        &mut self,
        host_id: &str,
        details: &MobileInvitationDetails,
        now: DateTime<Utc>,
    ) -> MobilePairingInvitation {
        let token_id = random_hex(6);
        let token = issue_mobile_pairing_token(host_id, &token_id, now, MOBILE_PAIRING_TTL, None);
        let invitation = create_mobile_pairing_invitation(&token, details);
        self.token = Some(token);
        self.pending.clear();
        invitation
    }

    pub fn authorize(&self, public_key_hex: &str, now: &str) -> Option<&MobilePairedDevice> {
        authorize_mobile_peer(&self.devices, public_key_hex, now)
    }

    pub fn has_active_invitation(&self, now: &str) -> bool {
        is_active_pairing_token(self.token.as_ref(), now)
    }

    /// True when this key belonged to a device the desktop revoked (and it has not re-paired).
    pub fn was_revoked(&self, public_key_hex: &str) -> bool {
        let needle = public_key_hex.to_lowercase();
        let mut matches = self.devices.iter().filter(|device| {
            device
                .public_key_hex
                .as_deref()
                .is_some_and(|key| key.to_lowercase() == needle)
        });
        let mut any = false;
        let all_revoked = matches.all(|device| {
            any = true;
            device.revoked_at.is_some()
        });
        any && all_revoked
    }

    /// An unknown peer presenting `token_id`. Only the current, unexpired, unconsumed
    /// invitation's token creates (or returns the existing) confirmation request for that key.
    pub fn submit_unpaired(
        &mut self,
        public_key_hex: &str,
        token_id: &str,
        now: &str,
    ) -> Result<MobilePairingPendingRequest, MobileSubmitRefusal> {
        let Some(token) = self.token.as_ref() else {
            return Err(MobileSubmitRefusal::NoInvitation);
        };
        if !constant_time_eq(token.token_id.as_bytes(), token_id.trim().as_bytes()) {
            return Err(MobileSubmitRefusal::InvalidToken);
        }
        if token.consumed_at.is_some() {
            return Err(MobileSubmitRefusal::Used);
        }
        if !is_active_pairing_token(Some(token), now) {
            return Err(MobileSubmitRefusal::Expired);
        }
        let needle = public_key_hex.to_lowercase();
        if let Some(existing) = self
            .pending
            .values()
            .find(|request| request.device_public_key.to_lowercase() == needle)
        {
            return Ok(existing.clone());
        }
        let request = MobilePairingPendingRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            token_id: token.token_id.clone(),
            host_id: token.host_id.clone(),
            device_id: mobile_device_id_for_public_key(public_key_hex),
            device_public_key: public_key_hex.to_owned(),
            device_label: format!(
                "Phone {}",
                public_key_hex.chars().take(6).collect::<String>()
            ),
            requested_at: now.to_owned(),
        };
        self.pending
            .insert(request.request_id.clone(), request.clone());
        Ok(request)
    }

    /// Consumes the invitation token and trusts the phone. `Err` carries the TS reason string.
    pub fn confirm(
        &mut self,
        request_id: &str,
        grant: &MobilePairingGrant,
        now: &str,
    ) -> Result<MobilePairedDevice, String> {
        let Some(pending) = self.pending.get(request_id).cloned() else {
            return Err("unknown-request".to_owned());
        };
        let request = MobilePairingRequest {
            token_id: pending.token_id.clone(),
            host_id: pending.host_id.clone(),
            device_id: pending.device_id.clone(),
            device_public_key: pending.device_public_key.clone(),
            project_ids: grant.project_ids.clone(),
            proof: pending.device_public_key.clone(),
            requested_at: pending.requested_at.clone(),
        };
        let (device_id, project_ids) = consume_mobile_pairing(
            &mut self.token,
            |request, _| request.device_public_key == pending.device_public_key,
            |_| true,
            &request,
            now,
        )
        .map_err(|failure| failure.as_str().to_owned())?;
        self.pending.shift_remove(request_id);
        let (superseded, kept): (Vec<_>, Vec<_>) = self
            .pending
            .drain(..)
            .partition(|(_, other)| other.token_id == pending.token_id);
        self.pending.extend(kept);
        self.superseded = superseded.into_iter().map(|(_, request)| request).collect();
        let label = grant
            .label
            .as_deref()
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map_or_else(|| pending.device_label.clone(), str::to_owned);
        let device = MobilePairedDevice {
            device_id,
            label,
            paired_at: now.to_owned(),
            public_key_hex: Some(pending.device_public_key.clone()),
            capabilities: Some(
                grant
                    .capabilities
                    .iter()
                    .map(|c| c.as_str().to_owned())
                    .collect(),
            ),
            project_ids: Some(project_ids),
            ..MobilePairedDevice::default()
        };
        self.devices
            .retain(|item| item.device_id != device.device_id);
        self.devices.push(device.clone());
        self.persist.save(&self.devices);
        Ok(device)
    }

    /// Requests voided by the last confirm (same single-use token); cleared when read.
    pub fn take_superseded(&mut self) -> Vec<MobilePairingPendingRequest> {
        std::mem::take(&mut self.superseded)
    }

    pub fn deny(&mut self, request_id: &str) -> bool {
        self.pending.shift_remove(request_id).is_some()
    }

    pub fn revoke(&mut self, device_id: &str, now: &str) -> Option<MobilePairedDevice> {
        let before = self
            .devices
            .iter()
            .find(|device| device.device_id == device_id)
            .cloned();
        self.devices = revoke_mobile_device(&self.devices, device_id, now);
        self.persist.save(&self.devices);
        self.devices
            .iter()
            .find(|device| device.device_id == device_id)
            .cloned()
            .or(before)
    }

    /// After a host-key reset every phone must re-pair.
    pub fn revoke_all(&mut self, now: &str) {
        for device in &mut self.devices {
            if device.revoked_at.is_none() {
                device.revoked_at = Some(now.to_owned());
            }
        }
        self.token = None;
        self.pending.clear();
        self.persist.save(&self.devices);
    }

    pub fn touch(&mut self, public_key_hex: &str, now: &str) {
        let Some(device_id) = self
            .authorize(public_key_hex, now)
            .map(|device| device.device_id.clone())
        else {
            return;
        };
        for device in &mut self.devices {
            if device.device_id == device_id {
                device.last_seen_at = Some(now.to_owned());
            }
        }
        self.persist.save(&self.devices);
    }
}

/// `mobileOnUnpairedPeer`: the listener's answer to an unknown phone key. At handshake
/// (`token_id` `None`) the phone is asked for its invitation — or told it was revoked; with a
/// token, the registry decides whether it becomes a confirmation request. `host_label` is the
/// configured host name, falling back to the machine name.
pub fn unpaired_peer_status(
    registry: &mut MobilePairingRegistry,
    mode: MobileAccessMode,
    host_label: &str,
    public_key_hex: &str,
    token_id: Option<&str>,
) -> MobileConnectionStatus {
    use MobileConnectionStatusCode as Code;
    if mode == MobileAccessMode::Off {
        return mobile_connection_status(Code::AccessDisabled, None);
    }
    let now = now_iso();
    let Some(token_id) = token_id else {
        return if registry.was_revoked(public_key_hex) && !registry.has_active_invitation(&now) {
            mobile_connection_status(Code::DeviceRevoked, None)
        } else {
            mobile_connection_status(Code::PairingRequired, None)
        };
    };
    match registry.submit_unpaired(public_key_hex, token_id, &now) {
        Err(MobileSubmitRefusal::Expired) => {
            mobile_connection_status(Code::InvitationExpired, None)
        }
        Err(MobileSubmitRefusal::Used) => mobile_connection_status(Code::InvitationUsed, None),
        Err(MobileSubmitRefusal::NoInvitation) => mobile_connection_status(
            Code::InvitationExpired,
            Some(
                "The desktop is not offering a pairing invitation right now. Create one in Settings → Mobile access and scan it again.",
            ),
        ),
        Err(MobileSubmitRefusal::InvalidToken) => {
            mobile_connection_status(Code::InvitationInvalid, None)
        }
        Ok(request) => {
            let host = if host_label.trim().is_empty() {
                "the desktop"
            } else {
                host_label.trim()
            };
            mobile_connection_status(
                Code::PairingPending,
                Some(&format!(
                    "Waiting for confirmation on {host}. Open Settings → Mobile access and confirm “{}”.",
                    request.device_label
                )),
            )
        }
    }
}

#[cfg(test)]
mod tests;
