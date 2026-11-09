//! The `github-actions` pipeline executor (`deployments/githubActionsExecutor.ts` port):
//! workflow discovery, declared-input parsing, dispatch-request validation and the dispatch
//! call itself.
//!
//! A dispatch never claims a run id: `workflow_dispatch` is answered with 204 No Content, so
//! [`DispatchedWorkflow`] has no run-id field at all. Correlating a dispatch with the run it
//! produced is the observer's job.
//!
//! Persisting intent before the authenticated dispatch is the caller's job: drive
//! `start-deploying` and save the run first, as the direct orchestrator does. A network
//! failure mid-dispatch (the "lost dispatch response") comes back as
//! [`GitHubActionsError::Request`], never as a confirmed refusal, and is never retried here.

use std::collections::BTreeMap;

use base64::Engine;
use chrono::{SecondsFormat, Utc};
use praxis_trackers::encode_uri_component;
use praxis_trackers::github::GitHubApiService;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use serde_yaml::Value as Yaml;

use crate::github_actions_api::{
    ActionsReply, GitHubActionsError, GitHubActionsFailureKind, forbidden_kind, send, string_field,
};

const MAX_ERROR_BODY_CHARS: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubActionsWorkflowSummary {
    pub id: u64,
    pub name: String,
    /// Repo-relative, e.g. `.github/workflows/deploy.yml`: what a profile's `workflowFile` names.
    pub path: String,
    /// `active`, `disabled_manually`, …; a disabled workflow still lists but cannot dispatch.
    pub state: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowDispatchInputType {
    String,
    Boolean,
    Choice,
    Environment,
    Number,
}

impl WorkflowDispatchInputType {
    fn parse(value: &str) -> Option<Self> {
        serde_json::from_value(Value::String(value.to_string())).ok()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDispatchInputDeclaration {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// `string` when the workflow does not say.
    #[serde(rename = "type")]
    pub input_type: WorkflowDispatchInputType,
    /// Only for `choice` inputs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

/// What a successful dispatch returns: only when it was sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchedWorkflow {
    pub dispatched_at: String,
}

fn dispatch_failure_kind(reply: &ActionsReply) -> GitHubActionsFailureKind {
    match reply.status {
        404 | 422 => GitHubActionsFailureKind::InvalidWorkflow,
        429 => GitHubActionsFailureKind::RateLimited,
        403 => forbidden_kind(reply),
        _ => GitHubActionsFailureKind::Other,
    }
}

fn truncate(value: &str) -> String {
    if value.chars().count() > MAX_ERROR_BODY_CHARS {
        let head: String = value.chars().take(MAX_ERROR_BODY_CHARS).collect();
        format!("{head}…")
    } else {
        value.to_string()
    }
}

fn encode_path_segments(value: &str) -> String {
    value
        .split('/')
        .map(encode_uri_component)
        .collect::<Vec<_>>()
        .join("/")
}

/// Dispatches and inspects one repository's workflows. The token needs `actions:write` to
/// dispatch and `contents:read` to read a workflow file.
#[derive(Debug, Clone)]
pub struct GitHubActionsDeploymentExecutor {
    api: GitHubApiService,
}

impl GitHubActionsDeploymentExecutor {
    #[must_use]
    pub fn new(api: GitHubApiService) -> Self {
        Self { api }
    }

    /// Every workflow the repository declares, disabled ones included.
    pub async fn list_workflows(
        &self,
    ) -> Result<Vec<GitHubActionsWorkflowSummary>, GitHubActionsError> {
        let path = format!("{}/actions/workflows", self.api.repo_path()?);
        let parsed = self.get(&path).await?;
        Ok(parsed
            .get("workflows")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(normalize_workflow).collect())
            .unwrap_or_default())
    }

    /// The workflow file's `on.workflow_dispatch.inputs`. Empty, not an error, for a workflow
    /// with no `workflow_dispatch` trigger or one with no inputs.
    pub async fn get_declared_inputs(
        &self,
        workflow_path: &str,
    ) -> Result<Vec<WorkflowDispatchInputDeclaration>, GitHubActionsError> {
        let path = format!(
            "{}/contents/{}",
            self.api.repo_path()?,
            encode_path_segments(workflow_path)
        );
        let parsed = self.get(&path).await?;
        let unexpected = || {
            GitHubActionsError::Failed(format!(
                "Could not read workflow file \"{workflow_path}\" — unexpected response shape."
            ))
        };
        let content = string_field(&parsed, "content").filter(|content| !content.is_empty());
        let (Some(content), Some("base64")) =
            (content, parsed.get("encoding").and_then(Value::as_str))
        else {
            return Err(unexpected());
        };
        // GitHub wraps the base64 at 60 columns; Node's decoder skips the whitespace.
        let compact: String = content.split_whitespace().collect();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(compact)
            .map_err(|_| unexpected())?;
        parse_declared_inputs(&String::from_utf8_lossy(&bytes), workflow_path)
            .map_err(GitHubActionsError::Failed)
    }

    /// Sends the dispatch. Returns only a timestamp, never a run id. A refusal GitHub
    /// returned is [`GitHubActionsError::Refused`]; a network failure is
    /// [`GitHubActionsError::Request`], so a caller cannot mistake it for a refusal.
    pub async fn dispatch_workflow(
        &self,
        workflow_id: &str,
        git_ref: &str,
        inputs: &BTreeMap<String, String>,
    ) -> Result<DispatchedWorkflow, GitHubActionsError> {
        let path = format!(
            "{}/actions/workflows/{}/dispatches",
            self.api.repo_path()?,
            encode_uri_component(workflow_id)
        );
        let dispatched_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let body = json!({ "ref": git_ref, "inputs": inputs });
        let reply = send(&self.api, Method::POST, &path, &[], Some(&body)).await?;
        if !reply.ok() {
            let detail = if reply.text.is_empty() {
                String::new()
            } else {
                format!(": {}", truncate(&reply.text))
            };
            return Err(GitHubActionsError::Refused {
                kind: dispatch_failure_kind(&reply),
                status: reply.status,
                message: format!(
                    "GitHub Actions dispatch failed ({}){detail}",
                    reply.status_line()
                ),
            });
        }
        // A successful dispatch is 204 No Content: nothing further to read.
        Ok(DispatchedWorkflow { dispatched_at })
    }

    async fn get(&self, path: &str) -> Result<Value, GitHubActionsError> {
        let reply = send(&self.api, Method::GET, path, &[], None).await?;
        if matches!(reply.status, 403 | 404) {
            return Err(GitHubActionsError::Refused {
                kind: if reply.status == 404 {
                    GitHubActionsFailureKind::InvalidWorkflow
                } else {
                    GitHubActionsFailureKind::InsufficientPermission
                },
                status: reply.status,
                message: format!(
                    "No permission to read Actions workflows for this repository (HTTP {}).",
                    reply.status
                ),
            });
        }
        if !reply.ok() {
            return Err(GitHubActionsError::Failed(format!(
                "GitHub Actions request failed ({}).",
                reply.status_line()
            )));
        }
        reply.json()
    }
}

fn normalize_workflow(raw: &Value) -> Option<GitHubActionsWorkflowSummary> {
    let id = raw.get("id")?.as_u64()?;
    Some(GitHubActionsWorkflowSummary {
        id,
        name: string_field(raw, "name").unwrap_or_else(|| format!("workflow-{id}")),
        path: string_field(raw, "path").unwrap_or_default(),
        state: string_field(raw, "state").unwrap_or_else(|| "unknown".to_string()),
    })
}

// ── Declared-input parsing ──────────────────────────────────────────────

/// `String(value)` for a YAML scalar, as JavaScript renders it.
fn scalar_text(value: &Yaml) -> Option<String> {
    match value {
        Yaml::String(text) => Some(text.clone()),
        Yaml::Bool(flag) => Some(flag.to_string()),
        Yaml::Number(number) => Some(match (number.as_i64(), number.as_f64()) {
            (Some(int), _) => int.to_string(),
            (None, Some(float)) if float.fract() == 0.0 && float.abs() < 1e15 => {
                format!("{float:.0}")
            }
            _ => number.to_string(),
        }),
        _ => None,
    }
}

/// Extracts `on.workflow_dispatch.inputs` from a workflow file. `on` may be a string, a
/// list or a map; only the map form can carry inputs, so the others mean "none declared".
/// Unparsable YAML is an error, not an empty list.
pub fn parse_declared_inputs(
    yaml_text: &str,
    source_label: &str,
) -> Result<Vec<WorkflowDispatchInputDeclaration>, String> {
    let parsed: Yaml = serde_yaml::from_str(yaml_text)
        .map_err(|error| format!("Could not parse \"{source_label}\" as YAML: {error}"))?;
    let inputs = parsed
        .get("on")
        .filter(|on| on.is_mapping())
        .and_then(|on| on.get("workflow_dispatch"))
        .and_then(|dispatch| dispatch.get("inputs"))
        .and_then(Yaml::as_mapping);
    let Some(inputs) = inputs else {
        return Ok(Vec::new());
    };
    Ok(inputs
        .iter()
        .filter_map(|(name, spec)| normalize_declared_input(scalar_text(name)?, spec))
        .collect())
}

fn normalize_declared_input(name: String, spec: &Yaml) -> Option<WorkflowDispatchInputDeclaration> {
    if name.is_empty() {
        return None;
    }
    let text = |key: &str| spec.get(key).and_then(Yaml::as_str).map(str::to_string);
    let input_type = text("type")
        .and_then(|value| WorkflowDispatchInputType::parse(&value))
        .unwrap_or(WorkflowDispatchInputType::String);
    let options = (input_type == WorkflowDispatchInputType::Choice)
        .then(|| spec.get("options").and_then(Yaml::as_sequence))
        .flatten()
        .map(|options| {
            options
                .iter()
                .filter_map(|option| option.as_str().map(str::to_string))
                .collect()
        });
    Some(WorkflowDispatchInputDeclaration {
        name,
        description: text("description"),
        required: spec.get("required").and_then(Yaml::as_bool) == Some(true),
        default: spec.get("default").and_then(scalar_text),
        input_type,
        options,
    })
}

// ── Dispatch request validation ─────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct ValidateDispatchRequestInput<'a> {
    pub declared_inputs: &'a [WorkflowDispatchInputDeclaration],
    pub git_ref: &'a str,
    pub inputs: &'a BTreeMap<String, String>,
    /// The declared input used to correlate the dispatch with its run. It must be declared
    /// and supplied: without it the run can never be confidently identified afterwards.
    pub correlation_input_name: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchValidationIssue {
    pub path: String,
    pub message: String,
}

fn validation_issue(
    path: impl Into<String>,
    message: impl Into<String>,
) -> DispatchValidationIssue {
    DispatchValidationIssue {
        path: path.into(),
        message: message.into(),
    }
}

/// Every reason the dispatch would be refused, found before spending an API call.
#[must_use]
pub fn validate_dispatch_request(
    input: &ValidateDispatchRequestInput<'_>,
) -> Vec<DispatchValidationIssue> {
    let mut issues = Vec::new();
    let supplied = |name: &str| {
        input
            .inputs
            .get(name)
            .is_some_and(|value| !value.trim().is_empty())
    };

    if input.git_ref.trim().is_empty() {
        issues.push(validation_issue(
            "ref",
            "A ref (branch, tag, or commit) is required to dispatch a workflow.",
        ));
    }

    for declaration in input.declared_inputs {
        let name = &declaration.name;
        if declaration.required && !supplied(name) {
            issues.push(validation_issue(
                format!("inputs.{name}"),
                format!("Required input \"{name}\" was not supplied."),
            ));
        }
        let value = input.inputs.get(name).filter(|value| !value.is_empty());
        if let (WorkflowDispatchInputType::Choice, Some(value), Some(options)) =
            (declaration.input_type, value, &declaration.options)
        {
            if !options.contains(value) {
                issues.push(validation_issue(
                    format!("inputs.{name}"),
                    format!("\"{value}\" is not one of the declared options for \"{name}\"."),
                ));
            }
        }
    }

    // GitHub itself refuses an undeclared input; caught here so the caller sees why.
    let declared = |name: &str| input.declared_inputs.iter().any(|d| d.name == name);
    for name in input.inputs.keys() {
        if !declared(name) {
            issues.push(validation_issue(
                format!("inputs.{name}"),
                format!("\"{name}\" is not a declared input for this workflow."),
            ));
        }
    }

    if let Some(name) = input.correlation_input_name.filter(|name| !name.is_empty()) {
        if !declared(name) {
            issues.push(validation_issue(
                "correlationInputName",
                format!("Correlation input \"{name}\" is not declared by this workflow."),
            ));
        } else if !supplied(name) {
            issues.push(validation_issue(
                format!("inputs.{name}"),
                format!(
                    "Correlation input \"{name}\" must be supplied — without it, the dispatched run cannot be reliably identified afterward."
                ),
            ));
        }
    }

    issues
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock_http::{MockResponse, MockServer};
    use praxis_trackers::github::{GitHubApiConfig, GitHubApiError};

    fn executor(base_url: &str) -> GitHubActionsDeploymentExecutor {
        GitHubActionsDeploymentExecutor::new(GitHubApiService::new(GitHubApiConfig {
            base_url: base_url.to_string(),
            owner: "acme".to_string(),
            repo: "demo".to_string(),
            token: "ghp-test".to_string(),
        }))
    }

    fn inputs(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    async fn dispatch_against(answer: MockResponse) -> GitHubActionsError {
        let server = MockServer::start(move |_| answer.clone()).await;
        executor(&server.base_url)
            .dispatch_workflow("1", "main", &BTreeMap::new())
            .await
            .expect_err("the dispatch is refused")
    }

    // ── list_workflows ───────────────────────────────────────────────────

    #[tokio::test]
    async fn list_workflows_normalizes_including_disabled_workflows() {
        let server = MockServer::start(|_| {
            MockResponse::json(&json!({
                "workflows": [
                    { "id": 1, "name": "Deploy", "path": ".github/workflows/deploy.yml", "state": "active" },
                    { "id": 2, "name": "Legacy deploy", "path": ".github/workflows/legacy.yml", "state": "disabled_manually" },
                    { "name": "no id" }
                ]
            }))
        })
        .await;
        let workflows = executor(&server.base_url)
            .list_workflows()
            .await
            .expect("workflows list");
        assert_eq!(workflows.len(), 2);
        assert_eq!(
            workflows[1],
            GitHubActionsWorkflowSummary {
                id: 2,
                name: "Legacy deploy".to_string(),
                path: ".github/workflows/legacy.yml".to_string(),
                state: "disabled_manually".to_string(),
            }
        );
        let request = &server.requests()[0];
        assert_eq!(request.path(), "/repos/acme/demo/actions/workflows");
        assert_eq!(request.header("authorization"), Some("Bearer ghp-test"));
    }

    #[tokio::test]
    async fn reading_workflows_without_permission_is_a_classified_refusal() {
        let server = MockServer::start(|_| MockResponse::text(403, "{}")).await;
        let error = executor(&server.base_url)
            .list_workflows()
            .await
            .expect_err("refused");
        assert_eq!(
            error.kind(),
            Some(GitHubActionsFailureKind::InsufficientPermission)
        );
        assert!(!error.to_string().contains("ghp-test"));
    }

    // ── get_declared_inputs / parse_declared_inputs ──────────────────────

    #[tokio::test]
    async fn get_declared_inputs_decodes_and_parses_a_workflow_dispatch_block() {
        let yaml = [
            "on:",
            "  workflow_dispatch:",
            "    inputs:",
            "      environment:",
            "        description: Environment to deploy to",
            "        required: true",
            "        type: choice",
            "        options:",
            "          - staging",
            "          - production",
            "      version:",
            "        required: false",
            "        default: latest",
        ]
        .join("\n");
        let encoded = base64::engine::general_purpose::STANDARD.encode(yaml);
        // GitHub wraps the content with newlines.
        let wrapped = format!("{}\n{}", &encoded[..20], &encoded[20..]);
        let server = MockServer::start(move |_| {
            MockResponse::json(&json!({ "content": wrapped, "encoding": "base64" }))
        })
        .await;
        let declared = executor(&server.base_url)
            .get_declared_inputs(".github/workflows/deploy.yml")
            .await
            .expect("declared inputs");
        assert_eq!(
            serde_json::to_value(&declared).expect("serialize"),
            json!([
                { "name": "environment", "description": "Environment to deploy to", "required": true, "type": "choice", "options": ["staging", "production"] },
                { "name": "version", "required": false, "default": "latest", "type": "string" }
            ])
        );
        assert_eq!(
            server.requests()[0].path(),
            "/repos/acme/demo/contents/.github/workflows/deploy.yml"
        );
    }

    #[tokio::test]
    async fn a_contents_answer_without_base64_content_is_an_error() {
        let server =
            MockServer::start(|_| MockResponse::json(&json!({ "encoding": "none" }))).await;
        let error = executor(&server.base_url)
            .get_declared_inputs("x.yml")
            .await
            .expect_err("unexpected shape");
        assert!(error.to_string().contains("unexpected response shape"));
    }

    #[test]
    fn a_workflow_with_no_workflow_dispatch_trigger_declares_no_inputs() {
        let parse = |yaml: &str| parse_declared_inputs(yaml, "x.yml").expect("parses");
        assert_eq!(parse("on: push\n"), Vec::new());
        assert_eq!(
            parse("on:\n  - push\n  - workflow_dispatch\n"),
            Vec::new(),
            "the list form declares no inputs even though it lists workflow_dispatch"
        );
        assert_eq!(parse("on:\n  push: {}\n"), Vec::new());
    }

    #[test]
    fn workflow_dispatch_with_no_config_declares_no_inputs() {
        assert_eq!(
            parse_declared_inputs("on:\n  workflow_dispatch:\n", "x.yml").expect("parses"),
            Vec::new()
        );
    }

    #[test]
    fn unparsable_yaml_is_a_clear_error() {
        let error = parse_declared_inputs("on: [unclosed", "broken.yml").expect_err("fails");
        assert!(error.starts_with("Could not parse \"broken.yml\""));
    }

    #[test]
    fn defaults_render_as_javascript_strings_and_unknown_types_read_as_string() {
        let yaml = "on:\n  workflow_dispatch:\n    inputs:\n      dry:\n        type: boolean\n        default: false\n      count:\n        type: wat\n        default: 3\n";
        let declared = parse_declared_inputs(yaml, "x.yml").expect("parses");
        assert_eq!(declared[0].default.as_deref(), Some("false"));
        assert_eq!(declared[0].input_type, WorkflowDispatchInputType::Boolean);
        assert_eq!(declared[1].default.as_deref(), Some("3"));
        assert_eq!(declared[1].input_type, WorkflowDispatchInputType::String);
    }

    // ── dispatch_workflow ────────────────────────────────────────────────

    #[tokio::test]
    async fn a_successful_dispatch_returns_only_a_timestamp() {
        let server = MockServer::start(|_| MockResponse::text(204, "")).await;
        let result = executor(&server.base_url)
            .dispatch_workflow("1", "main", &inputs(&[("environment", "staging")]))
            .await
            .expect("dispatched");
        assert!(!result.dispatched_at.is_empty());
        assert_eq!(
            serde_json::to_value(&result)
                .expect("serialize")
                .as_object()
                .map(|object| object.keys().cloned().collect::<Vec<_>>()),
            Some(vec!["dispatchedAt".to_string()])
        );
        let request = &server.requests()[0];
        assert_eq!(request.method, "POST");
        assert_eq!(
            request.path(),
            "/repos/acme/demo/actions/workflows/1/dispatches"
        );
        assert_eq!(
            request.json_body(),
            json!({ "ref": "main", "inputs": { "environment": "staging" } })
        );
    }

    #[tokio::test]
    async fn an_invalid_workflow_404_is_invalid_workflow() {
        let error = dispatch_against(MockResponse::status_json(
            404,
            &json!({ "message": "Not Found" }),
        ))
        .await;
        assert_eq!(
            error.kind(),
            Some(GitHubActionsFailureKind::InvalidWorkflow)
        );
        assert_eq!(error.status(), Some(404));
        assert!(
            error
                .to_string()
                .starts_with("GitHub Actions dispatch failed (HTTP 404")
        );
    }

    #[tokio::test]
    async fn an_unprocessable_ref_422_is_invalid_workflow() {
        let error = dispatch_against(MockResponse::status_json(
            422,
            &json!({ "message": "Unprocessable" }),
        ))
        .await;
        assert_eq!(
            error.kind(),
            Some(GitHubActionsFailureKind::InvalidWorkflow)
        );
    }

    #[tokio::test]
    async fn a_403_without_a_rate_limit_signal_is_insufficient_permission() {
        let error = dispatch_against(MockResponse::status_json(
            403,
            &json!({ "message": "Forbidden" }),
        ))
        .await;
        assert_eq!(
            error.kind(),
            Some(GitHubActionsFailureKind::InsufficientPermission)
        );
    }

    #[tokio::test]
    async fn a_403_with_no_remaining_rate_limit_is_rate_limited() {
        let error = dispatch_against(
            MockResponse::status_json(403, &json!({ "message": "API rate limit exceeded" }))
                .with_header("X-RateLimit-Remaining", "0"),
        )
        .await;
        assert_eq!(error.kind(), Some(GitHubActionsFailureKind::RateLimited));
    }

    #[tokio::test]
    async fn a_plain_429_is_rate_limited() {
        let error = dispatch_against(MockResponse::status_json(
            429,
            &json!({ "message": "Too Many Requests" }),
        ))
        .await;
        assert_eq!(error.kind(), Some(GitHubActionsFailureKind::RateLimited));
    }

    #[tokio::test]
    async fn a_lost_dispatch_response_is_never_mistaken_for_a_refusal() {
        // Nothing listens on port 9 (discard): the request fails at the network level.
        let error = executor("http://127.0.0.1:9")
            .dispatch_workflow("1", "main", &BTreeMap::new())
            .await
            .expect_err("the network fails");
        assert!(matches!(
            error,
            GitHubActionsError::Request(GitHubApiError::Transport(_))
        ));
        assert_eq!(error.kind(), None);
    }

    // ── validate_dispatch_request ────────────────────────────────────────

    fn env_input() -> WorkflowDispatchInputDeclaration {
        WorkflowDispatchInputDeclaration {
            name: "environment".to_string(),
            description: None,
            required: true,
            default: None,
            input_type: WorkflowDispatchInputType::Choice,
            options: Some(vec!["staging".to_string(), "production".to_string()]),
        }
    }

    fn token_input() -> WorkflowDispatchInputDeclaration {
        WorkflowDispatchInputDeclaration {
            name: "correlation_token".to_string(),
            description: None,
            required: false,
            default: None,
            input_type: WorkflowDispatchInputType::String,
            options: None,
        }
    }

    fn validate(
        declared: &[WorkflowDispatchInputDeclaration],
        git_ref: &str,
        supplied: &[(&str, &str)],
        correlation: Option<&str>,
    ) -> Vec<DispatchValidationIssue> {
        validate_dispatch_request(&ValidateDispatchRequestInput {
            declared_inputs: declared,
            git_ref,
            inputs: &inputs(supplied),
            correlation_input_name: correlation,
        })
    }

    fn has_path(issues: &[DispatchValidationIssue], path: &str) -> bool {
        issues.iter().any(|issue| issue.path == path)
    }

    #[test]
    fn a_missing_ref_is_refused() {
        assert!(has_path(&validate(&[], "", &[], None), "ref"));
    }

    #[test]
    fn a_missing_required_input_is_refused() {
        assert!(has_path(
            &validate(&[env_input()], "main", &[], None),
            "inputs.environment"
        ));
    }

    #[test]
    fn a_value_outside_a_choice_inputs_options_is_refused() {
        let issues = validate(&[env_input()], "main", &[("environment", "sandbox")], None);
        assert!(issues.iter().any(|issue| issue.path == "inputs.environment"
            && issue.message.contains("not one of the declared options")));
    }

    #[test]
    fn an_undeclared_input_is_refused() {
        let issues = validate(
            &[env_input()],
            "main",
            &[("environment", "staging"), ("mystery", "x")],
            None,
        );
        assert!(has_path(&issues, "inputs.mystery"));
    }

    #[test]
    fn a_well_formed_request_has_no_issues() {
        assert_eq!(
            validate(&[env_input()], "main", &[("environment", "staging")], None),
            Vec::new()
        );
    }

    #[test]
    fn an_undeclared_correlation_input_is_refused() {
        let issues = validate(
            &[env_input()],
            "main",
            &[("environment", "staging")],
            Some("correlation_token"),
        );
        assert!(has_path(&issues, "correlationInputName"));
    }

    #[test]
    fn a_declared_but_unsupplied_correlation_input_is_refused() {
        let issues = validate(
            &[env_input(), token_input()],
            "main",
            &[("environment", "staging")],
            Some("correlation_token"),
        );
        assert!(has_path(&issues, "inputs.correlation_token"));
    }

    #[test]
    fn a_declared_and_supplied_correlation_input_has_no_issue() {
        let issues = validate(
            &[env_input(), token_input()],
            "main",
            &[("environment", "staging"), ("correlation_token", "abc123")],
            Some("correlation_token"),
        );
        assert_eq!(issues, Vec::new());
    }
}
