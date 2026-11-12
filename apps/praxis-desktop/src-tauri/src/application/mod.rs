//! Rust desktop application adapters: ownership, stores and portable workspaces.
mod activity;
mod ai_browser;
mod browser_mcp;
mod agent_runtime;
mod ai;
mod acp_host;
mod api_host;
mod ai_delegate;
mod ai_review;
mod gadget_service;
mod ai_session_ops;
mod session_handover;
mod ai_models;
mod session_store;
mod user_mcp;
mod ai_providers;
mod ai_feedback;
mod ai_usage;
mod ai_usage_stats;
mod artifacts;
mod assistant;
mod team_chat;
mod team_chat_core;
mod board_prefs;
mod boards;
mod builtin_mcp;
mod connections;
mod deployments;
mod log_bus;
mod mobile_host;
mod semantic_model;
mod task_designer_plan;
mod task_designer_state;
mod plan_watch;
mod marketplace;
mod notes;
mod projects;
pub(crate) mod runtime;
mod runs;
mod scheduled_run_requests;
mod scheduled_runner_host;
mod scheduled_runs;
pub(crate) mod storage;
mod system;
mod task_designer;
mod webviews;
mod workflow_agent_stage;
mod workflow_engine;
mod workflow_env_failure;
mod workflow_estimate;
mod workflow_summary;
mod workflows;
mod workspaces;

use std::sync::{Arc, Mutex};

use chrono::{SecondsFormat, Utc};
use praxis_contracts::RustRpcError;
use praxis_host::HostContext;
use serde_json::{Value, json};

use storage::Catalog;

/// How long a call waits for the profile lock before reporting the profile busy.
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

type Result<T> = std::result::Result<T, RustRpcError>;

fn failure(message: impl ToString) -> RustRpcError {
    RustRpcError {
        code: "APPLICATION_ERROR".into(),
        message: message.to_string(),
    }
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn text(args: &[Value], index: usize) -> Result<&str> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| failure(format!("Argument {} must be a string.", index + 1)))
}

const CHANNELS: &[&str] = &[
    "workspaces:list",
    "workspaces:get",
    "workspaces:create",
    "workspaces:update",
    "workspaces:remove",
    "workspaces:setActive",
    "workspaces:openFolder",
    // Used by native dialogs, never added to the renderer allowlist.
    "workspaces:openFile",
    "workspaces:writeFile",
    "projects:list",
    "projects:get",
    "projects:create",
    "projects:useExisting",
    "projects:inspectFolder",
    "projects:listDocuments",
    "projects:readDocument",
    "projects:update",
    "projects:remove",
    "projects:attachFolder",
    "projects:linkBoard",
    "projects:unlinkBoard",
    "connection:list",
    "connection:add",
    "connection:update",
    "connection:remove",
    "connection:generateId",
    "connection:check",
    "connection:getTrackedBoards",
    "connection:addTrackedBoards",
    "connection:removeTrackedBoard",
    "connection:updateTrackedBoard",
    "folder:discoverPlans",
    "board:list",
    "board:get",
    "issue:list",
    "issue:getFilterMetadata",
    "issue:get",
    "issue:create",
    "issue:update",
    "issue:delete",
    "issue:transition",
    "issue:addComment",
    "issue:getSelfAssigneeLabel",
    "issue:getProjects",
    "issue:getParentItems",
    "boardPrefs:get",
    "boardPrefs:set",
    "log:getRecent",
    "activity:list",
    "notes:list",
    "notes:createNote",
    "notes:updateNote",
    "notes:deleteNote",
    "notes:createGroup",
    "notes:updateGroup",
    "notes:deleteGroup",
    "notes:replaceMemberships",
    "notes:prepareSnapshot",
    "artifacts:list",
    "artifacts:readText",
    "artifacts:loadImage",
    "artifacts:pageThumbnail",
    "artifacts:createGroup",
    "artifacts:updateGroup",
    "artifacts:deleteGroup",
    "artifacts:delete",
    "artifacts:reveal",
    "scheduledRuns:list",
    "scheduledRuns:get",
    "scheduledRuns:save",
    "scheduledRuns:preview",
    "scheduledRuns:remove",
    "scheduledRuns:rename",
    "scheduledRuns:archive",
    "scheduledRuns:workflowChoices",
    "scheduledRuns:pause",
    "scheduledRuns:startNow",
    "scheduledRuns:resume",
    "scheduledRuns:cancel",
    "scheduledRuns:skipEntry",
    "scheduledRuns:retryEntry",
    "scheduledRuns:approveGate",
    "scheduledRuns:setArmed",
    "scheduledRuns:resolveMissed",
    "workflows:projectTrust",
    "workflows:approveProjectTrust",
    "workflows:listTemplates",
    "workflows:getRecommendedTemplate",
    "workflows:recommendTemplate",
    "workflows:recommendModelTiers",
    "workflows:templateReadiness",
    "workflows:catalog",
    "workflows:get",
    "workflows:instantiate",
    "workflows:promotePack",
    "workflows:save",
    "workflows:remove",
    "workflows:validate",
    "workflows:assistant",
    "workflows:effectivePolicy",
    "workflows:listPolicies",
    "workflows:savePolicy",
    "workflows:removePolicy",
    "workflows:startRun",
    "workflows:prepareRun",
    "workflows:checkRunBase",
    "workflows:commitRunBase",
    "workflows:selectControllerRun",
    "workflows:removeControllerRun",
    "workflows:listRuns",
    "workflows:getRun",
    "workflows:renameRun",
    "workflows:advanceStage",
    "workflows:approveRun",
    "workflows:bypassGate",
    "workflows:skipApproval",
    "workflows:decideLoop",
    "workflows:stageReport",
    "workflows:saveStageReport",
    "workflows:retryStage",
    "workflows:switchStageProvider",
    "workflows:stopForProviderLimit",
    "workflows:reworkStage",
    "workflows:resolveMergeWithAi",
    "workflows:cancelRun",
    "workflows:inspectRunWork",
    "workflows:deleteRun",
    "workflows:archiveRun",
    "workflows:getEvidence",
    "workflows:startDiagnosis",
    "workflows:getRecommendation",
    "workflows:clearRecommendation",
    "workflows:recommendAgent",
    "connection:setSecret",
    "connection:hasSecret",
    "projects:discoverImports",
    "projects:validateImports",
    "projects:createFromImports",
    "settings:getMobileHostInfo",
    "settings:publishMobileAppearance",
    "settings:createMobilePairingInvitation",
    "settings:confirmMobilePairing",
    "settings:denyMobilePairing",
    "settings:revokeMobilePairedDevice",
    "settings:rotateMobileHostKey",
    "settings:clearSessionData",
    "settings:clearProjectWorkspaceBoardData",
    "update:getStatus",
    "update:check",
    "update:download",
    "update:installNow",
    "coordination:state",
    "coordination:recover",
    "coordination:stopService",
    "marketplace:getStatus",
    "marketplace:configure",
    "marketplace:setToken",
    "marketplace:listCatalog",
    "marketplace:listInstalled",
    "marketplace:listActiveAppearance",
    "marketplace:install",
    "marketplace:update",
    "marketplace:remove",
    "marketplace:checkForUpdates",
    "marketplace:setTrust",
    "deployments:evaluateCredentials",
    "deployments:publishArtifact",
    "deployments:listArtifacts",
    "deployments:listAllArtifacts",
    "deployments:getArtifact",
    "runs:start",
    "runs:stop",
    "runs:stopService",
    "runs:startService",
    "runs:restartService",
    "runs:status",
    "runs:reconcile",
    "runs:previewUrl",
    "runs:runVerification",
    "runs:diagnoseVerificationFailure",
    "taskDesigner:getState",
    "taskDesigner:setState",
    "taskDesigner:resolveIssue",
    "taskDesigner:recommendFlow",
    "taskDesigner:recommendBoardFlow",
    "taskDesigner:generateMasterPlan",
    "detachedChat:open",
    "detachedChat:close",
    "detachedChat:list",
    "browser:attach",
    "browser:setBounds",
    "browser:setVisible",
    "browser:navigate",
    "browser:back",
    "browser:forward",
    "browser:reload",
    "browser:getState",
    "ai:detectLocalRuntimes",
    "ai:getStatus",
    "ai:setApiKey",
    "ai:listProviderStatuses",
    "ai:probeProviderCapability",
    "ai:testMcpServer",
    "ai:codeIntelligence",
    "ai:getSemanticModelStatus",
    "ai:downloadSemanticModel",
    "ai:deleteSemanticModel",
    "ai:resetCodeIntelligence",
    "ai:installCliProvider",
    "ai:getLatestCliProviderVersion",
    "ai:listCliModelOptions",
    "ai:listApiModelOptions",
    "ai:setProviderApiKey",
    "ai:testProviderApiKey",
    "ai:resetProviderApiKeys",
    "ai:listProviderPresets",
    "ai:testCustomProvider",
    "ai:saveCustomProvider",
    "ai:removeCustomProvider",
    "ai:listSessions",
    "ai:getSession",
    "ai:listInterruptedSessions",
    "ai:resumeInterruptedSession",
    "ai:dismissInterruptedSessions",
    "ai:loadImagePreview",
    "ai:openHtmlArtifactPreview",
    "ai:artifactPageThumbnail",
    "ai:readArtifactText",
    "ai:saveArtifactToWorkspace",
    "ai:renameSession",
    "ai:assignSessionToProject",
    "ai:deleteSession",
    "ai:archiveSession",
    "ai:delegate",
    "ai:abort",
    "ai:continueSession",
    "ai:updateSessionModel",
    "ai:updateSessionReasoningEffort",
    "ai:updateSessionPermissionMode",
    "ai:updateSessionToolAccess",
    "ai:handoverSession",
    "ai:startConversation",
    "ai:sendConversationMessage",
    "ai:stopConversation",
    "ai:setConversationToolOwner",
    "ai:editHandoverBrief",
    "ai:removeWorktree",
    "ai:setWorktree",
    "ai:switchSessionMode",
    "ai:setAcpMode",
    "ai:respondToPermission",
    "ai:undoToolFileChange",
    "ai:listWorkflowPacks",
    "ai:getWorkflowAssignment",
    "ai:setWorkflowAssignment",
    "ai:startTicketReview",
    "ai:getTicketReview",
    "ai:localPeerReview",
    "ai:localPeerReviewFollowUp",
    "ai:getAnalysis",
    "ai:submitAnalysis",
    "ai:cancelAnalysis",
    "ai:setAnalysisConfirmed",
    "ai:clearAnalysis",
    "ai:startDelivery",
    "ai:decomposeFeature",
    "ai:startSubTaskDelivery",
    "ai:listMergeRequests",
    "ai:createMergeRequest",
    "ai:checkMergeRequestFeedback",
    "ai:evaluatePrompt",
    "ai:getFindingFeedback",
    "ai:reviewFinding",
    "ai:evaluateSession",
    "ai:getSessionFeedback",
    "ai:submitSessionFeedback",
    "ai:rewritePromptFromFeedback",
    "aiUsage:series",
    "aiUsage:compareLatestPeriod",
    "aiUsage:dashboardSummary",
    "aiUsage:listEvents",
    "aiUsage:providerSnapshot",
    "aiUsage:providerHistory",
    "aiUsage:providerSnapshots",
    "aiUsage:setProviderUsageKey",
    "aiUsage:alibabaConsoleStatus",
    "aiUsage:alibabaConsoleSignIn",
    "aiUsage:alibabaConsoleSignOut",
    "assistant:sessionTurn",
    "assistant:control",
    "assistant:cancelTurn",
    "assistant:retryParticipant",
    "assistant:resolveAttempt",
    "assistant:stageAttachments",
    "assistant:turn",
    "assistant:teamReview",
    "assistant:listChats",
    "assistant:getChat",
    "assistant:createChat",
    "assistant:saveChat",
    "assistant:renameChat",
    "assistant:archiveChat",
    "assistant:deleteChat",
    "assistant:submitTurn",
    "assistant:getConversation",
    "agentRuntime:list",
    "agentRuntime:refresh",
    "agentRuntime:start",
    "agentRuntime:stop",
    "agentRuntime:restart",
    "agentRuntime:roots",
    "agentRuntime:activateSkill",
    "agentRuntime:createAgent",
    "agentRuntime:createProfile",
    "agentRuntime:createSkill",
    "agentRuntime:previewImport",
    "agentRuntime:importItem",
    "agentRuntime:approveNativeProject",
    "agentRuntime:revealNative",
    "agentRuntime:copyNative",
    "gadgets:getBlocks",
    "gadgets:publish",
    "gadgets:publishFromText",
    "gadgets:submit",
    "gadgets:replay",
    "gadgets:revoke",
    "gadgets:clear",
    "preview:attach",
    "preview:setBounds",
    "preview:setVisible",
    "preview:open",
    "preview:captureDiagnostics",
];

fn issue_action(channel: &str) -> Option<&'static str> {
    match channel {
        "issue:create" => Some("Created"),
        "issue:update" => Some("Updated"),
        "issue:delete" => Some("Deleted"),
        "issue:transition" => Some("Status changed"),
        "issue:addComment" => Some("Comment added"),
        _ => None,
    }
}

/// The connection id argument of an issue write, by channel arity.
fn issue_connection<'a>(channel: &str, args: &'a [Value]) -> Option<&'a str> {
    let index = match channel {
        "issue:create" | "issue:delete" => 1,
        _ => 2,
    };
    args.get(index).and_then(Value::as_str).filter(|id| !id.trim().is_empty())
}

/// How many AI sessions are mid-turn, for the close guard.
pub fn running_session_count(dir: &std::path::Path) -> usize {
    acp_host::active_keys(dir).iter().filter(|key| acp_host::is_running(dir, key)).count()
}

/// All desktop metadata mutations, including settings writes sharing the same
/// JSON file, use one lock. Long-running PTY/AI/workflow commands do not hold it.
/// A reverse-call client whose frames the mobile host answers in this process.
pub fn in_process_calls(host: &HostContext) -> praxis_host::HostCallClient {
    mobile_host::in_process_calls(host)
}

pub struct Application {
    state: Mutex<ApplicationState>,
    plan_watchers: plan_watch::PlanWatchers,
    mobile: Arc<mobile_host::MobileHost>,
    webviews: webviews::WebviewManager,
    version: String,
}

#[derive(Default)]
struct ApplicationState {
    active_workspace: Option<String>,
    initialized: bool,
}

impl Application {
    pub fn register(host: &HostContext, version: &str) {
        // The Output tab backfills from this bus; the launch line proves the
        // ring buffer and `log:getRecent` end to end.
        let bus = log_bus::restart(&host.config().user_data_dir);
        // Persisted as well, so the next session sees where this one began.
        if !bus.recent().is_empty() {
            bus.append(host, "—— previous session above ——");
        }
        bus.append(host, &format!("[app] Praxis {version} started"));
        let application = Arc::new(Self {
            state: Mutex::new(ApplicationState::default()),
            plan_watchers: plan_watch::PlanWatchers::default(),
            mobile: mobile_host::MobileHost::new(host),
            webviews: webviews::WebviewManager::new(),
            version: version.into(),
        });
        // Queued turns resume at launch, before any window asks for the chat.
        let recovery_host = host.clone();
        std::thread::spawn(move || team_chat::recover_on_startup(&recovery_host));
        let activity_root = host.config().user_data_dir.clone();
        host.events().on_event(move |event| {
            if event.channel == "ai:sessionChanged" {
                if let Some(session) = &event.payload {
                    activity::observe_session(&activity_root, session);
                }
            }
        });
        // Retired runtime-pin add-ons are uninstalled before anything reads the agent catalog.
        if marketplace::has_retired_pins(&host.config().user_data_dir) {
            let reconcile_host = host.clone();
            std::thread::spawn(move || {
                marketplace::reconcile_installed_on_launch(&reconcile_host, &reconcile_host.config().user_data_dir);
            });
        }
        mobile_host::register_internal_channels(host, &application.mobile);
        application.mobile.init();
        for &channel in CHANNELS.iter().chain(std::iter::once(&"settings:set")) {
            let application = Arc::clone(&application);
            host.register_handler(channel, move |host, args| {
                application.dispatch(host, channel, args)
            });
        }
    }

    fn dispatch(&self, host: &HostContext, channel: &str, args: &[Value]) -> Result<Value> {
        // These stores are independent of the project catalog and publish writes
        // atomically. Reading saved conversations or appearance must neither heal
        // workspace files nor fail because another catalog writer holds its lock.
        // In particular, opening an old conversation must not rewrite user data.
        match channel {
            "ai:listSessions" | "ai:getSession" => {
                return ai::dispatch(host, &host.config().user_data_dir, channel, args);
            }
            // Launching only spawns, and an abort can take seconds: neither may hold the profile lock.
            _ if ai_delegate::CHANNELS.contains(&channel) => {
                if let Some(result) = ai_delegate::dispatch(host, &host.config().user_data_dir, channel, args) {
                    return result;
                }
            }
            // Ticket reviews launch an agent and gadget answers call back into the tracker, so
            // neither may hold the profile lock.
            _ if ai_review::CHANNELS.contains(&channel) => {
                if let Some(result) = ai_review::dispatch(host, &host.config().user_data_dir, channel, args) {
                    return result;
                }
            }
            _ if gadget_service::CHANNELS.contains(&channel) => {
                if let Some(result) = gadget_service::dispatch(host, &host.config().user_data_dir, channel, args) {
                    return result;
                }
            }
            _ if ai_session_ops::CHANNELS.contains(&channel) => {
                if let Some(result) = ai_session_ops::dispatch(host, &host.config().user_data_dir, channel, args) {
                    return result;
                }
            }
            _ if channel.starts_with("assistant:") => {
                return assistant::dispatch(host, &host.config().user_data_dir, channel, args);
            }
            // The runner behind these reads the board and starts workflow runs, which take the profile
            // lock themselves, so a handler holding it here would wait on its own callers.
            _ if channel.starts_with("scheduledRuns:") => {
                return scheduled_runs::dispatch(host, channel, args);
            }
            // Marketplace work is network- and disk-bound and never touches the project catalog,
            // so it must not hold the profile lock while a registry answers.
            _ if channel.starts_with("marketplace:") => {
                return marketplace::dispatch(host, &host.config().user_data_dir, channel, args);
            }
            _ => {}
        }
        let mut state = self.state.lock().map_err(failure)?;
        std::fs::create_dir_all(&host.config().user_data_dir).map_err(failure)?;
        let profile_lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(
                host.config()
                    .user_data_dir
                    .join("desktop-state.praxis.lock"),
            )
            .map_err(failure)?;
        // Wait briefly for the lock rather than failing on first contact. Another writer is
        // normally done in milliseconds, and spawning a host process elsewhere in this process
        // forks a copy of every open descriptor (including this lock's) until its `exec`, which
        // can keep a just-released lock held for an instant. A genuinely stuck writer still fails.
        let deadline = std::time::Instant::now() + LOCK_WAIT;
        loop {
            match profile_lock.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => {
                    return Err(failure(format!(
                        "Desktop profile is busy; retry after the other writer finishes: {error}"
                    )));
                }
            }
        }
        storage::recover(&host.config().user_data_dir)?;
        if channel == "settings:set" {
            if let Some(raw) = storage::read(&host.config().settings_path)? {
                let existing: Value = serde_json::from_str(&raw).map_err(failure)?;
                if !existing.is_object() {
                    return Err(failure(
                        "Settings must contain a JSON object; preserve the file before repairing it.",
                    ));
                }
            }
            let patch = args.first().cloned().unwrap_or_else(|| json!({}));
            let updated = host
                .settings()
                .write(&patch)
                .map_err(|error| RustRpcError {
                    code: "SETTINGS_WRITE_ERROR".into(),
                    message: error.to_string(),
                })?;
            host.git_service()
                .set_configured_executable(updated.git.executable_path.clone());
            let payload = serde_json::to_value(updated).map_err(failure)?;
            drop(state);
            drop(profile_lock);
            host.events()
                .emit("settings:changed", Some(payload.clone()));
            return Ok(payload);
        }
        let mut catalog =
            Catalog::load(&host.config().user_data_dir, &host.config().settings_path)?;
        let before = connections::list(&catalog);
        if matches!(channel, "activity:list" | "board:list" | "board:get" | "issue:list") {
            // Reading a board is what starts watching its plan folder.
            self.plan_watchers.ensure(host, &catalog.list(storage::PROJECTS));
        }
        if !state.initialized {
            projects::heal(&mut catalog)?;
        }
        if channel == "workspaces:setActive" {
            let id = match args.first() {
                None | Some(Value::Null) => None,
                Some(Value::String(id)) if id.is_empty() => None,
                Some(Value::String(id)) => Some(id.clone()),
                _ => return Err(failure("Workspace id must be a string.")),
            };
            if let Some(id) = &id {
                catalog.require(storage::WORKSPACES, id)?;
            }
            state.active_workspace = id;
            if catalog.is_dirty() {
                catalog.commit()?;
            }
            state.initialized = true;
            return Ok(Value::Null);
        }
        let result = if channel.starts_with("workspaces:") {
            workspaces::dispatch(&mut catalog, channel, args, &self.version)?
        } else if channel.starts_with("projects:") {
            projects::dispatch(&mut catalog, channel, args, &self.version)?
        } else if channel.starts_with("connection:") || channel.starts_with("folder:") {
            connections::dispatch(
                host,
                &mut catalog,
                channel,
                args,
                state.active_workspace.as_deref(),
            )?
        } else if channel.starts_with("boardPrefs:") {
            board_prefs::dispatch(&host.config().user_data_dir, channel, args)?
        } else if channel == "log:getRecent" {
            log_bus::shared(&host.config().user_data_dir).dispatch(channel, args)?
        } else if channel.starts_with("activity:") {
            activity::dispatch(
                host,
                &mut catalog,
                &host.config().user_data_dir,
                channel,
                args,
            )?
        } else if channel.starts_with("notes:") {
            notes::dispatch(host, &catalog, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("artifacts:") {
            artifacts::dispatch(host, &catalog, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("scheduledRuns:") {
            scheduled_runs::dispatch(host, channel, args)?
        } else if channel.starts_with("workflows:") {
            workflows::dispatch(host, channel, args)?
        } else if let Some(result) = matches!(
            channel,
            "settings:getMobileHostInfo"
                | "settings:createMobilePairingInvitation"
                | "settings:confirmMobilePairing"
                | "settings:denyMobilePairing"
                | "settings:revokeMobilePairedDevice"
                | "settings:rotateMobileHostKey"
        )
        .then(|| self.mobile.dispatch(channel, args, catalog.list(storage::PROJECTS)))
        .flatten()
        {
            result?
        } else if channel.starts_with("settings:")
            || channel.starts_with("update:")
            || channel.starts_with("coordination:")
        {
            system::dispatch(
                host,
                &mut catalog,
                &host.config().user_data_dir,
                channel,
                args,
            )?
        } else if channel.starts_with("marketplace:") {
            marketplace::dispatch(host, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("deployments:") {
            deployments::dispatch(host, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("runs:") {
            runs::dispatch(host, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("taskDesigner:") {
            task_designer::dispatch(host, &mut catalog, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("browser:")
            || channel.starts_with("preview:")
            || channel.starts_with("detachedChat:")
        {
            self.webviews.dispatch(host, channel, args)?
        } else if channel.starts_with("aiUsage:") {
            ai_usage::dispatch(host, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("assistant:") {
            assistant::dispatch(host, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("agentRuntime:") {
            agent_runtime::dispatch(host, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("ai:") {
            ai::dispatch(host, &host.config().user_data_dir, channel, args)?
        } else if let Some(action) = issue_action(channel) {
            // Observe the service boundary: every write to a project's board is recorded.
            let existing = if channel == "issue:create" {
                None
            } else {
                let mut probe = vec![args.first().cloned().unwrap_or(Value::Null)];
                if let Some(connection) = issue_connection(channel, args) {
                    probe.push(json!(connection));
                }
                boards::dispatch(host, &mut catalog, "issue:get", &probe).ok()
            };
            let result = boards::dispatch(host, &mut catalog, channel, args)?;
            let issue = if channel == "issue:create" { Some(&result) } else { existing.as_ref() };
            if let (Some(issue), Some(connection_id)) = (issue, issue_connection(channel, args)) {
                let projects: Vec<Value> = catalog
                    .list(storage::PROJECTS)
                    .into_iter()
                    .filter(|project| {
                        project["id"].as_str().is_some_and(|id| {
                            connection_id == format!("project:{id}")
                                || project["linkedBoards"].as_array().is_some_and(|links| {
                                    links.iter().any(|link| link["connectionId"] == connection_id)
                                })
                        })
                    })
                    .collect();
                for project in &projects {
                    activity::record(
                        &host.config().user_data_dir,
                        &activity::Observation {
                            project_id: project["id"].as_str().unwrap_or(""),
                            kind: "issue",
                            target_key: issue["key"].as_str().unwrap_or(""),
                            summary: issue["summary"].as_str().unwrap_or(""),
                            action,
                            connection_id: Some(connection_id),
                            actor: activity::current_actor(),
                        },
                    );
                }
            }
            result
        } else {
            boards::dispatch(host, &mut catalog, channel, args)?
        };
        let mutation = matches!(
            channel,
            "workspaces:create"
                | "workspaces:update"
                | "workspaces:remove"
                | "workspaces:openFolder"
                | "workspaces:openFile"
                | "workspaces:writeFile"
                | "projects:create"
                | "projects:update"
                | "projects:remove"
                | "projects:useExisting"
                | "projects:attachFolder"
                | "projects:linkBoard"
                | "projects:unlinkBoard"
                | "projects:createFromImports"
                | "connection:add"
                | "connection:update"
                | "connection:remove"
                | "connection:addTrackedBoards"
                | "connection:removeTrackedBoard"
                | "connection:updateTrackedBoard"
                | "issue:create"
                | "issue:update"
                | "issue:delete"
                | "issue:transition"
                | "issue:addComment"
        );
        let after = connections::list(&catalog);
        let persisted = catalog.is_dirty();
        if mutation || persisted {
            catalog.commit()?;
        }
        if channel == "workspaces:remove"
            && state.active_workspace.as_deref() == args.first().and_then(Value::as_str)
        {
            state.active_workspace = None;
        }
        state.initialized = !matches!(channel, "workspaces:openFile" | "workspaces:openFolder");
        // Release the file lock before the in-process mutex. A caller waiting on the mutex
        // proceeds straight to `try_lock`; if the mutex went first it would find the file lock
        // still held and fail with "profile is busy" against our own previous call.
        drop(profile_lock);
        drop(state);
        if mutation || persisted {
            let mut changed = std::collections::BTreeSet::new();
            for connection in before.iter().chain(after.iter()) {
                if let Some(id) = connection["id"].as_str()
                    && before.iter().find(|value| value["id"] == id)
                        != after.iter().find(|value| value["id"] == id)
                {
                    changed.insert(id.to_owned());
                }
            }
            if channel.starts_with("issue:")
                && let Some(id) = args.last().and_then(Value::as_str)
            {
                changed.insert(id.to_owned());
            }
            for id in changed {
                host.events().emit("board:changed", Some(json!(id)));
            }
            if channel == "connection:remove" {
                let prefix = format!("praxis.connection.{}.", text(args, 0)?);
                for key in host.secrets().keys() {
                    if key.starts_with(&prefix) {
                        host.secrets().delete(&key);
                    }
                }
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests;
