//! Checking that a provider can actually be reached, before it is used.
//!
//! A provider that is configured but unreachable is a common state: a local
//! runtime that is not running, a base URL with a typo, a key that was
//! revoked. The preflight answers that question up front, so the failure is
//! reported as itself rather than as a failed turn later.
//!
//! The probes are behind a trait so the checks can be exercised without a
//! network or a subprocess.

use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// How a provider is reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    OpenAi,
    Anthropic,
    Gemini,
    Custom,
    /// A runtime on the user's own machine.
    Local,
}

/// What a preflight found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreflightStatus {
    Ready,
    Warning,
    Error,
}

/// The provider to check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreflightSpec {
    pub provider_id: String,
    pub provider_label: String,
    pub provider_kind: ProviderKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

/// The outcome of a preflight.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreflightResult {
    pub status: PreflightStatus,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_label: Option<String>,
}

/// The outcome of running a command.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandProbe {
    /// The exit code, or `None` when the command could not be run at all.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// The checks a preflight runs against the machine.
#[async_trait]
pub trait PreflightProbes: Send + Sync {
    /// Runs a command and reports how it ended.
    async fn run_command(&self, command: &str, args: &[&str]) -> CommandProbe;
    /// GETs a URL and returns the status code, or the reason it could not be
    /// reached.
    async fn http_status(&self, url: &str, bearer_token: Option<&str>) -> Result<u16, String>;
}

/// Probes that run against this machine.
#[derive(Debug)]
pub struct SystemPreflightProbes {
    client: reqwest::Client,
}

impl Default for SystemPreflightProbes {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemPreflightProbes {
    /// A probe set that reaches the network and runs commands.
    #[must_use]
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        Self { client }
    }
}

#[async_trait]
impl PreflightProbes for SystemPreflightProbes {
    async fn run_command(&self, command: &str, args: &[&str]) -> CommandProbe {
        match tokio::process::Command::new(command)
            .args(args)
            .output()
            .await
        {
            Ok(output) => CommandProbe {
                code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            },
            Err(error) => CommandProbe {
                code: None,
                stdout: String::new(),
                stderr: error.to_string(),
            },
        }
    }

    async fn http_status(&self, url: &str, bearer_token: Option<&str>) -> Result<u16, String> {
        let mut request = self.client.get(url);
        if let Some(token) = bearer_token {
            if !token.trim().is_empty() {
                request = request.bearer_auth(token.trim());
            }
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        Ok(response.status().as_u16())
    }
}

/// How a provider is reached.
///
/// A provider with a base URL is reached over HTTP, whatever it was declared
/// to be — so a local runtime that was given an address is probed the same way
/// as any other custom endpoint.
#[must_use]
pub fn detect_provider_kind(spec: &ProviderPreflightSpec) -> ProviderKind {
    if matches!(
        spec.provider_kind,
        ProviderKind::OpenAi | ProviderKind::Anthropic | ProviderKind::Gemini
    ) {
        return spec.provider_kind;
    }
    if spec
        .base_url
        .as_deref()
        .is_some_and(|base| !base.trim().is_empty())
    {
        return ProviderKind::Custom;
    }
    spec.provider_kind
}

/// The command a provider needs before it can run, if any.
///
/// A local runtime has to be installed and on the PATH; an API provider has
/// nothing to check locally.
#[must_use]
pub fn required_command(spec: &ProviderPreflightSpec) -> Option<&'static str> {
    if matches!(
        spec.provider_kind,
        ProviderKind::OpenAi | ProviderKind::Anthropic | ProviderKind::Gemini
    ) {
        return None;
    }
    let id = spec.provider_id.to_lowercase();
    if id.contains("ollama") {
        return Some("ollama");
    }
    if id.contains("lmstudio") || id.contains("lm-studio") {
        return Some("lms");
    }
    if id.contains("llama") {
        return Some("llama-server");
    }
    None
}

fn resolve(
    spec: &ProviderPreflightSpec,
    status: PreflightStatus,
    message: impl Into<String>,
    detail: Option<String>,
) -> ProviderPreflightResult {
    ProviderPreflightResult {
        status,
        message: message.into(),
        detail: detail.filter(|detail| !detail.trim().is_empty()),
        provider_id: Some(spec.provider_id.clone()),
        provider_label: Some(spec.provider_label.clone()),
    }
}

/// Checks that a provider can be reached.
pub async fn run_provider_preflight(
    spec: &ProviderPreflightSpec,
    probes: &dyn PreflightProbes,
) -> ProviderPreflightResult {
    if let Some(command) = required_command(spec) {
        let probe = probes.run_command(command, &["--version"]).await;
        if probe.code != Some(0) {
            return resolve(
                spec,
                PreflightStatus::Error,
                format!("{command} is not installed or not on your PATH."),
                Some(probe.stderr),
            );
        }
    }

    if detect_provider_kind(spec) == ProviderKind::Custom {
        let base = spec
            .base_url
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string();
        if base.is_empty() {
            return resolve(
                spec,
                PreflightStatus::Error,
                "That provider needs a base URL before it can be checked.",
                None,
            );
        }
        let url = format!("{base}/models");
        return match probes.http_status(&url, spec.api_key.as_deref()).await {
            Err(error) => resolve(
                spec,
                PreflightStatus::Error,
                format!("Could not reach {base}."),
                Some(error),
            ),
            Ok(status) if status == 401 || status == 403 => resolve(
                spec,
                PreflightStatus::Error,
                "That provider rejected the key.",
                Some(format!("HTTP {status}")),
            ),
            Ok(status) if !(200..300).contains(&status) => resolve(
                spec,
                PreflightStatus::Error,
                format!("That endpoint answered {status}."),
                None,
            ),
            Ok(_) => resolve(
                spec,
                PreflightStatus::Ready,
                "That provider answered.",
                None,
            ),
        };
    }

    resolve(
        spec,
        PreflightStatus::Ready,
        format!("{} is configured.", spec.provider_label),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        CommandProbe, PreflightProbes, PreflightStatus, ProviderKind, ProviderPreflightSpec,
        detect_provider_kind, run_provider_preflight,
    };
    use async_trait::async_trait;

    struct FakeProbes {
        command: CommandProbe,
        status: Result<u16, String>,
    }

    #[async_trait]
    impl PreflightProbes for FakeProbes {
        async fn run_command(&self, _command: &str, _args: &[&str]) -> CommandProbe {
            self.command.clone()
        }
        async fn http_status(&self, _url: &str, _token: Option<&str>) -> Result<u16, String> {
            self.status.clone()
        }
    }

    fn spec(kind: ProviderKind) -> ProviderPreflightSpec {
        ProviderPreflightSpec {
            provider_id: "ollama".to_string(),
            provider_label: "Ollama".to_string(),
            provider_kind: kind,
            base_url: None,
            model: None,
            api_key: None,
        }
    }

    #[tokio::test]
    async fn a_ready_local_provider_is_reported_when_the_runtime_answers() {
        let probes = FakeProbes {
            command: CommandProbe {
                code: Some(0),
                stdout: "ollama 0.1".to_string(),
                stderr: String::new(),
            },
            status: Ok(200),
        };
        let result = run_provider_preflight(&spec(ProviderKind::Local), &probes).await;
        assert_eq!(result.status, PreflightStatus::Ready);
        assert_eq!(result.provider_id.as_deref(), Some("ollama"));
        assert_eq!(result.provider_label.as_deref(), Some("Ollama"));
    }

    #[tokio::test]
    async fn a_missing_runtime_is_reported_as_an_error() {
        let probes = FakeProbes {
            command: CommandProbe {
                code: None,
                stdout: String::new(),
                stderr: "spawn ollama ENOENT".to_string(),
            },
            status: Ok(200),
        };
        let result = run_provider_preflight(&spec(ProviderKind::Local), &probes).await;
        assert_eq!(result.status, PreflightStatus::Error);
        assert_eq!(
            result.message,
            "ollama is not installed or not on your PATH."
        );
        assert_eq!(result.detail.as_deref(), Some("spawn ollama ENOENT"));
    }

    #[tokio::test]
    async fn a_custom_provider_without_a_base_url_is_reported_before_it_is_probed() {
        let probes = FakeProbes {
            command: CommandProbe {
                code: Some(0),
                stdout: String::new(),
                stderr: String::new(),
            },
            status: Ok(200),
        };
        let mut custom = spec(ProviderKind::Custom);
        custom.provider_id = "my-endpoint".to_string();
        let result = run_provider_preflight(&custom, &probes).await;
        assert_eq!(result.status, PreflightStatus::Error);
        assert_eq!(
            result.message,
            "That provider needs a base URL before it can be checked."
        );
    }

    #[tokio::test]
    async fn a_custom_provider_that_answers_is_reported_as_ready() {
        let probes = FakeProbes {
            command: CommandProbe {
                code: Some(0),
                stdout: String::new(),
                stderr: String::new(),
            },
            status: Ok(200),
        };
        let mut custom = spec(ProviderKind::Custom);
        custom.provider_id = "my-endpoint".to_string();
        custom.base_url = Some("https://ai.example.dev/v1".to_string());
        let result = run_provider_preflight(&custom, &probes).await;
        assert_eq!(result.status, PreflightStatus::Ready);
        assert_eq!(result.message, "That provider answered.");
    }

    #[tokio::test]
    async fn a_rejected_key_is_reported_as_such() {
        let probes = FakeProbes {
            command: CommandProbe {
                code: Some(0),
                stdout: String::new(),
                stderr: String::new(),
            },
            status: Ok(401),
        };
        let mut custom = spec(ProviderKind::Custom);
        custom.provider_id = "my-endpoint".to_string();
        custom.base_url = Some("https://ai.example.dev/v1".to_string());
        let result = run_provider_preflight(&custom, &probes).await;
        assert_eq!(result.status, PreflightStatus::Error);
        assert_eq!(result.message, "That provider rejected the key.");
        assert_eq!(result.detail.as_deref(), Some("HTTP 401"));
    }

    #[tokio::test]
    async fn an_api_provider_needs_no_local_command_and_is_reported_as_configured() {
        let probes = FakeProbes {
            command: CommandProbe {
                code: None,
                stdout: String::new(),
                stderr: String::new(),
            },
            status: Err("no network".to_string()),
        };
        let mut api = spec(ProviderKind::OpenAi);
        api.provider_id = "openai".to_string();
        api.provider_label = "OpenAI".to_string();
        let result = run_provider_preflight(&api, &probes).await;
        assert_eq!(result.status, PreflightStatus::Ready);
        assert_eq!(result.message, "OpenAI is configured.");
    }

    #[test]
    fn a_provider_with_a_base_url_is_probed_over_http_whatever_it_was_declared_to_be() {
        let mut local = spec(ProviderKind::Local);
        local.base_url = Some("http://localhost:11434/v1".to_string());
        assert_eq!(detect_provider_kind(&local), ProviderKind::Custom);

        let mut api = spec(ProviderKind::OpenAi);
        api.base_url = Some("https://api.openai.com/v1".to_string());
        assert_eq!(detect_provider_kind(&api), ProviderKind::OpenAi);
    }
}
