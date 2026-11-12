//! `assistant:*` channels: the Virtual Team's durable chats and turns. Ports `assistantIpc.ts`
//! and `teamChatCommands.ts`; the coordinator and storage live in `team_chat.rs`.

use std::path::Path;

use praxis_host::HostContext;
use serde_json::{Value, json};

use super::runtime::block_on;
use super::team_chat::{self as chat, Coordinator};
use super::team_chat_core::*;
use super::{Result, failure, now};

fn required(value: &Value, name: &str) -> Fallible<String> {
    match value.as_str() {
        Some(text) if !text.trim().is_empty() => Ok(text.to_owned()),
        _ => Err(format!("{name} is required.")),
    }
}

fn activate_and_coordinate(host: &HostContext) -> Fallible<std::sync::Arc<Coordinator>> {
    chat::activate(&host.config().user_data_dir)?;
    Ok(chat::coordinator(host))
}

fn fenced(command: &Value) -> Fallible {
    required(&command["conversationId"], "A conversation ID")?;
    required(&command["commandId"], "A command ID")?;
    required(&command["turnId"], "A turn ID")?;
    if !command["expectedRevision"].is_i64() {
        return Err("An expected revision is required.".into());
    }
    Ok(())
}

/// Run a control command through the coordinator; returns the full outcome.
fn control(host: &HostContext, command: &Value) -> Fallible<Value> {
    activate_and_coordinate(host)?.control_with_outcome(command)
}

fn typed_control(host: &HostContext, channel: &str, command: &Value) -> Fallible<Value> {
    fenced(command)?;
    let mut base = json!({ "conversationId": command["conversationId"], "commandId": command["commandId"], "expectedRevision": command["expectedRevision"], "turnId": command["turnId"] });
    match channel {
        "assistant:cancelTurn" => {
            base["action"] = json!("cancel");
            if command["attemptId"].as_str().is_some_and(|a| !a.is_empty()) {
                base["attemptId"] = command["attemptId"].clone();
            }
        }
        "assistant:retryParticipant" => {
            required(&command["participantId"], "A participant ID")?;
            required(&command["attemptId"], "An attempt ID")?;
            base["action"] = json!("retry");
            base["attemptId"] = command["attemptId"].clone();
            base["participantId"] = command["participantId"].clone();
        }
        _ => {
            required(&command["attemptId"], "An attempt ID")?;
            let resolution = command["resolution"].as_str();
            if resolution != Some("reconcile") && resolution != Some("retry") {
                return Err("Unknown attempt resolution.".into());
            }
            base["attemptId"] = command["attemptId"].clone();
            if resolution == Some("reconcile") {
                base["action"] = json!("reconcile");
                base["reconciliationNote"] =
                    json!(command["reconciliationNote"].as_str().unwrap_or_default());
            } else {
                base["action"] = json!("retry");
                base["acknowledgeDuplicateActionRisk"] =
                    json!(command["acknowledgeDuplicateActionRisk"] == true);
                if command["reconciliationEvidenceId"]
                    .as_str()
                    .is_some_and(|a| !a.is_empty())
                {
                    base["reconciliationEvidenceId"] = command["reconciliationEvidenceId"].clone();
                }
            }
        }
    }
    control(host, &base)
}

fn new_chat_id() -> String {
    format!("chat-{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

fn changed(host: &HostContext) {
    host.events().emit("assistant:chatsChanged", None);
}

fn chat_by_id(dir: &Path, id: &str) -> Fallible<Value> {
    let snapshot = chat::read_snapshot(dir)?;
    let record = if snapshot["activation"].is_null() {
        arr_of(&snapshot, "teamChats")
            .iter()
            .find(|c| c["id"] == id)
            .cloned()
    } else {
        arr_of(&snapshot, "conversations")
            .iter()
            .find(|c| c["id"] == id)
            .map(chat_record)
    };
    Ok(record.unwrap_or(Value::Null))
}

fn run(host: &HostContext, channel: &str, args: &[Value]) -> Fallible<Value> {
    let dir = host.config().user_data_dir.clone();
    let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
    match channel {
        "assistant:listChats" => {
            chat::activate(&dir)?;
            Ok(json!(summaries_for(
                &chat::read_snapshot(&dir)?,
                arg(0).as_str().unwrap_or_default()
            )))
        }
        "assistant:getChat" => {
            chat::activate(&dir)?;
            chat_by_id(&dir, arg(0).as_str().unwrap_or_default())
        }
        "assistant:getConversation" => {
            let coordinator = activate_and_coordinate(host)?;
            coordinator.initialize()?;
            Ok(coordinator
                .get_conversation(&required(&arg(0), "A conversation ID")?)?
                .unwrap_or(Value::Null))
        }
        "assistant:createChat" => {
            chat::activate(&dir)?;
            let stamp = now();
            let mut record = json!({ "id": new_chat_id(), "projectId": arg(0).as_str().unwrap_or_default(), "title": "New team chat", "createdAt": stamp, "updatedAt": stamp, "messages": [] });
            if let Some(key) = arg(1).as_str().filter(|k| !k.is_empty()) {
                record["issueKey"] = json!(key);
            }
            let conversation = import_legacy_chat(&record)?;
            chat::transaction(&dir, |snapshot| {
                arr_mut(snapshot, "conversations").push(conversation);
                Ok(())
            })?;
            changed(host);
            Ok(record)
        }
        "assistant:saveChat" => {
            if !chat::read_snapshot(&dir)?["activation"].is_null() {
                return Err(
                    "Legacy assistant writes are disabled after durable activation.".into(),
                );
            }
            Err("Whole-transcript replacement is rejected for durable conversations.".into())
        }
        "assistant:renameChat" => {
            chat::activate(&dir)?;
            let id = arg(0).as_str().unwrap_or_default().to_owned();
            let title = arg(1).as_str().unwrap_or_default().trim().to_owned();
            if title.is_empty() {
                return Err("A chat needs a name.".into());
            }
            chat::transaction(&dir, |snapshot| {
                let conversation = arr_mut(snapshot, "conversations")
                    .iter_mut()
                    .find(|c| c["id"] == id.as_str())
                    .ok_or_else(|| format!("Conversation {id} was not found."))?;
                conversation["title"] = json!(title.chars().take(120).collect::<String>());
                conversation["revision"] =
                    json!(conversation["revision"].as_i64().unwrap_or(0) + 1);
                Ok(())
            })?;
            changed(host);
            chat_by_id(&dir, &id)
        }
        "assistant:archiveChat" => {
            chat::activate(&dir)?;
            let id = arg(0).as_str().unwrap_or_default().to_owned();
            let archived = arg(1) == true;
            chat::transaction(&dir, |snapshot| {
                let conversation = arr_mut(snapshot, "conversations")
                    .iter_mut()
                    .find(|c| c["id"] == id.as_str())
                    .ok_or_else(|| format!("Team chat {id} was not found."))?;
                if archived {
                    conversation["archived"] = json!(true);
                } else {
                    conversation.as_object_mut().map(|o| o.remove("archived"));
                }
                conversation["revision"] =
                    json!(conversation["revision"].as_i64().unwrap_or(0) + 1);
                Ok(())
            })?;
            changed(host);
            chat_by_id(&dir, &id)
        }
        "assistant:deleteChat" => {
            let coordinator = activate_and_coordinate(host)?;
            coordinator.remove_conversation(arg(0).as_str().unwrap_or_default())?;
            changed(host);
            Ok(Value::Null)
        }
        "assistant:stageAttachments" => {
            let coordinator = activate_and_coordinate(host)?;
            let id = arg(0).as_str().unwrap_or_default().to_owned();
            if coordinator.get_conversation(&id)?.is_none() {
                return Err("Conversation was not found.".into());
            }
            Ok(json!(chat::stage_attachments(
                &dir,
                &id,
                arg(1).as_array().map_or(&[], Vec::as_slice)
            )?))
        }
        "assistant:submitTurn" => {
            let command = arg(0);
            let coordinator = activate_and_coordinate(host)?;
            let id = required(&command["conversationId"], "A conversation ID")?;
            coordinator.initialize()?;
            let target = coordinator
                .get_conversation(&id)?
                .ok_or_else(|| format!("Conversation {id} was not found."))?;
            if command["context"]["projectId"]
                .as_str()
                .is_some_and(|p| !p.is_empty())
                && target["projectId"].as_str().is_some_and(|p| !p.is_empty())
                && command["context"]["projectId"] != target["projectId"]
            {
                return Err("Page context belongs to a different project.".into());
            }
            let refs = command["attachmentRefs"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            chat::resolve_attachments(&dir, &id, &refs).map_err(|message| {
                if message == "ENOENT" || message.contains("Invalid attachment digest") {
                    "Unknown attachment reference.".to_owned()
                } else {
                    message
                }
            })?;
            if !refs.is_empty() {
                let options = &command["runtimeOptions"];
                if options["mode"].as_str().unwrap_or("chat") == "chat"
                    && options["toolMode"].as_str().unwrap_or("project-only") == "project-only"
                {
                    return Err(
                        "Choose an image-capable agent runtime before attaching images.".into(),
                    );
                }
            }
            coordinator.submit_turn(&command)
        }
        "assistant:control" => {
            let command = arg(0);
            required(&command["conversationId"], "A conversation ID")?;
            required(&command["commandId"], "A command ID")?;
            let action = command["action"].as_str().unwrap_or_default();
            if ![
                "cancel",
                "retry",
                "pin",
                "unpin",
                "resume-context",
                "reconcile",
            ]
            .contains(&action)
            {
                return Err("Unknown control action.".into());
            }
            if !command["expectedRevision"].is_i64() {
                return Err("An expected revision is required.".into());
            }
            if matches!(action, "cancel" | "retry" | "reconcile") {
                required(&command["turnId"], "A turn ID")?;
            }
            if matches!(action, "pin" | "unpin") {
                required(&command["messageId"], "A message ID")?;
            }
            Ok(control(host, &command)?["conversation"].clone())
        }
        "assistant:cancelTurn" | "assistant:retryParticipant" | "assistant:resolveAttempt" => {
            typed_control(host, channel, &arg(0))
        }
        "assistant:turn" => {
            if !chat::read_snapshot(&dir)?["activation"].is_null() {
                return Err("Legacy assistant turns are disabled.".into());
            }
            block_on(chat::run_assistant_turn(host, &arg(0)))
        }
        "assistant:sessionTurn" => block_on(chat::run_assistant_turn(host, &arg(0))),
        "assistant:teamReview" => block_on(chat::run_team_review(host, &arg(0))),
        _ => Err(format!("Unknown assistant channel: {channel}")),
    }
}

pub fn dispatch(
    host: &HostContext,
    _user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    run(host, channel, args).map_err(failure)
}
