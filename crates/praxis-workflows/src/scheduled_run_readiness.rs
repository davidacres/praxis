//! Readiness for a scheduled run: what would stop it, or make it risky, if it started now
//! (`scheduledRunReadiness.ts` port).
//!
//! Readiness is **derived, never stored**. A ticket can be deleted, moved off the board, or lose its
//! workflow between saving and starting, so the answer is recomputed against the live board each
//! time a schedule is opened. The caller supplies a probe for the board side; this module stays
//! pure.
//!
//! A *blocker* means the run cannot start as it stands. A *warning* means it can, but the user
//! should know first — the editor shows both and lets a warning through.

use chrono::DateTime;
use serde::{Deserialize, Serialize};

use crate::scheduled_budget::LANE_ALLOWANCE_RESERVE;
use crate::scheduled_run::{
    ScheduledRun, ScheduledTicketRef, scheduled_concurrency, scheduled_steps,
};

/// How badly an issue affects the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadinessSeverity {
    Blocker,
    Warning,
}

/// What is wrong with a run, or risky about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduledReadinessCode {
    NoTickets,
    StartInPast,
    NoProvider,
    TicketMissing,
    TicketMoved,
    TicketClosed,
    NoFolder,
    NoWorkflow,
    WorkflowUntrusted,
    BaseDirty,
    AllowanceLow,
    NoAcceptanceCriteria,
    InOtherSchedule,
    ParallelLanes,
}

/// One thing to tell the user about a run before it starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledReadinessIssue {
    pub code: ScheduledReadinessCode,
    pub severity: ReadinessSeverity,
    /// Present when the issue belongs to one queue entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    /// The entry's ticket key, so a view can put the issue on that ticket even before the entry has
    /// a stable id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_key: Option<String>,
    pub message: String,
}

/// Whether a run could start now, and what the user should know first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRunReadiness {
    /// False when any blocker is present. Warnings do not make a run not ready.
    pub ready: bool,
    pub issues: Vec<ScheduledReadinessIssue>,
}

/// Where a queued ticket stands on the board.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketProbeState {
    /// The ticket is on the board.
    Found,
    /// The ticket no longer exists.
    Missing,
    /// The ticket exists but is no longer on this board.
    Moved,
}

/// What the board can say about one queued ticket right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledTicketProbe {
    pub state: TicketProbeState,
    /// The ticket is already in a finished status.
    pub closed: bool,
    pub has_folder: Option<bool>,
    pub has_workflow: Option<bool>,
    pub has_acceptance_criteria: Option<bool>,
    /// Name of another armed schedule that already queues this ticket.
    pub in_other_schedule: Option<String>,
}

impl ScheduledTicketProbe {
    /// A ticket that is on the board and in good order.
    #[must_use]
    pub fn found() -> Self {
        Self {
            state: TicketProbeState::Found,
            closed: false,
            has_folder: None,
            has_workflow: None,
            has_acceptance_criteria: None,
            in_other_schedule: None,
        }
    }
}

/// The board side of the readiness check.
pub trait ScheduledTicketProbeSource {
    /// What the board says about one queued ticket right now.
    fn probe(&self, ticket: &ScheduledTicketRef) -> ScheduledTicketProbe;
}

/// Everything readiness needs beyond the run itself.
pub struct ScheduledReadinessContext<'a> {
    pub now: String,
    pub probe: &'a dyn ScheduledTicketProbeSource,
    /// Enabled AI providers that are set up.
    pub usable_provider_count: usize,
    /// False when the chosen workflow needs local workspace trust that has not been given. An
    /// unattended start cannot stop to ask, so this blocks. `None` = not assessed.
    pub workflow_trusted: Option<bool>,
    /// The project's base checkout has uncommitted changes, which would pause an unattended start.
    pub base_dirty: bool,
    /// A provider that is already at or past the hand-over point.
    pub low_allowance_provider: Option<String>,
}

/// What would stop the run, or make it risky, if it started now.
#[must_use]
pub fn assess_scheduled_run_readiness(
    run: &ScheduledRun,
    context: &ScheduledReadinessContext<'_>,
) -> ScheduledRunReadiness {
    let mut issues: Vec<ScheduledReadinessIssue> = Vec::new();

    let issue =
        |code, severity, entry_id: Option<String>, issue_key: Option<String>, message: String| {
            ScheduledReadinessIssue {
                code,
                severity,
                entry_id,
                issue_key,
                message,
            }
        };

    if run.entries.is_empty() {
        issues.push(issue(
            ScheduledReadinessCode::NoTickets,
            ReadinessSeverity::Blocker,
            None,
            None,
            "Add at least one ticket.".into(),
        ));
    }
    // Only a draft can have a start that is too late to arm. A scheduled run whose time has come is
    // just due.
    let start_in_past = match (
        DateTime::parse_from_rfc3339(&run.scheduled_start_at),
        DateTime::parse_from_rfc3339(&context.now),
    ) {
        (Ok(start), Ok(now)) => start <= now,
        _ => false,
    };
    if run.status == crate::scheduled_run::ScheduledRunStatus::Draft && start_in_past {
        issues.push(issue(
            ScheduledReadinessCode::StartInPast,
            ReadinessSeverity::Blocker,
            None,
            None,
            "The start time has already passed.".into(),
        ));
    }
    if context.usable_provider_count == 0 {
        issues.push(issue(
            ScheduledReadinessCode::NoProvider,
            ReadinessSeverity::Blocker,
            None,
            None,
            "No AI provider is enabled and set up to run the tickets.".into(),
        ));
    }

    if run.policy.workflow_id().is_none() {
        issues.push(issue(
            ScheduledReadinessCode::NoWorkflow,
            ReadinessSeverity::Blocker,
            None,
            None,
            "Choose the workflow each ticket is started with.".into(),
        ));
    } else if context.workflow_trusted == Some(false) {
        issues.push(issue(
            ScheduledReadinessCode::WorkflowUntrusted,
            ReadinessSeverity::Blocker,
            None,
            None,
            "This workflow needs workspace trust. Review and approve it before the run, because an unattended start cannot ask.".into(),
        ));
    }
    if context.base_dirty {
        issues.push(issue(
            ScheduledReadinessCode::BaseDirty,
            ReadinessSeverity::Warning,
            None,
            None,
            "The project folder has uncommitted changes. The run will pause at the first ticket until they are committed or set aside.".into(),
        ));
    }
    let lanes = scheduled_concurrency(&run.policy);
    if lanes > 1 {
        // The budget warning FX-BE-149 asks for before a parallel run is saved or started.
        let shared = scheduled_steps(&run.entries)
            .iter()
            .any(|step| step.len() > 1);
        issues.push(issue(
            ScheduledReadinessCode::ParallelLanes,
            ReadinessSeverity::Warning,
            None,
            None,
            if shared {
                format!("Up to {lanes} tickets of a shared step run at once, using allowance up to {lanes} times as fast. Each extra ticket starts only while its provider reports {}% room per ticket.", (LANE_ALLOWANCE_RESERVE * 100.0).round())
            } else {
                format!("Tickets at once is {lanes}, but no step is shared, so tickets still run one at a time.")
            },
        ));
    }
    if let Some(provider) = &context.low_allowance_provider {
        issues.push(issue(
            ScheduledReadinessCode::AllowanceLow,
            ReadinessSeverity::Warning,
            None,
            None,
            format!("{provider} is nearly out of allowance, so the run may start on another provider or pause."),
        ));
    }

    for entry in &run.entries {
        let key = entry.ticket.issue_key.clone();
        let probe = context.probe.probe(&entry.ticket);
        let entry_id = Some(entry.id.clone());
        if probe.state == TicketProbeState::Missing {
            issues.push(issue(
                ScheduledReadinessCode::TicketMissing,
                ReadinessSeverity::Blocker,
                entry_id,
                Some(key.clone()),
                format!("{key} no longer exists."),
            ));
            continue;
        }
        if probe.state == TicketProbeState::Moved {
            issues.push(issue(
                ScheduledReadinessCode::TicketMoved,
                ReadinessSeverity::Blocker,
                entry_id,
                Some(key.clone()),
                format!("{key} is no longer on this board."),
            ));
            continue;
        }
        if probe.closed {
            issues.push(issue(
                ScheduledReadinessCode::TicketClosed,
                ReadinessSeverity::Blocker,
                entry_id.clone(),
                Some(key.clone()),
                format!("{key} is already finished."),
            ));
        }
        if probe.has_folder == Some(false) {
            issues.push(issue(
                ScheduledReadinessCode::NoFolder,
                ReadinessSeverity::Blocker,
                entry_id.clone(),
                Some(key.clone()),
                format!("{key} has no working folder to run in."),
            ));
        }
        if probe.has_workflow == Some(false) {
            issues.push(issue(
                ScheduledReadinessCode::NoWorkflow,
                ReadinessSeverity::Blocker,
                entry_id.clone(),
                Some(key.clone()),
                format!("{key} has no workflow assigned."),
            ));
        }
        if probe.has_acceptance_criteria == Some(false) {
            issues.push(issue(
                ScheduledReadinessCode::NoAcceptanceCriteria,
                ReadinessSeverity::Warning,
                entry_id.clone(),
                Some(key.clone()),
                format!("{key} has no acceptance criteria, so the agent may stop to ask."),
            ));
        }
        if let Some(other) = &probe.in_other_schedule {
            issues.push(issue(
                ScheduledReadinessCode::InOtherSchedule,
                ReadinessSeverity::Warning,
                entry_id,
                Some(key.clone()),
                format!("{key} is also queued in \"{other}\"."),
            ));
        }
    }

    let ready = !issues
        .iter()
        .any(|issue| issue.severity == ReadinessSeverity::Blocker);
    ScheduledRunReadiness { ready, issues }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::scheduled_run::{
        CreateScheduledRunInput, ScheduledRun, ScheduledRunStatus, ScheduledTicketRef,
        arm_scheduled_run, create_scheduled_run, reconcile_scheduled_run_on_launch,
    };

    use super::*;

    const NOW: &str = "2026-10-20T10:00:00.000Z";
    const LATER: &str = "2026-10-21T21:00:00.000Z";

    fn ticket(key: &str) -> ScheduledTicketRef {
        ScheduledTicketRef {
            connection_id: "c1".into(),
            issue_key: key.into(),
            title: format!("Title {key}"),
        }
    }

    fn draft(keys: &[&str]) -> ScheduledRun {
        create_scheduled_run(CreateScheduledRunInput {
            id: None,
            project_id: None,
            name: "Nightly".into(),
            scheduled_start_at: LATER.into(),
            timezone: "Europe/London".into(),
            tickets: keys.iter().map(|key| ticket(key)).collect(),
            with_previous: vec![],
            workflow_id: Some("governed-delivery".into()),
            max_concurrency: None,
            at: NOW.into(),
        })
        .expect("draft")
    }

    struct Probes {
        map: HashMap<String, ScheduledTicketProbe>,
    }

    impl ScheduledTicketProbeSource for Probes {
        fn probe(&self, ticket: &ScheduledTicketRef) -> ScheduledTicketProbe {
            self.map
                .get(&ticket.issue_key)
                .cloned()
                .unwrap_or(ScheduledTicketProbe {
                    state: TicketProbeState::Found,
                    closed: false,
                    has_folder: Some(true),
                    has_workflow: Some(true),
                    has_acceptance_criteria: Some(true),
                    in_other_schedule: None,
                })
        }
    }

    fn probes(pairs: &[(&str, ScheduledTicketProbe)]) -> Probes {
        Probes {
            map: pairs
                .iter()
                .map(|(key, probe)| ((*key).to_string(), probe.clone()))
                .collect(),
        }
    }

    fn ready(
        run: &ScheduledRun,
        probes: &Probes,
        usable_provider_count: usize,
    ) -> ScheduledRunReadiness {
        assess_scheduled_run_readiness(
            run,
            &ScheduledReadinessContext {
                now: NOW.into(),
                probe: probes,
                usable_provider_count,
                workflow_trusted: None,
                base_dirty: false,
                low_allowance_provider: None,
            },
        )
    }

    fn codes(readiness: &ScheduledRunReadiness) -> Vec<ScheduledReadinessCode> {
        readiness.issues.iter().map(|issue| issue.code).collect()
    }

    #[test]
    fn a_healthy_schedule_is_ready_with_no_issues() {
        let readiness = ready(&draft(&["PRX-1", "PRX-2", "PRX-3"]), &probes(&[]), 2);
        assert!(readiness.ready);
        assert!(readiness.issues.is_empty());
    }

    #[test]
    fn blockers_make_a_schedule_not_ready_and_name_the_ticket() {
        let run = draft(&["PRX-1", "PRX-2", "PRX-3"]);
        let mut missing = ScheduledTicketProbe::found();
        missing.state = TicketProbeState::Missing;
        let mut moved = ScheduledTicketProbe::found();
        moved.state = TicketProbeState::Moved;
        let mut closed = ScheduledTicketProbe::found();
        closed.closed = true;
        closed.has_folder = Some(false);
        closed.has_workflow = Some(false);

        let readiness = ready(
            &run,
            &probes(&[("PRX-1", missing), ("PRX-2", moved), ("PRX-3", closed)]),
            2,
        );
        assert!(!readiness.ready);
        assert_eq!(
            codes(&readiness),
            vec![
                ScheduledReadinessCode::TicketMissing,
                ScheduledReadinessCode::TicketMoved,
                ScheduledReadinessCode::TicketClosed,
                ScheduledReadinessCode::NoFolder,
                ScheduledReadinessCode::NoWorkflow,
            ]
        );
        assert_eq!(
            readiness.issues[0].entry_id.as_deref(),
            Some(run.entries[0].id.as_str())
        );
        assert!(
            readiness.issues[0]
                .message
                .contains("PRX-1 no longer exists")
        );
    }

    #[test]
    fn warnings_do_not_block() {
        let mut warned = ScheduledTicketProbe::found();
        warned.has_acceptance_criteria = Some(false);
        warned.in_other_schedule = Some("Sprint 42".into());
        let readiness = ready(&draft(&["PRX-1"]), &probes(&[("PRX-1", warned)]), 2);
        assert!(readiness.ready);
        assert_eq!(
            codes(&readiness),
            vec![
                ScheduledReadinessCode::NoAcceptanceCriteria,
                ScheduledReadinessCode::InOtherSchedule,
            ]
        );
        assert!(
            readiness
                .issues
                .iter()
                .all(|issue| issue.severity == ReadinessSeverity::Warning)
        );
    }

    #[test]
    fn an_empty_queue_a_past_start_and_no_provider_are_blockers() {
        let past = create_scheduled_run(CreateScheduledRunInput {
            id: None,
            project_id: None,
            name: "x".into(),
            scheduled_start_at: "2026-10-19T00:00:00Z".into(),
            timezone: "UTC".into(),
            tickets: vec![],
            with_previous: vec![],
            workflow_id: None,
            max_concurrency: None,
            at: NOW.into(),
        })
        .expect("past");
        let readiness = ready(&past, &probes(&[]), 0);
        let mut found = codes(&readiness);
        found.sort_by_key(|code| format!("{code:?}"));
        let mut expected = vec![
            ScheduledReadinessCode::NoProvider,
            ScheduledReadinessCode::NoTickets,
            ScheduledReadinessCode::NoWorkflow,
            ScheduledReadinessCode::StartInPast,
        ];
        expected.sort_by_key(|code| format!("{code:?}"));
        assert_eq!(found, expected);
    }

    #[test]
    fn a_scheduled_run_whose_time_has_come_is_due_not_flagged_as_late() {
        let armed = arm_scheduled_run(draft(&["PRX-1"]), NOW).expect("arm");
        assert_eq!(armed.status, ScheduledRunStatus::Scheduled);
        let readiness = assess_scheduled_run_readiness(
            &armed,
            &ScheduledReadinessContext {
                now: "2026-10-22T00:00:00Z".into(),
                probe: &probes(&[]),
                usable_provider_count: 1,
                workflow_trusted: None,
                base_dirty: false,
                low_allowance_provider: None,
            },
        );
        assert!(!codes(&readiness).contains(&ScheduledReadinessCode::StartInPast));
        assert!(readiness.ready);
    }

    #[test]
    fn a_finished_run_is_not_flagged_for_a_past_start() {
        let missed = reconcile_scheduled_run_on_launch(
            arm_scheduled_run(draft(&["PRX-1"]), NOW).expect("arm"),
            "2026-10-22T00:00:00Z",
        );
        let readiness = assess_scheduled_run_readiness(
            &missed,
            &ScheduledReadinessContext {
                now: "2026-10-22T00:00:00Z".into(),
                probe: &probes(&[]),
                usable_provider_count: 1,
                workflow_trusted: None,
                base_dirty: false,
                low_allowance_provider: None,
            },
        );
        assert!(!codes(&readiness).contains(&ScheduledReadinessCode::StartInPast));
    }

    #[test]
    fn a_schedule_with_no_workflow_is_blocked_and_an_untrusted_one_has_its_own_message() {
        let no_workflow = create_scheduled_run(CreateScheduledRunInput {
            id: None,
            project_id: None,
            name: "N".into(),
            scheduled_start_at: LATER.into(),
            timezone: "UTC".into(),
            tickets: vec![ticket("PRX-1")],
            with_previous: vec![],
            workflow_id: None,
            max_concurrency: None,
            at: NOW.into(),
        })
        .expect("run");
        let readiness = ready(&no_workflow, &probes(&[]), 1);
        assert!(readiness.issues.iter().any(|issue| {
            issue.code == ScheduledReadinessCode::NoWorkflow
                && issue.severity == ReadinessSeverity::Blocker
        }));

        let untrusted = assess_scheduled_run_readiness(
            &draft(&["PRX-1"]),
            &ScheduledReadinessContext {
                now: NOW.into(),
                probe: &probes(&[]),
                usable_provider_count: 1,
                workflow_trusted: Some(false),
                base_dirty: false,
                low_allowance_provider: None,
            },
        );
        assert!(!untrusted.ready);
        assert!(codes(&untrusted).contains(&ScheduledReadinessCode::WorkflowUntrusted));
    }

    #[test]
    fn a_dirty_base_and_a_nearly_empty_provider_warn_without_blocking() {
        let readiness = assess_scheduled_run_readiness(
            &draft(&["PRX-1"]),
            &ScheduledReadinessContext {
                now: NOW.into(),
                probe: &probes(&[]),
                usable_provider_count: 1,
                workflow_trusted: None,
                base_dirty: true,
                low_allowance_provider: Some("claude".into()),
            },
        );
        assert!(readiness.ready);
        let mut found = codes(&readiness);
        found.sort_by_key(|code| format!("{code:?}"));
        let mut expected = vec![
            ScheduledReadinessCode::AllowanceLow,
            ScheduledReadinessCode::BaseDirty,
        ];
        expected.sort_by_key(|code| format!("{code:?}"));
        assert_eq!(found, expected);
    }

    #[test]
    fn a_parallel_run_carries_a_budget_warning_and_says_so_when_no_step_is_shared() {
        let parallel = |keys: &[&str], max: i64, shared: bool| {
            let with_previous = if shared && keys.len() > 1 {
                vec![crate::scheduled_run::ticket_ref_key("c1", keys[1])]
            } else {
                vec![]
            };
            create_scheduled_run(CreateScheduledRunInput {
                id: None,
                project_id: None,
                name: "Nightly".into(),
                scheduled_start_at: LATER.into(),
                timezone: "Europe/London".into(),
                tickets: keys.iter().map(|key| ticket(key)).collect(),
                with_previous,
                workflow_id: Some("governed-delivery".into()),
                max_concurrency: Some(max),
                at: NOW.into(),
            })
            .expect("run")
        };

        let warning = |run: &ScheduledRun| {
            ready(run, &probes(&[]), 1)
                .issues
                .into_iter()
                .find(|issue| issue.code == ScheduledReadinessCode::ParallelLanes)
        };

        assert!(warning(&parallel(&["A", "B"], 1, true)).is_none());
        let shared = warning(&parallel(&["A", "B"], 2, true)).expect("warning");
        assert!(
            shared
                .message
                .contains("Up to 2 tickets of a shared step run at once, using allowance up to 2 times as fast"),
            "{}",
            shared.message
        );
        assert_eq!(shared.severity, ReadinessSeverity::Warning);
        let unshared = warning(&parallel(&["A", "B"], 2, false)).expect("warning");
        assert!(
            unshared.message.contains("no step is shared"),
            "{}",
            unshared.message
        );
    }
}
