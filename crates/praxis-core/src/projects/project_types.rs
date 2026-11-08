//! Project types and constants (`packages/core/src/projects/projectTypes.ts`).

use std::collections::BTreeMap;

use praxis_contracts::{IssueOrigin, ProjectWorkflowStage, WorkflowStageCategory};
use serde::{Deserialize, Serialize};

/// The Praxis project descriptor written into a project's own folder (`FX-BE-048`).
pub const PROJECT_FILE_NAME: &str = "project.praxis.md";

/// Project category type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectType {
    Software,
    Product,
    Research,
    Experiment,
}

impl ProjectType {
    /// Returns the canonical lowercase string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Software => "software",
            Self::Product => "product",
            Self::Research => "research",
            Self::Experiment => "experiment",
        }
    }
}

/// Starting point selected in the project creation wizard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectStartingPoint {
    NewFolder,
    ExistingFolder,
    AppStorage,
}

/// Where a project's work items live (`app` vs `folder`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectStorage {
    App,
    Folder,
}

/// Whether the project owns a Praxis board or is just a file-backed workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectPlanningMode {
    Board,
    Files,
}

/// Status of `project.praxis.md` after creation or folder attachment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectFileStatus {
    Created,
    Retained,
    NotRequested,
}

/// One work item stored inside an app-storage project record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkItem {
    pub id: String,
    pub key: String,
    pub summary: String,
    pub description: String,
    pub issue_type: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<IssueOrigin>,
}

/// Reference to an external board linked to a project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBoardReference {
    pub connection_id: String,
    pub board_id: String,
    pub display_name: String,
}

/// Local filesystem inspection cache (dropped when writing portable workspace files).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInspection {
    pub path: String,
    pub exists: bool,
    pub is_directory: bool,
    pub has_git: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readme: Option<String>,
    pub project_file_exists: bool,
    pub manifests: Vec<String>,
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_files: Option<Vec<String>>,
}

/// Cached AI workflow template recommendation on a project record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTemplateRecommendation {
    pub template_id: String,
    pub rationale: String,
    pub model: String,
    pub computed_at: String,
}

/// Allowed project icon names (`PROJECT_ICON_NAMES`).
pub const PROJECT_ICON_NAMES: &[&str] = &[
    "rocket",
    "target",
    "milestone",
    "star",
    "folder",
    "book",
    "lightbulb",
    "zap",
    "shield",
    "globe",
    "tools",
    "terminal",
    "server",
    "organization",
    "graph",
    "columns",
    "bug",
    "ticket",
    "sparkles",
    "robot",
];

/// Allowed project accent color names (`PROJECT_COLOR_NAMES`).
pub const PROJECT_COLOR_NAMES: &[&str] = &[
    "blue", "orange", "aqua", "yellow", "magenta", "green", "violet", "red",
];

/// Persisted project record (`ProjectRecord` in `projectTypes.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub key: String,
    #[serde(rename = "type")]
    pub project_type: ProjectType,
    pub purpose: String,
    #[serde(default)]
    pub brief: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage: Option<ProjectStorage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_mode: Option<ProjectPlanningMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_folder: Option<String>,
    pub workflow_stages: Vec<ProjectWorkflowStage>,
    #[serde(default)]
    pub default_board_id: String,
    #[serde(default)]
    pub work_items: Vec<ProjectWorkItem>,
    #[serde(default)]
    pub linked_boards: Vec<ProjectBoardReference>,
    pub default_ai_tool_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_inspection: Option<FolderInspection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_file_status: Option<ProjectFileStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_workflow_template: Option<StoredTemplateRecommendation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts_folder: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Re-export [`WorkflowStageCategory`] as `ProjectWorkflowCategory` for parity with TypeScript.
pub type ProjectWorkflowCategory = WorkflowStageCategory;
