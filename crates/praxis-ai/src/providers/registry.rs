//! The developer-maintained provider registry, secret naming, and CLI availability probes.
//! Ports `providers/registry.ts`, `providerSecrets.ts` (naming), `cliProbe.ts` and the CLI half
//! of `providerPreflight.ts`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Value, json};

use super::environment::effective_path;

pub const DEFAULT_VERCEL_URL: &str = "https://ai-gateway.vercel.sh";
pub const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com";
/// The Vercel gateway key keeps its original name so previously stored keys still resolve.
pub const SECRET_VERCEL_API_KEY: &str = "praxis.vercelApiKey";
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DescriptorKind {
    Api,
    CliAgent,
}

#[derive(Debug, Clone)]
pub struct ProviderDescriptor {
    pub id: String,
    pub kind: DescriptorKind,
    pub label: String,
    pub default_base_url: Option<String>,
    pub default_model: String,
    pub api_path: Option<String>,
    pub default_command: Option<String>,
    pub default_args: Vec<String>,
}

fn api(id: &str, label: &str, url: &str, model: &str, path: Option<&str>) -> ProviderDescriptor {
    ProviderDescriptor {
        id: id.into(),
        kind: DescriptorKind::Api,
        label: label.into(),
        default_base_url: Some(url.into()),
        default_model: model.into(),
        api_path: path.map(Into::into),
        default_command: None,
        default_args: Vec::new(),
    }
}

fn cli(id: &str, label: &str, command: &str, args: &[&str]) -> ProviderDescriptor {
    ProviderDescriptor {
        id: id.into(),
        kind: DescriptorKind::CliAgent,
        label: label.into(),
        default_base_url: None,
        default_model: String::new(),
        api_path: None,
        default_command: Some(command.into()),
        default_args: args.iter().map(|a| (*a).to_owned()).collect(),
    }
}

/// Built-in providers, in the order Settings lists them.
#[must_use]
pub fn built_in_descriptors() -> Vec<ProviderDescriptor> {
    vec![
        api(
            "vercel-gateway",
            "Vercel AI Gateway",
            DEFAULT_VERCEL_URL,
            "anthropic/claude-sonnet-4.6",
            None,
        ),
        api(
            "openai",
            "OpenAI",
            "https://api.openai.com",
            "gpt-4o-mini",
            None,
        ),
        api(
            "anthropic",
            "Anthropic",
            "https://api.anthropic.com",
            "claude-sonnet-4-6",
            None,
        ),
        api(
            "gemini",
            "Google Gemini",
            DEFAULT_GEMINI_BASE_URL,
            "gemini-2.5-flash",
            None,
        ),
        api(
            "z-ai",
            "Z.ai",
            "https://api.z.ai",
            "glm-5.3",
            Some("/api/coding/paas/v4"),
        ),
        cli(
            "claude-code-cli",
            "Claude Code (local)",
            "claude-agent-acp",
            &[],
        ),
        cli("codex-cli", "Codex CLI (local)", "codex-acp", &[]),
        cli(
            "copilot-cli",
            "GitHub Copilot (local)",
            "copilot",
            &["--acp"],
        ),
        cli("antigravity-cli", "Antigravity", "antigravity-acp", &[]),
        cli("cursor-cli", "Cursor (local)", "agent", &["acp"]),
    ]
}

#[must_use]
pub fn is_custom_provider_id(id: &str) -> bool {
    id.starts_with("custom:")
}

/// The secret-store key for a provider's API key. Matches the TypeScript names exactly, so keys
/// migrated from the Electron app (`praxis.geminiApiKey`, `praxis.customProvider.<slug>.apiKey`)
/// are found.
#[must_use]
pub fn secret_key_for_provider(provider: &str) -> String {
    if provider == "vercel-gateway" {
        return SECRET_VERCEL_API_KEY.to_owned();
    }
    if let Some(slug) = provider.strip_prefix("custom:") {
        return format!("praxis.customProvider.{slug}.apiKey");
    }
    format!("praxis.{provider}ApiKey")
}

/// The catalog behind Settings → AI Provider → Add provider, generated from the TypeScript
/// `PROVIDER_PRESETS` by `scripts/generate-provider-presets.mjs`.
#[must_use]
pub fn provider_presets() -> Vec<Value> {
    serde_json::from_str(include_str!("provider_presets.json")).unwrap_or_default()
}

/// Providers whose keys live in the AI provider secrets namespace.
pub const API_KEY_PROVIDERS: [&str; 5] =
    ["vercel-gateway", "openai", "anthropic", "gemini", "z-ai"];

/// The gateway key from the environment: `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, then
/// `FROSTY_VERCEL_API_KEY`.
#[must_use]
pub fn gateway_key_from_env() -> Option<String> {
    [
        "AI_GATEWAY_API_KEY",
        "VERCEL_OIDC_TOKEN",
        "FROSTY_VERCEL_API_KEY",
    ]
    .iter()
    .find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

/// Resolves `command` to an executable file, searching `search_path` when it has no directory
/// part. Honors `PATHEXT` on Windows.
#[must_use]
pub fn resolve_executable(command: &str, search_path: &str) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    let candidates: Vec<PathBuf> =
        if Path::new(command).components().count() > 1 || Path::new(command).is_absolute() {
            vec![PathBuf::from(command)]
        } else {
            std::env::split_paths(search_path)
                .map(|dir| dir.join(command))
                .collect()
        };
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    for base in candidates {
        let mut variants = vec![base.clone()];
        variants.extend(
            extensions
                .iter()
                .map(|ext| PathBuf::from(format!("{}{ext}", base.display()))),
        );
        for path in variants {
            if is_executable_file(&path) {
                return Some(path);
            }
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Whether `command` resolves to a spawnable executable. Starts nothing, so it is free to call
/// while rendering Settings.
#[must_use]
pub fn is_executable_available(command: &str) -> bool {
    resolve_executable(command, effective_path()).is_some()
}

fn drain<R: std::io::Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = pipe {
            let _ = std::io::Read::read_to_string(&mut pipe, &mut text);
        }
        text
    })
}

/// A cheap, non-interactive check that a local CLI runs: `<command> --version`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliPreflight {
    /// `unavailable | denied | failed | ready`.
    pub status: &'static str,
    pub message: String,
    pub provider_version: Option<String>,
}

impl CliPreflight {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut value = json!({ "status": self.status, "message": self.message });
        if let Some(version) = &self.provider_version {
            value["providerVersion"] = json!(version);
        }
        value
    }
}

fn version_from(output: &str) -> Option<String> {
    Regex::new(r"(?i)\b(?:v(?:ersion)?\s*)?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)\b")
        .ok()?
        .captures(output)
        .map(|c| c[1].to_owned())
}

fn denied(output: &str) -> bool {
    Regex::new(r"(?i)\b(permission denied|access denied|not authorized|unauthorized|forbidden|login required)\b").is_ok_and(|re| re.is_match(output))
}

/// Runs only a local `--version`. Neither starts ACP nor sends a prompt.
#[must_use]
pub fn probe_cli_provider(command: &str) -> CliPreflight {
    let Some(resolved) = resolve_executable(command, effective_path()) else {
        return CliPreflight {
            status: "unavailable",
            message: format!("spawn {command} ENOENT"),
            provider_version: None,
        };
    };
    let mut child = match Command::new(&resolved)
        .arg("--version")
        .env("PATH", effective_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let status = if error.kind() == std::io::ErrorKind::PermissionDenied {
                "denied"
            } else {
                "unavailable"
            };
            return CliPreflight {
                status,
                message: error.to_string(),
                provider_version: None,
            };
        }
    };
    let (out, err) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let deadline = Instant::now() + VERSION_TIMEOUT;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status.code()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return CliPreflight {
                    status: "failed",
                    message: format!(
                        "CLI version check timed out after {}ms.",
                        VERSION_TIMEOUT.as_millis()
                    ),
                    provider_version: None,
                };
            }
        }
    };
    let output = format!(
        "{}{}",
        out.join().unwrap_or_default(),
        err.join().unwrap_or_default()
    );
    let message = output.trim().to_owned();
    match code {
        Some(Some(0)) => CliPreflight {
            status: "ready",
            provider_version: version_from(&message),
            message: if message.is_empty() {
                "CLI is available.".into()
            } else {
                message
            },
        },
        other => CliPreflight {
            status: if denied(&message) { "denied" } else { "failed" },
            message: if message.is_empty() {
                format!(
                    "CLI exited with status {}.",
                    other.flatten().map_or("unknown".into(), |c| c.to_string())
                )
            } else {
                message
            },
            provider_version: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_keys_match_the_names_the_electron_app_wrote() {
        assert_eq!(
            secret_key_for_provider("vercel-gateway"),
            "praxis.vercelApiKey"
        );
        assert_eq!(secret_key_for_provider("gemini"), "praxis.geminiApiKey");
        assert_eq!(secret_key_for_provider("z-ai"), "praxis.z-aiApiKey");
        assert_eq!(
            secret_key_for_provider("custom:openrouter"),
            "praxis.customProvider.openrouter.apiKey"
        );
        assert_eq!(
            secret_key_for_provider("custom:alibaba-model-studio-token-plan"),
            "praxis.customProvider.alibaba-model-studio-token-plan.apiKey"
        );
    }

    #[test]
    fn built_ins_are_listed_in_settings_order_with_the_documented_commands() {
        let ids: Vec<_> = built_in_descriptors().into_iter().map(|d| d.id).collect();
        assert_eq!(
            ids,
            [
                "vercel-gateway",
                "openai",
                "anthropic",
                "gemini",
                "z-ai",
                "claude-code-cli",
                "codex-cli",
                "copilot-cli",
                "antigravity-cli",
                "cursor-cli"
            ]
        );
        let copilot = built_in_descriptors()
            .into_iter()
            .find(|d| d.id == "copilot-cli")
            .expect("copilot");
        assert_eq!(
            (
                copilot.default_command.as_deref(),
                copilot.default_args.as_slice()
            ),
            (Some("copilot"), ["--acp".to_string()].as_slice())
        );
    }

    #[test]
    fn presets_are_the_documented_catalog() {
        let presets = provider_presets();
        assert_eq!(presets.len(), 18);
        let ollama = presets
            .iter()
            .find(|p| p["id"] == "ollama")
            .expect("ollama");
        assert_eq!(
            (
                ollama["group"].as_str(),
                ollama["keyRequired"].as_bool(),
                ollama["auth"]["kind"].as_str()
            ),
            (Some("local"), Some(false), Some("none"))
        );
        let bifrost = presets
            .iter()
            .find(|p| p["id"] == "bifrost")
            .expect("bifrost");
        assert_eq!(bifrost["auth"]["name"], "x-bf-vk");
    }

    #[test]
    fn versions_are_read_the_way_the_typescript_reads_them() {
        assert_eq!(
            version_from("claude-agent-acp v0.5.2 (build 7)").as_deref(),
            Some("0.5.2")
        );
        assert_eq!(version_from("version 1.2").as_deref(), Some("1.2"));
        assert_eq!(version_from("no digits here"), None);
        assert!(denied("Error: Permission denied"));
        assert!(!denied("all fine"));
    }

    #[cfg(unix)]
    #[test]
    fn availability_requires_an_executable_file_not_just_a_name() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("praxis-exec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let tool = dir.join("my-agent");
        std::fs::write(&tool, "#!/bin/sh\necho 'my-agent 9.8.7'\n").expect("write");
        assert!(
            resolve_executable("my-agent", dir.to_str().unwrap_or("")).is_none(),
            "not executable yet"
        );
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        assert_eq!(
            resolve_executable("my-agent", dir.to_str().unwrap_or("")),
            Some(tool.clone())
        );
        assert!(resolve_executable("missing", dir.to_str().unwrap_or("")).is_none());
        // An absolute path ignores the search path.
        assert_eq!(
            resolve_executable(tool.to_str().unwrap_or(""), ""),
            Some(tool.clone())
        );
        let probe = probe_cli_provider(tool.to_str().unwrap_or(""));
        assert_eq!(
            (probe.status, probe.provider_version.as_deref()),
            ("ready", Some("9.8.7"))
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_cli_is_unavailable() {
        let probe = probe_cli_provider("definitely-not-installed-praxis");
        assert_eq!(probe.status, "unavailable");
        assert!(!is_executable_available("definitely-not-installed-praxis"));
    }
}
