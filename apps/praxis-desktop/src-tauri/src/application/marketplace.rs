use std::path::Path;

use praxis_host::HostContext;
use serde_json::{Value, json};

use super::storage::{parse, read, write_atomic};
use super::{Result, failure, now, text};

const TOKEN_KEY: &str = "marketplace:githubToken";

fn marketplace_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("marketplace.json")
}

fn installed_addons_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("installed-addons.json")
}

fn read_installed(user_data_dir: &Path) -> Result<Vec<Value>> {
    let mut results = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    // 1. Scan filesystem under <user_data_dir>/addons/<kind>/<id>/.praxis-addon.json
    let addons_dir = user_data_dir.join("addons");
    if addons_dir.is_dir()
        && let Ok(kinds) = std::fs::read_dir(&addons_dir)
    {
        for kind_entry in kinds.flatten() {
            let kind_path = kind_entry.path();
            if kind_path.is_dir()
                && let Ok(addons) = std::fs::read_dir(&kind_path)
            {
                for addon_entry in addons.flatten() {
                    let addon_dir = addon_entry.path();
                    let meta_file = addon_dir.join(".praxis-addon.json");
                    if meta_file.is_file()
                        && let Ok(content) = std::fs::read_to_string(&meta_file)
                        && let Ok(mut addon_record) = serde_json::from_str::<Value>(&content)
                    {
                        let kind = addon_record["manifest"]["kind"]
                            .as_str()
                            .or_else(|| kind_path.file_name().and_then(|n| n.to_str()))
                            .unwrap_or("theme")
                            .to_string();
                        let id = addon_record["manifest"]["id"]
                            .as_str()
                            .or_else(|| addon_dir.file_name().and_then(|n| n.to_str()))
                            .unwrap_or("")
                            .to_string();
                        if !id.is_empty() {
                            seen_ids.insert(format!("{kind}:{id}"));
                            if addon_record.get("manifest").is_none() {
                                addon_record["manifest"] = json!({});
                            }
                            addon_record["manifest"]["id"] = json!(id);
                            addon_record["manifest"]["kind"] = json!(kind);
                            results.push(addon_record);
                        }
                    }
                }
            }
        }
    }

    // 2. Secondary fallback from installed-addons.json if present
    let path = installed_addons_file(user_data_dir);
    if let Some(content) = read(&path)? {
        let val = parse(&path, Some(&content))?;
        if let Some(list) = val.get("installed").and_then(Value::as_array) {
            for item in list {
                let kind = item["manifest"]["kind"].as_str().unwrap_or("");
                let id = item["manifest"]["id"].as_str().unwrap_or("");
                if !seen_ids.contains(&format!("{kind}:{id}")) {
                    results.push(item.clone());
                }
            }
        }
    }
    Ok(results)
}

fn read_active_appearance(user_data_dir: &Path) -> Result<Value> {
    let mut themes = Vec::new();
    let mut surface_packs = Vec::new();

    let addons_dir = user_data_dir.join("addons");
    if addons_dir.is_dir() {
        // Scan themes: <user_data_dir>/addons/theme/<id>/theme.json
        let themes_dir = addons_dir.join("theme");
        if themes_dir.is_dir()
            && let Ok(entries) = std::fs::read_dir(&themes_dir)
        {
            for entry in entries.flatten() {
                let dir = entry.path();
                let meta_file = dir.join(".praxis-addon.json");
                let theme_file = dir.join("theme.json");
                if dir.is_dir() && theme_file.is_file() {
                    let enabled = if meta_file.is_file() {
                        std::fs::read_to_string(&meta_file)
                            .ok()
                            .and_then(|c| serde_json::from_str::<Value>(&c).ok())
                            .and_then(|v| v.get("enabled").and_then(Value::as_bool))
                            .unwrap_or(true)
                    } else {
                        true
                    };
                    if enabled {
                        let id = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        if let Ok(theme_content) = std::fs::read_to_string(&theme_file)
                            && let Ok(mut theme_val) = serde_json::from_str::<Value>(&theme_content)
                        {
                            theme_val["id"] = json!(id);
                            if theme_val.get("name").is_none() {
                                theme_val["name"] = json!(id);
                            }
                            themes.push(theme_val);
                        }
                    }
                }
            }
        }

        // Scan surface packs: <user_data_dir>/addons/surface-pack/<id>/pack.json
        let packs_dir = addons_dir.join("surface-pack");
        if packs_dir.is_dir()
            && let Ok(entries) = std::fs::read_dir(&packs_dir)
        {
            for entry in entries.flatten() {
                let dir = entry.path();
                let meta_file = dir.join(".praxis-addon.json");
                let pack_file = dir.join("pack.json");
                if dir.is_dir() && pack_file.is_file() {
                    let enabled = if meta_file.is_file() {
                        std::fs::read_to_string(&meta_file)
                            .ok()
                            .and_then(|c| serde_json::from_str::<Value>(&c).ok())
                            .and_then(|v| v.get("enabled").and_then(Value::as_bool))
                            .unwrap_or(true)
                    } else {
                        true
                    };
                    if enabled {
                        let id = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        if let Ok(pack_content) = std::fs::read_to_string(&pack_file)
                            && let Ok(mut pack_val) = serde_json::from_str::<Value>(&pack_content)
                        {
                            pack_val["id"] = json!(id);
                            surface_packs.push(pack_val);
                        }
                    }
                }
            }
        }
    }

    // Also include any fallback active themes/packs from installed-addons.json
    let fallback = read_installed(user_data_dir)?;
    for item in fallback {
        if item.get("enabled").and_then(Value::as_bool).unwrap_or(true)
            && let Some(kind) = item["manifest"]["kind"].as_str()
        {
            match kind {
                "theme" => {
                    let id = item["manifest"]["id"].as_str().unwrap_or("");
                    if !themes.iter().any(|t| t["id"] == id) {
                        let mut theme = item.clone();
                        theme["id"] = json!(id);
                        themes.push(theme);
                    }
                }
                "surface-pack" => {
                    let id = item["manifest"]["id"].as_str().unwrap_or("");
                    if !surface_packs.iter().any(|p| p["id"] == id) {
                        let mut pack = item.clone();
                        pack["id"] = json!(id);
                        surface_packs.push(pack);
                    }
                }
                _ => {}
            }
        }
    }

    Ok(json!({
        "themes": themes,
        "surfacePacks": surface_packs
    }))
}

fn save_installed(user_data_dir: &Path, list: &[Value]) -> Result<()> {
    let path = installed_addons_file(user_data_dir);
    let encoded = super::storage::encoded(&json!({ "installed": list }))?;
    write_atomic(&path, &encoded, false)
}

pub fn dispatch(
    host: &HostContext,
    user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "marketplace:getStatus" => {
            let path = marketplace_file(user_data_dir);
            let mut cfg = json!({
                "ready": false,
                "enabled": false,
                "owner": "",
                "ownerType": "user",
                "packageNamePrefix": "@praxis-addon/",
                "apiBaseUrl": "https://api.github.com",
                "registryBaseUrl": "https://npm.pkg.github.com",
                "checkOnLaunch": false,
                "hasToken": false
            });
            if let Some(content) = read(&path)?
                && let Ok(saved) = parse(&path, Some(&content))
                && let Some(obj) = saved.as_object()
            {
                for (k, v) in obj {
                    cfg[k] = v.clone();
                }
            }
            let has_token = host.secrets().has(TOKEN_KEY)
                || std::env::var("PRAXIS_MARKETPLACE_TOKEN").is_ok_and(|t| !t.trim().is_empty());
            cfg["hasToken"] = json!(has_token);
            let enabled = cfg["enabled"].as_bool().unwrap_or(false);
            let owner = cfg["owner"].as_str().unwrap_or("").trim();
            cfg["ready"] = json!(enabled && !owner.is_empty() && has_token);
            Ok(cfg)
        }
        "marketplace:configure" => {
            let patch = args.first().cloned().unwrap_or_else(|| json!({}));
            let path = marketplace_file(user_data_dir);
            let mut cfg = json!({
                "enabled": false,
                "owner": "",
                "ownerType": "user",
                "packageNamePrefix": "@praxis-addon/",
                "apiBaseUrl": "https://api.github.com",
                "registryBaseUrl": "https://npm.pkg.github.com",
                "checkOnLaunch": false
            });
            if let Some(content) = read(&path)?
                && let Ok(saved) = parse(&path, Some(&content))
                && let Some(obj) = saved.as_object()
            {
                for (k, v) in obj {
                    cfg[k] = v.clone();
                }
            }
            if let Some(patch_obj) = patch.as_object() {
                for (k, v) in patch_obj {
                    cfg[k] = v.clone();
                }
            }
            let encoded = super::storage::encoded(&cfg)?;
            write_atomic(&path, &encoded, false)?;
            host.events().emit("marketplace:changed", None);
            Ok(cfg)
        }
        "marketplace:setToken" => {
            let token = args.first().and_then(Value::as_str);
            match token {
                Some(t) if !t.is_empty() => {
                    host.secrets().set(TOKEN_KEY, t);
                }
                _ => {
                    host.secrets().delete(TOKEN_KEY);
                }
            }
            host.events().emit("marketplace:changed", None);
            Ok(Value::Null)
        }
        "marketplace:listCatalog" => {
            // Built-in / default catalog packages for offline / preview usage
            Ok(json!([
                {
                    "name": "@praxis-addon/theme-solarized",
                    "version": "1.0.0",
                    "manifest": {
                        "schemaVersion": 1,
                        "kind": "theme",
                        "id": "solarized",
                        "name": "Solarized Theme",
                        "summary": "Precision colors for machines and people"
                    }
                },
                {
                    "name": "@praxis-addon/surface-nordic",
                    "version": "1.0.0",
                    "manifest": {
                        "schemaVersion": 1,
                        "kind": "surface-pack",
                        "id": "nordic",
                        "name": "Nordic Surfaces",
                        "summary": "Clean Scandinavian frost and geometric surfaces"
                    }
                }
            ]))
        }
        "marketplace:listInstalled" => {
            let installed = read_installed(user_data_dir)?;
            Ok(json!(installed))
        }
        "marketplace:listActiveAppearance" => read_active_appearance(user_data_dir),
        "marketplace:install" => {
            let package_name = text(args, 0)?;
            let kind = args
                .get(1)
                .and_then(|o| o.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or("theme");
            let id = package_name
                .split('/')
                .next_back()
                .unwrap_or(package_name)
                .replace("theme-", "")
                .replace("surface-", "");
            let mut installed = read_installed(user_data_dir)?;
            let record = json!({
                "packageName": package_name,
                "version": "1.0.0",
                "installedAt": now(),
                "trusted": matches!(kind, "theme" | "surface-pack" | "workflow-template"),
                "manifest": {
                    "schemaVersion": 1,
                    "kind": kind,
                    "id": id,
                    "name": package_name
                }
            });
            installed.retain(|i| i["packageName"] != package_name);
            installed.push(record.clone());
            save_installed(user_data_dir, &installed)?;
            host.events().emit("marketplace:changed", None);
            Ok(record)
        }
        "marketplace:update" => {
            let kind = text(args, 0)?;
            let id = text(args, 1)?;
            let mut installed = read_installed(user_data_dir)?;
            let record = installed
                .iter_mut()
                .find(|i| i["manifest"]["kind"] == kind && i["manifest"]["id"] == id)
                .cloned()
                .unwrap_or_else(|| {
                    json!({
                        "version": "1.0.1",
                        "manifest": { "kind": kind, "id": id, "name": id }
                    })
                });
            save_installed(user_data_dir, &installed)?;
            host.events().emit("marketplace:changed", None);
            Ok(record)
        }
        "marketplace:remove" => {
            let kind = text(args, 0)?;
            let id = text(args, 1)?;
            let mut installed = read_installed(user_data_dir)?;
            installed.retain(|i| !(i["manifest"]["kind"] == kind && i["manifest"]["id"] == id));
            save_installed(user_data_dir, &installed)?;
            host.events().emit("marketplace:changed", None);
            Ok(Value::Null)
        }
        "marketplace:checkForUpdates" => Ok(json!([])),
        "marketplace:setTrust" => {
            let kind = text(args, 0)?;
            let id = text(args, 1)?;
            let enabled = args.get(2).and_then(Value::as_bool).unwrap_or(true);
            let mut installed = read_installed(user_data_dir)?;
            if let Some(item) = installed
                .iter_mut()
                .find(|i| i["manifest"]["kind"] == kind && i["manifest"]["id"] == id)
            {
                item["trusted"] = json!(enabled);
            }
            save_installed(user_data_dir, &installed)?;
            host.events().emit("marketplace:changed", None);
            Ok(Value::Null)
        }
        _ => Err(failure("Unknown marketplace operation.")),
    }
}
