//! User-added MCP server configuration and sanitization (`mcpServerConfig.ts`).

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use super::custom_providers::is_valid_header_name;

const MAX_SERVERS: usize = 32;

/// Transport protocol for a user-configured MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Http,
    Stdio,
}

/// Validated MCP server configuration stored in `AppSettings.ai.mcpServers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: McpTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    pub require_approval: bool,
}

fn is_valid_server_name(name: &str) -> bool {
    let chars: Vec<char> = name.chars().collect();
    if chars.is_empty() || chars.len() > 48 {
        return false;
    }
    if !chars[0].is_ascii_alphanumeric() {
        return false;
    }
    chars
        .iter()
        .all(|c| c.is_ascii_alphanumeric() || matches!(*c, ' ' | '_' | '.' | '-'))
}

fn is_valid_env_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    if !(bytes[0].is_ascii_alphabetic() || bytes[0] == b'_') {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

fn read_string_map<F>(value: Option<&Value>, valid_key: F) -> Option<BTreeMap<String, String>>
where
    F: Fn(&str) -> bool,
{
    let obj = value?.as_object()?;
    let mut out = BTreeMap::new();
    for (k, v) in obj {
        if let Some(s) = v.as_str()
            && valid_key(k)
        {
            out.insert(k.clone(), s.to_string());
        }
    }
    (!out.is_empty()).then_some(out)
}

fn read_url(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?.trim();
    let parsed = Url::parse(raw).ok()?;
    if parsed.scheme() == "http" || parsed.scheme() == "https" {
        Some(parsed.to_string())
    } else {
        None
    }
}

/// Converts a server display name (`GitHub Tools`) to its tool-name slug (`github_tools`).
#[must_use]
pub fn mcp_server_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut prev_underscore = false;
    for ch in name.to_ascii_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            slug.push(ch);
            prev_underscore = false;
        } else if !prev_underscore && !slug.is_empty() {
            slug.push('_');
            prev_underscore = true;
        }
    }
    let trimmed = slug.trim_matches('_');
    if trimmed.is_empty() {
        "server".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Keeps only well-formed MCP server entries; drops malformed or colliding entries.
#[must_use]
pub fn sanitize_mcp_servers(value: Option<&Value>) -> Vec<McpServerConfig> {
    let Some(arr) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen_ids = HashSet::new();
    let mut seen_names = HashSet::new();
    let mut out = Vec::new();

    for raw in arr {
        if out.len() >= MAX_SERVERS {
            break;
        }
        let Some(obj) = raw.as_object() else {
            continue;
        };
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if id.is_empty() || seen_ids.contains(id) || !is_valid_server_name(name) {
            continue;
        }
        let slug = mcp_server_slug(name);
        if seen_names.contains(&slug) {
            continue;
        }

        let transport = match obj.get("transport").and_then(Value::as_str) {
            Some("http") => McpTransport::Http,
            Some("stdio") => McpTransport::Stdio,
            _ => continue,
        };

        let enabled = obj.get("enabled").and_then(Value::as_bool) != Some(false);
        let require_approval = obj.get("requireApproval").and_then(Value::as_bool) != Some(false);

        let entry = match transport {
            McpTransport::Http => {
                let Some(url) = read_url(obj.get("url")) else {
                    continue;
                };
                let headers = read_string_map(obj.get("headers"), is_valid_header_name);
                McpServerConfig {
                    id: id.to_string(),
                    name: name.to_string(),
                    enabled,
                    transport,
                    url: Some(url),
                    headers,
                    command: None,
                    args: None,
                    env: None,
                    require_approval,
                }
            }
            McpTransport::Stdio => {
                let command = obj
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default();
                if command.is_empty() {
                    continue;
                }
                let args: Vec<String> = obj
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(Value::as_str)
                            .map(ToString::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                let env = read_string_map(obj.get("env"), is_valid_env_name);
                McpServerConfig {
                    id: id.to_string(),
                    name: name.to_string(),
                    enabled,
                    transport,
                    url: None,
                    headers: None,
                    command: Some(command.to_string()),
                    args: (!args.is_empty()).then_some(args),
                    env,
                    require_approval,
                }
            }
        };

        seen_ids.insert(id.to_string());
        seen_names.insert(slug);
        out.push(entry);
    }

    out
}

/// Returns a validation message when a draft MCP server config is incomplete.
#[must_use]
pub fn describe_mcp_server_problem(
    name: Option<&str>,
    transport: Option<&str>,
    url: Option<&str>,
    command: Option<&str>,
) -> Option<String> {
    let trimmed_name = name.map(str::trim).unwrap_or_default();
    if !is_valid_server_name(trimmed_name) {
        return Some(
            "Name must start with a letter or number and use letters, numbers, spaces, dots, dashes or underscores (48 characters at most)."
                .to_string(),
        );
    }
    match transport {
        Some("http") => {
            let val = url.map(|u| Value::String(u.to_string()));
            if read_url(val.as_ref()).is_none() {
                return Some("Enter a full http:// or https:// URL.".to_string());
            }
            None
        }
        Some("stdio") => {
            if command.map(str::trim).unwrap_or_default().is_empty() {
                return Some("Enter the command to run.".to_string());
            }
            None
        }
        _ => Some("Choose a transport.".to_string()),
    }
}

/// Filters a list of MCP servers to enabled ones only.
#[must_use]
pub fn enabled_mcp_servers(servers: &[McpServerConfig]) -> Vec<McpServerConfig> {
    servers.iter().filter(|s| s.enabled).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitizes_http_and_stdio_servers_and_drops_duplicates() {
        let raw = json!([
            { "id": "a", "name": "Docs", "enabled": true, "transport": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer x", "bad header": "no" } },
            { "id": "b", "name": "Local", "transport": "stdio", "command": "npx", "args": ["-y", "thing", 7], "env": { "TOKEN": "v", "1BAD": "no" } },
            { "id": "c", "name": "No url", "transport": "http" },
            { "id": "d", "name": "File", "transport": "http", "url": "file:///etc/passwd" },
            { "id": "e", "name": "No command", "transport": "stdio" },
            { "id": "f", "name": "", "transport": "stdio", "command": "x" },
            { "id": "g", "name": "Odd", "transport": "carrier-pigeon", "url": "https://example.com" },
            "nonsense"
        ]);
        let servers = sanitize_mcp_servers(Some(&raw));
        assert_eq!(
            servers.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(
            servers[0]
                .headers
                .as_ref()
                .and_then(|h| h.get("Authorization")),
            Some(&"Bearer x".to_string())
        );
        assert_eq!(
            servers[1].args,
            Some(vec!["-y".to_string(), "thing".to_string()])
        );
        assert_eq!(
            servers[1].env.as_ref().and_then(|e| e.get("TOKEN")),
            Some(&"v".to_string())
        );
        assert!(servers[0].require_approval);
    }
}
