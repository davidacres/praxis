//! A project's workflow, as data (`FX-BF-019`, `packages/core/src/projects/projectWorkflow.ts`).
//!
//! Resolves freeform status strings onto declared workflow stages through four tiers:
//! 1. Exact stage name (case- and punctuation-insensitive)
//! 2. Synonym's preferred stage name
//! 3. First stage of the synonym's category
//! 4. First stage fallback (never drops a status)

use std::collections::HashSet;

use praxis_contracts::{ProjectWorkflowStage, WorkflowStageCategory};

/// Ordered workflow categories (`todo` -> `indeterminate` -> `done`).
pub const WORKFLOW_CATEGORIES: &[WorkflowStageCategory] = &[
    WorkflowStageCategory::Todo,
    WorkflowStageCategory::Indeterminate,
    WorkflowStageCategory::Done,
];

/// Returns the five default workflow stages every folder board used before custom workflows existed.
///
/// Same names, same order, and same categories as `DEFAULT_WORKFLOW` in TypeScript.
#[must_use]
pub fn default_workflow() -> Vec<ProjectWorkflowStage> {
    vec![
        ProjectWorkflowStage {
            id: "stage-backlog".to_string(),
            name: "Backlog".to_string(),
            category: Some(WorkflowStageCategory::Todo),
        },
        ProjectWorkflowStage {
            id: "stage-to-do".to_string(),
            name: "To Do".to_string(),
            category: Some(WorkflowStageCategory::Todo),
        },
        ProjectWorkflowStage {
            id: "stage-in-progress".to_string(),
            name: "In Progress".to_string(),
            category: Some(WorkflowStageCategory::Indeterminate),
        },
        ProjectWorkflowStage {
            id: "stage-blocked".to_string(),
            name: "Blocked".to_string(),
            category: Some(WorkflowStageCategory::Indeterminate),
        },
        ProjectWorkflowStage {
            id: "stage-done".to_string(),
            name: "Done".to_string(),
            category: Some(WorkflowStageCategory::Done),
        },
    ]
}

struct SynonymEntry {
    match_tokens: &'static [&'static str],
    prefer: &'static str,
    category: WorkflowStageCategory,
}

const SYNONYMS: &[SynonymEntry] = &[
    SynonymEntry {
        match_tokens: &[
            "complete", "done", "✅", "shipped", "closed", "resolved", "obsolete",
        ],
        prefer: "Done",
        category: WorkflowStageCategory::Done,
    },
    SynonymEntry {
        match_tokens: &["block"],
        prefer: "Blocked",
        category: WorkflowStageCategory::Indeterminate,
    },
    SynonymEntry {
        match_tokens: &["progress", "doing", "wip", "🔄", "active"],
        prefer: "In Progress",
        category: WorkflowStageCategory::Indeterminate,
    },
    SynonymEntry {
        match_tokens: &["review"],
        prefer: "Review",
        category: WorkflowStageCategory::Indeterminate,
    },
    SynonymEntry {
        match_tokens: &["to do", "todo", "pending", "planned", "next"],
        prefer: "To Do",
        category: WorkflowStageCategory::Todo,
    },
    SynonymEntry {
        match_tokens: &["backlog", "proposed", "📋", "new", "open", "idea"],
        prefer: "Backlog",
        category: WorkflowStageCategory::Todo,
    },
];

/// Lowercased, punctuation- and emoji-tolerant form used for name comparison.
#[must_use]
pub fn comparable_status_token(value: &str) -> String {
    let lower = value.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut last_was_space = true;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_was_space = false;
        } else if !last_was_space {
            out.push(' ');
            last_was_space = true;
        }
    }
    out.trim().to_string()
}

fn matches_synonym(entry: &SynonymEntry, raw: &str, needle: &str) -> bool {
    entry.match_tokens.iter().any(|token| {
        let normalized = comparable_status_token(token);
        if !normalized.is_empty() {
            needle.contains(&normalized)
        } else {
            raw.contains(token)
        }
    })
}

fn stages_of(workflow: Option<&[ProjectWorkflowStage]>) -> Vec<ProjectWorkflowStage> {
    match workflow {
        Some(stages) if !stages.is_empty() => stages.to_vec(),
        _ => default_workflow(),
    }
}

/// The category a stage declares, defaulting by position when it declares none.
#[must_use]
pub fn category_of_stage(
    stage: &ProjectWorkflowStage,
    index: usize,
    total: usize,
) -> WorkflowStageCategory {
    stage
        .category
        .unwrap_or_else(|| infer_category(&stage.name, index, total))
}

/// Best category for a stage that does not declare one: its name if recognizable,
/// otherwise its position (first is `todo`, last is `done`, middle is `indeterminate`).
#[must_use]
pub fn infer_category(name: &str, index: usize, total: usize) -> WorkflowStageCategory {
    let needle = comparable_status_token(name);
    for entry in SYNONYMS {
        if matches_synonym(entry, name, &needle) {
            return entry.category;
        }
    }
    if index == 0 {
        return WorkflowStageCategory::Todo;
    }
    if total > 0 && index == total - 1 {
        return WorkflowStageCategory::Done;
    }
    WorkflowStageCategory::Indeterminate
}

/// Fills in any missing category so downstream code can rely on one (`{ id, name, category }`).
#[must_use]
pub fn normalize_workflow_stages(
    stages: Option<&[ProjectWorkflowStage]>,
) -> Vec<ProjectWorkflowStage> {
    let source = stages_of(stages);
    let total = source.len();
    source
        .into_iter()
        .enumerate()
        .map(|(index, stage)| {
            let category = category_of_stage(&stage, index, total);
            ProjectWorkflowStage {
                id: stage.id,
                name: stage.name,
                category: Some(category),
            }
        })
        .collect()
}

/// Stage names in board order.
#[must_use]
pub fn workflow_status_names(workflow: Option<&[ProjectWorkflowStage]>) -> Vec<String> {
    stages_of(workflow).into_iter().map(|s| s.name).collect()
}

/// The first stage of a category, or `None` when the workflow has none.
#[must_use]
pub fn first_stage_of_category(
    workflow: Option<&[ProjectWorkflowStage]>,
    category: WorkflowStageCategory,
) -> Option<ProjectWorkflowStage> {
    normalize_workflow_stages(workflow)
        .into_iter()
        .find(|stage| stage.category == Some(category))
}

/// Resolves a freeform status string onto one of the workflow's stages in four tiers:
/// 1. Exact stage name (case- and punctuation-insensitive)
/// 2. Synonym's preferred stage name
/// 3. First stage of the synonym's category
/// 4. First stage fallback
#[must_use]
pub fn resolve_status(raw: &str, workflow: Option<&[ProjectWorkflowStage]>) -> String {
    let stages = normalize_workflow_stages(workflow);
    let fallback = stages
        .first()
        .map(|s| s.name.clone())
        .unwrap_or_else(|| "Backlog".to_string());
    let needle = comparable_status_token(raw);
    if needle.is_empty() && raw.trim().is_empty() {
        return fallback;
    }

    // 1 — exact stage name.
    if let Some(exact) = stages
        .iter()
        .find(|stage| comparable_status_token(&stage.name) == needle)
    {
        return exact.name.clone();
    }

    // 2/3 — synonym, preferring its canonical name then its category.
    for entry in SYNONYMS {
        if !matches_synonym(entry, raw, &needle) {
            continue;
        }
        let prefer_needle = comparable_status_token(entry.prefer);
        if let Some(preferred) = stages
            .iter()
            .find(|stage| comparable_status_token(&stage.name) == prefer_needle)
        {
            return preferred.name.clone();
        }
        if let Some(by_category) = stages
            .iter()
            .find(|stage| stage.category == Some(entry.category))
        {
            return by_category.name.clone();
        }
    }

    // 4 — never drop a status.
    fallback
}

/// The category of a status a tracker reports, or `None` when it cannot be told.
#[must_use]
pub fn category_of_status(
    raw: Option<&str>,
    workflow: Option<&[ProjectWorkflowStage]>,
) -> Option<WorkflowStageCategory> {
    let raw_str = raw.unwrap_or("");
    let needle = comparable_status_token(raw_str);
    if needle.is_empty() && raw_str.trim().is_empty() {
        return None;
    }
    if let Some(exact) = normalize_workflow_stages(workflow)
        .into_iter()
        .find(|stage| comparable_status_token(&stage.name) == needle)
    {
        return exact.category;
    }
    SYNONYMS
        .iter()
        .find(|entry| matches_synonym(entry, raw_str, &needle))
        .map(|entry| entry.category)
}

/// Rank used to order columns for a workflow, mirroring `jiraShape.statusCategoryRank`.
#[must_use]
pub fn workflow_category_rank(category: Option<&str>) -> u32 {
    match category {
        Some("todo") => 0,
        Some("indeterminate") => 1,
        Some("done") => 2,
        _ => 3,
    }
}

/// Validation shared by the store and the workflow editor.
#[must_use]
pub fn validate_workflow_stages(stages: &[ProjectWorkflowStage]) -> Option<String> {
    if stages.len() < 2 || stages.iter().any(|stage| stage.name.trim().is_empty()) {
        return Some("At least two named workflow stages are required.".to_string());
    }
    let mut names = HashSet::with_capacity(stages.len());
    for stage in stages {
        if !names.insert(stage.name.trim().to_lowercase()) {
            return Some("Workflow stage names must be unique.".to_string());
        }
    }
    let normalized = normalize_workflow_stages(Some(stages));
    if !normalized
        .iter()
        .any(|stage| stage.category == Some(WorkflowStageCategory::Todo))
    {
        return Some("A workflow needs at least one stage where work starts.".to_string());
    }
    let done_count = normalized
        .iter()
        .filter(|stage| stage.category == Some(WorkflowStageCategory::Done))
        .count();
    if done_count != 1 {
        return Some("A workflow needs exactly one stage that means done.".to_string());
    }
    if normalized.last().and_then(|s| s.category) != Some(WorkflowStageCategory::Done) {
        return Some("The stage that means done must be last.".to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn software_workflow() -> Vec<ProjectWorkflowStage> {
        vec![
            ProjectWorkflowStage {
                id: "1".to_string(),
                name: "Backlog".to_string(),
                category: Some(WorkflowStageCategory::Todo),
            },
            ProjectWorkflowStage {
                id: "2".to_string(),
                name: "Requirements".to_string(),
                category: Some(WorkflowStageCategory::Todo),
            },
            ProjectWorkflowStage {
                id: "3".to_string(),
                name: "Architecture".to_string(),
                category: Some(WorkflowStageCategory::Indeterminate),
            },
            ProjectWorkflowStage {
                id: "4".to_string(),
                name: "Implementation".to_string(),
                category: Some(WorkflowStageCategory::Indeterminate),
            },
            ProjectWorkflowStage {
                id: "5".to_string(),
                name: "Verification".to_string(),
                category: Some(WorkflowStageCategory::Indeterminate),
            },
            ProjectWorkflowStage {
                id: "6".to_string(),
                name: "Done".to_string(),
                category: Some(WorkflowStageCategory::Done),
            },
        ]
    }

    #[test]
    fn against_default_workflow_every_legacy_mapping_is_preserved() {
        let def = default_workflow();
        let cases = [
            ("Complete", "Done"),
            ("✅ Complete", "Done"),
            ("complete", "Done"),
            ("done", "Done"),
            ("Blocked", "Blocked"),
            ("blocked on review", "Blocked"),
            ("In Progress", "In Progress"),
            ("🔄 In progress", "In Progress"),
            ("doing", "In Progress"),
            ("wip", "In Progress"),
            ("To Do", "To Do"),
            ("todo", "To Do"),
            ("pending", "To Do"),
            ("planned", "To Do"),
            ("Backlog", "Backlog"),
            ("Proposed", "Backlog"),
            ("something nobody recognises", "Backlog"),
            ("", "Backlog"),
        ];
        for (input, expected) in cases {
            assert_eq!(
                resolve_status(input, Some(&def)),
                expected,
                "{input} -> {expected}"
            );
        }
    }

    #[test]
    fn no_workflow_at_all_behaves_as_default_workflow() {
        assert_eq!(resolve_status("✅ Complete", None), "Done");
        assert_eq!(resolve_status("anything", None), "Backlog");
        assert_eq!(
            workflow_status_names(None),
            vec!["Backlog", "To Do", "In Progress", "Blocked", "Done"]
        );
        assert_eq!(
            workflow_status_names(Some(&[])),
            workflow_status_names(None)
        );
    }

    #[test]
    fn exact_stage_name_wins_case_and_punctuation_insensitively() {
        let sw = software_workflow();
        assert_eq!(resolve_status("Architecture", Some(&sw)), "Architecture");
        assert_eq!(resolve_status("architecture", Some(&sw)), "Architecture");
        assert_eq!(
            resolve_status("  Verification  ", Some(&sw)),
            "Verification"
        );
        assert_eq!(resolve_status("Requirements", Some(&sw)), "Requirements");
    }

    #[test]
    fn freeform_status_falls_back_to_workflow_category_stages() {
        let sw = software_workflow();
        assert_eq!(resolve_status("✅ Complete", Some(&sw)), "Done");
        assert_eq!(resolve_status("🚧 In progress", Some(&sw)), "Architecture");
        assert_eq!(resolve_status("blocked", Some(&sw)), "Architecture");
        assert_eq!(resolve_status("pending", Some(&sw)), "Backlog");
    }

    #[test]
    fn unrecognised_status_resolves_to_first_stage() {
        let sw = software_workflow();
        assert_eq!(resolve_status("zzz", Some(&sw)), "Backlog");
        assert_eq!(resolve_status("", Some(&sw)), "Backlog");
        let odd = vec![
            ProjectWorkflowStage {
                id: "a".to_string(),
                name: "Icebox".to_string(),
                category: Some(WorkflowStageCategory::Todo),
            },
            ProjectWorkflowStage {
                id: "b".to_string(),
                name: "Shipped".to_string(),
                category: Some(WorkflowStageCategory::Done),
            },
        ];
        assert_eq!(resolve_status("nonsense", Some(&odd)), "Icebox");
        assert_eq!(resolve_status("✅ Complete", Some(&odd)), "Shipped");
    }

    #[test]
    fn category_inference_and_normalization_match_typescript() {
        assert_eq!(infer_category("Done", 1, 5), WorkflowStageCategory::Done);
        assert_eq!(
            infer_category("In Progress", 0, 5),
            WorkflowStageCategory::Indeterminate
        );
        assert_eq!(infer_category("Backlog", 3, 5), WorkflowStageCategory::Todo);
        assert_eq!(
            infer_category("Hypothesis", 0, 4),
            WorkflowStageCategory::Todo
        );
        assert_eq!(
            infer_category("Method", 1, 4),
            WorkflowStageCategory::Indeterminate
        );
        assert_eq!(
            infer_category("Synthesis", 2, 4),
            WorkflowStageCategory::Indeterminate
        );
        assert_eq!(
            infer_category("Decision", 3, 4),
            WorkflowStageCategory::Done
        );

        let legacy = vec![
            ProjectWorkflowStage {
                id: "1".to_string(),
                name: "Backlog".to_string(),
                category: None,
            },
            ProjectWorkflowStage {
                id: "2".to_string(),
                name: "Source planning".to_string(),
                category: None,
            },
            ProjectWorkflowStage {
                id: "3".to_string(),
                name: "Evidence".to_string(),
                category: None,
            },
            ProjectWorkflowStage {
                id: "4".to_string(),
                name: "Wrapped".to_string(),
                category: None,
            },
        ];
        let categories: Vec<_> = normalize_workflow_stages(Some(&legacy))
            .into_iter()
            .map(|s| s.category.expect("category"))
            .collect();
        assert_eq!(
            categories,
            vec![
                WorkflowStageCategory::Todo,
                WorkflowStageCategory::Indeterminate,
                WorkflowStageCategory::Indeterminate,
                WorkflowStageCategory::Done,
            ]
        );
    }

    #[test]
    fn validate_workflow_stages_enforces_rules() {
        let def = default_workflow();
        let sw = software_workflow();
        assert_eq!(validate_workflow_stages(&def), None);
        assert_eq!(validate_workflow_stages(&sw), None);

        assert!(
            validate_workflow_stages(&[ProjectWorkflowStage {
                id: "1".to_string(),
                name: "Only".to_string(),
                category: None,
            }])
            .expect("error")
            .to_lowercase()
            .contains("at least two")
        );
        assert!(
            validate_workflow_stages(&[
                ProjectWorkflowStage {
                    id: "1".to_string(),
                    name: "A".to_string(),
                    category: None,
                },
                ProjectWorkflowStage {
                    id: "2".to_string(),
                    name: "a".to_string(),
                    category: None,
                },
            ])
            .expect("error")
            .to_lowercase()
            .contains("unique")
        );
    }
}
