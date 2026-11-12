use std::fs;
use std::path::Path;

use praxis_host::HostContext;
use serde_json::{Value, json};
use uuid::Uuid;

use super::storage::{Catalog, parse, read, write_atomic};
use super::{Result, failure, now, text};

fn mobile_pairing_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("mobile-pairing.json")
}

fn default_mobile_info() -> Value {
    json!({
        "hostId": "praxis-host",
        "hostName": "Praxis Desktop",
        "port": 47833,
        "advertised": false,
        "status": "listening",
        "devices": [],
        "pendingInvitations": [],
        "lanInterfaces": [],
        "pairingCode": Value::Null
    })
}

fn read_mobile_info(user_data_dir: &Path) -> Result<Value> {
    let path = mobile_pairing_file(user_data_dir);
    if let Some(content) = read(&path)? {
        let val = parse(&path, Some(&content))?;
        if val.is_object() {
            return Ok(val);
        }
    }
    Ok(default_mobile_info())
}

fn save_mobile_info(user_data_dir: &Path, value: &Value) -> Result<()> {
    let path = mobile_pairing_file(user_data_dir);
    let encoded = super::storage::encoded(value)?;
    write_atomic(&path, &encoded, false)
}

pub fn dispatch(
    host: &HostContext,
    catalog: &mut Catalog,
    user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "settings:getMobileHostInfo" => read_mobile_info(user_data_dir),
        "settings:publishMobileAppearance" => {
            let appearance = args.first().cloned().unwrap_or(Value::Null);
            let path = user_data_dir.join("mobile-appearance.json");
            let encoded = super::storage::encoded(&appearance)?;
            write_atomic(&path, &encoded, false)?;
            host.events()
                .emit("mobile:appearanceChanged", Some(appearance));
            Ok(Value::Null)
        }
        "settings:createMobilePairingInvitation" => {
            let mut info = read_mobile_info(user_data_dir)?;
            let code = format!("{:06}", (Uuid::new_v4().as_u128() % 1_000_000) as u32);
            let invitation_id = format!("inv-{}", Uuid::new_v4());
            let invitation = json!({
                "id": invitation_id,
                "code": code,
                "createdAt": now()
            });
            if let Some(invs) = info
                .get_mut("pendingInvitations")
                .and_then(Value::as_array_mut)
            {
                invs.push(invitation);
            } else {
                info["pendingInvitations"] = json!([invitation]);
            }
            info["pairingCode"] = json!(code);
            save_mobile_info(user_data_dir, &info)?;
            Ok(info)
        }
        "settings:confirmMobilePairing" => {
            let request_id = text(args, 0)?;
            let grant = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let mut info = read_mobile_info(user_data_dir)?;
            if let Some(invs) = info
                .get_mut("pendingInvitations")
                .and_then(Value::as_array_mut)
            {
                invs.retain(|inv| inv["id"] != request_id && inv["code"] != request_id);
            }
            let device = json!({
                "id": format!("dev-{}", Uuid::new_v4()),
                "name": grant.get("label").and_then(Value::as_str).unwrap_or("Mobile device"),
                "pairedAt": now(),
                "capabilities": grant.get("capabilities").cloned().unwrap_or_else(|| json!([])),
                "projectIds": grant.get("projectIds").cloned().unwrap_or_else(|| json!([]))
            });
            if let Some(devices) = info.get_mut("devices").and_then(Value::as_array_mut) {
                devices.push(device);
            } else {
                info["devices"] = json!([device]);
            }
            save_mobile_info(user_data_dir, &info)?;
            Ok(info)
        }
        "settings:denyMobilePairing" => {
            let request_id = text(args, 0)?;
            let mut info = read_mobile_info(user_data_dir)?;
            if let Some(invs) = info
                .get_mut("pendingInvitations")
                .and_then(Value::as_array_mut)
            {
                invs.retain(|inv| inv["id"] != request_id && inv["code"] != request_id);
            }
            save_mobile_info(user_data_dir, &info)?;
            Ok(info)
        }
        "settings:revokeMobilePairedDevice" => {
            let device_id = text(args, 0)?;
            let mut info = read_mobile_info(user_data_dir)?;
            if let Some(devices) = info.get_mut("devices").and_then(Value::as_array_mut) {
                devices.retain(|d| d["id"] != device_id);
            }
            save_mobile_info(user_data_dir, &info)?;
            Ok(info)
        }
        "settings:rotateMobileHostKey" => {
            let mut info = read_mobile_info(user_data_dir)?;
            let new_host_id = format!("host-{}", Uuid::new_v4());
            info["hostId"] = json!(new_host_id);
            save_mobile_info(user_data_dir, &info)?;
            Ok(info)
        }
        "settings:clearSessionData" => {
            for file in [
                "ai-sessions.json",
                "ai-analysis.json",
                "session-feedback.json",
            ] {
                let _ = fs::remove_file(user_data_dir.join(file));
            }
            let _ = fs::remove_dir_all(user_data_dir.join("ai-transcripts"));
            Ok(Value::Null)
        }
        "settings:clearProjectWorkspaceBoardData" => {
            catalog.set("boards", vec![], None);
            for file in [
                "workspaces.json",
                "workspace-locations.json",
                "projects.json",
                "board-preferences.json",
                "task-designer.json",
            ] {
                let _ = fs::remove_file(user_data_dir.join(file));
            }
            let _ = fs::remove_dir_all(user_data_dir.join("projects"));
            host.events().emit("board:changed", Some(Value::Null));
            Ok(Value::Null)
        }
        "update:getStatus" | "update:check" | "update:download" | "update:installNow" => {
            Ok(json!({
                "state": "unsupported",
                "reason": "Updates are only checked in a packaged build."
            }))
        }
        "coordination:state" => Ok(json!({
            "state": {
                "schemaVersion": 1,
                "epoch": "tauri-unavailable",
                "revision": 0,
                "sequence": 0,
                "sessions": {},
                "claims": [],
                "waiters": [],
                "events": []
            },
            "role": "follower",
            "blockedReason": "The coordination broker is not connected in this Tauri build."
        })),
        "coordination:recover" => Ok(Value::Null),
        "coordination:stopService" => {
            if let Some(pgid) = args.first().and_then(Value::as_i64)
                && pgid > 1
            {
                #[cfg(unix)]
                {
                    let _ = std::process::Command::new("kill")
                        .arg("-TERM")
                        .arg(format!("-{pgid}"))
                        .status();
                }
                return Ok(json!(true));
            }
            Ok(json!(false))
        }
        _ => Err(failure("Unknown system operation.")),
    }
}
