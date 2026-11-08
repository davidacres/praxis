//! `board.praxis.json` reader and writer (`packages/core/src/folder/boardConfigFile.ts`).

use std::path::Path;

use praxis_contracts::{ProjectWorkflowStage, WorkflowStageCategory};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::folder::folder_fs::{folder_read_file, folder_write_file};
use crate::projects::project_workflow::{normalize_workflow_stages, validate_workflow_stages};

/// Filename for a plans root's board configuration file.
pub const BOARD_CONFIG_FILENAME: &str = "board.praxis.json";

/// Optional per-plans-root board settings stored in `board.praxis.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardConfigFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_issue_creation: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<Vec<ProjectWorkflowStage>>,
}

fn read_non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn read_workflow(value: Option<&Value>) -> Option<Vec<ProjectWorkflowStage>> {
    let arr = value?.as_array()?;
    if arr.is_empty() {
        return None;
    }
    let mut stages = Vec::with_capacity(arr.len());
    for (index, entry) in arr.iter().enumerate() {
        let obj = entry.as_object()?;
        let name = read_non_empty_string(obj.get("name"))?;
        let id =
            read_non_empty_string(obj.get("id")).unwrap_or_else(|| format!("stage-{}", index + 1));
        let category = match obj.get("category").and_then(Value::as_str) {
            Some("todo") => Some(WorkflowStageCategory::Todo),
            Some("indeterminate") => Some(WorkflowStageCategory::Indeterminate),
            Some("done") => Some(WorkflowStageCategory::Done),
            _ => None,
        };
        stages.push(ProjectWorkflowStage { id, name, category });
    }
    let normalized = normalize_workflow_stages(Some(&stages));
    if validate_workflow_stages(&normalized).is_some() {
        None
    } else {
        Some(normalized)
    }
}

/// Reads `<plans_root_path>/board.praxis.json`. Returns `BoardConfigFile::default()` when absent or invalid.
#[must_use]
pub fn read_board_config_file(plans_root_path: &Path) -> BoardConfigFile {
    let Ok(raw) = folder_read_file(&plans_root_path.join(BOARD_CONFIG_FILENAME)) else {
        return BoardConfigFile::default();
    };
    let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&raw) else {
        return BoardConfigFile::default();
    };

    let mut config = BoardConfigFile::default();
    if let Some(pk) = read_non_empty_string(record.get("projectKey")) {
        config.project_key = Some(pk);
    }
    if let Some(pn) = read_non_empty_string(record.get("projectName")) {
        config.project_name = Some(pn);
    }
    if let Some(allow) = record.get("allowIssueCreation").and_then(Value::as_bool) {
        config.allow_issue_creation = Some(allow);
    }
    if let Some(workflow) = read_workflow(record.get("workflow")) {
        config.workflow = Some(workflow);
    }
    config
}

/// Writes `<plans_root_path>/board.praxis.json`, omitting empty fields.
pub fn write_board_config_file(
    plans_root_path: &Path,
    config: &BoardConfigFile,
) -> std::io::Result<()> {
    let mut body = BoardConfigFile::default();
    if let Some(pk) = config
        .project_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        body.project_key = Some(pk.to_string());
    }
    if let Some(pn) = config
        .project_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        body.project_name = Some(pn.to_string());
    }
    if let Some(allow) = config.allow_issue_creation {
        body.allow_issue_creation = Some(allow);
    }
    if let Some(ref wf) = config.workflow
        && !wf.is_empty()
    {
        body.workflow = Some(normalize_workflow_stages(Some(wf)));
    }
    let json = serde_json::to_string_pretty(&body).map_err(std::io::Error::other)?;
    folder_write_file(
        &plans_root_path.join(BOARD_CONFIG_FILENAME),
        &format!("{json}\n"),
    )
}
