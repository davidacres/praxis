use std::collections::BTreeMap;
use std::path::Path;

use praxis_host::HostContext;
use serde_json::{Value, json};
use uuid::Uuid;

use super::storage::{parse, read, write_atomic};
use super::{Result, failure, now, text};


fn analysis_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("ai-analysis.json")
}

fn feedback_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("session-feedback.json")
}

fn read_sessions(user_data_dir: &Path) -> Result<BTreeMap<String, Value>> {
    super::session_store::store(user_data_dir).all()
}

fn save_sessions(user_data_dir: &Path, sessions: &BTreeMap<String, Value>) -> Result<()> {
    super::session_store::store(user_data_dir).replace_all(sessions.clone())
}

/// The renderer-facing analysis state for an issue: stored fields plus the runtime-only `busy` flag.
fn analysis_state(analyses: &BTreeMap<String, Value>, issue_key: &str) -> Value {
    let stored = analyses.get(issue_key);
    let mut state = json!({
        "issueKey": issue_key,
        "messages": stored.map_or_else(|| json!([]), |s| if s["messages"].is_array() { s["messages"].clone() } else { json!([]) }),
        "confirmed": stored.is_some_and(|s| s["confirmed"] == true),
        "busy": false,
    });
    for field in ["confirmedAt", "provider", "model"] {
        if let Some(value) = stored.map(|s| &s[field]).filter(|v| !v.is_null()) {
            state[field] = value.clone();
        }
    }
    state
}

/// Confirming an analysis turns the same session into the implementation run (full tools, new contract).
fn promote_analysis_session(host: &HostContext, user_data_dir: &Path, issue_key: &str) -> Result<()> {
    let sessions = super::session_store::store(user_data_dir);
    let Some(record) = sessions.get(issue_key)? else { return Ok(()) };
    if record["taskDefinition"]["kind"] != "analysis" {
        return Ok(());
    }
    let updated = sessions.mutate(issue_key, true, |r| {
        let task = &mut r["taskDefinition"];
        task["definitionOfDone"] = json!("Implement the confirmed plan, run the relevant tests, and report the completed result.");
        if let Some(object) = task.as_object_mut() {
            object.remove("nonGoals");
        }
        task["completionContract"] = json!("Continue in this conversation until the confirmed implementation is complete and verified.");
        r["toolMode"] = json!("full");
    })?;
    if let Some(updated) = updated {
        host.events().emit("ai:sessionChanged", Some(updated));
    }
    Ok(())
}

fn read_analysis(user_data_dir: &Path) -> Result<BTreeMap<String, Value>> {
    let path = analysis_file(user_data_dir);
    if let Some(content) = read(&path)? {
        let val = parse(&path, Some(&content))?;
        let map_obj = val
            .get("praxis.issueAnalysis")
            .or_else(|| val.get("praxis.aiAnalysis.v1"))
            .and_then(Value::as_object);
        if let Some(map_obj) = map_obj {
            let mut map = BTreeMap::new();
            for (k, v) in map_obj {
                map.insert(k.clone(), v.clone());
            }
            return Ok(map);
        }
    }
    Ok(BTreeMap::new())
}

/// Whether the analysis gate for `issue_key` has been confirmed.
pub(super) fn is_analysis_confirmed(user_data_dir: &Path, issue_key: &str) -> Result<bool> {
    Ok(read_analysis(user_data_dir)?.get(issue_key).is_some_and(|a| a["confirmed"] == true))
}

fn save_analysis(user_data_dir: &Path, analysis: &BTreeMap<String, Value>) -> Result<()> {
    let path = analysis_file(user_data_dir);
    let key = if let Some(content) = read(&path)?
        && let Ok(val) = parse(&path, Some(&content))
        && val.get("praxis.aiAnalysis.v1").is_some()
    {
        "praxis.aiAnalysis.v1"
    } else {
        "praxis.issueAnalysis"
    };
    let encoded = super::storage::encoded(&json!({ key: analysis }))?;
    write_atomic(&path, &encoded, false)
}

fn read_feedback(user_data_dir: &Path) -> Result<BTreeMap<String, Value>> {
    let path = feedback_file(user_data_dir);
    if let Some(content) = read(&path)? {
        let val = parse(&path, Some(&content))?;
        if let Some(map_obj) = val
            .get("praxis.sessionFeedback.v1")
            .and_then(Value::as_object)
        {
            let mut map = BTreeMap::new();
            for (k, v) in map_obj {
                map.insert(k.clone(), v.clone());
            }
            return Ok(map);
        }
    }
    Ok(BTreeMap::new())
}

fn save_feedback(user_data_dir: &Path, feedback: &BTreeMap<String, Value>) -> Result<()> {
    let path = feedback_file(user_data_dir);
    let encoded = super::storage::encoded(&json!({ "praxis.sessionFeedback.v1": feedback }))?;
    write_atomic(&path, &encoded, false)
}

pub fn dispatch(
    host: &HostContext,
    user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    if let Some(result) = super::ai_providers::dispatch(host, channel, args) {
        return result;
    }
    if let Some(result) = super::ai_models::dispatch(host, channel, args) {
        return result;
    }
    match channel {
        // 1. Provider configuration & statuses
        "ai:testMcpServer" => Ok(super::user_mcp::test_server(args.first().unwrap_or(&Value::Null))),
        "ai:testProviderApiKey" => Ok(json!({ "valid": true })),

        // 2. Code intelligence & semantic model
        "ai:codeIntelligence" => Ok(json!({ "results": [], "totalMatches": 0 })),
        "ai:getSemanticModelStatus" => Ok(super::semantic_model::status(user_data_dir)),
        "ai:downloadSemanticModel" => super::semantic_model::download(host, user_data_dir),
        "ai:deleteSemanticModel" => Ok(super::semantic_model::delete(user_data_dir)),
        "ai:resetCodeIntelligence" => Ok(Value::Null),

        // 3. Sessions & conversations
        "ai:listSessions" => {
            super::ai_review::recover_projects(host, user_data_dir);
            let sessions = read_sessions(user_data_dir)?;
            let mut list: Vec<Value> = sessions
                .values()
                .cloned()
                .map(|mut session| {
                    if let Some(record) = session.as_object_mut() {
                        if let Some(last_activity) = record
                            .get("events")
                            .and_then(Value::as_array)
                            .and_then(|events| events.last())
                            .and_then(|event| event.get("timestamp"))
                            .cloned()
                        {
                            record.insert("lastActivityAt".into(), last_activity);
                        }
                        record.remove("conversationHistory");
                        record.insert("events".into(), json!([]));
                        record.insert("eventsLoaded".into(), json!(false));
                    }
                    super::session_store::stamp_reasoning(session)
                })
                .collect();
            list.sort_by(|a, b| {
                b["startedAt"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(a["startedAt"].as_str().unwrap_or(""))
            });
            Ok(json!(list))
        }
        "ai:getSession" => {
            let issue_key = text(args, 0)?;
            let sessions = read_sessions(user_data_dir)?;
            let mut session = sessions
                .get(issue_key)
                .or_else(|| {
                    sessions
                        .values()
                        .find(|session| session["sessionId"].as_str() == Some(issue_key))
                })
                .cloned()
                .unwrap_or(Value::Null);
            if !session.is_null() {
                let events_empty = session
                    .get("events")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty);
                if (events_empty
                    || session.get("eventsLoaded").and_then(Value::as_bool) == Some(false))
                    && let Some(session_id) = session.get("sessionId").and_then(Value::as_str)
                {
                    let clean_id = session_id
                        .chars()
                        .map(|c| {
                            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                                c
                            } else {
                                '_'
                            }
                        })
                        .collect::<String>();
                    let transcript_path = user_data_dir
                        .join("ai-transcripts")
                        .join(format!("{clean_id}.json"));
                    if let Some(raw) = read(&transcript_path)? {
                        let transcript = parse(&transcript_path, Some(&raw))?;
                        if let Some(events) = transcript.get("events") {
                            session["events"] = events.clone();
                        }
                        if let Some(plan) = transcript.get("planText") {
                            session["planText"] = plan.clone();
                        }
                        if let Some(reasoning) = transcript.get("reasoningText") {
                            session["reasoningText"] = reasoning.clone();
                        }
                        if let Some(resp) = transcript.get("responseText") {
                            session["responseText"] = resp.clone();
                        }
                    }
                }
                session["eventsLoaded"] = json!(true);
                session["eventCount"] = json!(
                    session
                        .get("events")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len)
                );
                // Sessions recorded before skill detection existed are scanned when first opened,
                // and the result is saved with the session.
                if session["detectedSkills"].is_null() {
                    let events = session["events"].as_array().cloned().unwrap_or_default();
                    let signals = praxis_ai::session::skill_usage::detect_skill_uses(&events);
                    if let Some(uses) = praxis_ai::session::skill_usage::merge_detected_skill_uses(None, &signals) {
                        session["detectedSkills"] = json!(uses);
                        let key = session["issueKey"].as_str().unwrap_or(issue_key).to_owned();
                        let saved = session["detectedSkills"].clone();
                        let _ = super::session_store::store(user_data_dir).mutate(&key, true, |record| record["detectedSkills"] = saved);
                    }
                }
                if let Some(record) = session.as_object_mut() {
                    // Provider conversation history is private execution state.
                    record.remove("conversationHistory");
                }
                session = super::session_store::stamp_reasoning(session);
            }
            Ok(session)
        }
        "ai:listInterruptedSessions" => {
            let sessions = read_sessions(user_data_dir)?;
            let interrupted: Vec<Value> = sessions
                .values()
                .filter(|s| {
                    s["interruptedByRestart"] == true
                        && s["archived"] != true
                        && s["workflowNodeId"].is_null()
                        && matches!(s["state"].as_str(), Some("aborted" | "paused"))
                })
                .cloned()
                .map(|mut session| {
                    session.as_object_mut().map(|o| o.remove("conversationHistory"));
                    session
                })
                .collect();
            Ok(json!(interrupted))
        }
        "ai:dismissInterruptedSessions" => {
            let Some(keys) = args.first().and_then(Value::as_array).filter(|k| k.iter().all(Value::is_string)) else {
                return Err(failure("Invalid session selection."));
            };
            let store = super::session_store::store(user_data_dir);
            for key in keys.iter().filter_map(Value::as_str) {
                store.mutate(key, true, |record| {
                    record.as_object_mut().map(|o| o.remove("interruptedByRestart"));
                })?;
            }
            store.flush()?;
            Ok(Value::Null)
        }
        "ai:renameSession" => {
            let issue_key = text(args, 0)?;
            let name = text(args, 1)?;
            let mut sessions = read_sessions(user_data_dir)?;
            let updated = if let Some(s) = sessions.get_mut(issue_key) {
                s["title"] = json!(name);
                Some(s.clone())
            } else {
                None
            };
            if let Some(s) = updated {
                save_sessions(user_data_dir, &sessions)?;
                host.events().emit("ai:sessionChanged", Some(s.clone()));
                Ok(s)
            } else {
                Err(failure(format!("Session {issue_key} was not found.")))
            }
        }
        "ai:assignSessionToProject" => {
            let issue_key = text(args, 0)?;
            let project_id = text(args, 1)?;
            let mut sessions = read_sessions(user_data_dir)?;
            let updated = if let Some(s) = sessions.get_mut(issue_key) {
                s["projectId"] = json!(project_id);
                Some(s.clone())
            } else {
                None
            };
            if let Some(s) = updated {
                save_sessions(user_data_dir, &sessions)?;
                host.events().emit("ai:sessionChanged", Some(s.clone()));
                Ok(s)
            } else {
                let new_session = json!({
                    "issueKey": issue_key,
                    "sessionId": issue_key,
                    "projectId": project_id,
                    "title": format!("Session {issue_key}"),
                    "state": "active",
                    "createdAt": now(),
                    "events": []
                });
                sessions.insert(issue_key.to_string(), new_session.clone());
                save_sessions(user_data_dir, &sessions)?;
                host.events()
                    .emit("ai:sessionChanged", Some(new_session.clone()));
                Ok(new_session)
            }
        }
        "ai:deleteSession" => {
            let issue_key = text(args, 0)?;
            let mut sessions = read_sessions(user_data_dir)?;
            sessions.remove(issue_key);
            save_sessions(user_data_dir, &sessions)?;
            // The session leaves the broker (an executing claim waits for recovery).
            super::coordination::end_coordinated_session(issue_key);
            host.events()
                .emit("ai:sessionDeleted", Some(json!(issue_key)));
            Ok(Value::Null)
        }
        "ai:archiveSession" => {
            let issue_key = text(args, 0)?;
            let archived = args.get(1).and_then(Value::as_bool).unwrap_or(true);
            let mut sessions = read_sessions(user_data_dir)?;
            let updated = if let Some(s) = sessions.get_mut(issue_key) {
                s["archived"] = json!(archived);
                Some(s.clone())
            } else {
                None
            };
            if let Some(s) = updated {
                save_sessions(user_data_dir, &sessions)?;
                host.events().emit("ai:sessionChanged", Some(s.clone()));
                Ok(s)
            } else {
                Err(failure(format!("Session {issue_key} was not found.")))
            }
        }
        "ai:updateSessionToolAccess" => {
            let issue_key = text(args, 0)?;
            if super::acp_host::is_running(user_data_dir, issue_key) {
                return Err(failure("Wait for the current session turn to finish before changing tool access."));
            }
            let options = args.get(1).cloned().unwrap_or(Value::Null);
            let sessions = super::session_store::store(user_data_dir);
            let record = sessions.get(issue_key)?.ok_or_else(|| failure(format!("No agent session found for {issue_key}.")))?;
            // A folder may be set or cleared; clearing it with no tool mode falls back to project-only.
            let mut working = record["workingDirectory"].as_str().map(str::to_owned);
            let mut tool_mode = record["toolMode"].as_str().map(str::to_owned);
            if let Some(folder) = options.get("workingDirectory") {
                working = folder.as_str().map(str::trim).filter(|f| !f.is_empty()).map(str::to_owned);
                if working.is_none() && options["toolMode"].is_null() {
                    tool_mode = Some("project-only".into());
                }
            }
            if let Some(mode) = options["toolMode"].as_str() {
                if matches!(mode, "full" | "read-only") && working.is_none() {
                    return Err(failure("A working folder is required for file tools."));
                }
                tool_mode = Some(mode.to_owned());
            }
            let updated = sessions.mutate(issue_key, true, |r| {
                match &working {
                    Some(folder) => r["workingDirectory"] = json!(folder),
                    None => {
                        r.as_object_mut().map(|o| o.remove("workingDirectory"));
                    }
                }
                if let Some(mode) = &tool_mode {
                    r["toolMode"] = json!(mode);
                }
            })?;
            let updated = updated.ok_or_else(|| failure(format!("No agent session found for {issue_key}.")))?;
            host.events().emit("ai:sessionChanged", Some(updated.clone()));
            Ok(updated)
        }
        "ai:undoToolFileChange" => Ok(json!({ "undone": true })),

        // 4. Artifacts in AI
        // The shell opens the window (a Tauri webview, or another page under e2e); this validates
        // the file and hands back the document with the restricted-preview policy applied.
        "ai:openHtmlArtifactPreview" => {
            let file = args.get(1).and_then(Value::as_str).unwrap_or_default();
            if !super::html_preview::is_html_path(file) {
                return Err(failure("Only HTML artifacts can be previewed."));
            }
            let source = super::ai_session_ops::read_artifact_text(user_data_dir, args)?;
            let title = args
                .get(2)
                .and_then(Value::as_str)
                .filter(|t| !t.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| file.rsplit('/').next().unwrap_or(file).to_owned());
            Ok(json!({
                "title": super::html_preview::window_title(&title),
                "html": super::html_preview::apply_policy(source.as_str().unwrap_or_default()),
            }))
        }
        // A thumbnail is decoration: null unless the shell has already drawn and cached it.
        "ai:artifactPageThumbnail" => Ok(Value::Null),

        // 5. Workflow packs & ticket review
        "ai:listWorkflowPacks" => Ok(json!(super::workflow_packs::discover(
            super::workflow_packs::discovery_root(host).as_deref()
        ))),
        "ai:getWorkflowAssignment" => {
            let issue_key = text(args, 0)?;
            Ok(super::workflow_packs::assignment(host, issue_key))
        }
        "ai:setWorkflowAssignment" => {
            let issue_key = text(args, 0)?;
            let workflow = args.get(1).filter(|w| w.is_object()).cloned();
            super::workflow_packs::assign(host, issue_key, workflow, "manual").map_err(failure)?;
            Ok(Value::Null)
        }
        // 6. Analysis
        "ai:getAnalysis" => Ok(analysis_state(&read_analysis(user_data_dir)?, text(args, 0)?)),
        "ai:submitAnalysis" => {
            let issue_key = text(args, 0)?;
            let analysis = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let mut analyses = read_analysis(user_data_dir)?;
            analyses.insert(issue_key.to_string(), analysis.clone());
            save_analysis(user_data_dir, &analyses)?;
            host.events().emit("ai:analysisChanged", Some(analysis_state(&analyses, issue_key)));
            Ok(analysis)
        }
        "ai:cancelAnalysis" => Ok(Value::Null),
        "ai:clearAnalysis" => {
            let issue_key = text(args, 0)?;
            let mut analyses = read_analysis(user_data_dir)?;
            analyses.remove(issue_key);
            save_analysis(user_data_dir, &analyses)?;
            host.events().emit("ai:analysisChanged", Some(analysis_state(&analyses, issue_key)));
            Ok(Value::Null)
        }
        "ai:setAnalysisConfirmed" => {
            let issue_key = text(args, 0)?;
            let confirmed = args.get(1).and_then(Value::as_bool).unwrap_or(true);
            let mut analyses = read_analysis(user_data_dir)?;
            let entry = analyses.entry(issue_key.to_owned()).or_insert_with(|| json!({ "messages": [], "confirmed": false }));
            entry["confirmed"] = json!(confirmed);
            if confirmed {
                entry["confirmedAt"] = json!(now());
            } else if let Some(object) = entry.as_object_mut() {
                object.remove("confirmedAt");
            }
            save_analysis(user_data_dir, &analyses)?;
            if confirmed {
                promote_analysis_session(host, user_data_dir, issue_key)?;
            }
            host.events().emit("ai:analysisChanged", Some(analysis_state(&analyses, issue_key)));
            Ok(Value::Null)
        }

        // 7. Delivery, peer review and merge requests live in `ai_workflows`.

        // 8. Feedback & prompt evaluation
        "ai:evaluatePrompt" => {
            let input = args.first().cloned().unwrap_or(Value::Null);
            Ok(super::ai_feedback::empty_report("prompt-readiness", &input, now()))
        }
        "ai:getFindingFeedback" => {
            let digest = text(args, 0)?;
            let feedbacks = read_feedback(user_data_dir)?;
            Ok(feedbacks.get(digest).cloned().unwrap_or(Value::Null))
        }
        "ai:reviewFinding" => {
            let input = args.first().cloned().unwrap_or_else(|| json!({}));
            Ok(json!({ "recorded": true, "finding": input }))
        }
        "ai:evaluateSession" => {
            let input = args.first().cloned().unwrap_or(Value::Null);
            let input = if input.is_string() { json!({ "issueKey": input }) } else { input };
            Ok(super::ai_feedback::empty_report("session-execution", &input, now()))
        }
        "ai:getSessionFeedback" => {
            let session_id = text(args, 0)?;
            let feedbacks = read_feedback(user_data_dir)?;
            Ok(feedbacks.get(session_id).cloned().unwrap_or(Value::Null))
        }
        "ai:submitSessionFeedback" => {
            let session_id = text(args, 0)?;
            let feedback = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let mut feedbacks = read_feedback(user_data_dir)?;
            feedbacks.insert(session_id.to_string(), feedback.clone());
            save_feedback(user_data_dir, &feedbacks)?;
            Ok(feedback)
        }
        "ai:rewritePromptFromFeedback" => {
            let prompt = text(args, 0).unwrap_or("");
            Ok(json!({ "rewrittenPrompt": prompt }))
        }
        _ => Err(failure(format!("Unknown AI channel: {channel}"))),
    }
}
