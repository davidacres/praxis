//! Project-scoped schedules for the phone (`apps/praxis-desktop/main/src/main/mobileScheduledRuns.ts`
//! port).
//!
//! Shares the desktop's editor rules (`praxis-workflows`' `compose`/`arm`/`hold`/`resolve_missed`)
//! and its persistent store, reached through [`MobileScheduleStore`]. A phone names project ticket
//! keys; it never supplies (or sees) the backing connection ids.

use std::sync::Arc;

use async_trait::async_trait;
use praxis_workflows::scheduled_run::{
    ComposeScheduledRunInput, MissedResolution, ScheduledRun, ScheduledTicketRef,
    arm_scheduled_run, compose_scheduled_run, hold_scheduled_run, resolve_missed_scheduled_run,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::protocol::now_iso;

/// The desktop's scheduled-run store.
#[async_trait]
pub trait MobileScheduleStore: Send + Sync {
    fn list(&self) -> Vec<ScheduledRun>;
    fn get(&self, id: &str) -> Option<ScheduledRun>;
    async fn save(&self, run: ScheduledRun) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileScheduledEntry {
    pub id: String,
    pub sequence: u32,
    pub issue_key: String,
    pub title: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Revision 8: a schedule without connection settings or filesystem paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileScheduledRun {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub status: String,
    pub scheduled_start_at: String,
    pub timezone: String,
    pub entries: Vec<MobileScheduledEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileScheduleInput {
    pub name: String,
    pub date: String,
    pub time: String,
    pub timezone: String,
    /// Project ticket keys in execution order. The desktop resolves their backing connection.
    pub issue_keys: Vec<String>,
}

fn word(value: impl Serialize) -> String {
    match serde_json::to_value(value) {
        Ok(Value::String(text)) => text,
        _ => String::new(),
    }
}

pub fn mobile_scheduled_run(run: &ScheduledRun) -> Result<MobileScheduledRun, String> {
    let Some(project_id) = run.project_id.clone().filter(|p| !p.is_empty()) else {
        return Err("A mobile schedule requires a project.".to_owned());
    };
    Ok(MobileScheduledRun {
        id: run.id.clone(),
        project_id,
        name: run.name.clone(),
        status: word(run.status),
        scheduled_start_at: run.scheduled_start_at.clone(),
        timezone: run.timezone.clone(),
        entries: run
            .entries
            .iter()
            .map(|entry| {
                let outcome = entry.outcome.as_ref();
                MobileScheduledEntry {
                    id: entry.id.clone(),
                    sequence: entry.sequence,
                    issue_key: entry.ticket.issue_key.clone(),
                    title: entry.ticket.title.clone(),
                    status: outcome.map_or_else(|| "queued".to_owned(), |o| word(o.status)),
                    workflow_run_id: outcome
                        .and_then(|o| o.workflow_run_id.clone())
                        .filter(|id| !id.is_empty()),
                    reason: outcome
                        .and_then(|o| o.reason.clone())
                        .filter(|r| !r.is_empty()),
                }
            })
            .collect(),
    })
}

/// What the host services call (`MobileHostServiceDeps.schedules`).
#[async_trait]
pub trait MobileSchedules: Send + Sync {
    async fn list(&self, project_id: &str) -> Result<Vec<MobileScheduledRun>, String>;
    async fn save(
        &self,
        project_id: &str,
        input: MobileScheduleInput,
    ) -> Result<MobileScheduledRun, String>;
    async fn set_armed(
        &self,
        project_id: &str,
        id: &str,
        armed: bool,
    ) -> Result<MobileScheduledRun, String>;
    async fn resolve_missed(
        &self,
        project_id: &str,
        id: &str,
        resolution: MissedResolution,
    ) -> Result<MobileScheduledRun, String>;
}

/// The desktop services [`create_mobile_schedules`] needs.
#[async_trait]
pub trait MobileScheduleDeps: Send + Sync {
    fn store(&self) -> Arc<dyn MobileScheduleStore>;
    /// The project's tickets, with their backing connections.
    async fn tickets(&self, project_id: &str) -> Result<Vec<ScheduledTicketRef>, String>;
    fn changed(&self, project_id: &str);
    /// The workflow a phone-made schedule uses.
    async fn default_workflow(&self, _project_id: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    /// Wakes the runner after a missed run is started now.
    async fn start_now(&self) -> Result<(), String> {
        Ok(())
    }
    fn now(&self) -> String {
        now_iso()
    }
}

struct DesktopSchedules<D> {
    deps: D,
}

/// `createMobileSchedules`.
pub fn create_mobile_schedules<D: MobileScheduleDeps + 'static>(
    deps: D,
) -> Arc<dyn MobileSchedules> {
    Arc::new(DesktopSchedules { deps })
}

impl<D: MobileScheduleDeps> DesktopSchedules<D> {
    fn require_run(&self, project_id: &str, id: &str) -> Result<ScheduledRun, String> {
        self.deps
            .store()
            .get(id)
            .filter(|run| run.project_id.as_deref() == Some(project_id))
            .ok_or_else(|| "That scheduled run was not found in this project.".to_owned())
    }

    async fn save_run(&self, run: ScheduledRun) -> Result<MobileScheduledRun, String> {
        let projected = mobile_scheduled_run(&run);
        let project_id = run.project_id.clone().unwrap_or_default();
        self.deps.store().save(run).await?;
        self.deps.changed(&project_id);
        projected
    }
}

#[async_trait]
impl<D: MobileScheduleDeps> MobileSchedules for DesktopSchedules<D> {
    async fn list(&self, project_id: &str) -> Result<Vec<MobileScheduledRun>, String> {
        self.deps
            .store()
            .list()
            .iter()
            .filter(|run| run.project_id.as_deref() == Some(project_id))
            .map(mobile_scheduled_run)
            .collect()
    }

    async fn save(
        &self,
        project_id: &str,
        input: MobileScheduleInput,
    ) -> Result<MobileScheduledRun, String> {
        let available = self.deps.tickets(project_id).await?;
        let tickets = input
            .issue_keys
            .iter()
            .map(|key| {
                let mut matches = available.iter().filter(|ticket| &ticket.issue_key == key);
                match (matches.next(), matches.next()) {
                    (Some(ticket), None) => Ok(ticket.clone()),
                    _ => Err(format!(
                        "Ticket {key} is unavailable or ambiguous in this project."
                    )),
                }
            })
            .collect::<Result<Vec<_>, String>>()?;
        let workflow_id = self.deps.default_workflow(project_id).await?;
        let run = compose_scheduled_run(
            None,
            ComposeScheduledRunInput {
                project_id: Some(project_id.to_owned()),
                name: input.name,
                date: input.date,
                time: input.time,
                timezone: input.timezone,
                tickets,
                with_previous: Vec::new(),
                workflow_id,
                max_concurrency: None,
                arm: false,
                at: self.deps.now(),
            },
        )?;
        self.save_run(run).await
    }

    async fn set_armed(
        &self,
        project_id: &str,
        id: &str,
        armed: bool,
    ) -> Result<MobileScheduledRun, String> {
        let run = self.require_run(project_id, id)?;
        let now = self.deps.now();
        let next = if armed {
            arm_scheduled_run(run, &now)?
        } else {
            hold_scheduled_run(run, &now)?
        };
        self.save_run(next).await
    }

    async fn resolve_missed(
        &self,
        project_id: &str,
        id: &str,
        resolution: MissedResolution,
    ) -> Result<MobileScheduledRun, String> {
        let run = self.require_run(project_id, id)?;
        let saved = self
            .save_run(resolve_missed_scheduled_run(
                run,
                resolution,
                &self.deps.now(),
            )?)
            .await?;
        if resolution == MissedResolution::StartNow {
            self.deps.start_now().await?;
        }
        Ok(saved)
    }
}

#[cfg(test)]
mod tests;
