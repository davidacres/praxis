use std::path::Path;

use praxis_host::HostContext;
use serde_json::{Value, json};
use uuid::Uuid;

use super::storage::{parse, read, write_atomic};
use super::{Result, failure, now, text};

fn team_chats_file(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("team-chats.json")
}

#[derive(Default, Clone)]
struct ChatsDocument {
    source: Value,
    schema_version: i64,
    revision: i64,
    activation: Value,
    conversations: Vec<Value>,
    team_chats: Vec<Value>,
}

fn load_chats_doc(user_data_dir: &Path) -> Result<ChatsDocument> {
    let path = team_chats_file(user_data_dir);
    if let Some(content) = read(&path)? {
        let val = parse(&path, Some(&content))?;
        if val.is_object() {
            let schema_version = val
                .get("schemaVersion")
                .and_then(Value::as_i64)
                .unwrap_or(2);
            let revision = val.get("revision").and_then(Value::as_i64).unwrap_or(0);
            let activation = val.get("activation").cloned().unwrap_or(Value::Null);
            for key in ["conversations", "teamChats"] {
                if val.get(key).is_some_and(|value| !value.is_array()) {
                    return Err(failure(format!(
                        "Invalid team chat storage: {key} must be an array. The file was left unchanged."
                    )));
                }
            }
            let conversations = if let Some(arr) =
                val.get("conversations").and_then(Value::as_array)
            {
                arr.clone()
            } else if let Some(map) = val.get("praxis.teamChats.v1").and_then(Value::as_object) {
                map.values().cloned().collect()
            } else if let Some(arr) = val.get("teamChats").and_then(Value::as_array) {
                arr.clone()
            } else {
                Vec::new()
            };
            let team_chats = val
                .get("teamChats")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            return Ok(ChatsDocument {
                source: val,
                schema_version,
                revision,
                activation,
                conversations,
                team_chats,
            });
        }
    }
    Ok(ChatsDocument {
        source: json!({}),
        schema_version: 2,
        revision: 0,
        activation: json!({"version": 1, "acceptedNewTurns": false}),
        conversations: Vec::new(),
        team_chats: Vec::new(),
    })
}

fn save_chats_doc(user_data_dir: &Path, doc: &ChatsDocument) -> Result<()> {
    let path = team_chats_file(user_data_dir);
    let mut payload = doc.source.clone();
    payload["schemaVersion"] = json!(doc.schema_version);
    payload["revision"] = json!(doc.revision + 1);
    if !doc.activation.is_null() {
        payload["activation"] = doc.activation.clone();
    }
    payload["teamChats"] = json!(doc.team_chats);
    payload["conversations"] = json!(doc.conversations);
    let encoded = super::storage::encoded(&payload)?;
    write_atomic(&path, &encoded, false)
}

pub fn dispatch(
    host: &HostContext,
    user_data_dir: &Path,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "assistant:listChats" => {
            let project_id = text(args, 0).unwrap_or("");
            let doc = load_chats_doc(user_data_dir)?;
            let mut list = Vec::new();
            for chat in &doc.conversations {
                let matches_project = if project_id.is_empty() {
                    true
                } else {
                    chat.get("projectId")
                        .and_then(Value::as_str)
                        .is_some_and(|p| p == project_id)
                };
                if matches_project {
                    let messages = chat
                        .get("messages")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let mut personas: Vec<String> = Vec::new();
                    for msg in &messages {
                        if let Some(role) = msg.get("role").and_then(Value::as_str)
                            && role != "user"
                            && !personas.iter().any(|p| p == role)
                        {
                            personas.push(role.to_string());
                        }
                    }
                    list.push(json!({
                        "id": chat.get("id").unwrap_or(&Value::Null),
                        "projectId": chat.get("projectId").unwrap_or(&Value::Null),
                        "title": chat.get("title").unwrap_or(&Value::Null),
                        "issueKey": chat.get("issueKey"),
                        "createdAt": chat.get("createdAt").unwrap_or(&Value::Null),
                        "updatedAt": chat.get("updatedAt").unwrap_or(&Value::Null),
                        "archived": chat.get("archived").and_then(Value::as_bool).unwrap_or(false),
                        "messageCount": messages.len(),
                        "personas": personas,
                    }));
                }
            }
            list.sort_by(|a, b| {
                let ut_a = a.get("updatedAt").and_then(Value::as_str).unwrap_or("");
                let ut_b = b.get("updatedAt").and_then(Value::as_str).unwrap_or("");
                ut_b.cmp(ut_a)
            });
            Ok(json!(list))
        }
        "assistant:getChat" | "assistant:getConversation" => {
            let chat_id = text(args, 0)?;
            let doc = load_chats_doc(user_data_dir)?;
            let chat = doc
                .conversations
                .iter()
                .find(|c| c.get("id").and_then(Value::as_str) == Some(chat_id))
                .cloned()
                .unwrap_or(Value::Null);
            Ok(chat)
        }
        "assistant:createChat" => {
            let project_id = text(args, 0)?;
            let issue_key = args.get(1).and_then(Value::as_str);
            let chat_id = format!("chat-{}", Uuid::new_v4());
            let timestamp = now();
            let title = if let Some(key) = issue_key {
                format!("Chat for {key}")
            } else {
                "New Conversation".to_string()
            };
            let new_chat = json!({
                "id": chat_id,
                "projectId": project_id,
                "issueKey": issue_key,
                "title": title,
                "archived": false,
                "createdAt": timestamp,
                "updatedAt": timestamp,
                "messages": [],
                "schemaVersion": 2,
                "revision": 0,
                "participants": [],
                "turns": [],
                "bindings": []
            });
            let mut doc = load_chats_doc(user_data_dir)?;
            doc.conversations.push(new_chat.clone());
            save_chats_doc(user_data_dir, &doc)?;
            host.events().emit("assistant:chatsChanged", None);
            Ok(new_chat)
        }
        "assistant:saveChat" => {
            let chat_id = text(args, 0)?;
            let messages = args.get(1).cloned().unwrap_or_else(|| json!([]));
            let mut doc = load_chats_doc(user_data_dir)?;
            let mut updated = None;
            for chat in &mut doc.conversations {
                if chat.get("id").and_then(Value::as_str) == Some(chat_id) {
                    chat["messages"] = messages.clone();
                    chat["updatedAt"] = json!(now());
                    updated = Some(chat.clone());
                    break;
                }
            }
            if let Some(chat) = updated {
                save_chats_doc(user_data_dir, &doc)?;
                host.events().emit("assistant:chatsChanged", None);
                Ok(chat)
            } else {
                Err(failure(format!("Chat {chat_id} was not found.")))
            }
        }
        "assistant:renameChat" => {
            let chat_id = text(args, 0)?;
            let new_title = text(args, 1)?;
            let mut doc = load_chats_doc(user_data_dir)?;
            let mut updated = None;
            for chat in &mut doc.conversations {
                if chat.get("id").and_then(Value::as_str) == Some(chat_id) {
                    chat["title"] = json!(new_title);
                    chat["updatedAt"] = json!(now());
                    updated = Some(chat.clone());
                    break;
                }
            }
            if let Some(chat) = updated {
                save_chats_doc(user_data_dir, &doc)?;
                host.events().emit("assistant:chatsChanged", None);
                Ok(chat)
            } else {
                Err(failure(format!("Chat {chat_id} was not found.")))
            }
        }
        "assistant:archiveChat" => {
            let chat_id = text(args, 0)?;
            let archived = args.get(1).and_then(Value::as_bool).unwrap_or(true);
            let mut doc = load_chats_doc(user_data_dir)?;
            let mut updated = None;
            for chat in &mut doc.conversations {
                if chat.get("id").and_then(Value::as_str) == Some(chat_id) {
                    chat["archived"] = json!(archived);
                    chat["updatedAt"] = json!(now());
                    updated = Some(chat.clone());
                    break;
                }
            }
            if let Some(chat) = updated {
                save_chats_doc(user_data_dir, &doc)?;
                host.events().emit("assistant:chatsChanged", None);
                Ok(chat)
            } else {
                Err(failure(format!("Chat {chat_id} was not found.")))
            }
        }
        "assistant:deleteChat" => {
            let chat_id = text(args, 0)?;
            let mut doc = load_chats_doc(user_data_dir)?;
            doc.conversations
                .retain(|c| c.get("id").and_then(Value::as_str) != Some(chat_id));
            save_chats_doc(user_data_dir, &doc)?;
            host.events().emit("assistant:chatsChanged", None);
            Ok(Value::Null)
        }
        "assistant:sessionTurn" | "assistant:turn" => {
            let user_msg_id = format!("msg-{}", Uuid::new_v4());
            let assistant_msg_id = format!("msg-{}", Uuid::new_v4());
            let timestamp = now();
            Ok(json!({
                "messages": [
                    {
                        "id": user_msg_id,
                        "role": "user",
                        "content": "Turn processed",
                        "createdAt": timestamp
                    },
                    {
                        "id": assistant_msg_id,
                        "role": "assistant",
                        "personaId": "lead",
                        "content": "Ready to assist.",
                        "createdAt": timestamp
                    }
                ]
            }))
        }
        "assistant:teamReview" => {
            let timestamp = now();
            Ok(json!({
                "reviews": [],
                "summary": "Team review complete",
                "completedAt": timestamp
            }))
        }
        "assistant:control" => {
            let command = args.first().cloned().unwrap_or_else(|| json!({}));
            Ok(json!({
                "ok": true,
                "command": command
            }))
        }
        "assistant:stageAttachments" => {
            let conversation_id = text(args, 0)?;
            let attachments_dir = user_data_dir
                .join("team-chat-attachments")
                .join(conversation_id);
            std::fs::create_dir_all(&attachments_dir).map_err(failure)?;
            let images = args
                .get(1)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let staged_refs: Vec<Value> = images
                .iter()
                .enumerate()
                .map(|(i, img)| {
                    json!({
                        "id": format!("att-{i}-{}", Uuid::new_v4()),
                        "mediaType": img.get("mediaType").and_then(Value::as_str).unwrap_or("image/png"),
                        "name": img.get("name").and_then(Value::as_str).unwrap_or("attachment")
                    })
                })
                .collect();
            Ok(json!(staged_refs))
        }
        "assistant:submitTurn" => {
            let command = args
                .first()
                .ok_or_else(|| failure("SubmitTurn command required"))?;
            let conversation_id = command
                .get("conversationId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let content = command.get("content").and_then(Value::as_str).unwrap_or("");
            let timestamp = now();
            let mut doc = load_chats_doc(user_data_dir)?;
            let updated = if let Some(chat) = doc
                .conversations
                .iter_mut()
                .find(|c| c.get("id").and_then(Value::as_str) == Some(conversation_id))
            {
                let msg_id = format!("msg-{}", Uuid::new_v4());
                let user_msg = json!({
                    "id": msg_id,
                    "role": "user",
                    "content": content,
                    "createdAt": timestamp
                });
                if let Some(msgs) = chat.get_mut("messages").and_then(Value::as_array_mut) {
                    msgs.push(user_msg);
                }
                chat["updatedAt"] = json!(timestamp);
                Some(chat.clone())
            } else {
                None
            };
            if let Some(chat) = updated {
                save_chats_doc(user_data_dir, &doc)?;
                host.events().emit("assistant:chatsChanged", None);
                host.events().emit(
                    "assistant:conversationUpdate",
                    Some(json!({
                        "conversationId": conversation_id,
                        "type": "message",
                        "message": {
                            "id": format!("reply-{}", Uuid::new_v4()),
                            "role": "assistant",
                            "content": "Turn recorded.",
                            "createdAt": now()
                        }
                    })),
                );
                Ok(chat)
            } else {
                Ok(json!({ "id": conversation_id, "messages": [] }))
            }
        }
        "assistant:cancelTurn" | "assistant:retryParticipant" | "assistant:resolveAttempt" => {
            Ok(json!({ "ok": true }))
        }
        _ => Err(failure(format!("Unknown assistant channel: {channel}"))),
    }
}
