//! `project.praxis.md` generation with marker protection (`FX-BE-047`, `projectManager.ts`).
//!
//! **Rule: Praxis rewrites only a file it wrote.**
//! - No file: write the generated block wrapped in `SNAPSHOT_BEGIN` / `SNAPSHOT_END` markers.
//! - Markers present: replace only what is between them; anything outside is preserved.
//! - Markers absent: leave the file completely alone (`Retained`).

use std::path::Path;

use praxis_contracts::ProjectWorkflowStage;

use crate::projects::project_types::{PROJECT_FILE_NAME, ProjectFileStatus, ProjectRecord};
use crate::projects::project_workflow::normalize_workflow_stages;

/// Opening marker for Praxis-generated `project.praxis.md` sections.
pub const SNAPSHOT_BEGIN: &str = "<!-- praxis:begin — generated from the project. Edit in Praxis; text outside this block is yours. -->";
/// Closing marker for Praxis-generated `project.praxis.md` sections.
pub const SNAPSHOT_END: &str = "<!-- praxis:end -->";

/// Returns the effective workflow stages for a project record.
#[must_use]
pub fn effective_workflow(project: &ProjectRecord) -> Vec<ProjectWorkflowStage> {
    normalize_workflow_stages(Some(&project.workflow_stages))
}

fn format_brief_heading(key: &str) -> String {
    let mut spaced = String::with_capacity(key.len() + 4);
    for (idx, ch) in key.chars().enumerate() {
        if idx > 0 && ch.is_ascii_uppercase() {
            spaced.push(' ');
        }
        spaced.push(ch);
    }
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => {
            let mut out = first.to_uppercase().collect::<String>();
            out.push_str(chars.as_str());
            out
        }
        None => String::new(),
    }
}

/// Renders the inner markdown body for `project.praxis.md` (without outer markers).
#[must_use]
pub fn render_project_snapshot(project: &ProjectRecord) -> String {
    let fields = project
        .brief
        .iter()
        .map(|(key, value)| {
            let heading = format_brief_heading(key);
            let body = if value.is_empty() {
                "_Not specified_"
            } else {
                value.as_str()
            };
            format!("## {heading}\n\n{body}\n")
        })
        .collect::<Vec<_>>()
        .join("\n");

    let purpose = if project.purpose.is_empty() {
        "_Not specified_"
    } else {
        project.purpose.as_str()
    };

    let workflow_lines = effective_workflow(project)
        .into_iter()
        .map(|stage| format!("- {}", stage.name))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "# {}\n\n- Key: {}\n- Type: {}\n- Created: {}\n\n## Purpose\n\n{}\n\n{}\n## Workflow\n\n{}\n",
        project.name,
        project.key,
        project.project_type.as_str(),
        project.created_at,
        purpose,
        fields,
        workflow_lines
    )
}

/// Writes or updates `<folder>/project.praxis.md`, strictly leaving marker-less files untouched.
pub fn write_project_snapshot(
    folder: &Path,
    project: &ProjectRecord,
) -> std::io::Result<ProjectFileStatus> {
    let target = folder.join(PROJECT_FILE_NAME);
    let generated = render_project_snapshot(project);

    let existing = match std::fs::read_to_string(&target) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            std::fs::write(
                &target,
                format!("{SNAPSHOT_BEGIN}\n{generated}{SNAPSHOT_END}\n"),
            )?;
            return Ok(ProjectFileStatus::Created);
        }
        Err(err) => return Err(err),
    };

    let Some(begin) = existing.find(SNAPSHOT_BEGIN) else {
        return Ok(ProjectFileStatus::Retained);
    };
    let Some(end) = existing.find(SNAPSHOT_END) else {
        return Ok(ProjectFileStatus::Retained);
    };
    if end <= begin {
        return Ok(ProjectFileStatus::Retained);
    }

    let next = format!(
        "{}{SNAPSHOT_BEGIN}\n{generated}{}",
        &existing[..begin],
        &existing[end..]
    );
    if next != existing {
        std::fs::write(&target, next)?;
    }
    Ok(ProjectFileStatus::Retained)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::project_types::ProjectType;
    use praxis_contracts::WorkflowStageCategory;
    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sample_project(folder: Option<String>, purpose: &str) -> ProjectRecord {
        ProjectRecord {
            id: "p1".to_string(),
            name: "Praxis".to_string(),
            key: "PRAXIS".to_string(),
            project_type: ProjectType::Software,
            purpose: purpose.to_string(),
            brief: BTreeMap::new(),
            storage: Some(crate::projects::project_types::ProjectStorage::Folder),
            planning_mode: None,
            workspace_folder: folder,
            workflow_stages: vec![
                ProjectWorkflowStage {
                    id: "1".to_string(),
                    name: "Backlog".to_string(),
                    category: Some(WorkflowStageCategory::Todo),
                },
                ProjectWorkflowStage {
                    id: "2".to_string(),
                    name: "In Progress".to_string(),
                    category: Some(WorkflowStageCategory::Indeterminate),
                },
                ProjectWorkflowStage {
                    id: "3".to_string(),
                    name: "Done".to_string(),
                    category: Some(WorkflowStageCategory::Done),
                },
            ],
            default_board_id: "p1-board".to_string(),
            work_items: vec![],
            linked_boards: vec![],
            default_ai_tool_mode: "full".to_string(),
            folder_inspection: None,
            project_file_status: None,
            recommended_workflow_template: None,
            icon: None,
            color: None,
            artifacts_folder: None,
            created_at: "2026-08-31T22:27:04.012Z".to_string(),
            updated_at: "2026-08-31T22:27:04.012Z".to_string(),
        }
    }

    fn temp_dir(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("{prefix}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("mkdir temp");
        dir
    }

    #[test]
    fn new_project_file_is_generated_inside_markers() {
        let dir = temp_dir("praxis-snapshot-new");
        let proj = sample_project(
            Some(dir.to_string_lossy().to_string()),
            "Ship a planning tool.",
        );
        let status = write_project_snapshot(&dir, &proj).expect("write snapshot");
        assert_eq!(status, ProjectFileStatus::Created);
        let body = std::fs::read_to_string(dir.join(PROJECT_FILE_NAME)).expect("read");
        assert!(body.contains("praxis:begin"));
        assert!(body.contains("praxis:end"));
        assert!(body.contains("## Workflow\n\n- Backlog\n- In Progress\n- Done"));
        assert!(body.contains("Ship a planning tool."));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn regenerating_replaces_only_marked_block_and_preserves_outside_prose() {
        let dir = temp_dir("praxis-snapshot-regen");
        let mut proj = sample_project(
            Some(dir.to_string_lossy().to_string()),
            "Ship a planning tool.",
        );
        write_project_snapshot(&dir, &proj).expect("initial write");
        let file_path = dir.join(PROJECT_FILE_NAME);
        let mut initial = std::fs::read_to_string(&file_path).expect("read");
        initial.push_str("\n## Team notes\n\nKeep this.\n");
        std::fs::write(&file_path, initial).expect("append notes");

        proj.purpose = "Changed.".to_string();
        proj.workflow_stages = vec![
            ProjectWorkflowStage {
                id: "1".to_string(),
                name: "Icebox".to_string(),
                category: Some(WorkflowStageCategory::Todo),
            },
            ProjectWorkflowStage {
                id: "2".to_string(),
                name: "Shipped".to_string(),
                category: Some(WorkflowStageCategory::Done),
            },
        ];
        let status = write_project_snapshot(&dir, &proj).expect("second write");
        assert_eq!(status, ProjectFileStatus::Retained);

        let body = std::fs::read_to_string(&file_path).expect("read updated");
        assert!(body.contains("Keep this."));
        assert!(body.contains("- Icebox\n- Shipped"));
        assert!(!body.contains("- In Progress"));
        assert!(body.contains("Changed."));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn markerless_file_is_never_modified() {
        let dir = temp_dir("praxis-snapshot-markerless");
        let hand_written = [
            "# praxis",
            "",
            "- Key: PRAXIS",
            "",
            "## Purpose",
            "",
            "A desktop workspace that keeps planning, tickets and agents in one place.",
            "",
            "## Workflow",
            "",
            "- Backlog",
            "- To Do",
            "- In Progress",
            "- Blocked",
            "- Done",
            "",
        ]
        .join("\n");
        let file_path = dir.join(PROJECT_FILE_NAME);
        std::fs::write(&file_path, &hand_written).expect("write hand_written");

        let proj = sample_project(
            Some(dir.to_string_lossy().to_string()),
            "Someone else's purpose.",
        );
        let status = write_project_snapshot(&dir, &proj).expect("write snapshot");
        assert_eq!(status, ProjectFileStatus::Retained);
        assert_eq!(
            std::fs::read_to_string(&file_path).expect("read"),
            hand_written
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
