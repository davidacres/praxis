//! Rust desktop application adapters: ownership, stores and portable workspaces.
mod activity;
mod agent_runtime;
mod ai;
mod acp_host;
mod api_host;
mod ai_delegate;
mod ai_models;
mod session_store;
mod ai_providers;
mod ai_usage;
mod artifacts;
mod assistant;
mod board_prefs;
mod boards;
mod connections;
mod deployments;
mod gadgets;
mod log_bus;
mod marketplace;
mod notes;
mod projects;
pub(crate) mod runtime;
mod runs;
mod scheduled_runs;
pub(crate) mod storage;
mod system;
mod task_designer;
mod webviews;
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

/// All desktop metadata mutations, including settings writes sharing the same
/// JSON file, use one lock. Long-running PTY/AI/workflow commands do not hold it.
pub struct Application {
    state: Mutex<ApplicationState>,
    log_bus: Mutex<Option<log_bus::LogBus>>,
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
        let bus = log_bus::LogBus::new(&host.config().user_data_dir);
        // Persisted as well, so the next session sees where this one began.
        if !bus.recent().is_empty() {
            bus.append(host, "—— previous session above ——");
        }
        bus.append(host, &format!("[app] Praxis {version} started"));
        let application = Arc::new(Self {
            state: Mutex::new(ApplicationState::default()),
            log_bus: Mutex::new(Some(bus)),
            webviews: webviews::WebviewManager::new(),
            version: version.into(),
        });
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
            "assistant:listChats" | "assistant:getChat" | "assistant:getConversation" => {
                return assistant::dispatch(host, &host.config().user_data_dir, channel, args);
            }
            "marketplace:listActiveAppearance" => {
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
            let mut bus_guard = self.log_bus.lock().map_err(failure)?;
            let bus =
                bus_guard.get_or_insert_with(|| log_bus::LogBus::new(&host.config().user_data_dir));
            bus.dispatch(channel, args)?
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
            task_designer::dispatch(&host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("browser:")
            || channel.starts_with("preview:")
            || channel.starts_with("detachedChat:")
        {
            self.webviews.dispatch(host, channel, args)?
        } else if channel.starts_with("gadgets:") {
            gadgets::dispatch(host, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("aiUsage:") {
            ai_usage::dispatch(host, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("assistant:") {
            assistant::dispatch(host, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("agentRuntime:") {
            agent_runtime::dispatch(host, &host.config().user_data_dir, channel, args)?
        } else if channel.starts_with("ai:") {
            ai::dispatch(host, &host.config().user_data_dir, channel, args)?
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
