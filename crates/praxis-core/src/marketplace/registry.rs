//! Pure parts of the GitHub Packages registry client (`registryClient.ts` port): URL and
//! origin rules, packument normalisation, `Link` header paging and error wording. The HTTP
//! transport itself lives in the desktop host; nothing here performs I/O.

use std::collections::BTreeMap;

use serde_json::Value;
use url::Url;

use super::integrity::TarballDist;

pub const DEFAULT_API_BASE_URL: &str = "https://api.github.com";
pub const DEFAULT_REGISTRY_BASE_URL: &str = "https://npm.pkg.github.com";
pub const DEFAULT_ADDON_PACKAGE_PREFIX: &str = "praxis-addon-";
pub const GITHUB_API_VERSION: &str = "2022-11-28";

/// One add-on package the owner publishes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryPackageRef {
    pub name: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PackumentVersion {
    pub version: String,
    /// The `praxis` manifest straight from the published `package.json`; `None` when absent.
    pub praxis: Option<Value>,
    pub tarball: String,
    pub dist: TarballDist,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Packument {
    pub name: String,
    pub dist_tags: BTreeMap<String, String>,
    pub versions: BTreeMap<String, PackumentVersion>,
    pub time: BTreeMap<String, String>,
}

/// The origin of a configured endpoint. Only `https:` is accepted, except on a loopback host.
pub fn endpoint_origin(url: &str, label: &str) -> Result<String, String> {
    let parsed = Url::parse(url).map_err(|_| format!("The marketplace {label} \"{url}\" is not a valid URL."))?;
    let host = parsed.host_str().unwrap_or_default();
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1");
    if parsed.scheme() != "https" && !(loopback && parsed.scheme() == "http") {
        let authority = match parsed.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        };
        return Err(format!(
            "The marketplace {label} must use https: (got {}://{authority}).",
            parsed.scheme()
        ));
    }
    Ok(parsed.origin().ascii_serialization())
}

/// Refuses a URL on any origin but the expected one, so the bearer token never leaves it.
pub fn assert_same_origin(url: &str, expected_origin: &str, what: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|_| format!("Refusing {what}: \"{url}\" is not a valid URL."))?;
    let origin = parsed.origin().ascii_serialization();
    if origin != expected_origin {
        return Err(format!(
            "Refusing {what} from {origin}: only {expected_origin} is trusted with the marketplace token."
        ));
    }
    Ok(())
}

fn encode_component(value: &str) -> String {
    // encodeURIComponent leaves `A-Za-z0-9-_.!~*'()` alone.
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `@scope/name` becomes `@scope%2Fname`; unscoped names are percent-encoded as one component.
#[must_use]
pub fn encode_packument_path(package_name: &str) -> String {
    if package_name.starts_with('@')
        && let Some(slash) = package_name.find('/')
    {
        return format!("{}%2F{}", &package_name[..slash], encode_component(&package_name[slash + 1..]));
    }
    encode_component(package_name)
}

/// Extracts the URL for `rel="next"` from a GitHub `Link` header.
#[must_use]
pub fn parse_next_link(link_header: Option<&str>) -> Option<String> {
    for part in link_header?.split(',') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix('<')
            && let Some((url, tail)) = rest.split_once('>')
        {
            let tail = tail.trim_start().strip_prefix(';').map(str::trim_start);
            if tail.is_some_and(|t| t.starts_with("rel=\"next\"")) {
                return Some(url.to_string());
            }
        }
    }
    None
}

#[must_use]
pub fn format_registry_error(context: &str, status: u16, status_text: &str, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(Value::as_str).map(|m| m.trim().to_string()))
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| {
            let trimmed = body.trim();
            if !trimmed.is_empty() && trimmed.len() < 300 { trimmed.to_string() } else { String::new() }
        });
    let suffix = if detail.is_empty() { String::new() } else { format!(" — {detail}") };
    match status {
        401 | 403 => format!(
            "{context}: {status} {status_text}{suffix}. Check the marketplace GitHub token and that it has `read:packages` (GitHub Packages requires a token even for public packages)."
        ),
        404 => format!("{context}: not found (404){suffix}."),
        _ => format!("{context}: {status} {status_text}{suffix}"),
    }
}

/// Shapes a registry packument; versions without a tarball URL are dropped.
pub fn normalize_packument(name: &str, raw: &Value) -> Result<Packument, String> {
    let Some(raw) = raw.as_object() else {
        return Err(format!("Registry returned a non-object packument for {name}."));
    };
    let string_map = |value: Option<&Value>| -> BTreeMap<String, String> {
        value
            .and_then(Value::as_object)
            .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
            .unwrap_or_default()
    };
    let mut versions = BTreeMap::new();
    if let Some(entries) = raw.get("versions").and_then(Value::as_object) {
        for (version, entry) in entries {
            let Some(entry) = entry.as_object() else { continue };
            let dist = entry.get("dist").and_then(Value::as_object);
            let Some(tarball) = dist.and_then(|d| d.get("tarball")).and_then(Value::as_str) else { continue };
            let text = |key: &str| dist.and_then(|d| d.get(key)).and_then(Value::as_str).map(str::to_string);
            versions.insert(
                version.clone(),
                PackumentVersion {
                    version: version.clone(),
                    praxis: entry.get("praxis").cloned(),
                    tarball: tarball.to_string(),
                    dist: TarballDist { integrity: text("integrity"), shasum: text("shasum") },
                },
            );
        }
    }
    Ok(Packument {
        name: name.to_string(),
        dist_tags: string_map(raw.get("dist-tags")),
        versions,
        time: string_map(raw.get("time")),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn scoped_names_encode_the_slash_only() {
        assert_eq!(encode_packument_path("@acme/praxis-addon-x"), "@acme%2Fpraxis-addon-x");
        assert_eq!(encode_packument_path("praxis-addon-x"), "praxis-addon-x");
    }

    #[test]
    fn next_link_is_found_among_rels() {
        let header = "<https://api.github.com/p?page=1>; rel=\"prev\", <https://api.github.com/p?page=3>; rel=\"next\"";
        assert_eq!(parse_next_link(Some(header)).as_deref(), Some("https://api.github.com/p?page=3"));
        assert_eq!(parse_next_link(None), None);
    }

    #[test]
    fn endpoints_must_be_https_unless_loopback() {
        assert!(endpoint_origin("http://example.com", "API URL").is_err());
        assert_eq!(endpoint_origin("http://127.0.0.1:4010/x", "API URL").unwrap(), "http://127.0.0.1:4010");
        assert!(assert_same_origin("https://evil.test/a.tgz", "https://npm.pkg.github.com", "an add-on tarball").is_err());
    }

    #[test]
    fn auth_errors_carry_the_scope_hint() {
        let message = format_registry_error("Listing marketplace packages", 401, "Unauthorized", "{\"message\":\"Bad credentials\"}");
        assert!(message.contains("— Bad credentials") && message.contains("read:packages"));
        assert_eq!(format_registry_error("Fetching x", 404, "Not Found", ""), "Fetching x: not found (404).");
    }

    #[test]
    fn packument_keeps_manifest_and_drops_versions_without_tarball() {
        let raw = json!({
            "dist-tags": {"latest": "1.0.0"},
            "versions": {
                "1.0.0": {"praxis": {"kind": "theme"}, "dist": {"tarball": "http://x/t.tgz", "integrity": "sha512-a"}},
                "0.9.0": {"dist": {}}
            }
        });
        let packument = normalize_packument("p", &raw).unwrap();
        assert_eq!(packument.versions.len(), 1);
        assert_eq!(packument.versions["1.0.0"].dist.integrity.as_deref(), Some("sha512-a"));
        assert!(packument.versions["1.0.0"].praxis.is_some());
    }
}
