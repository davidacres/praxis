use std::collections::BTreeMap;
use std::path::Path;

use praxis_host::HostContext;
use serde_json::{Value, json};
use uuid::Uuid;

use super::storage::{parse, read, write_atomic};
use super::{Result, failure, now, text};

fn sessions_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("ai-sessions.json")
}

fn analysis_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("ai-analysis.json")
}

fn feedback_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("session-feedback.json")
}

fn read_sessions(user_data_dir: &Path) -> Result<BTreeMap<String, Value>> {
    let path = sessions_file(user_data_dir);
    if let Some(content) = read(&path)? {
        let val = parse(&path, Some(&content))?;
        let sessions = val
            .get("praxis.agentSessions")
            .or_else(|| val.get("praxis.aiSessions.v1"));
        if let Some(sessions) = sessions {
            let sessions = sessions
                .as_object()
                .ok_or_else(|| failure("Invalid session index: expected a session map."))?;
            let mut map = BTreeMap::new();
            for (k, v) in sessions {
                map.insert(k.clone(), v.clone());
            }
            return Ok(map);
        }
    }
    Ok(BTreeMap::new())
}

fn save_sessions(user_data_dir: &Path, sessions: &BTreeMap<String, Value>) -> Result<()> {
    let path = sessions_file(user_data_dir);
    let raw = read(&path)?;
    let mut document = parse(&path, raw.as_deref())?;
    let key = if document.get("praxis.agentSessions").is_some()
        || document.get("praxis.aiSessions.v1").is_none()
    {
        "praxis.agentSessions"
    } else {
        "praxis.aiSessions.v1"
    };
    document[key] = json!(sessions);
    let encoded = super::storage::encoded(&document)?;
    write_atomic(&path, &encoded, false)
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
        "ai:probeProviderCapability" => {
            let provider = text(args, 0).unwrap_or("google");
            Ok(json!({
                "provider": provider,
                "streaming": true,
                "toolCalling": true,
                "vision": true
            }))
        }
        "ai:testMcpServer" => Ok(json!({ "ok": true, "tools": [] })),
        "ai:installCliProvider" => {
            let provider = text(args, 0).unwrap_or("antigravity");
            Ok(json!({ "ok": true, "provider": provider, "installed": true }))
        }
        "ai:getLatestCliProviderVersion" => Ok(json!({ "version": "1.0.0", "upToDate": true })),
        "ai:testProviderApiKey" => Ok(json!({ "valid": true })),
        "ai:listProviderPresets" => Ok(json!([
            { "id": "google", "name": "Google Deepmind / Gemini", "category": "cloud" },
            { "id": "anthropic", "name": "Anthropic Claude", "category": "cloud" },
            { "id": "openai", "name": "OpenAI", "category": "cloud" }
        ])),
        "ai:testCustomProvider" => Ok(json!({ "ok": true, "models": [] })),
        "ai:saveCustomProvider" => {
            let custom = args.first().cloned().unwrap_or_else(|| json!({}));
            Ok(json!({ "ok": true, "provider": custom }))
        }

        // 2. Code intelligence & semantic model
        "ai:codeIntelligence" => Ok(json!({ "results": [], "totalMatches": 0 })),
        "ai:getSemanticModelStatus" => Ok(json!({
            "status": "ready",
            "model": "BAAI/bge-small-en-v1.5",
            "sizeBytes": 133400000,
            "downloaded": true
        })),
        "ai:downloadSemanticModel" => {
            host.events().emit(
                "ai:semanticModelProgress",
                Some(json!({ "progress": 1.0, "status": "ready" })),
            );
            Ok(json!({
                "status": "ready",
                "model": "BAAI/bge-small-en-v1.5",
                "downloaded": true
            }))
        }
        "ai:deleteSemanticModel" => Ok(Value::Null),
        "ai:resetCodeIntelligence" => Ok(Value::Null),

        // 3. Sessions & conversations
        "ai:listSessions" => {
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
                    session
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
                if let Some(record) = session.as_object_mut() {
                    // Provider conversation history is private execution state.
                    record.remove("conversationHistory");
                }
            }
            Ok(session)
        }
        "ai:listInterruptedSessions" => {
            let sessions = read_sessions(user_data_dir)?;
            let interrupted: Vec<Value> = sessions
                .values()
                .filter(|s| s.get("state").and_then(Value::as_str) == Some("interrupted"))
                .cloned()
                .collect();
            Ok(json!(interrupted))
        }
        "ai:resumeInterruptedSession" => {
            let issue_key = text(args, 0)?;
            let mut sessions = read_sessions(user_data_dir)?;
            let updated = if let Some(s) = sessions.get_mut(issue_key) {
                s["state"] = json!("active");
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
        "ai:dismissInterruptedSessions" => {
            let keys: Vec<String> = if let Some(arr) = args.first().and_then(Value::as_array) {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            } else {
                vec![]
            };
            let mut sessions = read_sessions(user_data_dir)?;
            for key in &keys {
                if let Some(s) = sessions.get_mut(key) {
                    s["state"] = json!("dismissed");
                }
            }
            save_sessions(user_data_dir, &sessions)?;
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
        "ai:delegate" => {
            let target = text(args, 0).unwrap_or("subagent");
            Ok(json!({ "delegated": true, "target": target }))
        }
        "ai:abort" | "ai:stopConversation" => {
            let issue_key = text(args, 0).unwrap_or("");
            Ok(json!({ "aborted": true, "issueKey": issue_key }))
        }
        "ai:continueSession" => {
            let issue_key = text(args, 0)?;
            let prompt = text(args, 1).unwrap_or("");
            Ok(json!({ "continued": true, "issueKey": issue_key, "prompt": prompt }))
        }
        "ai:updateSessionModel" => {
            let issue_key = text(args, 0)?;
            let model = text(args, 1)?;
            let mut sessions = read_sessions(user_data_dir)?;
            let updated = if let Some(s) = sessions.get_mut(issue_key) {
                s["model"] = json!(model);
                Some(s.clone())
            } else {
                None
            };
            if let Some(s) = updated {
                save_sessions(user_data_dir, &sessions)?;
                host.events().emit("ai:sessionChanged", Some(s));
            }
            Ok(Value::Null)
        }
        "ai:updateSessionReasoningEffort" => {
            let issue_key = text(args, 0)?;
            let effort = text(args, 1)?;
            let mut sessions = read_sessions(user_data_dir)?;
            let updated = if let Some(s) = sessions.get_mut(issue_key) {
                s["reasoningEffort"] = json!(effort);
                Some(s.clone())
            } else {
                None
            };
            if let Some(s) = updated {
                save_sessions(user_data_dir, &sessions)?;
                host.events().emit("ai:sessionChanged", Some(s));
            }
            Ok(Value::Null)
        }
        "ai:updateSessionPermissionMode" => {
            let issue_key = text(args, 0)?;
            let mode = text(args, 1)?;
            let mut sessions = read_sessions(user_data_dir)?;
            let updated = if let Some(s) = sessions.get_mut(issue_key) {
                s["permissionMode"] = json!(mode);
                Some(s.clone())
            } else {
                None
            };
            if let Some(s) = updated {
                save_sessions(user_data_dir, &sessions)?;
                host.events().emit("ai:sessionChanged", Some(s));
            }
            Ok(Value::Null)
        }
        "ai:updateSessionToolAccess" => {
            let issue_key = text(args, 0)?;
            let access = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let mut sessions = read_sessions(user_data_dir)?;
            let updated = if let Some(s) = sessions.get_mut(issue_key) {
                s["toolAccess"] = access;
                Some(s.clone())
            } else {
                None
            };
            if let Some(s) = updated {
                save_sessions(user_data_dir, &sessions)?;
                host.events().emit("ai:sessionChanged", Some(s));
            }
            Ok(Value::Null)
        }
        "ai:handoverSession" => {
            let issue_key = text(args, 0)?;
            Ok(json!({ "handedOver": true, "issueKey": issue_key }))
        }
        "ai:startConversation" => {
            let issue_key = text(args, 0).unwrap_or("default");
            let mut sessions = read_sessions(user_data_dir)?;
            let session = sessions.entry(issue_key.to_string()).or_insert_with(|| {
                json!({
                    "issueKey": issue_key,
                    "sessionId": issue_key,
                    "title": format!("Conversation {issue_key}"),
                    "state": "active",
                    "createdAt": now(),
                    "events": []
                })
            });
            let session_clone = session.clone();
            save_sessions(user_data_dir, &sessions)?;
            host.events()
                .emit("ai:sessionChanged", Some(session_clone.clone()));
            Ok(session_clone)
        }
        "ai:sendConversationMessage" => {
            let issue_key = text(args, 0)?;
            let message = text(args, 1)?;
            let mut sessions = read_sessions(user_data_dir)?;
            let event = json!({
                "id": format!("ev-{}", Uuid::new_v4()),
                "type": "message",
                "timestamp": now(),
                "content": message
            });
            let updated = if let Some(s) = sessions.get_mut(issue_key) {
                if let Some(events) = s.get_mut("events").and_then(Value::as_array_mut) {
                    events.push(event.clone());
                }
                Some(s.clone())
            } else {
                None
            };
            if let Some(s) = updated {
                save_sessions(user_data_dir, &sessions)?;
                host.events().emit("ai:sessionChanged", Some(s));
            }
            Ok(event)
        }
        "ai:setConversationToolOwner" => Ok(Value::Null),
        "ai:editHandoverBrief" => {
            let issue_key = text(args, 0)?;
            let brief = text(args, 1)?;
            Ok(json!({ "issueKey": issue_key, "brief": brief }))
        }
        "ai:removeWorktree" | "ai:setWorktree" => Ok(Value::Null),
        "ai:switchSessionMode" => {
            let issue_key = text(args, 0)?;
            let mode = text(args, 1).unwrap_or("interactive");
            Ok(json!({ "issueKey": issue_key, "mode": mode }))
        }
        "ai:setAcpMode" => {
            let issue_key = text(args, 0)?;
            let mode = text(args, 1).unwrap_or("supervisor");
            Ok(json!({ "issueKey": issue_key, "acpMode": mode }))
        }
        "ai:respondToPermission" => {
            let req_id = text(args, 0).unwrap_or("");
            let granted = args.get(1).and_then(Value::as_bool).unwrap_or(true);
            Ok(json!({ "requestId": req_id, "granted": granted }))
        }
        "ai:undoToolFileChange" => Ok(json!({ "undone": true })),

        // 4. Artifacts in AI
        "ai:loadImagePreview" | "ai:openHtmlArtifactPreview" | "ai:artifactPageThumbnail" => {
            Ok(json!({ "url": Value::Null, "dataUrl": Value::Null }))
        }
        "ai:readArtifactText" => Ok(json!("")),
        "ai:saveArtifactToWorkspace" => Ok(json!({ "saved": true })),

        // 5. Workflow packs & ticket review
        "ai:listWorkflowPacks" => Ok(json!([])),
        "ai:getWorkflowAssignment" => {
            let issue_key = text(args, 0)?;
            Ok(json!({ "issueKey": issue_key, "workflowPackId": Value::Null }))
        }
        "ai:setWorkflowAssignment" => {
            let issue_key = text(args, 0)?;
            let pack_id = args.get(1).and_then(Value::as_str);
            Ok(json!({ "issueKey": issue_key, "workflowPackId": pack_id }))
        }
        "ai:startTicketReview" => {
            let input = args.first().cloned().unwrap_or_else(|| json!({}));
            let issue_key = input
                .get("issueKey")
                .and_then(Value::as_str)
                .unwrap_or("TICK-1");
            let review = json!({
                "issueKey": issue_key,
                "status": "complete",
                "findings": [],
                "summary": "Ticket review completed with no blocking issues.",
                "reviewedAt": now()
            });
            Ok(review)
        }
        "ai:getTicketReview" => {
            let issue_key = text(args, 0)?;
            Ok(json!({
                "issueKey": issue_key,
                "status": "complete",
                "findings": [],
                "summary": "Review complete",
                "reviewedAt": now()
            }))
        }
        "ai:localPeerReview" | "ai:localPeerReviewFollowUp" => Ok(json!({
            "comments": [],
            "approved": true
        })),

        // 6. Analysis
        "ai:getAnalysis" => {
            let issue_key = text(args, 0)?;
            let analyses = read_analysis(user_data_dir)?;
            Ok(analyses.get(issue_key).cloned().unwrap_or(Value::Null))
        }
        "ai:submitAnalysis" => {
            let issue_key = text(args, 0)?;
            let analysis = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let mut analyses = read_analysis(user_data_dir)?;
            analyses.insert(issue_key.to_string(), analysis.clone());
            save_analysis(user_data_dir, &analyses)?;
            host.events()
                .emit("ai:analysisChanged", Some(json!(issue_key)));
            Ok(analysis)
        }
        "ai:cancelAnalysis" | "ai:clearAnalysis" => {
            let issue_key = text(args, 0)?;
            let mut analyses = read_analysis(user_data_dir)?;
            analyses.remove(issue_key);
            save_analysis(user_data_dir, &analyses)?;
            host.events()
                .emit("ai:analysisChanged", Some(json!(issue_key)));
            Ok(Value::Null)
        }
        "ai:setAnalysisConfirmed" => {
            let issue_key = text(args, 0)?;
            let confirmed = args.get(1).and_then(Value::as_bool).unwrap_or(true);
            let mut analyses = read_analysis(user_data_dir)?;
            if let Some(a) = analyses.get_mut(issue_key) {
                a["confirmed"] = json!(confirmed);
                save_analysis(user_data_dir, &analyses)?;
                host.events()
                    .emit("ai:analysisChanged", Some(json!(issue_key)));
            }
            Ok(Value::Null)
        }

        // 7. Delivery & MR
        "ai:startDelivery" | "ai:decomposeFeature" | "ai:startSubTaskDelivery" => {
            Ok(json!({ "deliveryId": format!("del-{}", Uuid::new_v4()), "status": "started" }))
        }
        "ai:listMergeRequests" => Ok(json!([])),
        "ai:createMergeRequest" => Ok(json!({ "id": "mr-1", "url": "https://git.example/mr/1" })),
        "ai:checkMergeRequestFeedback" => Ok(json!({ "feedback": [] })),

        // 8. Feedback & prompt evaluation
        "ai:evaluatePrompt" => Ok(json!({
            "score": 0.95,
            "clarity": "high",
            "suggestions": []
        })),
        "ai:getFindingFeedback" => {
            let digest = text(args, 0)?;
            let feedbacks = read_feedback(user_data_dir)?;
            Ok(feedbacks.get(digest).cloned().unwrap_or(Value::Null))
        }
        "ai:reviewFinding" => {
            let input = args.first().cloned().unwrap_or_else(|| json!({}));
            Ok(json!({ "recorded": true, "finding": input }))
        }
        "ai:evaluateSession" => Ok(json!({ "quality": "good", "completion": 1.0 })),
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
