use std::collections::BTreeMap;
use std::sync::Mutex;
use url::Url;

use super::guard_policy::is_private_or_loopback_host;

#[derive(Debug, Clone)]
pub struct PreviewAccessGrant {
    pub origin: String,
    pub project_id: String,
    pub run_id: String,
    pub service_id: String,
}

#[derive(Debug, Default)]
pub struct PreviewAccessRegistry {
    grants: Mutex<BTreeMap<String, PreviewAccessGrant>>,
}

impl PreviewAccessRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn grant(&self, origin: &str, project_id: &str, run_id: &str, service_id: &str) {
        if let Ok(mut grants) = self.grants.lock() {
            let normalized = normalize_origin(origin);
            grants.insert(
                normalized.clone(),
                PreviewAccessGrant {
                    origin: normalized,
                    project_id: project_id.to_string(),
                    run_id: run_id.to_string(),
                    service_id: service_id.to_string(),
                },
            );
        }
    }

    pub fn revoke_origin(&self, origin: &str) {
        if let Ok(mut grants) = self.grants.lock() {
            let normalized = normalize_origin(origin);
            grants.remove(&normalized);
        }
    }

    pub fn revoke_for_run(&self, project_id: &str, run_id: &str) {
        if let Ok(mut grants) = self.grants.lock() {
            grants.retain(|_, g| !(g.project_id == project_id && g.run_id == run_id));
        }
    }

    pub fn revoke_all(&self) {
        if let Ok(mut grants) = self.grants.lock() {
            grants.clear();
        }
    }

    pub fn is_origin_granted(&self, raw_url: &str) -> bool {
        let Ok(url) = Url::parse(raw_url) else {
            return false;
        };
        let origin = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
        let origin_with_port = if let Some(port) = url.port() {
            format!("{origin}:{port}")
        } else {
            origin
        };
        let normalized = normalize_origin(&origin_with_port);
        self.grants
            .lock()
            .map(|g| g.contains_key(&normalized))
            .unwrap_or(false)
    }

    pub fn grant_for(&self, raw_url: &str) -> Option<PreviewAccessGrant> {
        let Ok(url) = Url::parse(raw_url) else {
            return None;
        };
        let origin = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
        let origin_with_port = if let Some(port) = url.port() {
            format!("{origin}:{port}")
        } else {
            origin
        };
        let normalized = normalize_origin(&origin_with_port);
        self.grants.lock().ok()?.get(&normalized).cloned()
    }
}

fn normalize_origin(origin: &str) -> String {
    let trimmed = origin.trim().trim_end_matches('/');
    trimmed.to_lowercase()
}

pub fn preview_access_blocked_reason(
    raw_url: &str,
    registry: &PreviewAccessRegistry,
) -> Option<String> {
    let url = match Url::parse(raw_url) {
        Ok(u) => u,
        Err(_) => return Some("Not a valid absolute URL.".into()),
    };

    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Some(format!(
            "Unsupported scheme \"{scheme}\" — only http and https are allowed."
        ));
    }

    let host = url.host_str().unwrap_or_default();
    if !is_private_or_loopback_host(host) {
        return None;
    }

    if registry.is_origin_granted(raw_url) {
        return None;
    }

    let port_suffix = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!(
        "Refusing a loopback / private-network origin with no active preview grant ({scheme}://{host}{port_suffix})."
    ))
}
