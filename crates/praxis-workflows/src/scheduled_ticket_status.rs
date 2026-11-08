//! Where a scheduled ticket moves on its board as the run works it
//! (`scheduledTicketStatus.ts` port).
//!
//! A ticket the schedule starts goes to the workflow's first in-flight stage, and one it finishes
//! goes to the first done stage, so the board says what the run is doing without anyone moving
//! cards. Stages are told apart by category, not by name, through the project's own workflow —
//! `category_of_status` — so a board whose columns are "Building" and "Shipped" moves the same way
//! as one with "In Progress" and "Done".
//!
//! Pure: the backend's transitions and the ticket's status go in, the transition to apply (or none)
//! comes out.

use praxis_contracts::{ProjectWorkflowStage, WorkflowStageCategory, WorkflowTransition};
use praxis_core::projects::project_workflow::{
    category_of_status, first_stage_of_category, workflow_category_rank,
};

/// The board category a ticket moves to: in flight when it starts, done when it finishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledTicketPhase {
    Indeterminate,
    Done,
}

impl ScheduledTicketPhase {
    /// The workflow category this phase means.
    #[must_use]
    pub fn category(self) -> WorkflowStageCategory {
        match self {
            Self::Indeterminate => WorkflowStageCategory::Indeterminate,
            Self::Done => WorkflowStageCategory::Done,
        }
    }

    /// The category name the rank helper reads.
    fn category_name(self) -> &'static str {
        match self {
            Self::Indeterminate => "indeterminate",
            Self::Done => "done",
        }
    }
}

/// The category name a stage category is known by.
fn category_name(category: WorkflowStageCategory) -> &'static str {
    match category {
        WorkflowStageCategory::Todo => "todo",
        WorkflowStageCategory::Indeterminate => "indeterminate",
        WorkflowStageCategory::Done => "done",
    }
}

/// Where a transition leads.
fn target(transition: &WorkflowTransition) -> &str {
    transition.to_status.as_deref().unwrap_or(&transition.name)
}

/// The transition that moves a ticket into `phase`, or `None` when it should not move: it is already
/// there or further on (a run never drags a finished ticket back to in progress), or the board has
/// no stage of that kind. A transition whose target cannot be told is never taken.
#[must_use]
pub fn scheduled_ticket_transition(
    current: Option<&str>,
    transitions: &[WorkflowTransition],
    phase: ScheduledTicketPhase,
    workflow: Option<&[ProjectWorkflowStage]>,
) -> Option<WorkflowTransition> {
    if let Some(now) = category_of_status(current, workflow) {
        if workflow_category_rank(Some(category_name(now)))
            >= workflow_category_rank(Some(phase.category_name()))
        {
            return None;
        }
    }
    let candidates: Vec<&WorkflowTransition> = transitions
        .iter()
        .filter(|transition| {
            category_of_status(Some(target(transition)), workflow) == Some(phase.category())
        })
        .collect();
    // The workflow's first stage of the kind ("In Progress" before "Blocked"), when the board offers
    // it.
    let preferred =
        first_stage_of_category(workflow, phase.category()).map(|stage| stage.name.to_lowercase());
    candidates
        .iter()
        .find(|transition| Some(target(transition).to_lowercase()) == preferred)
        .or_else(|| candidates.first())
        .map(|transition| (*transition).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moves(statuses: &[&str]) -> Vec<WorkflowTransition> {
        statuses
            .iter()
            .enumerate()
            .map(|(index, status)| WorkflowTransition {
                id: format!("t{index}"),
                name: format!("Move to {status}"),
                to_status: Some((*status).to_string()),
                raw: None,
            })
            .collect()
    }

    fn stage(id: &str, name: &str, category: WorkflowStageCategory) -> ProjectWorkflowStage {
        ProjectWorkflowStage {
            id: id.into(),
            name: name.into(),
            category: Some(category),
        }
    }

    #[test]
    fn a_ticket_starts_in_the_first_in_flight_stage_preferring_it_over_blocked() {
        let transitions = moves(&["Blocked", "In Progress", "Done"]);
        let chosen = scheduled_ticket_transition(
            Some("Backlog"),
            &transitions,
            ScheduledTicketPhase::Indeterminate,
            None,
        );
        assert_eq!(chosen.and_then(|t| t.to_status), Some("In Progress".into()));
        let chosen = scheduled_ticket_transition(
            Some("In Progress"),
            &transitions,
            ScheduledTicketPhase::Done,
            None,
        );
        assert_eq!(chosen.and_then(|t| t.to_status), Some("Done".into()));
    }

    #[test]
    fn stages_are_told_apart_by_the_project_workflows_categories() {
        let workflow = vec![
            stage("idea", "Idea", WorkflowStageCategory::Todo),
            stage("build", "Building", WorkflowStageCategory::Indeterminate),
            stage("ship", "Shipped", WorkflowStageCategory::Done),
        ];
        let chosen = scheduled_ticket_transition(
            Some("Idea"),
            &moves(&["Building", "Shipped"]),
            ScheduledTicketPhase::Indeterminate,
            Some(&workflow),
        );
        assert_eq!(chosen.and_then(|t| t.to_status), Some("Building".into()));
        let chosen = scheduled_ticket_transition(
            Some("Building"),
            &moves(&["Idea", "Shipped"]),
            ScheduledTicketPhase::Done,
            Some(&workflow),
        );
        assert_eq!(chosen.and_then(|t| t.to_status), Some("Shipped".into()));
    }

    #[test]
    fn it_never_moves_backwards_or_to_a_stage_it_cannot_place() {
        assert!(
            scheduled_ticket_transition(
                Some("Done"),
                &moves(&["In Progress"]),
                ScheduledTicketPhase::Indeterminate,
                None
            )
            .is_none()
        );
        assert!(
            scheduled_ticket_transition(
                Some("In Progress"),
                &moves(&["Backlog", "Done"]),
                ScheduledTicketPhase::Indeterminate,
                None
            )
            .is_none()
        );
        assert!(
            scheduled_ticket_transition(
                Some("Backlog"),
                &moves(&["Architecture"]),
                ScheduledTicketPhase::Indeterminate,
                None
            )
            .is_none()
        );
    }

    #[test]
    fn it_does_not_move_when_the_board_has_no_stage_of_that_kind() {
        let two_stages = vec![
            stage("b", "Backlog", WorkflowStageCategory::Todo),
            stage("d", "Done", WorkflowStageCategory::Done),
        ];
        assert!(
            scheduled_ticket_transition(
                Some("Backlog"),
                &moves(&["Done"]),
                ScheduledTicketPhase::Indeterminate,
                Some(&two_stages),
            )
            .is_none()
        );
        let chosen = scheduled_ticket_transition(
            Some("Backlog"),
            &moves(&["Done"]),
            ScheduledTicketPhase::Done,
            Some(&two_stages),
        );
        assert_eq!(chosen.and_then(|t| t.to_status), Some("Done".into()));
    }
}
