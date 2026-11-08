//! Built-in security/QA/licence check presets and stack-based recommendation
//! (`checkPresets.ts` port).

use serde::{Deserialize, Serialize};

use crate::types::{
    CheckResultAdapterKind, WorkflowArtifactContract, WorkflowArtifactKind, WorkflowCheckNode,
    WorkflowGateKind, WorkflowNodeBase,
};

/// What a preset checks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckPresetCategory {
    Security,
    Qa,
    License,
}

/// A ready-made check command with its report adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckPreset {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub category: CheckPresetCategory,
    pub command: &'static str,
    pub args: &'static [&'static str],
    pub adapter: CheckResultAdapterKind,
    pub report_path: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub satisfies_gate: Option<WorkflowGateKind>,
    pub applicable_stacks: &'static [&'static str],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ruleset_path: Option<&'static str>,
}

pub const SECRET_SCAN_PRESET: CheckPreset = CheckPreset {
    id: "secret-scan",
    name: "Secret Scanning (Gitleaks)",
    description: "Detect hardcoded secrets, keys, and credentials using Gitleaks",
    category: CheckPresetCategory::Security,
    command: "gitleaks",
    args: &[
        "detect",
        "--no-git",
        "--report-format",
        "sarif",
        "--report-path",
        "gitleaks.sarif",
    ],
    adapter: CheckResultAdapterKind::Sarif,
    report_path: "gitleaks.sarif",
    satisfies_gate: Some(WorkflowGateKind::Security),
    applicable_stacks: &["*"],
    ruleset_path: None,
};

pub const SAST_SEMGREP_PRESET: CheckPreset = CheckPreset {
    id: "sast-semgrep",
    name: "SAST (Semgrep)",
    description: "Static application security testing with curated ruleset",
    category: CheckPresetCategory::Security,
    command: "semgrep",
    args: &[
        "scan",
        "--config",
        "rulesets/semgrep-curated.yaml",
        "--baseline-commit={baseCommit}",
        "--sarif",
        "--output",
        "semgrep.sarif",
    ],
    adapter: CheckResultAdapterKind::Sarif,
    report_path: "semgrep.sarif",
    satisfies_gate: Some(WorkflowGateKind::Security),
    applicable_stacks: &[
        "javascript",
        "typescript",
        "python",
        "go",
        "java",
        "csharp",
        "ruby",
        "rust",
    ],
    ruleset_path: Some("rulesets/semgrep-curated.yaml"),
};

pub const SCA_OSV_PRESET: CheckPreset = CheckPreset {
    id: "sca-osv",
    name: "SCA (OSV-Scanner)",
    description: "Software composition analysis for vulnerable open-source dependencies",
    category: CheckPresetCategory::Security,
    command: "osv-scanner",
    // --no-ignore: a run worktree under a git-ignored `.worktrees/` would otherwise be skipped whole.
    args: &[
        "scan",
        "source",
        "--no-ignore",
        "--format",
        "sarif",
        "--output-file",
        "osv-report.sarif",
        ".",
    ],
    adapter: CheckResultAdapterKind::Sarif,
    report_path: "osv-report.sarif",
    satisfies_gate: Some(WorkflowGateKind::Security),
    applicable_stacks: &["javascript", "typescript", "python", "go", "rust", "java"],
    ruleset_path: None,
};

pub const SCA_TRIVY_PRESET: CheckPreset = CheckPreset {
    id: "sca-trivy",
    name: "SCA (Trivy Filesystem)",
    description: "Filesystem and package vulnerability scanner for container and .NET stacks",
    category: CheckPresetCategory::Security,
    command: "trivy",
    args: &[
        "fs",
        "--format",
        "sarif",
        "--output",
        "trivy-report.sarif",
        ".",
    ],
    adapter: CheckResultAdapterKind::Sarif,
    report_path: "trivy-report.sarif",
    satisfies_gate: Some(WorkflowGateKind::Security),
    applicable_stacks: &["dotnet", "csharp", "container"],
    ruleset_path: None,
};

pub const LICENSE_CHECK_PRESET: CheckPreset = CheckPreset {
    id: "license-check",
    name: "License Policy Check",
    description: "Audit open-source dependencies against approved software licenses",
    category: CheckPresetCategory::License,
    command: "license-checker",
    args: &["--sarif", "--output", "license-report.sarif"],
    adapter: CheckResultAdapterKind::Sarif,
    report_path: "license-report.sarif",
    satisfies_gate: Some(WorkflowGateKind::Security),
    applicable_stacks: &["javascript", "typescript"],
    ruleset_path: None,
};

/// Every built-in preset.
pub const CHECK_PRESETS: &[CheckPreset] = &[
    SECRET_SCAN_PRESET,
    SAST_SEMGREP_PRESET,
    SCA_OSV_PRESET,
    SCA_TRIVY_PRESET,
    LICENSE_CHECK_PRESET,
];

/// What folder inspection found about a project's stack.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StackInspectionInput {
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub manifests: Vec<String>,
    #[serde(default)]
    pub frameworks: Vec<String>,
}

/// Picks recommended presets from folder inspection: always secrets; Semgrep when there is
/// code; Trivy for .NET, otherwise OSV-Scanner.
#[must_use]
pub fn detect_recommended_check_presets(
    inspection: Option<&StackInspectionInput>,
) -> Vec<CheckPreset> {
    let mut presets = vec![SECRET_SCAN_PRESET];
    let Some(inspection) = inspection else {
        return presets;
    };
    let lower = |values: &[String]| values.iter().map(|v| v.to_lowercase()).collect::<Vec<_>>();
    let langs = lower(&inspection.languages);
    let manifests = lower(&inspection.manifests);
    let frameworks = lower(&inspection.frameworks);
    let has = |values: &[String], needle: &str| values.iter().any(|v| v == needle);

    let has_code = !langs.is_empty() || !manifests.is_empty();
    if has_code {
        presets.push(SAST_SEMGREP_PRESET);
    }
    let is_dot_net = has(&langs, "c#")
        || has(&langs, "csharp")
        || has(&frameworks, ".net")
        || has(&frameworks, "dotnet")
        || manifests
            .iter()
            .any(|m| m.ends_with(".csproj") || m.ends_with(".sln"));
    if is_dot_net {
        presets.push(SCA_TRIVY_PRESET);
    } else if has_code {
        presets.push(SCA_OSV_PRESET);
    }
    presets
}

/// Overrides for [`create_check_node_from_preset`].
#[derive(Debug, Clone, Default)]
pub struct CheckNodeOptions {
    pub id: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub inputs: Option<Vec<String>>,
    pub satisfies_gate: Option<WorkflowGateKind>,
}

/// Builds a check node from a preset with a single required `findings` output.
#[must_use]
pub fn create_check_node_from_preset(
    preset: &CheckPreset,
    options: CheckNodeOptions,
) -> WorkflowCheckNode {
    let node_id = options.id.unwrap_or_else(|| preset.id.to_string());
    WorkflowCheckNode {
        base: WorkflowNodeBase {
            id: node_id.clone(),
            name: preset.name.to_string(),
            x: options.x.unwrap_or(0.0),
            y: options.y.unwrap_or(0.0),
            inputs: options.inputs.unwrap_or_default(),
            enabled: None,
        },
        command: preset.command.to_string(),
        args: Some(preset.args.iter().map(|arg| (*arg).to_string()).collect()),
        success_exit_codes: None,
        outputs: vec![WorkflowArtifactContract {
            id: format!("{node_id}-findings"),
            kind: WorkflowArtifactKind::Findings,
            required: true,
            description: Some(format!("Normalized findings from {}", preset.name)),
            adapter: Some(preset.adapter),
            publish_to: None,
        }],
        mutates_worktree: None,
        satisfies_gate: options.satisfies_gate.or(preset.satisfies_gate),
        timeout_ms: None,
        max_attempts: None,
        adapter: Some(preset.adapter),
        report_path: Some(preset.report_path.to_string()),
        observe: None,
        failure_recovery: None,
        affected_tests: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inspection(
        languages: &[&str],
        manifests: &[&str],
        frameworks: &[&str],
    ) -> StackInspectionInput {
        let own = |values: &[&str]| values.iter().map(|v| (*v).to_string()).collect();
        StackInspectionInput {
            languages: own(languages),
            manifests: own(manifests),
            frameworks: own(frameworks),
        }
    }

    fn ids(presets: &[CheckPreset]) -> Vec<&'static str> {
        presets.iter().map(|p| p.id).collect()
    }

    #[test]
    fn node_typescript_projects_get_the_default_set() {
        let picked = detect_recommended_check_presets(Some(&inspection(
            &["TypeScript", "JavaScript"],
            &["package.json", "package-lock.json"],
            &["React"],
        )));
        assert_eq!(ids(&picked), vec!["secret-scan", "sast-semgrep", "sca-osv"]);
    }

    #[test]
    fn dotnet_projects_get_trivy() {
        let picked = detect_recommended_check_presets(Some(&inspection(
            &["C#"],
            &["App.csproj"],
            &[".NET"],
        )));
        assert_eq!(
            ids(&picked),
            vec!["secret-scan", "sast-semgrep", "sca-trivy"]
        );
    }

    #[test]
    fn secrets_are_always_included_even_for_empty_projects() {
        assert_eq!(
            ids(&detect_recommended_check_presets(Some(
                &StackInspectionInput::default()
            ))),
            vec!["secret-scan"]
        );
        assert_eq!(
            ids(&detect_recommended_check_presets(None)),
            vec!["secret-scan"]
        );
        assert_eq!(CHECK_PRESETS.len(), 5);
    }

    #[test]
    fn creates_a_check_node_with_a_findings_output() {
        let node = create_check_node_from_preset(&SECRET_SCAN_PRESET, CheckNodeOptions::default());
        assert_eq!(node.base.id, "secret-scan");
        assert_eq!(node.command, "gitleaks");
        assert_eq!(node.adapter, Some(CheckResultAdapterKind::Sarif));
        assert_eq!(node.satisfies_gate, Some(WorkflowGateKind::Security));
        assert_eq!(node.outputs.len(), 1);
        assert_eq!(node.outputs[0].kind, WorkflowArtifactKind::Findings);
        assert_eq!(node.outputs[0].adapter, Some(CheckResultAdapterKind::Sarif));
        let json =
            serde_json::to_value(crate::types::WorkflowNode::Check(node)).expect("serialize");
        assert_eq!(json["type"], "check");
        assert_eq!(json["outputs"][0]["id"], "secret-scan-findings");
    }
}
