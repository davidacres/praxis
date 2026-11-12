//! `marketplace:*` IPC (`marketplaceIpc.ts` / `marketplaceInstance.ts` port).
//!
//! Config comes from `settings.marketplace`, the GitHub token from the secret store (or
//! `PRAXIS_MARKETPLACE_TOKEN`), and installed add-ons live under `<userData>/addons/<kind>/<id>`.
//! Activation: themes and surface packs are read back by `listActiveAppearance`; trusted agents
//! and skills are mirrored into `<userData>/agents|skills/<id>` so the agent runtime discovers
//! them; workflow templates feed the workflow library (`workflow_templates`).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use praxis_core::agent_runtime::bundled::{is_bundled_agent, mirror_bundled_agents};
use praxis_core::marketplace::addon_manifest::validate_addon_manifest;
use praxis_core::marketplace::catalog_types::{
    AddonKind, AddonUpdate, CatalogEntry, INSTALL_RECORD_FILE, InstalledAddon,
};
use praxis_core::marketplace::integrity::assert_tarball_integrity;
use praxis_core::marketplace::registry::{
    DEFAULT_ADDON_PACKAGE_PREFIX, DEFAULT_API_BASE_URL, DEFAULT_REGISTRY_BASE_URL, GITHUB_API_VERSION, Packument,
    RegistryPackageRef, assert_same_origin, encode_packument_path, endpoint_origin, format_registry_error,
    normalize_packument, parse_next_link,
};
use praxis_core::marketplace::semver::{is_newer_version, max_version, meets_minimum, sort_versions_descending};
use praxis_core::marketplace::storage::AddonStorage;
use praxis_core::marketplace::tarball_manifest::{MAX_UNPACKED_TARBALL_BYTES, read_praxis_manifest_from_tarball};
use praxis_host::HostContext;
use serde_json::{Value, json};

use super::runtime::{block_on, runtime};
use super::{Result, failure, text};

const TOKEN_KEY: &str = "marketplace:githubToken";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Praxis's retired runtime-pin packages; uninstalled on launch.
const RETIRED_PIN_PACKAGE_PREFIX: &str = "@davidacres/praxis-addon-agent-";

fn storage(user_data_dir: &Path) -> AddonStorage {
    AddonStorage::new(user_data_dir.join("addons"))
}

fn log(message: &str) {
    eprintln!("{message}");
}

// ── config & status ──────────────────────────────────────────────────────

fn token(host: &HostContext) -> Option<String> {
    // Env override first: the e2e sandbox and headless CI have no keychain.
    if let Ok(from_env) = std::env::var("PRAXIS_MARKETPLACE_TOKEN") {
        let from_env = from_env.trim();
        if !from_env.is_empty() {
            return Some(from_env.to_string());
        }
    }
    host.secrets().get(TOKEN_KEY).filter(|t| !t.is_empty())
}

fn status(host: &HostContext) -> Value {
    let cfg = host.settings().read().marketplace;
    let has_token = token(host).is_some();
    json!({
        "ready": cfg.enabled && !cfg.owner.trim().is_empty() && has_token,
        "enabled": cfg.enabled,
        "owner": cfg.owner,
        "ownerType": cfg.owner_type,
        "packageNamePrefix": cfg.package_name_prefix,
        "apiBaseUrl": cfg.api_base_url,
        "registryBaseUrl": cfg.registry_base_url,
        "checkOnLaunch": cfg.check_on_launch,
        "hasToken": has_token
    })
}

fn emit_changed(host: &HostContext) {
    host.events().emit("marketplace:changed", None);
}

fn configure(host: &HostContext, patch: &Value) -> Result<Value> {
    let updated = host.settings().write(&json!({ "marketplace": patch })).map_err(failure)?;
    host.events().emit("settings:changed", Some(serde_json::to_value(updated).map_err(failure)?));
    emit_changed(host);
    Ok(status(host))
}

// ── registry client ──────────────────────────────────────────────────────

enum FetchError {
    NotFound(String),
    Other(String),
}

impl FetchError {
    fn message(self) -> String {
        match self {
            Self::NotFound(message) | Self::Other(message) => message,
        }
    }
}

struct Client {
    http: reqwest::Client,
    owner: String,
    owner_type: String,
    token: String,
    prefix: String,
    api_base: String,
    registry_base: String,
    api_origin: String,
    registry_origin: String,
}

impl Client {
    fn new(host: &HostContext) -> std::result::Result<Self, String> {
        let cfg = host.settings().read().marketplace;
        if !cfg.enabled {
            return Err("The add-on marketplace is turned off in Settings.".into());
        }
        let owner = cfg.owner.trim().to_string();
        if owner.is_empty() {
            return Err("Set a marketplace owner (a GitHub user or organisation) in Settings.".into());
        }
        let token = token(host).ok_or("Add a marketplace GitHub token in Settings (needs `read:packages`).")?;
        let or_default = |value: &str, default: &str| {
            let trimmed = value.trim().trim_end_matches('/');
            if trimmed.is_empty() { default.to_string() } else { trimmed.to_string() }
        };
        let api_base = or_default(&cfg.api_base_url, DEFAULT_API_BASE_URL);
        let registry_base = or_default(&cfg.registry_base_url, DEFAULT_REGISTRY_BASE_URL);
        Ok(Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(60))
                .user_agent("praxis-desktop")
                .build()
                .map_err(|e| e.to_string())?,
            api_origin: endpoint_origin(&api_base, "API URL")?,
            registry_origin: endpoint_origin(&registry_base, "registry URL")?,
            prefix: if cfg.package_name_prefix.is_empty() { DEFAULT_ADDON_PACKAGE_PREFIX.into() } else { cfg.package_name_prefix },
            owner,
            owner_type: cfg.owner_type,
            token: token.trim().to_string(),
            api_base,
            registry_base,
        })
    }

    async fn list_addon_packages(&self) -> std::result::Result<Vec<RegistryPackageRef>, String> {
        let scope = if self.owner_type == "org" { "orgs" } else { "users" };
        let mut url = Some(format!(
            "{}/{scope}/{}/packages?package_type=npm&per_page=100",
            self.api_base,
            encode_packument_path(&self.owner)
        ));
        let mut refs = Vec::new();
        while let Some(current) = url.take() {
            assert_same_origin(&current, &self.api_origin, "the next page of marketplace packages")?;
            let response = self
                .http
                .get(&current)
                .header("Accept", "application/vnd.github+json")
                .header("Authorization", format!("Bearer {}", self.token))
                .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let code = response.status();
            let link = response.headers().get("link").and_then(|v| v.to_str().ok()).map(str::to_string);
            let body = response.text().await.map_err(|e| e.to_string())?;
            if !code.is_success() {
                return Err(format_registry_error(
                    "Listing marketplace packages",
                    code.as_u16(),
                    code.canonical_reason().unwrap_or_default(),
                    &body,
                ));
            }
            let page: Value = if body.trim().is_empty() { json!([]) } else { serde_json::from_str(&body).map_err(|e| e.to_string())? };
            for item in page.as_array().into_iter().flatten() {
                let Some(name) = item.get("name").and_then(Value::as_str) else { continue };
                let unscoped = name.split_once('/').map_or(name, |(_, rest)| rest);
                if !unscoped.starts_with(&self.prefix) {
                    continue;
                }
                refs.push(RegistryPackageRef {
                    name: name.to_string(),
                    updated_at: item.get("updated_at").and_then(Value::as_str).map(str::to_string),
                });
            }
            url = parse_next_link(link.as_deref());
        }
        refs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(refs)
    }

    async fn fetch_packument(&self, name: &str) -> std::result::Result<Packument, FetchError> {
        let url = format!("{}/{}", self.registry_base, encode_packument_path(name));
        let response = self
            .http
            .get(&url)
            .header("Accept", "application/json")
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(|e| FetchError::Other(e.to_string()))?;
        let code = response.status();
        let body = response.text().await.map_err(|e| FetchError::Other(e.to_string()))?;
        if !code.is_success() {
            let message = format_registry_error(&format!("Fetching {name}"), code.as_u16(), code.canonical_reason().unwrap_or_default(), &body);
            return Err(if code.as_u16() == 404 { FetchError::NotFound(message) } else { FetchError::Other(message) });
        }
        let raw: Value = serde_json::from_str(&body).map_err(|e| FetchError::Other(e.to_string()))?;
        normalize_packument(name, &raw).map_err(FetchError::Other)
    }

    /// Some registries only resolve the scoped form (`@owner/name`) of a name the REST listing
    /// returned unscoped; retry scoped on a 404 only.
    async fn get_packument(&self, name: &str) -> std::result::Result<Packument, String> {
        match self.fetch_packument(name).await {
            Ok(packument) => Ok(packument),
            Err(FetchError::NotFound(_)) if !name.starts_with('@') => self
                .fetch_packument(&format!("@{}/{name}", self.owner))
                .await
                .map_err(FetchError::message),
            Err(error) => Err(error.message()),
        }
    }

    async fn download_tarball(&self, url: &str) -> std::result::Result<Vec<u8>, String> {
        assert_same_origin(url, &self.registry_origin, "an add-on tarball")?;
        let response = self
            .http
            .get(url)
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let code = response.status();
        if !code.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format_registry_error("Downloading add-on tarball", code.as_u16(), code.canonical_reason().unwrap_or_default(), &body));
        }
        response.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
    }
}

// ── service ──────────────────────────────────────────────────────────────

fn resolve_latest(packument: &Packument) -> Option<String> {
    if let Some(tagged) = packument.dist_tags.get("latest")
        && packument.versions.contains_key(tagged)
    {
        return Some(tagged.clone());
    }
    let versions: Vec<&String> = packument.versions.keys().collect();
    max_version(&versions)
}

async fn resolve_catalog_entry(client: &Client, pkg: RegistryPackageRef) -> Option<CatalogEntry> {
    let packument = match client.get_packument(&pkg.name).await {
        Ok(packument) => packument,
        Err(error) => {
            log(&format!("[marketplace] skipping {}: {error}", pkg.name));
            return None;
        }
    };
    let Some(resolved) = resolve_latest(&packument) else {
        log(&format!("[marketplace] skipping {}: no usable published version", pkg.name));
        return None;
    };
    let entry = packument.versions.get(&resolved);
    let mut validation = validate_addon_manifest(entry.and_then(|e| e.praxis.as_ref()).unwrap_or(&Value::Null));
    // GitHub Packages' packument strips custom `package.json` fields; fall back to the tarball
    // only when the field is genuinely missing, not when it is invalid.
    if let Some(entry) = entry
        && entry.praxis.is_none()
    {
        match client.download_tarball(&entry.tarball).await {
            Ok(tarball) => {
                let outcome = assert_tarball_integrity(&tarball, &entry.dist).and_then(|()| {
                    read_praxis_manifest_from_tarball(&tarball, MAX_UNPACKED_TARBALL_BYTES)
                });
                match outcome {
                    Ok(from_tarball) => validation = validate_addon_manifest(&from_tarball.unwrap_or(Value::Null)),
                    Err(error) => log(&format!("[marketplace] tarball manifest fallback failed for {}: {error}", pkg.name)),
                }
            }
            Err(error) => log(&format!("[marketplace] tarball manifest fallback failed for {}: {error}", pkg.name)),
        }
    }
    let Some(manifest) = validation.manifest else {
        log(&format!("[marketplace] skipping {}@{resolved}: invalid manifest ({})", pkg.name, validation.errors.join("; ")));
        return None;
    };
    let versions = sort_versions_descending(&packument.versions.keys().collect::<Vec<_>>());
    let incompatible = manifest.min_app_version.as_deref().is_some_and(|min| !meets_minimum(APP_VERSION, min));
    let mut warnings = validation.warnings;
    if incompatible {
        warnings.push(format!(
            "Needs Praxis {} or newer (you have {APP_VERSION}).",
            manifest.min_app_version.as_deref().unwrap_or_default()
        ));
    }
    Some(CatalogEntry {
        manifest,
        package_name: pkg.name,
        latest_version: resolved.clone(),
        versions,
        updated_at: packument.time.get(&resolved).cloned().or(pkg.updated_at),
        incompatible,
        warnings,
    })
}

fn list_catalog(host: &HostContext) -> Result<Value> {
    let client = Client::new(host).map_err(failure)?;
    let entries = block_on(async {
        let packages = client.list_addon_packages().await?;
        let client = std::sync::Arc::new(client);
        let handles: Vec<_> = packages
            .into_iter()
            .map(|pkg| {
                let client = client.clone();
                runtime().spawn(async move { resolve_catalog_entry(&client, pkg).await })
            })
            .collect();
        let mut entries = Vec::new();
        for handle in handles {
            if let Ok(Some(entry)) = handle.await {
                entries.push(entry);
            }
        }
        Ok::<_, String>(entries)
    })
    .map_err(failure)?;
    let mut entries = entries;
    entries.sort_by(|a, b| {
        a.manifest.kind.as_str().cmp(b.manifest.kind.as_str()).then_with(|| a.manifest.name.to_lowercase().cmp(&b.manifest.name.to_lowercase()))
    });
    serde_json::to_value(entries).map_err(failure)
}

struct InstallOptions {
    version: Option<String>,
    trust: bool,
}

async fn install_package(
    client: &Client,
    store: &AddonStorage,
    package_name: &str,
    options: &InstallOptions,
) -> std::result::Result<InstalledAddon, String> {
    let packument = client.get_packument(package_name).await?;
    let version = options
        .version
        .clone()
        .or_else(|| resolve_latest(&packument))
        .ok_or_else(|| format!("{package_name} has no installable version."))?;
    let entry = packument
        .versions
        .get(&version)
        .ok_or_else(|| format!("{package_name} has no published version {version}."))?;

    let tarball = client.download_tarball(&entry.tarball).await?;
    assert_tarball_integrity(&tarball, &entry.dist)?;

    // The packument can lack `praxis` entirely even for a correct package (GitHub Packages).
    let manifest_value = match &entry.praxis {
        Some(value) => value.clone(),
        None => read_praxis_manifest_from_tarball(&tarball, MAX_UNPACKED_TARBALL_BYTES)?.unwrap_or(Value::Null),
    };
    let validation = validate_addon_manifest(&manifest_value);
    let Some(manifest) = validation.manifest else {
        return Err(format!("{package_name}@{version} has an invalid add-on manifest: {}", validation.errors.join("; ")));
    };
    if let Some(min) = manifest.min_app_version.as_deref()
        && !meets_minimum(APP_VERSION, min)
    {
        return Err(format!("{} needs Praxis {min} or newer; this build is {APP_VERSION}.", manifest.name));
    }

    let enabled = manifest.kind.is_declarative() || options.trust;
    let record = InstalledAddon {
        manifest,
        package_name: package_name.to_string(),
        version,
        integrity: entry.dist.integrity.clone(),
        installed_at: super::now(),
        enabled,
    };
    store.write(&record, &tarball)?;
    log(&format!(
        "[marketplace] installed {}/{} {}{}",
        record.manifest.kind, record.manifest.id, record.version,
        if enabled { "" } else { " (disabled — grant trust to enable)" }
    ));
    Ok(record)
}

fn install(host: &HostContext, user_data_dir: &Path, args: &[Value]) -> Result<Value> {
    let package_name = text(args, 0)?;
    let options = args.get(1).cloned().unwrap_or(Value::Null);
    let options = InstallOptions {
        version: options.get("version").and_then(Value::as_str).map(str::to_string),
        trust: options.get("trust").and_then(Value::as_bool) == Some(true),
    };
    let client = Client::new(host).map_err(failure)?;
    let store = storage(user_data_dir);
    let record = block_on(install_package(&client, &store, package_name, &options)).map_err(failure)?;
    after_change(host, user_data_dir, record.manifest.kind);
    serde_json::to_value(record).map_err(failure)
}

fn parse_kind(args: &[Value]) -> Result<AddonKind> {
    let raw = text(args, 0)?;
    AddonKind::parse(raw).ok_or_else(|| failure(format!("Unknown add-on kind \"{raw}\".")))
}

fn update(host: &HostContext, user_data_dir: &Path, args: &[Value]) -> Result<Value> {
    let kind = parse_kind(args)?;
    let id = text(args, 1)?;
    let store = storage(user_data_dir);
    let current = store.get(kind, id).ok_or_else(|| failure(format!("No installed {kind} add-on with id \"{id}\".")))?;
    let client = Client::new(host).map_err(failure)?;
    let options = InstallOptions { version: None, trust: current.enabled && !kind.is_declarative() };
    let record = block_on(install_package(&client, &store, &current.package_name, &options)).map_err(failure)?;
    after_change(host, user_data_dir, kind);
    serde_json::to_value(record).map_err(failure)
}

fn check_for_updates(host: &HostContext, user_data_dir: &Path) -> Result<Value> {
    let client = Client::new(host).map_err(failure)?;
    let installed = storage(user_data_dir).list();
    let updates = block_on(async {
        let mut updates: Vec<AddonUpdate> = Vec::new();
        for addon in installed {
            let packument = match client.get_packument(&addon.package_name).await {
                Ok(packument) => packument,
                Err(error) => {
                    log(&format!("[marketplace] update check failed for {}: {error}", addon.package_name));
                    continue;
                }
            };
            if let Some(latest) = resolve_latest(&packument)
                && is_newer_version(&latest, &addon.version)
            {
                updates.push(AddonUpdate {
                    id: addon.manifest.id.clone(),
                    kind: addon.manifest.kind,
                    package_name: addon.package_name.clone(),
                    installed_version: addon.version.clone(),
                    latest_version: latest,
                });
            }
        }
        updates
    });
    serde_json::to_value(updates).map_err(failure)
}

// ── activation: agents and skills mirror into the discovery roots ────────

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn discovery_root(user_data_dir: &Path, kind: AddonKind) -> PathBuf {
    user_data_dir.join(if kind == AddonKind::Agent { "agents" } else { "skills" })
}

/// A built-in agent's folder holds its instructions; an add-on reusing its id never overwrites it.
fn shadows_built_in(addon: &InstalledAddon) -> bool {
    addon.manifest.kind == AddonKind::Agent && is_bundled_agent(&addon.manifest.id)
}

/// Mirrors a trusted agent/skill add-on's payload into the global discovery root, and clears the
/// mirror when it is not trusted.
fn sync_kind_into_discovery(user_data_dir: &Path, kind: AddonKind) {
    let store = storage(user_data_dir);
    let root = discovery_root(user_data_dir, kind);
    let _ = fs::create_dir_all(&root);
    for addon in store.list().into_iter().filter(|a| a.manifest.kind == kind) {
        if shadows_built_in(&addon) {
            log(&format!(
                "[marketplace] not using {}: it reuses the built-in agent id \"{}\".",
                addon.manifest.name, addon.manifest.id
            ));
            continue;
        }
        let target = root.join(&addon.manifest.id);
        let _ = fs::remove_dir_all(&target);
        if addon.enabled {
            if copy_tree(&store.addon_dir(kind, &addon.manifest.id), &target).is_ok() {
                // The install record is bookkeeping, not part of the agent/skill.
                let _ = fs::remove_file(target.join(INSTALL_RECORD_FILE));
            }
        }
    }
}

fn refresh_agent_runtime(host: &HostContext, user_data_dir: &Path) {
    sync_kind_into_discovery(user_data_dir, AddonKind::Agent);
    sync_kind_into_discovery(user_data_dir, AddonKind::Skill);
    if let Err(error) = super::agent_runtime::dispatch(host, user_data_dir, "agentRuntime:refresh", &[]) {
        log(&format!("[marketplace] agent runtime refresh failed: {}", error.message));
    }
}

fn after_change(host: &HostContext, user_data_dir: &Path, kind: AddonKind) {
    if matches!(kind, AddonKind::Agent | AddonKind::Skill) {
        refresh_agent_runtime(host, user_data_dir);
    }
    emit_changed(host);
}

fn remove(host: &HostContext, user_data_dir: &Path, args: &[Value]) -> Result<Value> {
    let kind = parse_kind(args)?;
    let id = text(args, 1)?;
    storage(user_data_dir).remove(kind, id).map_err(failure)?;
    if matches!(kind, AddonKind::Agent | AddonKind::Skill) {
        // The discovery sync only visits add-ons still installed, so the removed copy goes here.
        if !(kind == AddonKind::Agent && is_bundled_agent(id)) {
            let _ = fs::remove_dir_all(discovery_root(user_data_dir, kind).join(id));
        }
        if kind == AddonKind::Agent {
            mirror_bundled_agents(&discovery_root(user_data_dir, kind));
        }
        refresh_agent_runtime(host, user_data_dir);
    }
    emit_changed(host);
    Ok(Value::Null)
}

fn set_trust(host: &HostContext, user_data_dir: &Path, args: &[Value]) -> Result<Value> {
    let kind = parse_kind(args)?;
    let id = text(args, 1)?;
    let enabled = args.get(2).and_then(Value::as_bool).unwrap_or(true);
    let store = storage(user_data_dir);
    if store.get(kind, id).is_none() {
        return Err(failure(format!("No installed {kind} add-on with id \"{id}\".")));
    }
    store.set_enabled(kind, id, enabled).map_err(failure)?;
    refresh_agent_runtime(host, user_data_dir);
    emit_changed(host);
    Ok(Value::Null)
}

/// Enabled `workflow-template` add-on definitions, for the workflow library.
pub fn workflow_templates(user_data_dir: &Path) -> Vec<Value> {
    storage(user_data_dir).workflow_templates()
}

/// True when a retired runtime-pin package is installed and launch must reconcile.
pub fn has_retired_pins(user_data_dir: &Path) -> bool {
    storage(user_data_dir).list().iter().any(|a| a.manifest.kind == AddonKind::Agent && is_retired_pin(&a.package_name))
}

/// Launch-time reconciliation: drop retired pin packages, then re-mirror agents and skills.
pub fn reconcile_installed_on_launch(host: &HostContext, user_data_dir: &Path) {
    let store = storage(user_data_dir);
    let retired: Vec<InstalledAddon> = store
        .list()
        .into_iter()
        .filter(|a| a.manifest.kind == AddonKind::Agent && is_retired_pin(&a.package_name))
        .collect();
    for addon in &retired {
        let _ = store.remove(AddonKind::Agent, &addon.manifest.id);
        if !shadows_built_in(addon) {
            let _ = fs::remove_dir_all(discovery_root(user_data_dir, AddonKind::Agent).join(&addon.manifest.id));
        }
    }
    if !retired.is_empty() {
        mirror_bundled_agents(&discovery_root(user_data_dir, AddonKind::Agent));
    }
    refresh_agent_runtime(host, user_data_dir);
}

/// `@davidacres/praxis-addon-agent-[claude-|codex-]{planner,reviewer,implementer}`
fn is_retired_pin(package_name: &str) -> bool {
    let Some(rest) = package_name.strip_prefix(RETIRED_PIN_PACKAGE_PREFIX) else { return false };
    let rest = rest.strip_prefix("claude-").or_else(|| rest.strip_prefix("codex-")).unwrap_or(rest);
    matches!(rest, "planner" | "reviewer" | "implementer")
}

pub fn dispatch(host: &HostContext, user_data_dir: &Path, channel: &str, args: &[Value]) -> Result<Value> {
    match channel {
        "marketplace:getStatus" => Ok(status(host)),
        "marketplace:configure" => configure(host, args.first().unwrap_or(&Value::Null)),
        "marketplace:setToken" => {
            match args.first().and_then(Value::as_str).map(str::trim) {
                Some(t) if !t.is_empty() => {
                    host.secrets().set(TOKEN_KEY, t);
                }
                _ => {
                    host.secrets().delete(TOKEN_KEY);
                }
            }
            emit_changed(host);
            Ok(status(host))
        }
        "marketplace:listCatalog" => list_catalog(host),
        // Installed add-ons are read straight from disk: no registry, no token.
        "marketplace:listInstalled" => serde_json::to_value(storage(user_data_dir).list()).map_err(failure),
        "marketplace:listActiveAppearance" => {
            serde_json::to_value(storage(user_data_dir).read_active_appearance()).map_err(failure)
        }
        "marketplace:install" => install(host, user_data_dir, args),
        "marketplace:update" => update(host, user_data_dir, args),
        "marketplace:remove" => remove(host, user_data_dir, args),
        "marketplace:checkForUpdates" => check_for_updates(host, user_data_dir),
        "marketplace:setTrust" => set_trust(host, user_data_dir, args),
        _ => Err(failure("Unknown marketplace operation.")),
    }
}
