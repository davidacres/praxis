//! Between-turn session operations that launch or wait on agents, so they run outside the profile
//! lock: changing a session's model, handing it to another provider, and the opt-in multi-AI
//! conversation. Ports the matching handlers of Electron's `aiIpc.ts`.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use praxis_ai::providers::registry::built_in_descriptors;
use praxis_host::HostContext;
use serde_json::{Value, json};

use super::acp_host;
use super::session_handover as handover;
use super::session_store::{stamp_reasoning, store};
use super::{Result, failure, now, text};

pub const CHANNELS: [&str; 14] = [
    "ai:loadImagePreview",
    "ai:readArtifactText",
    "ai:removeWorktree",
    "ai:setWorktree",
    "ai:updateSessionModel",
    "ai:updateSessionReasoningEffort",
    "ai:updateSessionPermissionMode",
    "ai:handoverSession",
    "ai:editHandoverBrief",
    "ai:switchSessionMode",
    "ai:startConversation",
    "ai:sendConversationMessage",
    "ai:stopConversation",
    "ai:setConversationToolOwner",
];

fn no_session(key: &str) -> praxis_contracts::RustRpcError {
    failure(format!("No agent session found for {key}."))
}

fn changed(host: &HostContext, record: &Value) {
    host.events()
        .emit("ai:sessionChanged", Some(stamp_reasoning(record.clone())));
}

/// The label of a provider (built in or a saved custom endpoint), or `None` when it is unknown.
fn provider_label(host: &HostContext, provider: &str) -> Option<String> {
    built_in_descriptors()
        .into_iter()
        .find(|d| d.id == provider)
        .map(|d| d.label)
        .or_else(|| {
            host.settings()
                .read()
                .ai
                .custom_providers
                .iter()
                .flatten()
                .find(|c| c.id == provider)
                .and_then(|c| serde_json::to_value(c).ok())
                .map(|c| c["label"].as_str().unwrap_or(provider).to_owned())
        })
}

/// A saved endpoint that did not pass tool calling cannot run agent sessions.
fn assert_can_run(host: &HostContext, provider: &str) -> Result<()> {
    let custom = host
        .settings()
        .read()
        .ai
        .custom_providers
        .iter()
        .flatten()
        .find(|c| c.id == provider)
        .and_then(|c| serde_json::to_value(c).ok());
    if let Some(custom) = custom
        && !custom["capabilities"].is_null()
        && custom["capabilities"]["tools"] != true
    {
        return Err(failure(format!(
            "{} didn't pass tool calling, which agent sessions need. Run its connection test in Settings → AI Provider after changing the model or server.",
            custom["label"].as_str().unwrap_or(provider)
        )));
    }
    Ok(())
}

fn update_model(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let key = text(args, 0)?;
    let model = text(args, 1)?.trim().to_owned();
    if model.is_empty() {
        return Err(failure("Choose a model."));
    }
    let sessions = store(dir);
    let record = sessions.get(key)?.ok_or_else(|| no_session(key))?;
    if acp_host::has_active_task(dir, key) {
        return Err(failure(
            "Wait for the session to finish this turn before changing model.",
        ));
    }
    let provider = record["provider"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| host.settings().read().ai.active_provider.clone());
    super::ai_models::assert_model_available(host, &provider, &model)?;
    if record["model"] == model {
        return Ok(stamp_reasoning(record));
    }
    let cli = built_in_descriptors().into_iter().any(|d| {
        d.id == provider && d.kind == praxis_ai::providers::registry::DescriptorKind::CliAgent
    });
    let detail = record["model"]
        .as_str()
        .map(|previous| format!("Previous model: {previous}"));
    let mut outcome = Ok(());
    let updated = sessions.mutate(key, true, |r| {
        outcome = handover::transition_runtime(
            r,
            Some(&provider),
            Some(&model),
            "model_change",
            cli,
            &format!("Model changed to {model}"),
            detail.as_deref(),
        )
    })?;
    outcome?;
    let updated = updated.ok_or_else(|| no_session(key))?;
    host.events()
        .emit("ai:sessionChanged", Some(updated.clone()));
    Ok(updated)
}

fn update_reasoning(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let key = text(args, 0)?;
    let effort = text(args, 1)?.to_owned();
    let sessions = store(dir);
    let record = sessions.get(key)?.ok_or_else(|| no_session(key))?;
    if acp_host::has_active_task(dir, key) {
        return Err(failure(
            "Wait for the session to finish this turn before changing reasoning effort.",
        ));
    }
    handover::assert_can_change_runtime(&record)?;
    let updated = sessions
        .mutate(key, true, |r| r["reasoningEffort"] = json!(effort))?
        .ok_or_else(|| no_session(key))?;
    host.events()
        .emit("ai:sessionChanged", Some(updated.clone()));
    Ok(updated)
}

fn update_permission_mode(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let key = text(args, 0)?;
    let mode = text(args, 1)?.to_owned();
    if acp_host::has_active_task(dir, key) {
        return Err(failure(
            "Wait for the current session turn to finish before changing permission mode.",
        ));
    }
    let sessions = store(dir);
    let updated = sessions
        .mutate(key, true, |r| {
            r["permissionMode"] = json!(mode);
            r["autoApprovePermissions"] = json!(matches!(mode.as_str(), "bypass" | "autopilot"));
        })?
        .ok_or_else(|| no_session(key))?;
    host.events()
        .emit("ai:sessionChanged", Some(updated.clone()));
    Ok(updated)
}

fn edit_brief(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let key = text(args, 0)?;
    let expected = args.get(1).and_then(Value::as_u64).unwrap_or(u64::MAX);
    let edits = args.get(2).cloned().unwrap_or(Value::Null);
    let sessions = store(dir);
    let record = sessions.get(key)?.ok_or_else(|| no_session(key))?;
    let previous = if record["handoverBrief"].is_object() {
        record["handoverBrief"].clone()
    } else {
        handover::empty_brief(&now())
    };
    let brief = handover::apply_user_edits(&previous, expected, &edits)?;
    let updated = sessions
        .mutate(key, true, |r| r["handoverBrief"] = brief)?
        .ok_or_else(|| no_session(key))?;
    host.events()
        .emit("ai:sessionChanged", Some(updated.clone()));
    Ok(updated)
}

fn handover_session(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    handover_to(
        host,
        dir,
        text(args, 0)?,
        args.get(1).cloned().unwrap_or(Value::Null),
    )
}

/// Hands a session to another provider: refresh its brief, snapshot what the work stands on, validate the
/// handover, record the runtime change and continue the session there (`handoverSession`).
pub(super) fn handover_to(
    host: &HostContext,
    dir: &Path,
    key: &str,
    input: Value,
) -> Result<Value> {
    let sessions = store(dir);
    let record = sessions.get(key)?.ok_or_else(|| no_session(key))?;
    if acp_host::has_active_task(dir, key) {
        return Err(failure(
            "Wait for the session to finish this turn before handing over.",
        ));
    }
    let target = input["provider"].as_str().unwrap_or_default().to_owned();
    let label = provider_label(host, &target).ok_or_else(|| failure("Unknown provider."))?;
    assert_can_run(host, &target)?;
    let model = input["model"]
        .as_str()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned);
    if let Some(model) = &model {
        super::ai_models::assert_model_available(host, &target, model)?;
    }
    handover::assert_can_change_runtime(&record)?;
    if input["briefEdits"].is_object() {
        let previous = if record["handoverBrief"].is_object() {
            record["handoverBrief"].clone()
        } else {
            handover::empty_brief(&now())
        };
        let edited = handover::apply_user_edits(
            &previous,
            input["expectedBriefRevision"].as_u64().unwrap_or(u64::MAX),
            &input["briefEdits"],
        )?;
        sessions.mutate(key, true, |r| r["handoverBrief"] = edited)?;
    }
    // The brief is refreshed from the session so the next AI starts from its current state.
    let current = sessions.get(key)?.ok_or_else(|| no_session(key))?;
    let refreshed = handover::refreshed_brief(&current);
    sessions.mutate(key, true, |r| r["handoverBrief"] = refreshed)?;
    let current = sessions.get(key)?.ok_or_else(|| no_session(key))?;
    // What the work stands on (commit, files, dependencies), taken now and persisted as evidence.
    let (snapshot, manifest, head) =
        super::context_snapshot::take_snapshot(&current, &host.config().user_data_dir, &now());
    let text_for_next = handover::envelope_text(&current, Some(&snapshot));
    let purpose = if current["purpose"].is_object() {
        current["purpose"].clone()
    } else {
        handover::purpose_from_task(&current["taskDefinition"], key, current["title"].as_str())
    };
    let blocking: Vec<String> = super::context_snapshot::validate_handover(
        &purpose,
        &current["handoverBrief"],
        &text_for_next,
        Some(&snapshot),
        key,
        head.as_deref(),
    )
    .into_iter()
    .filter_map(|(blocks, message)| blocks.then_some(message))
    .collect();
    if !blocking.is_empty() {
        return Err(failure(format!("Handover blocked: {}", blocking.join(" "))));
    }
    let detail = match &manifest {
        Some(m) => format!(
            "{text_for_next}\n\nContext snapshot {} ({} files, {} left out) saved to {}",
            m["fingerprint"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(12)
                .collect::<String>(),
            m["included"],
            m["excluded"],
            m["path"].as_str().unwrap_or_default()
        ),
        None => text_for_next.clone(),
    };
    let mut outcome = Ok(());
    let summary = format!(
        "Handed over to {label}{}",
        model
            .as_deref()
            .map(|m| format!(" ({m})"))
            .unwrap_or_default()
    );
    let updated = sessions.mutate(key, true, |r| {
        outcome = handover::transition_runtime(
            r,
            Some(&target),
            model.as_deref(),
            "provider_handover",
            true,
            &summary,
            Some(&detail),
        )
    })?;
    outcome?;
    if let Some(updated) = updated {
        host.events().emit("ai:sessionChanged", Some(updated));
    }
    super::ai_delegate::continue_with(host, dir, &[json!(key), json!(text_for_next)], false, None)?;
    sessions
        .get(key)?
        .map(stamp_reasoning)
        .ok_or_else(|| no_session(key))
}

fn switch_mode(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let key = text(args, 0)?;
    let mode = text(args, 1)?.to_owned();
    if !matches!(mode.as_str(), "chat" | "analysis" | "review") {
        return Err(failure("Invalid session mode."));
    }
    let sessions = store(dir);
    let record = sessions.get(key)?.ok_or_else(|| no_session(key))?;
    if !matches!(
        record["state"].as_str(),
        Some("completed" | "failed" | "aborted")
    ) {
        return Err(failure(
            "Wait for the current session turn to finish before switching mode.",
        ));
    }
    let updated = sessions
        .mutate(key, true, |r| {
            r["mode"] = json!(mode);
            if r["taskDefinition"].is_object() {
                r["taskDefinition"]["sessionMode"] = json!(mode);
            }
        })?
        .ok_or_else(|| no_session(key))?;
    host.events().emit("ai:sessionChanged", Some(updated));
    Ok(Value::Null)
}

// ── multi-AI conversation ────────────────────────────────────────────────

fn starting() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(Default::default)
}

fn label_of(provider: &str, model: Option<&str>) -> String {
    format!(
        "{provider}{}",
        model.map(|m| format!(" · {m}")).unwrap_or_default()
    )
}

fn start_conversation(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let key = text(args, 0)?;
    let input = args.get(1).cloned().unwrap_or(Value::Null);
    let mode = input["mode"].as_str().unwrap_or_default().to_owned();
    if !matches!(mode.as_str(), "consult" | "debate" | "pair") {
        return Err(failure("Choose a conversation mode."));
    }
    let guest_provider = input["provider"].as_str().unwrap_or_default().to_owned();
    if provider_label(host, &guest_provider).is_none() {
        return Err(failure("Choose a valid second AI provider."));
    }
    assert_can_run(host, &guest_provider)?;
    let sessions = store(dir);
    let record = sessions.get(key)?.ok_or_else(|| no_session(key))?;
    if acp_host::has_active_task(dir, key) {
        return Err(failure(
            "Wait for the current session turn to finish before bringing in another AI.",
        ));
    }
    let model = input["model"]
        .as_str()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned);
    if let Some(model) = &model {
        super::ai_models::assert_model_available(host, &guest_provider, model)?;
    }
    handover::assert_can_change_runtime(&record)?;
    let host_provider = record["provider"]
        .as_str()
        .ok_or_else(|| failure("This session has no provider to invite another AI into."))?
        .to_owned();
    if record["conversation"]["state"] == "running" {
        return Err(failure("A multi-AI conversation is already running."));
    }
    let turn_cap = input["turnCap"]
        .as_f64()
        .map(|n| n.floor().clamp(1.0, 20.0) as u64)
        .ok_or_else(|| failure("Choose a valid conversation turn cap."))?;
    let host_model = record["model"]
        .as_str()
        .filter(|m| !m.is_empty())
        .map(str::to_owned);
    let mut host_participant = json!({ "id": "host", "provider": host_provider, "role": "host", "displayLabel": label_of(&host_provider, host_model.as_deref()) });
    if let Some(m) = &host_model {
        host_participant["model"] = json!(m);
    }
    let mut guest = json!({ "id": "guest", "provider": guest_provider, "role": "guest", "displayLabel": label_of(&guest_provider, model.as_deref()) });
    if let Some(m) = &model {
        guest["model"] = json!(m);
    }
    if host_provider == guest_provider && host_model == model {
        return Err(failure(
            "Choose a different provider or model for the second AI.",
        ));
    }
    let conversation = json!({
        "mode": mode, "participants": [host_participant, guest], "currentSpeakerId": "guest", "toolOwnerId": "host",
        "originalToolMode": record["toolMode"].as_str().unwrap_or("full"), "turnCap": turn_cap, "turnsUsed": 0, "state": "running",
    });
    let summary = format!(
        "Started {mode} conversation with {}",
        label_of(&guest_provider, model.as_deref())
    );
    let updated = sessions
        .mutate(key, true, |r| {
            r["conversation"] = conversation;
            let mut events = r["events"].as_array().cloned().unwrap_or_default();
            events.push(
                json!({ "timestamp": now(), "type": "conversation_turn", "summary": summary }),
            );
            r["eventCount"] = json!(events.len());
            r["events"] = json!(events);
        })?
        .ok_or_else(|| no_session(key))?;
    host.events()
        .emit("ai:sessionChanged", Some(updated.clone()));
    queue_turn(host, dir, key);
    Ok(updated)
}

fn send_message(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let key = text(args, 0)?;
    let input = args.get(1).cloned().unwrap_or(Value::Null);
    let message = input["message"]
        .as_str()
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    let images = super::ai_delegate::sanitize_images(input.get("images").unwrap_or(&Value::Null));
    if message.is_empty() && images.is_empty() {
        return Err(failure("Enter a message for the AI conversation."));
    }
    let sessions = store(dir);
    let record = sessions.get(key)?;
    let running = record
        .as_ref()
        .is_some_and(|r| r["conversation"]["state"] == "running");
    if !running {
        return Err(failure("No running multi-AI conversation."));
    }
    let participant = input["participantId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let known = record.as_ref().is_some_and(|r| {
        r["conversation"]["participants"]
            .as_array()
            .is_some_and(|p| p.iter().any(|x| x["id"] == participant))
    });
    if !known {
        return Err(failure("Unknown conversation participant."));
    }
    let mut pending = json!({ "participantId": participant, "message": message });
    if !images.is_empty() {
        pending["images"] = json!(images);
    }
    let updated = sessions
        .mutate(key, true, |r| {
            let mut queue = r["conversation"]["pendingUserMessages"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            queue.push(pending);
            r["conversation"]["pendingUserMessages"] = json!(queue);
        })?
        .ok_or_else(|| no_session(key))?;
    host.events().emit("ai:sessionChanged", Some(updated));
    let gate = format!("{}\u{0}{key}", dir.display());
    if !acp_host::has_active_task(dir, key)
        && !starting().lock().is_ok_and(|set| set.contains(&gate))
    {
        if let Some((participant, message, images)) = take_pending(host, dir, key) {
            set_speaker(host, dir, key, &participant);
            run_turn_in_background(host, dir, key, Some((message, images)));
        }
    }
    sessions
        .get(key)?
        .map(stamp_reasoning)
        .ok_or_else(|| no_session(key))
}

/// The queued human message, if any, for the next turn.
fn take_pending(host: &HostContext, dir: &Path, key: &str) -> Option<(String, String, Vec<Value>)> {
    let mut taken = None;
    let updated = store(dir)
        .mutate(key, true, |r| {
            let queue = r["conversation"]["pendingUserMessages"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if let Some(first) = queue.first() {
                taken = Some((
                    first["participantId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    first["message"].as_str().unwrap_or_default().to_owned(),
                    first["images"].as_array().cloned().unwrap_or_default(),
                ));
                let rest: Vec<Value> = queue.into_iter().skip(1).collect();
                if rest.is_empty() {
                    r["conversation"]
                        .as_object_mut()
                        .map(|o| o.remove("pendingUserMessages"));
                } else {
                    r["conversation"]["pendingUserMessages"] = json!(rest);
                }
            }
        })
        .ok()
        .flatten();
    if taken.is_some()
        && let Some(updated) = updated
    {
        host.events().emit("ai:sessionChanged", Some(updated));
    }
    taken
}

fn set_speaker(host: &HostContext, dir: &Path, key: &str, participant: &str) {
    if let Ok(Some(updated)) = store(dir).mutate(key, true, |r| {
        r["conversation"]["currentSpeakerId"] = json!(participant)
    }) {
        host.events().emit("ai:sessionChanged", Some(updated));
    }
}

/// Stops a conversation between turns and restores the tool owner as the single-agent runtime.
fn finish(host: &HostContext, dir: &Path, key: &str, state: &str) -> Option<Value> {
    let cap = store(dir)
        .get(key)
        .ok()
        .flatten()
        .map(|r| r["conversation"]["turnCap"].clone())
        .unwrap_or(Value::Null);
    let summary = match state {
        "capped" => format!("Conversation stopped at its {cap}-turn cap."),
        "failed" => "Conversation stopped after a provider failure.".to_owned(),
        _ => "Conversation stopped by you.".to_owned(),
    };
    let updated = store(dir)
        .mutate(key, true, |r| {
            r["conversation"]["state"] = json!(state);
            let owner = r["conversation"]["participants"]
                .as_array()
                .and_then(|p| {
                    p.iter()
                        .find(|x| x["id"] == r["conversation"]["toolOwnerId"])
                        .or_else(|| p.first())
                })
                .cloned()
                .unwrap_or(Value::Null);
            r["provider"] = owner["provider"].clone();
            match owner["model"].as_str() {
                Some(m) => r["model"] = json!(m),
                None => {
                    r.as_object_mut().map(|o| o.remove("model"));
                }
            }
            r["toolMode"] = r["conversation"]["originalToolMode"].clone();
            let mut events = r["events"].as_array().cloned().unwrap_or_default();
            events.push(
                json!({ "timestamp": now(), "type": "conversation_turn", "summary": summary }),
            );
            r["eventCount"] = json!(events.len());
            r["events"] = json!(events);
        })
        .ok()
        .flatten();
    if let Some(updated) = &updated {
        host.events()
            .emit("ai:sessionChanged", Some(updated.clone()));
    }
    updated
}

fn conversation_prompt(record: &Value) -> String {
    let conversation = &record["conversation"];
    let participants = conversation["participants"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let speaker = participants
        .iter()
        .find(|p| p["id"] == conversation["currentSpeakerId"])
        .cloned()
        .unwrap_or(Value::Null);
    let other = participants
        .iter()
        .find(|p| p["id"] != speaker["id"])
        .cloned()
        .unwrap_or(Value::Null);
    // The envelope is built from the other participant so the prompt never tells an AI it is
    // taking over from itself.
    let mut from_other = record.clone();
    from_other["provider"] = other["provider"].clone();
    from_other["model"] = other["model"].clone();
    let envelope = handover::envelope_text(&from_other, None);
    let access = if record["toolMode"] == "full" {
        "You currently hold the only write-capable tool access. Do not act concurrently with the other AI."
    } else {
        "You are read-only for this turn. Do not write files, execute commands, or mutate external systems."
    };
    [
        format!(
            "You are {}, participating in a bounded Praxis {} conversation.",
            speaker["displayLabel"].as_str().unwrap_or_default(),
            conversation["mode"].as_str().unwrap_or_default()
        ),
        format!(
            "Address {} and the human directly. This is AI turn {} of {}.",
            other["displayLabel"].as_str().unwrap_or_default(),
            conversation["turnsUsed"].as_u64().unwrap_or(0) + 1,
            conversation["turnCap"]
        ),
        access.to_owned(),
        "Give one concise, self-contained response, then stop so Praxis can yield to the other AI."
            .to_owned(),
        String::new(),
        envelope,
    ]
    .join("\n")
}

fn queue_turn(host: &HostContext, dir: &Path, key: &str) {
    run_turn_in_background(host, dir, key, None);
}

/// Runs one turn on a worker thread, then settles the conversation once the agent is done.
fn run_turn_in_background(
    host: &HostContext,
    dir: &Path,
    key: &str,
    human: Option<(String, Vec<Value>)>,
) {
    let (host, dir, key) = (host.clone(), dir.to_path_buf(), key.to_owned());
    std::thread::spawn(move || {
        let _ = run_turn(&host, &dir, &key, human);
    });
}

fn run_turn(
    host: &HostContext,
    dir: &Path,
    key: &str,
    human: Option<(String, Vec<Value>)>,
) -> Result<()> {
    let sessions = store(dir);
    let gate = format!("{}\u{0}{key}", dir.display());
    if starting().lock().is_ok_and(|set| set.contains(&gate)) {
        return Ok(());
    }
    let running = |r: &Option<Value>| {
        r.as_ref()
            .is_some_and(|r| r["conversation"]["state"] == "running")
    };
    if !running(&sessions.get(key)?) {
        return Ok(());
    }
    if acp_host::has_active_task(dir, key) {
        std::thread::sleep(Duration::from_millis(25));
        return run_turn(host, dir, key, human);
    }
    if let Ok(mut set) = starting().lock() {
        set.insert(gate.clone());
    }
    let outcome = launch_turn(host, dir, key, human.as_ref());
    if let Ok(mut set) = starting().lock() {
        set.remove(&gate);
    }
    match outcome {
        Ok(true) => settle_when_done(host, dir, key),
        Ok(false) => {}
        Err(error) => {
            let message = error.message;
            let limit =
                praxis_ai::providers::provider_limit_error::is_provider_limit_error(&message);
            let notice = if limit {
                praxis_ai::providers::provider_limit_error::extract_provider_limit_message(&message)
                    .unwrap_or(message.clone())
            } else {
                message
            };
            if running(&sessions.get(key)?) {
                finish(host, dir, key, "failed");
                if let Ok(Some(updated)) = sessions.mutate(key, true, |r| {
                    r["state"] = json!("failed");
                    r["lastError"] = json!(notice);
                    let mut events = r["events"].as_array().cloned().unwrap_or_default();
                    events.push(json!({ "timestamp": now(), "type": "error", "summary": notice }));
                    r["eventCount"] = json!(events.len());
                    r["events"] = json!(events);
                }) {
                    host.events().emit("ai:sessionChanged", Some(updated));
                }
            }
        }
    }
    Ok(())
}

/// Starts one turn. Returns whether an agent is now running.
fn launch_turn(
    host: &HostContext,
    dir: &Path,
    key: &str,
    human: Option<&(String, Vec<Value>)>,
) -> Result<bool> {
    let sessions = store(dir);
    let record = sessions.get(key)?.ok_or_else(|| no_session(key))?;
    let conversation = &record["conversation"];
    if conversation["turnsUsed"].as_u64().unwrap_or(0)
        >= conversation["turnCap"].as_u64().unwrap_or(0)
    {
        finish(host, dir, key, "capped");
        return Ok(false);
    }
    let speaker = conversation["participants"]
        .as_array()
        .and_then(|p| {
            p.iter()
                .find(|x| x["id"] == conversation["currentSpeakerId"])
        })
        .cloned()
        .ok_or_else(|| failure("The current conversation speaker is missing."))?;
    let tool_mode =
        if conversation["mode"] == "pair" && conversation["toolOwnerId"] == speaker["id"] {
            "full"
        } else {
            "read-only"
        };
    let mut outcome = Ok(());
    let label = speaker["displayLabel"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let prepared = sessions.mutate(key, true, |r| {
        r["toolMode"] = json!(tool_mode);
        outcome = handover::transition_runtime(
            r,
            speaker["provider"].as_str(),
            speaker["model"].as_str(),
            "conversation_turn",
            true,
            &format!("{label}'s conversation turn"),
            None,
        );
    })?;
    outcome?;
    let prepared = prepared.ok_or_else(|| no_session(key))?;
    host.events()
        .emit("ai:sessionChanged", Some(prepared.clone()));
    let context = conversation_prompt(&prepared);
    let (message, images) = human.map_or_else(
        || ("Continue the conversation.".to_owned(), Vec::new()),
        |(m, i)| (m.clone(), i.clone()),
    );
    super::ai_delegate::continue_with(
        host,
        dir,
        &[json!(key), json!(message), json!(images)],
        human.is_none(),
        Some(&context),
    )?;
    Ok(true)
}

/// Once the agent finishes, counts the turn and schedules whoever speaks next.
fn settle_when_done(host: &HostContext, dir: &Path, key: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(3 * 60 * 60);
    while acp_host::has_active_task(dir, key) && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    let sessions = store(dir);
    let Ok(Some(record)) = sessions.get(key) else {
        return;
    };
    if record["conversation"]["state"] != "running" {
        return;
    }
    match record["state"].as_str() {
        Some("completed") => {
            let pending = take_pending(host, dir, key);
            let used = record["conversation"]["turnsUsed"].as_u64().unwrap_or(0) + 1;
            let cap = record["conversation"]["turnCap"].as_u64().unwrap_or(0);
            if used >= cap {
                let _ =
                    sessions.mutate(key, true, |r| r["conversation"]["turnsUsed"] = json!(used));
                finish(host, dir, key, "capped");
                return;
            }
            if let Ok(Some(updated)) = sessions.mutate(key, true, |r| {
                r["conversation"]["turnsUsed"] = json!(used);
                let next = r["conversation"]["participants"]
                    .as_array()
                    .and_then(|p| {
                        p.iter()
                            .find(|x| x["id"] != r["conversation"]["currentSpeakerId"])
                    })
                    .map(|x| x["id"].clone());
                if let Some(next) = next {
                    r["conversation"]["currentSpeakerId"] = next;
                }
            }) {
                host.events().emit("ai:sessionChanged", Some(updated));
            }
            match pending {
                Some((participant, message, images)) => {
                    set_speaker(host, dir, key, &participant);
                    let _ = run_turn(host, dir, key, Some((message, images)));
                }
                None => {
                    let _ = run_turn(host, dir, key, None);
                }
            }
        }
        Some("failed" | "aborted") => {
            finish(host, dir, key, "failed");
        }
        _ => {}
    }
}

fn stop_conversation(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let key = text(args, 0)?;
    let running = store(dir)
        .get(key)?
        .is_some_and(|r| r["conversation"]["state"] == "running");
    if !running {
        return Err(failure("No multi-AI conversation is running."));
    }
    // Marked stopped before the host is cancelled, so cleanup never schedules one more turn.
    let stopped = finish(host, dir, key, "stopped");
    acp_host::abort_task(host, dir, key);
    Ok(stopped.map(stamp_reasoning).unwrap_or(Value::Null))
}

fn set_tool_owner(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let key = text(args, 0)?;
    let participant = text(args, 1)?.to_owned();
    if acp_host::has_active_task(dir, key) {
        return Err(failure("Tool ownership can only change between turns."));
    }
    let sessions = store(dir);
    let record = sessions.get(key)?;
    let Some(record) = record.filter(|r| r["conversation"]["state"] == "running") else {
        return Err(failure("No running multi-AI conversation."));
    };
    handover::assert_can_change_runtime(&record)?;
    if record["conversation"]["mode"] != "pair" {
        return Err(failure("Tool ownership can only change in pair mode."));
    }
    if !record["conversation"]["participants"]
        .as_array()
        .is_some_and(|p| p.iter().any(|x| x["id"] == participant))
    {
        return Err(failure("Unknown conversation participant."));
    }
    let updated = sessions
        .mutate(key, true, |r| {
            r["conversation"]["toolOwnerId"] = json!(participant)
        })?
        .ok_or_else(|| no_session(key))?;
    host.events()
        .emit("ai:sessionChanged", Some(updated.clone()));
    Ok(updated)
}

/// The folder a session works in, found by issue key or session id.
fn session_folder(dir: &Path, key_or_id: &str) -> Option<String> {
    let sessions = store(dir);
    let record = sessions.get(key_or_id).ok().flatten().or_else(|| {
        sessions
            .all()
            .ok()?
            .into_values()
            .find(|r| r["sessionId"] == key_or_id)
    })?;
    ["worktreePath", "workingDirectory"].iter().find_map(|f| {
        record[*f]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    })
}

const MAX_IMAGE_PREVIEW_BYTES: u64 = 12 * 1024 * 1024;
const MAX_TEXT_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024;

/// A session's image as a data URL, or null when it is not available (a preview is decoration).
fn load_image_preview(dir: &Path, args: &[Value]) -> Result<Value> {
    use base64::Engine;
    let Some(folder) = session_folder(dir, text(args, 0)?) else {
        return Ok(Value::Null);
    };
    let input = args
        .get(1)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if input.is_empty() {
        return Ok(Value::Null);
    }
    let bare = input.split(['?', '#']).next().unwrap_or_default();
    let extension = Path::new(bare)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    let Some(media) = [
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("gif", "image/gif"),
        ("webp", "image/webp"),
        ("bmp", "image/bmp"),
        ("avif", "image/avif"),
    ]
    .iter()
    .find(|(e, _)| *e == extension)
    .map(|(_, m)| *m) else {
        return Ok(Value::Null);
    };
    let candidate = input
        .strip_prefix("file://")
        .map_or_else(|| input.to_owned(), str::to_owned);
    let Ok(absolute) = praxis_ai::mcp::builtin::read_only_files::resolve_sandboxed_path(
        Path::new(&folder),
        &candidate,
    ) else {
        return Ok(Value::Null);
    };
    match std::fs::metadata(&absolute) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_IMAGE_PREVIEW_BYTES => {
            match std::fs::read(&absolute) {
                Ok(bytes) => Ok(json!(format!(
                    "data:{media};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ))),
                Err(_) => Ok(Value::Null),
            }
        }
        _ => Ok(Value::Null),
    }
}

/// The text of a file-backed artifact inside the session's folder.
pub(super) fn read_artifact_text(dir: &Path, args: &[Value]) -> Result<Value> {
    let folder = session_folder(dir, text(args, 0)?);
    let input = args
        .get(1)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let absolute_input = Path::new(input).is_absolute()
        || input.split_once(':').is_some_and(|(scheme, _)| {
            scheme.len() > 1
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        });
    let Some(folder) = folder.filter(|_| !input.is_empty() && !absolute_input) else {
        return Err(failure(
            "Artifact is not available in the session workspace.",
        ));
    };
    let resolved =
        praxis_ai::mcp::builtin::read_only_files::resolve_sandboxed_path(Path::new(&folder), input)
            .map_err(|_| failure("Artifact is outside the session workspace."))?;
    let (Ok(root), Ok(real)) = (
        std::fs::canonicalize(&folder),
        std::fs::canonicalize(&resolved),
    ) else {
        return Err(failure(format!(
            "Artifact file was not found in the session folder ({folder})."
        )));
    };
    if !real.starts_with(&root) {
        return Err(failure("Artifact resolves outside the session workspace."));
    }
    match std::fs::metadata(&real) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_TEXT_ARTIFACT_BYTES => std::fs::read(&real)
            .map(|b| json!(String::from_utf8_lossy(&b)))
            .map_err(|_| failure("Artifact could not be read.")),
        _ => Err(failure("Artifact must be a text file no larger than 2 MB.")),
    }
}

/// Creates (or re-attaches) the dedicated worktree for a session; returns its facts as JSON.
pub(super) fn prepare_worktree(
    default_base: &str,
    issue: &Value,
    folder: &str,
    reuse_existing: bool,
    branch_name: Option<String>,
) -> Result<Value> {
    use praxis_core::git::{GitWorktreeManager, PrepareWorktreeOptions, WorktreeIssueInput};
    let current = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(folder)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .filter(|b| !b.is_empty() && b != "HEAD");
    let base = current
        .or_else(|| Some(default_base.trim().to_owned()).filter(|b| !b.is_empty()))
        .ok_or_else(|| {
            failure("Could not determine a base branch for the worktree (detached HEAD?).")
        })?;
    let input = WorktreeIssueInput {
        key: issue["key"].as_str().unwrap_or_default().to_owned(),
        summary: issue["summary"].as_str().unwrap_or_default().to_owned(),
        branch: issue["branch"].as_str().map(str::to_owned),
    };
    let options = PrepareWorktreeOptions {
        force_clean: false,
        reuse_existing,
        branch_name,
        ..PrepareWorktreeOptions::default()
    };
    match GitWorktreeManager::silent().prepare_delivery_worktree_sync(
        &input,
        &base,
        Path::new(folder),
        Some(&options),
    ) {
        Ok(prepared) => Ok(
            json!({ "worktreePath": prepared.worktree_path, "branchName": prepared.branch_name, "baseBranch": prepared.base_branch, "worktreeName": prepared.worktree_name }),
        ),
        Err(praxis_core::git::WorktreeError::Conflict { worktree_path, .. }) => {
            Err(failure(format!(
                "A worktree for {} already exists at {worktree_path}. Remove it (or that session) and retry.",
                input.key
            )))
        }
        Err(error) => Err(failure(error)),
    }
}

fn set_worktree(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    let key = text(args, 0)?;
    let options = args.get(1).cloned().unwrap_or(Value::Null);
    let sessions = store(dir);
    let record = sessions.get(key)?.ok_or_else(|| no_session(key))?;
    if acp_host::has_active_task(dir, key) {
        return Err(failure(
            "Wait for the current session to finish before creating a worktree.",
        ));
    }
    let folder = record["workingDirectory"]
        .as_str()
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .ok_or_else(|| failure("A working directory is required to set a worktree."))?
        .to_owned();
    let default_base = host.settings().read().delivery.default_base_branch.clone();
    let base = options["baseBranch"]
        .as_str()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map_or(default_base, str::to_owned);
    let issue = json!({ "key": key, "summary": record["title"].as_str().unwrap_or(key) });
    let branch = options["branchName"]
        .as_str()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_owned);
    let prepared = prepare_worktree(&base, &issue, &folder, true, branch)?;
    let updated = sessions
        .mutate(key, true, |r| {
            r["workingDirectory"] = prepared["worktreePath"].clone();
            r["worktreePath"] = prepared["worktreePath"].clone();
            r["worktreeBranch"] = prepared["branchName"].clone();
            r["worktreeBaseBranch"] = prepared["baseBranch"].clone();
            r["worktreeName"] = prepared["worktreeName"].clone();
        })?
        .ok_or_else(|| no_session(key))?;
    host.events()
        .emit("ai:sessionChanged", Some(updated.clone()));
    Ok(updated)
}

fn remove_worktree(host: &HostContext, dir: &Path, args: &[Value]) -> Result<Value> {
    use praxis_core::git::{GitWorktreeManager, WorktreeTarget};
    let key = text(args, 0)?;
    let sessions = store(dir);
    let record = sessions.get(key)?.ok_or_else(|| no_session(key))?;
    if acp_host::has_active_task(dir, key) {
        return Err(failure(
            "Wait for the current session to finish before removing its worktree.",
        ));
    }
    let path = record["worktreePath"]
        .as_str()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    let branch = record["worktreeBranch"]
        .as_str()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    let (Some(path), Some(branch)) = (path, branch) else {
        return Err(failure(format!("Session {key} has no dedicated worktree.")));
    };
    let target = WorktreeTarget {
        worktree_path: path.to_owned(),
        branch_name: branch.to_owned(),
    };
    GitWorktreeManager::silent()
        .remove_delivery_worktree_sync(Path::new(path), &target, None)
        .map_err(|e| failure(format!("Could not remove the session worktree: {e}")))?;
    // The session ran in the worktree, so point it back at the main checkout.
    let main_root = Path::new(path)
        .parent()
        .and_then(Path::parent)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Some(updated) = sessions.mutate(key, true, |r| {
        r["workingDirectory"] = json!(main_root);
        for field in [
            "worktreePath",
            "worktreeBranch",
            "worktreeBaseBranch",
            "worktreeName",
        ] {
            r.as_object_mut().map(|o| o.remove(field));
        }
    })? {
        host.events().emit("ai:sessionChanged", Some(updated));
    }
    Ok(Value::Null)
}

pub fn dispatch(
    host: &HostContext,
    dir: &Path,
    channel: &str,
    args: &[Value],
) -> Option<Result<Value>> {
    Some(match channel {
        "ai:loadImagePreview" => load_image_preview(dir, args),
        "ai:readArtifactText" => read_artifact_text(dir, args),
        "ai:removeWorktree" => remove_worktree(host, dir, args),
        "ai:setWorktree" => set_worktree(host, dir, args),
        "ai:updateSessionModel" => update_model(host, dir, args),
        "ai:updateSessionReasoningEffort" => update_reasoning(host, dir, args),
        "ai:updateSessionPermissionMode" => update_permission_mode(host, dir, args),
        "ai:handoverSession" => handover_session(host, dir, args),
        "ai:editHandoverBrief" => edit_brief(host, dir, args),
        "ai:switchSessionMode" => switch_mode(host, dir, args),
        "ai:startConversation" => start_conversation(host, dir, args),
        "ai:sendConversationMessage" => send_message(host, dir, args),
        "ai:stopConversation" => stop_conversation(host, dir, args),
        "ai:setConversationToolOwner" => set_tool_owner(host, dir, args),
        _ => return None,
    })
}
