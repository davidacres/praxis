//! Project Run profiles (`projects/runProfile.ts` port).
//!
//! Describes the services a project runs locally for a diagnostic preview, stored as
//! `run.praxis.json`. Validation fails closed: a profile that cannot be proven safe is
//! rejected rather than repaired, because launching the wrong command or leaking a
//! secret into a committed file costs far more than refusing to save.

use std::collections::{BTreeMap, BTreeSet};

use praxis_core::workspaces::workspace_paths::is_portable_folder_path;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const RUN_PROFILE_FILE_NAME: &str = "run.praxis.json";
pub const RUN_PROFILE_SCHEMA_VERSION: u32 = 1;

/// How a service's readiness is decided.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RunReadinessProbe {
    /// `path` is relative to the service's own base URL; `expected_status` defaults to any 2xx.
    #[serde(rename_all = "camelCase")]
    Http {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_status: Option<u16>,
    },
    Tcp {
        port: u32,
    },
    /// A substring the service's own output must emit once ready. Only ever matched, never run.
    LogLine {
        #[serde(rename = "match")]
        match_text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunServiceDefinition {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub executable: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// Repo-relative, resolved against the project folder at launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Service ids that must be ready first. Must form a DAG.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readiness_probe: Option<RunReadinessProbe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u32>,
    /// Secret-shaped keys must hold a `${secret:NAME}` reference, never a literal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProfile {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub services: Vec<RunServiceDefinition>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunProfileIssue {
    pub path: String,
    pub message: String,
}

fn issue(path: impl Into<String>, message: impl Into<String>) -> RunProfileIssue {
    RunProfileIssue {
        path: path.into(),
        message: message.into(),
    }
}

/// Whether an env/config key looks like it holds a secret. Matches the TS vocabulary
/// `token|secret|password|api[_-]?key|(?:^|_)pat(?:_|$)`, case-insensitively.
#[must_use]
pub fn is_secret_shaped_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("apikey")
        || lower.contains("api_key")
        || lower.contains("api-key")
        || lower.split('_').any(|segment| segment == "pat")
}

/// Whether a value is exactly a `${secret:NAME}` reference.
#[must_use]
pub fn is_secret_reference_value(value: &str) -> bool {
    let Some(name) = value
        .strip_prefix("${secret:")
        .and_then(|rest| rest.strip_suffix('}'))
    else {
        return false;
    };
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn is_valid_port(port: u32) -> bool {
    (1..=65_535).contains(&port)
}

/// Fails closed on duplicate ids, a dependency cycle, an ill-shaped probe, an absolute
/// `cwd`, and a secret-shaped env key holding anything but a secret reference. An empty
/// result means the profile is valid.
#[must_use]
pub fn validate_run_profile(profile: &RunProfile) -> Vec<RunProfileIssue> {
    let mut errors = Vec::new();

    if profile.id.trim().is_empty() {
        errors.push(issue("id", "id is required."));
    }
    if profile.name.trim().is_empty() {
        errors.push(issue("name", "name is required."));
    }
    if profile.services.is_empty() {
        errors.push(issue(
            "services",
            "A run profile needs at least one service.",
        ));
    }

    let mut seen_ids = BTreeSet::new();
    for (index, service) in profile.services.iter().enumerate() {
        let at = format!("services[{index}]");

        if service.id.trim().is_empty() {
            errors.push(issue(format!("{at}.id"), "id is required."));
        } else if !seen_ids.insert(service.id.as_str()) {
            errors.push(issue(
                format!("{at}.id"),
                format!("Duplicate service id \"{}\".", service.id),
            ));
        }

        if service.executable.trim().is_empty() {
            errors.push(issue(format!("{at}.executable"), "executable is required."));
        }

        if let Some(cwd) = &service.cwd {
            if !is_portable_folder_path(cwd) {
                errors.push(issue(
                    format!("{at}.cwd"),
                    format!("cwd must be repo-relative, not absolute: \"{cwd}\"."),
                ));
            }
        }

        if let Some(port) = service.port {
            if !is_valid_port(port) {
                errors.push(issue(
                    format!("{at}.port"),
                    "port must be an integer between 1 and 65535.",
                ));
            }
        }

        match &service.readiness_probe {
            None => {}
            Some(RunReadinessProbe::Http { path, .. }) if path.trim().is_empty() => {
                errors.push(issue(
                    format!("{at}.readinessProbe.path"),
                    "An http probe needs a path.",
                ));
            }
            Some(RunReadinessProbe::Tcp { port }) if !is_valid_port(*port) => {
                errors.push(issue(
                    format!("{at}.readinessProbe.port"),
                    "A tcp probe needs a valid port (1-65535).",
                ));
            }
            Some(RunReadinessProbe::LogLine { match_text }) if match_text.trim().is_empty() => {
                errors.push(issue(
                    format!("{at}.readinessProbe.match"),
                    "A log-line probe needs a non-empty match string.",
                ));
            }
            Some(_) => {}
        }

        for (key, value) in service.env.iter().flatten() {
            if is_secret_shaped_key(key) && !is_secret_reference_value(value) {
                errors.push(issue(
                    format!("{at}.env.{key}"),
                    format!(
                        "\"{key}\" looks like a secret; use a ${{secret:NAME}} reference, never a literal value."
                    ),
                ));
            }
        }
    }

    let ids: BTreeSet<&str> = profile.services.iter().map(|s| s.id.as_str()).collect();
    for (index, service) in profile.services.iter().enumerate() {
        for dep in service.depends_on.iter().flatten() {
            if !ids.contains(dep.as_str()) {
                errors.push(issue(
                    format!("services[{index}].dependsOn"),
                    format!("Unknown service id \"{dep}\"."),
                ));
            }
        }
    }

    if let Some(cycle) = find_dependency_cycle(&profile.services) {
        errors.push(issue(
            "services",
            format!("Service dependencies form a cycle: {}.", cycle.join(" → ")),
        ));
    }

    errors
}

/// IPC validation before typed deserialization: report invalid ports and unknown
/// probe kinds using the same field errors as the desktop rather than serde errors.
#[must_use]
pub fn validate_run_profile_value(profile: &Value) -> Vec<RunProfileIssue> {
    let mut errors = Vec::new();
    let string = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let valid_port = |value: Option<&Value>| {
        value
            .and_then(Value::as_u64)
            .is_some_and(|port| port > 0 && port <= 65535)
    };
    for field in ["id", "name"] {
        if string(profile.get(field)).trim().is_empty() {
            errors.push(issue(field, format!("{field} is required.")));
        }
    }
    let services = profile
        .get("services")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if services.is_empty() {
        errors.push(issue(
            "services",
            "A run profile needs at least one service.",
        ));
    }
    let mut ids = BTreeSet::new();
    for (index, service) in services.iter().enumerate() {
        let at = format!("services[{index}]");
        let id = string(service.get("id"));
        if id.trim().is_empty() {
            errors.push(issue(format!("{at}.id"), "id is required."));
        } else if !ids.insert(id.clone()) {
            errors.push(issue(
                format!("{at}.id"),
                format!("Duplicate service id \"{id}\"."),
            ));
        }
        if string(service.get("executable")).trim().is_empty() {
            errors.push(issue(format!("{at}.executable"), "executable is required."));
        }
        if let Some(cwd) = service.get("cwd") {
            let text = string(Some(cwd));
            if !cwd.is_string() || !is_portable_folder_path(&text) {
                errors.push(issue(
                    format!("{at}.cwd"),
                    format!("cwd must be repo-relative, not absolute: \"{text}\"."),
                ));
            }
        }
        if service.get("port").is_some() && !valid_port(service.get("port")) {
            errors.push(issue(
                format!("{at}.port"),
                "port must be an integer between 1 and 65535.",
            ));
        }
        if let Some(probe) = service
            .get("readinessProbe")
            .filter(|v| !v.is_null() && **v != Value::Bool(false))
        {
            let kind = string(probe.get("kind"));
            match kind.as_str() {
                "http" if string(probe.get("path")).trim().is_empty() => errors.push(issue(
                    format!("{at}.readinessProbe.path"),
                    "An http probe needs a path.",
                )),
                "tcp" if !valid_port(probe.get("port")) => errors.push(issue(
                    format!("{at}.readinessProbe.port"),
                    "A tcp probe needs a valid port (1-65535).",
                )),
                "log-line" if string(probe.get("match")).trim().is_empty() => errors.push(issue(
                    format!("{at}.readinessProbe.match"),
                    "A log-line probe needs a non-empty match string.",
                )),
                "http" | "tcp" | "log-line" => {}
                _ => {
                    let label = probe.get("kind").map_or_else(
                        || "undefined".into(),
                        |value| {
                            value
                                .as_str()
                                .map_or_else(|| value.to_string(), str::to_string)
                        },
                    );
                    errors.push(issue(
                        format!("{at}.readinessProbe.kind"),
                        format!("Unknown readiness probe kind \"{label}\"."),
                    ));
                }
            }
        }
        if let Some(env) = service.get("env").and_then(Value::as_object) {
            for (key, value) in env {
                if is_secret_shaped_key(key)
                    && !value.as_str().is_some_and(is_secret_reference_value)
                {
                    errors.push(issue(format!("{at}.env.{key}"), format!("\"{key}\" looks like a secret; use a ${{secret:NAME}} reference, never a literal value.")));
                }
            }
        }
    }
    let deps = |service: &Value| {
        service
            .get("dependsOn")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    for (index, service) in services.iter().enumerate() {
        for dep in deps(service) {
            let text = string(Some(&dep));
            if !ids.contains(&text) {
                errors.push(issue(
                    format!("services[{index}].dependsOn"),
                    format!("Unknown service id \"{text}\"."),
                ));
            }
        }
    }
    let graph: BTreeMap<String, Vec<String>> = services
        .iter()
        .map(|s| {
            (
                string(s.get("id")),
                deps(s).iter().map(|v| string(Some(v))).collect(),
            )
        })
        .collect();
    fn visit(
        id: &str,
        graph: &BTreeMap<String, Vec<String>>,
        done: &mut BTreeSet<String>,
        path: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        if done.contains(id) {
            return None;
        }
        if path.iter().any(|v| v == id) {
            let mut cycle = path.clone();
            cycle.push(id.to_string());
            return Some(cycle);
        }
        path.push(id.to_string());
        for dep in graph.get(id).into_iter().flatten() {
            if graph.contains_key(dep) {
                if let Some(cycle) = visit(dep, graph, done, path) {
                    return Some(cycle);
                }
            }
        }
        path.pop();
        done.insert(id.to_string());
        None
    }
    let mut done = BTreeSet::new();
    for service in &services {
        if let Some(cycle) = visit(
            &string(service.get("id")),
            &graph,
            &mut done,
            &mut Vec::new(),
        ) {
            errors.push(issue(
                "services",
                format!("Service dependencies form a cycle: {}.", cycle.join(" → ")),
            ));
            break;
        }
    }
    errors
}

/// DFS over `depends_on`; returns the cycle (for a clear message) or `None` for a DAG.
fn find_dependency_cycle(services: &[RunServiceDefinition]) -> Option<Vec<String>> {
    let by_id: BTreeMap<&str, &RunServiceDefinition> =
        services.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut done: BTreeSet<&str> = BTreeSet::new();

    fn visit<'a>(
        id: &'a str,
        by_id: &BTreeMap<&'a str, &'a RunServiceDefinition>,
        done: &mut BTreeSet<&'a str>,
        visiting: &mut Vec<&'a str>,
    ) -> Option<Vec<String>> {
        if done.contains(id) {
            return None;
        }
        if let Some(pos) = visiting.iter().position(|v| *v == id) {
            let mut cycle: Vec<String> = visiting[pos..].iter().map(|s| s.to_string()).collect();
            cycle.push(id.to_string());
            return Some(cycle);
        }
        visiting.push(id);
        if let Some(service) = by_id.get(id) {
            for dep in service.depends_on.iter().flatten() {
                if !by_id.contains_key(dep.as_str()) {
                    continue; // reported separately as an unknown id
                }
                if let Some(found) = visit(dep, by_id, done, visiting) {
                    return Some(found);
                }
            }
        }
        visiting.pop();
        done.insert(id);
        None
    }

    for service in services {
        let mut visiting = Vec::new();
        if let Some(found) = visit(&service.id, &by_id, &mut done, &mut visiting) {
            return Some(found);
        }
    }
    None
}

/// Parses a JSON value into a validated profile. Fails closed on anything malformed rather
/// than repairing it. A missing `schemaVersion` reads as 0; one newer than this build understands is rejected.
pub fn parse_run_profile(value: &Value) -> Result<RunProfile, Vec<RunProfileIssue>> {
    let Some(raw) = value.as_object() else {
        return Err(vec![issue("", "A run profile must be a JSON object.")]);
    };

    let schema_version = raw
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if schema_version > u64::from(RUN_PROFILE_SCHEMA_VERSION) {
        return Err(vec![issue(
            "schemaVersion",
            format!("Unsupported run profile schema version {schema_version}."),
        )]);
    }

    let string_field = |key: &str| {
        raw.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    let mut parse_issues = Vec::new();
    let mut services = Vec::new();
    if let Some(items) = raw.get("services").and_then(Value::as_array) {
        for (index, item) in items.iter().enumerate() {
            match serde_json::from_value::<RunServiceDefinition>(item.clone()) {
                Ok(service) => services.push(service),
                Err(error) => parse_issues.push(issue(
                    format!("services[{index}]"),
                    format!("Invalid service definition: {error}"),
                )),
            }
        }
    }
    if !parse_issues.is_empty() {
        return Err(parse_issues);
    }

    let profile = RunProfile {
        schema_version: u32::try_from(schema_version).unwrap_or(0),
        id: string_field("id"),
        name: string_field("name"),
        services,
        created_at: string_field("createdAt"),
        updated_at: string_field("updatedAt"),
    };

    let errors = validate_run_profile(&profile);
    if errors.is_empty() {
        Ok(profile)
    } else {
        Err(errors)
    }
}

/// Serializes a profile as pretty JSON with a trailing newline.
#[must_use]
pub fn serialize_run_profile(profile: &RunProfile) -> String {
    let mut text = serde_json::to_string_pretty(profile).expect("RunProfile serializes to JSON");
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn service(id: &str) -> RunServiceDefinition {
        RunServiceDefinition {
            id: id.to_string(),
            name: id.to_string(),
            executable: "npm".to_string(),
            args: Some(vec!["run".into(), "dev".into()]),
            cwd: None,
            depends_on: None,
            readiness_probe: None,
            port: None,
            env: None,
        }
    }

    fn profile(services: Vec<RunServiceDefinition>) -> RunProfile {
        RunProfile {
            schema_version: 1,
            id: "p".into(),
            name: "Project".into(),
            services,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    fn paths(errors: &[RunProfileIssue]) -> Vec<&str> {
        errors.iter().map(|e| e.path.as_str()).collect()
    }

    #[test]
    fn a_frontend_and_api_profile_validates_clean() {
        let mut web = service("web");
        web.port = Some(5173);
        web.readiness_probe = Some(RunReadinessProbe::Http {
            path: "/".into(),
            expected_status: None,
        });
        let mut api = service("api");
        api.cwd = Some("server".into());
        api.port = Some(3000);
        api.depends_on = Some(vec!["web".into()]);
        assert!(validate_run_profile(&profile(vec![web, api])).is_empty());
    }

    #[test]
    fn a_profile_round_trips_through_serialize_and_parse_unchanged() {
        let mut web = service("web");
        web.readiness_probe = Some(RunReadinessProbe::LogLine {
            match_text: "ready in".into(),
        });
        let original = profile(vec![web]);
        let text = serialize_run_profile(&original);
        let parsed = parse_run_profile(&serde_json::from_str(&text).expect("test setup"))
            .expect("test setup");
        assert_eq!(parsed, original);
    }

    #[test]
    fn a_malformed_payload_fails_closed() {
        assert!(parse_run_profile(&json!("nope")).is_err());
        assert!(parse_run_profile(&json!([1, 2])).is_err());
    }

    #[test]
    fn a_schema_version_it_does_not_understand_is_rejected() {
        let err = parse_run_profile(&json!({
            "schemaVersion": 99, "id": "p", "name": "n", "services": []
        }))
        .expect_err("test expects an error");
        assert_eq!(paths(&err), vec!["schemaVersion"]);
    }

    #[test]
    fn absolute_cwd_is_rejected_including_windows_style() {
        for cwd in ["/abs/path", "C:\\work\\app"] {
            let mut web = service("web");
            web.cwd = Some(cwd.into());
            assert_eq!(
                paths(&validate_run_profile(&profile(vec![web]))),
                vec!["services[0].cwd"],
                "{cwd}"
            );
        }
    }

    #[test]
    fn relative_cwd_is_accepted() {
        let mut web = service("web");
        web.cwd = Some("apps/web".into());
        assert!(validate_run_profile(&profile(vec![web])).is_empty());
    }

    #[test]
    fn duplicate_service_ids_are_rejected() {
        let errors = validate_run_profile(&profile(vec![service("web"), service("web")]));
        assert_eq!(paths(&errors), vec!["services[1].id"]);
    }

    #[test]
    fn a_two_service_cycle_is_rejected_with_the_cycle_named() {
        let mut a = service("a");
        a.depends_on = Some(vec!["b".into()]);
        let mut b = service("b");
        b.depends_on = Some(vec!["a".into()]);
        let errors = validate_run_profile(&profile(vec![a, b]));
        assert!(
            errors
                .iter()
                .any(|e| e.message.contains("a → b → a") || e.message.contains("b → a → b"))
        );
    }

    #[test]
    fn a_longer_cycle_is_detected() {
        let mut a = service("a");
        a.depends_on = Some(vec!["b".into()]);
        let mut b = service("b");
        b.depends_on = Some(vec!["c".into()]);
        let mut c = service("c");
        c.depends_on = Some(vec!["a".into()]);
        let errors = validate_run_profile(&profile(vec![a, b, c]));
        assert!(errors.iter().any(|e| e.message.contains("cycle")));
    }

    #[test]
    fn an_unknown_depends_on_id_is_rejected() {
        let mut web = service("web");
        web.depends_on = Some(vec!["ghost".into()]);
        let errors = validate_run_profile(&profile(vec![web]));
        assert_eq!(paths(&errors), vec!["services[0].dependsOn"]);
    }

    #[test]
    fn a_diamond_dependency_is_a_valid_dag() {
        let mut top = service("top");
        top.depends_on = Some(vec!["left".into(), "right".into()]);
        let mut left = service("left");
        left.depends_on = Some(vec!["base".into()]);
        let mut right = service("right");
        right.depends_on = Some(vec!["base".into()]);
        let services = vec![top, left, right, service("base")];
        assert!(validate_run_profile(&profile(services)).is_empty());
    }

    #[test]
    fn ill_shaped_probes_are_rejected() {
        let cases = [
            (
                RunReadinessProbe::Http {
                    path: "  ".into(),
                    expected_status: None,
                },
                "readinessProbe.path",
            ),
            (
                RunReadinessProbe::Tcp { port: 70_000 },
                "readinessProbe.port",
            ),
            (
                RunReadinessProbe::LogLine {
                    match_text: String::new(),
                },
                "readinessProbe.match",
            ),
        ];
        for (probe, suffix) in cases {
            let mut web = service("web");
            web.readiness_probe = Some(probe);
            let errors = validate_run_profile(&profile(vec![web]));
            assert_eq!(paths(&errors), vec![format!("services[0].{suffix}")]);
        }
    }

    #[test]
    fn an_unknown_probe_kind_is_rejected_at_parse_time() {
        let result = parse_run_profile(&json!({
            "schemaVersion": 1, "id": "p", "name": "n",
            "services": [{ "id": "web", "executable": "x",
                "readinessProbe": { "kind": "telepathy" } }]
        }));
        assert!(result.is_err());
    }

    #[test]
    fn a_literal_value_under_a_secret_shaped_key_is_rejected() {
        let mut web = service("web");
        web.env = Some(BTreeMap::from([("API_TOKEN".into(), "abc123".into())]));
        let errors = validate_run_profile(&profile(vec![web]));
        assert_eq!(paths(&errors), vec!["services[0].env.API_TOKEN"]);
    }

    #[test]
    fn a_secret_reference_under_a_secret_shaped_key_is_accepted() {
        let mut web = service("web");
        web.env = Some(BTreeMap::from([(
            "API_TOKEN".into(),
            "${secret:api.token}".into(),
        )]));
        assert!(validate_run_profile(&profile(vec![web])).is_empty());
    }

    #[test]
    fn a_plain_env_variable_may_hold_a_literal() {
        let mut web = service("web");
        web.env = Some(BTreeMap::from([("NODE_ENV".into(), "development".into())]));
        assert!(validate_run_profile(&profile(vec![web])).is_empty());
    }

    #[test]
    fn every_secret_shaped_vocabulary_word_is_caught() {
        for key in [
            "GITHUB_TOKEN",
            "client_secret",
            "DB_PASSWORD",
            "api_key",
            "APIKEY",
            "api-key",
            "MY_PAT",
            "pat",
        ] {
            assert!(is_secret_shaped_key(key), "{key} should be secret-shaped");
        }
        for key in ["PATH", "pathway", "NODE_ENV", "PORT"] {
            assert!(!is_secret_shaped_key(key), "{key} should not be");
        }
    }

    #[test]
    fn a_profile_with_no_services_is_rejected() {
        let errors = validate_run_profile(&profile(vec![]));
        assert_eq!(paths(&errors), vec!["services"]);
    }

    #[test]
    fn a_profile_missing_id_or_name_is_rejected() {
        let mut p = profile(vec![service("web")]);
        p.id = "  ".into();
        p.name = String::new();
        assert_eq!(paths(&validate_run_profile(&p)), vec!["id", "name"]);
    }
}
