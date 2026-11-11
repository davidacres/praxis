//! On-disk home for installed add-ons (`electronAddonStorage.ts` port), under
//! `<addons root>/<kind>/<id>/`: the unpacked `package/addon/**` payload plus a
//! `.praxis-addon.json` install record.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use flate2::read::MultiGzDecoder;
use serde_json::Value;

use super::addon_manifest::validate_addon_manifest;
use super::catalog_types::{
    ADDON_KINDS, ActiveAppearanceAddons, AddonDisplayMode, AddonKind, AddonSurfacePackContent, AddonThemeContent,
    INSTALL_RECORD_FILE, InstalledAddon,
};
use super::tarball_manifest::MAX_UNPACKED_TARBALL_BYTES;

#[derive(Debug, Clone)]
pub struct AddonStorage {
    root: PathBuf,
}

/// Manifest ids are `[a-z0-9-]`; this is defence in depth against a record that arrived another way.
fn sanitize_segment(value: &str) -> String {
    value.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect()
}

fn io(err: impl std::fmt::Display) -> String {
    err.to_string()
}

impl AddonStorage {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    #[must_use]
    pub fn kind_root(&self, kind: AddonKind) -> PathBuf {
        self.root.join(kind.as_str())
    }

    #[must_use]
    pub fn addon_dir(&self, kind: AddonKind, id: &str) -> PathBuf {
        self.kind_root(kind).join(sanitize_segment(id))
    }

    /// Every installed add-on, read from its on-disk record.
    #[must_use]
    pub fn list(&self) -> Vec<InstalledAddon> {
        let mut out = Vec::new();
        for kind in ADDON_KINDS {
            let Ok(entries) = fs::read_dir(self.kind_root(*kind)) else { continue };
            let mut names: Vec<String> = entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().to_str().map(str::to_string))
                .collect();
            names.sort();
            for name in names {
                if let Some(record) = self.read_record(*kind, &name) {
                    out.push(record);
                }
            }
        }
        out
    }

    #[must_use]
    pub fn get(&self, kind: AddonKind, id: &str) -> Option<InstalledAddon> {
        self.read_record(kind, &sanitize_segment(id))
    }

    /// Replaces any existing install: unpacks the (already verified) tarball and writes the record.
    pub fn write(&self, record: &InstalledAddon, tarball: &[u8]) -> Result<(), String> {
        let dir = self.addon_dir(record.manifest.kind, &record.manifest.id);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(io)?;
        if let Err(error) = extract_addon_payload(tarball, &dir) {
            let _ = fs::remove_dir_all(&dir);
            return Err(error);
        }
        self.write_record(&dir, record)
    }

    pub fn remove(&self, kind: AddonKind, id: &str) -> Result<(), String> {
        match fs::remove_dir_all(self.addon_dir(kind, id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io(error)),
        }
    }

    pub fn set_enabled(&self, kind: AddonKind, id: &str, enabled: bool) -> Result<(), String> {
        let mut record = self.get(kind, id).ok_or_else(|| format!("No installed {kind} add-on with id \"{id}\"."))?;
        record.enabled = enabled;
        self.write_record(&self.addon_dir(kind, id), &record)
    }

    fn write_record(&self, dir: &Path, record: &InstalledAddon) -> Result<(), String> {
        let body = serde_json::to_string_pretty(record).map_err(io)?;
        fs::write(dir.join(INSTALL_RECORD_FILE), format!("{body}\n")).map_err(io)
    }

    fn read_record(&self, kind: AddonKind, dir_name: &str) -> Option<InstalledAddon> {
        let raw = fs::read_to_string(self.kind_root(kind).join(dir_name).join(INSTALL_RECORD_FILE)).ok()?;
        let candidate: Value = serde_json::from_str(&raw).ok()?;
        let candidate = candidate.as_object()?;
        let manifest = validate_addon_manifest(candidate.get("manifest").unwrap_or(&Value::Null)).manifest?;
        if manifest.kind != kind {
            return None;
        }
        let text = |key: &str| candidate.get(key).and_then(Value::as_str).map(str::to_string);
        Some(InstalledAddon {
            manifest,
            package_name: text("packageName").unwrap_or_default(),
            version: text("version").unwrap_or_else(|| "0.0.0".to_string()),
            integrity: text("integrity"),
            installed_at: text("installedAt").unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
            enabled: candidate.get("enabled") != Some(&Value::Bool(false)),
        })
    }

    fn read_payload_json(&self, kind: AddonKind, id: &str, file: &str) -> Option<Value> {
        serde_json::from_str(&fs::read_to_string(self.addon_dir(kind, id).join(file)).ok()?).ok()
    }

    /// Enabled `theme` / `surface-pack` add-ons, shaped for the renderer to register.
    #[must_use]
    pub fn read_active_appearance(&self) -> ActiveAppearanceAddons {
        let mut active = ActiveAppearanceAddons::default();
        for addon in self.list() {
            if !addon.enabled {
                continue;
            }
            let id = &addon.manifest.id;
            match addon.manifest.kind {
                AddonKind::Theme => {
                    if let Some(theme) = self.read_payload_json(AddonKind::Theme, id, "theme.json").and_then(|raw| shape_theme(id, &raw)) {
                        active.themes.push(theme);
                    }
                }
                AddonKind::SurfacePack => {
                    if let Some(pack) = self.read_payload_json(AddonKind::SurfacePack, id, "pack.json").and_then(|raw| shape_surface_pack(id, &raw)) {
                        active.surface_packs.push(pack);
                    }
                }
                _ => {}
            }
        }
        active
    }

    /// Enabled `workflow-template` add-on definitions (`template.json`), for the workflow library.
    #[must_use]
    pub fn workflow_templates(&self) -> Vec<Value> {
        self.list()
            .into_iter()
            .filter(|a| a.manifest.kind == AddonKind::WorkflowTemplate && a.enabled)
            .filter_map(|a| self.read_payload_json(AddonKind::WorkflowTemplate, &a.manifest.id, "template.json"))
            .collect()
    }
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default()
}

fn shape_theme(id: &str, raw: &Value) -> Option<AddonThemeContent> {
    let raw = raw.as_object()?;
    let mode = match raw.get("mode").and_then(Value::as_str) {
        Some("light") => AddonDisplayMode::Light,
        Some("dark") => AddonDisplayMode::Dark,
        _ => return None,
    };
    Some(AddonThemeContent {
        id: id.to_string(),
        name: raw.get("name").and_then(Value::as_str).unwrap_or(id).to_string(),
        mode,
        description: raw.get("description").and_then(Value::as_str).unwrap_or_default().to_string(),
        preview: string_map(raw.get("preview")),
        terminal: raw.get("terminal").filter(|t| t.is_object()).map(|t| string_map(Some(t))),
    })
}

fn shape_surface_pack(id: &str, raw: &Value) -> Option<AddonSurfacePackContent> {
    let raw = raw.as_object()?;
    Some(AddonSurfacePackContent {
        id: id.to_string(),
        name: raw.get("name").and_then(Value::as_str).unwrap_or(id).to_string(),
        description: raw.get("description").and_then(Value::as_str).unwrap_or_default().to_string(),
        base_pack_id: raw.get("basePackId").and_then(Value::as_str).map(str::to_string),
        tokens: string_map(raw.get("tokens")),
        pattern: raw
            .get("pattern")
            .and_then(Value::as_object)
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
    })
}

/// Unpacks just `package/addon/**` from an npm tarball into `dest`, flattening the prefix.
/// Absolute paths, `..`, backslashes, drive letters and non file/directory entries are refused.
pub fn extract_addon_payload(tarball: &[u8], dest: &Path) -> Result<(), String> {
    let mut inflated = Vec::new();
    MultiGzDecoder::new(tarball)
        .take(MAX_UNPACKED_TARBALL_BYTES + 1)
        .read_to_end(&mut inflated)
        .map_err(|e| format!("Could not decompress the add-on tarball: {e}"))?;
    if inflated.len() as u64 > MAX_UNPACKED_TARBALL_BYTES {
        return Err("The add-on tarball unpacks to more than 64 MB; it is not a valid add-on.".to_string());
    }
    let mut archive = tar::Archive::new(inflated.as_slice());
    let mut wrote = 0usize;
    for entry in archive.entries().map_err(io)? {
        let mut entry = entry.map_err(io)?;
        let entry_path = entry.path().map_err(io)?.to_string_lossy().to_string();
        let kind = entry.header().entry_type();
        let bytes = entry_path.as_bytes();
        let drive_letter = bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1) == Some(&b':');
        let trimmed = entry_path.trim_end_matches('/');
        if entry_path.starts_with('/')
            || entry_path.contains('\\')
            || trimmed.split('/').any(|s| s == "..")
            || drive_letter
            || !(kind.is_file() || kind.is_dir())
        {
            return Err(format!("Unsafe add-on archive entry: {entry_path}"));
        }
        let Some(relative) = trimmed.strip_prefix("package/addon") else { continue };
        if !(relative.is_empty() || relative.starts_with('/')) {
            continue;
        }
        wrote += 1;
        let relative = relative.trim_start_matches('/');
        if relative.is_empty() {
            continue;
        }
        let target = dest.join(relative);
        if kind.is_dir() {
            fs::create_dir_all(&target).map_err(io)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(io)?;
            }
            let mut body = Vec::new();
            entry.read_to_end(&mut body).map_err(io)?;
            fs::write(&target, body).map_err(io)?;
        }
    }
    if wrote == 0 {
        return Err("The add-on tarball had no `package/addon/` payload.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::{Compression, write::GzEncoder};
    use serde_json::json;

    use super::*;

    fn tarball(files: &[(&str, &str)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (path, body) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, body.as_bytes()).unwrap();
        }
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&builder.into_inner().unwrap()).unwrap();
        gz.finish().unwrap()
    }

    fn record(kind: &str, id: &str, enabled: bool) -> InstalledAddon {
        let manifest = validate_addon_manifest(&json!({"schemaVersion": 1, "kind": kind, "id": id, "name": id})).manifest.unwrap();
        InstalledAddon {
            manifest,
            package_name: format!("praxis-addon-{id}"),
            version: "1.0.0".into(),
            integrity: None,
            installed_at: "2026-01-01T00:00:00.000Z".into(),
            enabled,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("praxis-addon-storage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn write_unpacks_only_the_addon_payload_and_lists_it() {
        let root = scratch("write");
        let storage = AddonStorage::new(&root);
        let tgz = tarball(&[
            ("package/package.json", "{}"),
            ("package/addon/theme.json", "{\"mode\":\"dark\",\"preview\":{\"canvas\":\"#000\"}}"),
        ]);
        storage.write(&record("theme", "nord", true), &tgz).unwrap();
        assert!(root.join("theme/nord/theme.json").is_file());
        assert!(!root.join("theme/nord/package.json").exists());
        let listed = storage.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].manifest.id, "nord");
        let appearance = storage.read_active_appearance();
        assert_eq!(appearance.themes[0].preview["canvas"], "#000");
        storage.set_enabled(AddonKind::Theme, "nord", false).unwrap();
        assert!(storage.read_active_appearance().themes.is_empty());
        storage.remove(AddonKind::Theme, "nord").unwrap();
        assert!(storage.list().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_tarball_without_a_payload_is_refused() {
        let root = scratch("empty");
        let storage = AddonStorage::new(&root);
        let error = storage.write(&record("theme", "x", true), &tarball(&[("package/package.json", "{}")])).unwrap_err();
        assert_eq!(error, "The add-on tarball had no `package/addon/` payload.");
        assert!(storage.list().is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
