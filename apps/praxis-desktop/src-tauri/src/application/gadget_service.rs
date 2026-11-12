//! The host-side pipeline a gadget action travels through. Ports `GadgetService` (with its action
//! ledger, lifecycle and scope rules) from core and the executor in the retired `gadgetIpc.ts`.
//!
//! Agent reply -> parsed blocks -> renderer -> user action -> scope and lifecycle checks ->
//! ledger -> executor -> structured result. Blocks and the ledger live in `gadgets.json` under
//! `praxis.gadgetBlocks` and `praxis.gadgetActionLedger`, as the original wrote them.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use praxis_ai::gadgets::contracts::{GadgetActionValue, GadgetEnvelope, GadgetScope};
use praxis_ai::gadgets::validation::validate_gadget_action_value;
use praxis_host::HostContext;
use serde_json::{Value, json};
use uuid::Uuid;

use super::session_store::store;
use super::storage::{encoded, parse, read, write_atomic};
use super::{Result, failure, now, text};

pub const CHANNELS: [&str; 7] = [
    "gadgets:getBlocks",
    "gadgets:publish",
    "gadgets:publishFromText",
    "gadgets:submit",
    "gadgets:replay",
    "gadgets:revoke",
    "gadgets:clear",
];

const BLOCKS_KEY: &str = "praxis.gadgetBlocks";
const LEDGER_KEY: &str = "praxis.gadgetActionLedger";
const FILE: &str = "gadgets.json";
const CONTRACT_VERSION: u64 = 1;
/// The workflow gate the ticket review's "Apply to ticket" action satisfies.
pub const TICKET_REVIEW_APPLY_GATE: &str = "ticket-review:apply";

#[derive(Default)]
struct State {
    loaded: bool,
    blocks: BTreeMap<String, Vec<Value>>,
    /// Ledger records, oldest first.
    records: Vec<Value>,
    events: Vec<Value>,
    sequence: u64,
}

fn states() -> &'static Mutex<HashMap<PathBuf, Mutex<State>>> {
    static STATES: OnceLock<Mutex<HashMap<PathBuf, Mutex<State>>>> = OnceLock::new();
    STATES.get_or_init(Default::default)
}

/// Runs `f` on the profile's state, loading it from disk the first time.
fn with_state<T>(dir: &Path, f: impl FnOnce(&mut State) -> T) -> T {
    let mut all = states()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let slot = all.entry(dir.to_path_buf()).or_default();
    let state = slot
        .get_mut()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !state.loaded {
        let path = dir.join(FILE);
        if let Ok(Some(raw)) = read(&path)
            && let Ok(document) = parse(&path, Some(&raw))
        {
            if let Some(map) = document.get(BLOCKS_KEY).and_then(Value::as_object) {
                for (session, blocks) in map {
                    if let Some(list) = blocks.as_array() {
                        state.blocks.insert(
                            session.clone(),
                            list.iter().filter(|b| b.is_object()).cloned().collect(),
                        );
                    }
                }
            }
            let ledger = &document[LEDGER_KEY];
            state.records = ledger["records"].as_array().cloned().unwrap_or_default();
            state.events = ledger["events"].as_array().cloned().unwrap_or_default();
            state.sequence = ledger["sequence"]
                .as_u64()
                .or_else(|| state.events.last().and_then(|e| e["sequence"].as_u64()))
                .unwrap_or(0);
        }
        state.loaded = true;
    }
    f(state)
}

fn persist(dir: &Path, state: &State) {
    let document = json!({
        BLOCKS_KEY: state.blocks,
        LEDGER_KEY: { "records": state.records, "events": state.events, "sequence": state.sequence },
    });
    if let Ok(text) = encoded(&document) {
        let _ = write_atomic(&dir.join(FILE), &text, false);
    }
}

// ── ledger ───────────────────────────────────────────────────────────────

fn put_record(state: &mut State, record: Value) {
    let key = record["idempotencyKey"].clone();
    match state
        .records
        .iter_mut()
        .find(|r| r["idempotencyKey"] == key)
    {
        Some(existing) => *existing = record.clone(),
        None => state.records.push(record.clone()),
    }
    state.sequence += 1;
    state.events.push(json!({
        "sequence": state.sequence, "at": record["updatedAt"], "correlationId": record["correlationId"], "idempotencyKey": record["idempotencyKey"],
        "gadgetId": record["gadgetId"], "status": record["status"], "scope": record["scope"],
    }));
}

/// The latest status that settled a gadget: a refused or failed attempt leaves it answerable.
fn effective_status(state: &State, gadget_id: &str, session_id: &str) -> Option<String> {
    state
        .records
        .iter()
        .filter(|r| {
            r["gadgetId"] == gadget_id
                && r["scope"]["sessionId"] == session_id
                && matches!(r["status"].as_str(), Some("accepted" | "completed"))
        })
        .max_by(|a, b| a["submittedAt"].as_str().cmp(&b["submittedAt"].as_str()))
        .and_then(|r| r["status"].as_str().map(str::to_owned))
}

fn recorded_answer(state: &State, gadget_id: &str, session_id: &str) -> Option<Value> {
    state
        .records
        .iter()
        .filter(|r| {
            r["gadgetId"] == gadget_id
                && r["scope"]["sessionId"] == session_id
                && matches!(r["status"].as_str(), Some("accepted" | "completed"))
        })
        .max_by(|a, b| a["submittedAt"].as_str().cmp(&b["submittedAt"].as_str()))
        .map(|r| r["evidence"]["value"].clone())
        .filter(|v| !v.is_null())
}

/// Stable digest of a submitted value: key order must not change the result.
fn digest(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), canonical(v)))
                    .collect::<std::collections::BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            other => other.clone(),
        }
    }
    format!(
        "{:x}",
        Sha256::digest(canonical(value).to_string().as_bytes())
    )
    .chars()
    .take(32)
    .collect()
}

fn result_of(record: &Value, replay: bool) -> Value {
    let mut result = json!({
        "version": CONTRACT_VERSION, "gadgetId": record["gadgetId"], "actionId": record["actionId"], "correlationId": record["correlationId"],
        "idempotencyKey": record["idempotencyKey"], "status": record["status"], "at": record["updatedAt"], "replay": replay,
    });
    for field in ["error", "outcome", "message"] {
        if !record[field].is_null() {
            result[field] = record[field].clone();
        }
    }
    result
}

fn rejected(request: &Value, error: Value, at: &str) -> Value {
    json!({
        "version": CONTRACT_VERSION, "gadgetId": request["gadgetId"], "actionId": request["actionId"],
        "correlationId": request["correlationId"], "idempotencyKey": request["idempotencyKey"], "status": "rejected", "at": at,
        "error": error, "message": error["message"],
    })
}

fn error(code: &str, message: &str, retryable: bool) -> Value {
    json!({ "code": code, "message": message, "retryable": retryable })
}

// ── lifecycle ────────────────────────────────────────────────────────────

fn is_expired(envelope: &Value, at: &str) -> bool {
    let (Some(expires), Ok(now)) = (
        envelope["expiresAt"].as_str(),
        chrono::DateTime::parse_from_rfc3339(at),
    ) else {
        return false;
    };
    chrono::DateTime::parse_from_rfc3339(expires).is_ok_and(|expires| expires <= now)
}

/// Gadget IDs a later gadget declared it supersedes.
fn superseded_ids(blocks: &[Value]) -> HashSet<String> {
    blocks
        .iter()
        .filter(|b| b["type"] == "gadget")
        .filter_map(|b| b["gadget"]["supersedes"].as_str().map(str::to_owned))
        .collect()
}

/// A gadget's state is derived, never stored as the single source of truth.
fn resolve_state(
    envelope: &Value,
    at: &str,
    superseded: &HashSet<String>,
    submission: Option<&str>,
    connected: bool,
) -> &'static str {
    match envelope["state"].as_str() {
        Some("revoked") => return "revoked",
        Some("submitting") => return "submitting",
        _ => {}
    }
    match submission {
        Some("completed") => return "completed",
        Some("accepted") => return "submitted",
        _ => {}
    }
    if envelope["gadgetId"]
        .as_str()
        .is_some_and(|id| superseded.contains(id))
    {
        return "superseded";
    }
    if is_expired(envelope, at) {
        return "expired";
    }
    if !connected {
        return "disconnected";
    }
    "active"
}

fn inert_error(state: &str) -> Option<Value> {
    Some(match state {
        "expired" => error(
            "gadget-expired",
            "This expired before it was answered.",
            false,
        ),
        "superseded" => error(
            "gadget-superseded",
            "A newer version of this replaced it.",
            false,
        ),
        "submitted" | "completed" => error(
            "already-submitted",
            "This has already been answered.",
            false,
        ),
        "revoked" => error(
            "gadget-not-found",
            "This was withdrawn and can no longer be answered.",
            false,
        ),
        "disconnected" => error(
            "scope-mismatch",
            "Not connected to the host that issued this.",
            true,
        ),
        _ => return None,
    })
}

// ── blocks ───────────────────────────────────────────────────────────────

fn decorate(state: &State, blocks: &[Value], connected: bool) -> Vec<Value> {
    let at = now();
    let superseded = superseded_ids(blocks);
    blocks
        .iter()
        .map(|block| {
            if block["type"] != "gadget" {
                return block.clone();
            }
            let gadget = &block["gadget"];
            let id = gadget["gadgetId"].as_str().unwrap_or_default();
            let session = gadget["scope"]["sessionId"].as_str().unwrap_or_default();
            let status = effective_status(state, id, session);
            let lifecycle = resolve_state(gadget, &at, &superseded, status.as_deref(), connected);
            let mut decorated = block.clone();
            decorated["gadget"]["state"] = json!(lifecycle);
            if let Some(answer) = recorded_answer(state, id, session) {
                decorated["gadget"]["answer"] = answer;
            }
            decorated
        })
        .collect()
}

/// Validates and stores a response's blocks for a session; returns what a renderer should draw.
fn publish_blocks(dir: &Path, session_id: &str, published: Vec<Value>) -> Vec<Value> {
    with_state(dir, |state| {
        let mut merged = state.blocks.get(session_id).cloned().unwrap_or_default();
        for block in published {
            // A gadget that re-publishes the same id replaces its block in place; so does a block
            // that re-uses a block id (a refused gadget comes back as a fallback under the same id).
            let index = if block["type"] == "gadget" {
                merged.iter().position(|c| {
                    (c["type"] == "gadget"
                        && c["gadget"]["gadgetId"] == block["gadget"]["gadgetId"])
                        || c["blockId"] == block["blockId"]
                })
            } else {
                merged.iter().position(|c| {
                    c["blockId"] == block["blockId"]
                        || (c["type"] == "markdown"
                            && block["type"] == "markdown"
                            && c["markdown"] == block["markdown"])
                })
            };
            match index {
                Some(i) => merged[i] = block,
                None => merged.push(block),
            }
        }
        state.blocks.insert(session_id.to_owned(), merged);
        persist(dir, state);
        decorate(state, &state.blocks[session_id], true)
    })
}

/// A raw block from `gadgets:publish`: markdown passes through, a gadget is validated or degraded to text.
fn coerce_raw_block(raw: &Value, session_id: &str, index: usize) -> Value {
    let block_id = raw["blockId"].as_str().map_or_else(
        || format!("{session_id}-block-{}", index + 1),
        str::to_owned,
    );
    if raw["type"] == "markdown" {
        return json!({ "type": "markdown", "blockId": block_id, "markdown": raw["markdown"] });
    }
    praxis_ai::gadgets::coerce::coerce_gadget_block(&raw["gadget"], &block_id)
}

/// The scope a session's gadgets are issued and answered against, minted from the live record.
fn session_scope(dir: &Path, session_id: &str) -> Option<GadgetScope> {
    let record = store(dir)
        .all()
        .ok()?
        .into_values()
        .find(|r| r["sessionId"] == session_id)?;
    Some(GadgetScope {
        host_id: host_id(dir),
        session_id: session_id.to_owned(),
        project_id: record["connectionId"]
            .as_str()
            .filter(|c| !c.is_empty())
            .map(str::to_owned),
        work_id: record["issueKey"]
            .as_str()
            .filter(|c| !c.is_empty())
            .map(str::to_owned),
        revision: None,
    })
}

/// This installation's stable host id.
fn host_id(dir: &Path) -> String {
    let path = dir.join("host-identity.json");
    if let Ok(Some(raw)) = read(&path)
        && let Ok(document) = parse(&path, Some(&raw))
        && let Some(id) = document["praxis.hostId"].as_str()
    {
        return id.to_owned();
    }
    let id = Uuid::new_v4().to_string();
    if let Ok(text) = encoded(&json!({ "praxis.hostId": id })) {
        let _ = write_atomic(&path, &text, false);
    }
    id
}

// ── submission ───────────────────────────────────────────────────────────

/// Is this action aimed where its gadget was issued, and may it proceed at all?
fn authorize(envelope: &Value, request: &Value, context: &GadgetScope) -> Option<Value> {
    if request["gadgetId"] != envelope["gadgetId"] {
        return Some(error(
            "scope-mismatch",
            "This action does not belong to this gadget.",
            false,
        ));
    }
    let scope = &envelope["scope"];
    if envelope["scope"]["hostId"] != json!(context.host_id) {
        return Some(error(
            "scope-mismatch",
            "This was issued by a different host.",
            false,
        ));
    }
    if scope["sessionId"] != json!(context.session_id) {
        return Some(error(
            "scope-mismatch",
            "This belongs to a different session.",
            false,
        ));
    }
    if scope["projectId"].as_str() != context.project_id.as_deref() {
        return Some(error(
            "scope-mismatch",
            "The project changed since this was asked.",
            false,
        ));
    }
    if scope["workId"].as_str() != context.work_id.as_deref() {
        return Some(error(
            "scope-mismatch",
            "The work item changed since this was asked.",
            false,
        ));
    }
    let action_id = request["actionId"].as_str().unwrap_or_default();
    let Some(descriptor) = envelope["actions"]
        .as_array()
        .and_then(|a| a.iter().find(|d| d["actionId"] == action_id))
    else {
        return Some(error(
            "unknown-action",
            &format!("This gadget does not offer an action called \"{action_id}\"."),
            false,
        ));
    };
    if descriptor["effect"] == "informational" {
        return None;
    }
    // Local-first Praxis has no gate state of its own: gates belong to a workflow run, which
    // enforces them where a run advances. A mutating action must still declare one.
    if descriptor["gate"].as_str().is_none() {
        return Some(error(
            "gate-required",
            "This action changes state but declares no workflow gate.",
            false,
        ));
    }
    None
}

/// Records and carries out an answer to a gadget: the one path for the desktop and the phone.
pub fn submit(host: &HostContext, dir: &Path, request: &Value) -> Value {
    let at = now();
    let mut request = request.clone();
    for field in ["correlationId", "idempotencyKey"] {
        if request[field].as_str().is_none_or(str::is_empty) {
            request[field] = json!(Uuid::new_v4().to_string());
        }
    }
    let value: GadgetActionValue = match serde_json::from_value(request["value"].clone()) {
        Ok(value) => value,
        Err(_) => {
            return rejected(
                &request,
                error(
                    "value-invalid",
                    "That answer was not in a form the host understands.",
                    false,
                ),
                &at,
            );
        }
    };
    let session_id = request["sessionId"].as_str().unwrap_or_default().to_owned();
    let gadget_id = request["gadgetId"].as_str().unwrap_or_default().to_owned();
    let scope = session_scope(dir, &session_id);
    let envelope = with_state(dir, |state| {
        state.blocks.get(&session_id).and_then(|blocks| {
            blocks
                .iter()
                .find(|b| b["type"] == "gadget" && b["gadget"]["gadgetId"] == gadget_id)
                .map(|b| b["gadget"].clone())
        })
    });
    let (Some(scope), Some(envelope)) = (scope.clone(), envelope) else {
        let (code, message) = if scope.is_some() {
            ("gadget-not-found", "This gadget is no longer available.")
        } else {
            (
                "scope-mismatch",
                "That session is no longer open on this host.",
            )
        };
        return rejected(&request, error(code, message, false), &at);
    };

    // A retry of an already-recorded submission is served before the lifecycle check: the gadget
    // is legitimately `submitted` by then, and refusing the retry would turn a dropped ack into a
    // dead end.
    let digest_of_value = digest(&request["value"]);
    let key = request["idempotencyKey"].clone();
    let prior = with_state(dir, |state| {
        state
            .records
            .iter()
            .find(|r| r["idempotencyKey"] == key)
            .cloned()
    });
    if let Some(prior) = prior.filter(|p| p["status"] != "rejected") {
        if prior["valueDigest"] != digest_of_value {
            return rejected(
                &request,
                error(
                    "duplicate-action",
                    "That submission ID was already used with a different answer.",
                    false,
                ),
                &at,
            );
        }
        return result_of(&prior, true);
    }

    let (lifecycle, blocks_snapshot) = with_state(dir, |state| {
        let blocks = state.blocks.get(&session_id).cloned().unwrap_or_default();
        let status = effective_status(state, &gadget_id, &session_id);
        (
            resolve_state(
                &envelope,
                &at,
                &superseded_ids(&blocks),
                status.as_deref(),
                true,
            ),
            blocks,
        )
    });
    let _ = blocks_snapshot;
    if let Some(inert) = inert_error(lifecycle) {
        return rejected(&request, inert, &at);
    }
    if let Some(denial) = authorize(&envelope, &request, &scope) {
        return rejected(&request, denial, &at);
    }
    if let Ok(typed) = serde_json::from_value::<GadgetEnvelope>(envelope.clone())
        && let Err(reason) = validate_gadget_action_value(&typed, &value)
    {
        return rejected(&request, json!(reason), &at);
    }

    // Admission: the only place a record is created, so every action carries its evidence.
    let action_id = request["actionId"].as_str().unwrap_or_default().to_owned();
    let descriptor = envelope["actions"]
        .as_array()
        .and_then(|a| a.iter().find(|d| d["actionId"] == action_id))
        .cloned()
        .unwrap_or(Value::Null);
    let mut evidence = json!({
        "kind": envelope["kind"], "prompt": envelope["fallbackText"], "actionLabel": descriptor["label"], "effect": descriptor["effect"],
        "value": request["value"], "issuedAt": envelope["issuedAt"],
    });
    if !descriptor["gate"].is_null() {
        evidence["gate"] = descriptor["gate"].clone();
    }
    let record = json!({
        "idempotencyKey": request["idempotencyKey"], "correlationId": request["correlationId"], "gadgetId": gadget_id, "actionId": action_id,
        "scope": envelope["scope"], "status": "accepted", "submittedAt": at, "updatedAt": at, "valueDigest": digest_of_value, "evidence": evidence,
    });
    with_state(dir, |state| {
        put_record(state, record.clone());
        persist(dir, state);
    });

    // The executor: an approval gadget approves the real run, a ticket review's apply form writes
    // the ticket, and everything else only turns the recorded answer into a confirmation.
    let outcome = execute(host, dir, &envelope, &descriptor, &request, &value);
    let settled = with_state(dir, |state| {
        let mut settled = state
            .records
            .iter()
            .find(|r| r["idempotencyKey"] == request["idempotencyKey"])
            .cloned()
            .unwrap_or(record.clone());
        match outcome {
            Ok((result, message)) => {
                settled["status"] = json!("completed");
                if !result.is_null() {
                    settled["outcome"] = result;
                }
                settled["message"] = json!(message);
            }
            Err(message) => {
                settled["status"] = json!("failed");
                settled["error"] =
                    json!({ "code": "value-invalid", "message": message, "retryable": true });
            }
        }
        settled["updatedAt"] = json!(now());
        put_record(state, settled.clone());
        persist(dir, state);
        settled
    });
    host.events()
        .emit("gadgets:changed", Some(json!(session_id)));
    result_of(&settled, false)
}

fn execute(
    host: &HostContext,
    dir: &Path,
    envelope: &Value,
    descriptor: &Value,
    request: &Value,
    value: &GadgetActionValue,
) -> std::result::Result<(Value, String), String> {
    let label = descriptor["label"]
        .as_str()
        .or_else(|| request["actionId"].as_str())
        .unwrap_or_default()
        .to_owned();
    if envelope["kind"] == "form"
        && descriptor["effect"] == "mutating"
        && descriptor["gate"] == TICKET_REVIEW_APPLY_GATE
        && let GadgetActionValue::Form { fields } = value
    {
        return super::ai_review::apply_ticket_review(
            host,
            dir,
            envelope["scope"]["sessionId"].as_str().unwrap_or_default(),
            fields,
        );
    }
    Ok(match value {
        GadgetActionValue::Choice { selected } => (
            json!({ "selected": selected }),
            format!("Recorded: {label}."),
        ),
        GadgetActionValue::Selection { selected } => (
            json!({ "selected": selected }),
            format!("Recorded {} selection(s).", selected.len()),
        ),
        GadgetActionValue::Confirmation { confirmed } => (
            json!({ "confirmed": confirmed }),
            if *confirmed {
                format!("Confirmed: {label}.")
            } else {
                "Declined — nothing was changed.".to_owned()
            },
        ),
        GadgetActionValue::Form { fields } => {
            (json!({ "fields": fields }), format!("Recorded: {label}."))
        }
        GadgetActionValue::None => (
            json!({ "acknowledged": true }),
            format!("Recorded: {label}."),
        ),
    })
}

// ── channels ─────────────────────────────────────────────────────────────

pub fn dispatch(
    host: &HostContext,
    dir: &Path,
    channel: &str,
    args: &[Value],
) -> Option<Result<Value>> {
    Some(match channel {
        "gadgets:getBlocks" => text(args, 0).map(|session| {
            with_state(dir, |state| {
                json!(decorate(
                    state,
                    state.blocks.get(session).map_or(&[][..], Vec::as_slice),
                    true
                ))
            })
        }),
        "gadgets:publish" => (|| {
            let session = text(args, 0)?;
            let raw: Vec<Value> = args
                .get(1)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let blocks = raw
                .iter()
                .enumerate()
                .map(|(i, b)| coerce_raw_block(b, session, i))
                .collect();
            let published = publish_blocks(dir, session, blocks);
            host.events().emit("gadgets:changed", Some(json!(session)));
            Ok(json!(published))
        })(),
        "gadgets:publishFromText" => (|| {
            let session = text(args, 0)?;
            let existing = || {
                with_state(dir, |state| {
                    json!(decorate(
                        state,
                        state.blocks.get(session).map_or(&[][..], Vec::as_slice),
                        true
                    ))
                })
            };
            // No live session means no scope to pin a gadget to; keep a stale transcript readable.
            let Some(scope) = session_scope(dir, session) else {
                return Ok(existing());
            };
            let parsed = praxis_ai::gadgets::coerce::parse_and_coerce_blocks(
                text(args, 2).unwrap_or(""),
                &json!(scope),
                &now(),
                text(args, 1).unwrap_or("block"),
            );
            if !parsed.contains_gadget {
                return Ok(existing());
            }
            let blocks: Vec<Value> = parsed.blocks;
            let published = publish_blocks(dir, session, blocks);
            host.events().emit("gadgets:changed", Some(json!(session)));
            Ok(json!(published))
        })(),
        "gadgets:submit" => args
            .first()
            .map(|request| submit(host, dir, request))
            .ok_or_else(|| failure("Gadget submission request is required.")),
        "gadgets:replay" => {
            let after = args.first().and_then(Value::as_u64).unwrap_or(0);
            Ok(with_state(dir, |state| {
                json!(
                    state
                        .events
                        .iter()
                        .filter(|e| e["sequence"].as_u64().unwrap_or(0) > after)
                        .take(200)
                        .cloned()
                        .collect::<Vec<_>>()
                )
            }))
        }
        "gadgets:revoke" => (|| {
            let (session, gadget) = (text(args, 0)?, text(args, 1)?);
            with_state(dir, |state| {
                if let Some(block) = state.blocks.get_mut(session).and_then(|blocks| {
                    blocks
                        .iter_mut()
                        .find(|b| b["type"] == "gadget" && b["gadget"]["gadgetId"] == gadget)
                }) {
                    block["gadget"]["state"] = json!("revoked");
                }
                persist(dir, state);
            });
            host.events().emit("gadgets:changed", Some(json!(session)));
            Ok(Value::Null)
        })(),
        "gadgets:clear" => (|| {
            let session = text(args, 0)?;
            clear_session(dir, session);
            host.events().emit("gadgets:changed", Some(json!(session)));
            Ok(Value::Null)
        })(),
        _ => return None,
    })
}

/// Drops every gadget a session issued (its conversation is about to stop existing).
pub fn clear_session(dir: &Path, session_id: &str) {
    with_state(dir, |state| {
        state.blocks.remove(session_id);
        persist(dir, state);
    });
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use praxis_ai::gadgets::block_parser::{ChatBlockParseOptions, parse_chat_blocks};

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gadgets-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lifecycle_prefers_an_answer_over_expiry_and_supersession() {
        let envelope = json!({ "gadgetId": "g", "expiresAt": "2000-01-01T00:00:00Z" });
        let superseded: HashSet<String> = ["g".to_owned()].into();
        assert_eq!(
            resolve_state(
                &envelope,
                "2026-01-01T00:00:00Z",
                &superseded,
                Some("completed"),
                true
            ),
            "completed"
        );
        assert_eq!(
            resolve_state(&envelope, "2026-01-01T00:00:00Z", &superseded, None, true),
            "superseded"
        );
        assert_eq!(
            resolve_state(
                &envelope,
                "2026-01-01T00:00:00Z",
                &HashSet::new(),
                None,
                true
            ),
            "expired"
        );
        assert_eq!(
            resolve_state(
                &json!({ "gadgetId": "g" }),
                "2026-01-01T00:00:00Z",
                &HashSet::new(),
                None,
                false
            ),
            "disconnected"
        );
    }

    #[test]
    fn a_republished_gadget_replaces_its_block_in_place() {
        let dir = temp();
        let gadget = |text: &str| json!({ "type": "gadget", "blockId": "b1", "gadget": { "gadgetId": "g", "scope": { "sessionId": "s" }, "text": text } });
        publish_blocks(&dir, "s", vec![gadget("one")]);
        let blocks = publish_blocks(
            &dir,
            "s",
            vec![
                gadget("two"),
                json!({ "type": "markdown", "blockId": "m", "markdown": "hi" }),
            ],
        );
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["gadget"]["text"], "two");
    }

    #[test]
    fn the_ledger_is_durable_and_orders_events() {
        let dir = temp();
        with_state(&dir, |state| {
            put_record(
                state,
                json!({ "idempotencyKey": "k", "status": "accepted", "updatedAt": "t", "gadgetId": "g", "scope": {} }),
            );
            put_record(
                state,
                json!({ "idempotencyKey": "k", "status": "completed", "updatedAt": "t2", "gadgetId": "g", "scope": {} }),
            );
            persist(&dir, state);
            assert_eq!(state.records.len(), 1);
            assert_eq!(state.sequence, 2);
        });
        let document: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).unwrap()).unwrap();
        assert_eq!(document[LEDGER_KEY]["sequence"], 2);
    }

    #[test]
    fn an_artifact_gadget_without_actions_is_published() {
        let text = "Here is the evidence.\n\n```praxis-gadget\n{\n  \"version\": 1,\n  \"kind\": \"artifact\",\n  \"gadgetId\": \"turn-evidence\",\n  \"payload\": {\n    \"title\": \"Evidence\",\n    \"artifacts\": [\n      {\"name\": \"shot.png\", \"path\": \"shot.png\", \"mediaType\": \"image/png\", \"description\": \"A screenshot\"}\n    ]\n  },\n  \"actions\": []\n}\n```\n";
        let _unused = "Here.\n\n```praxis-gadget\n{\"version\":1,\"kind\":\"artifact\",\"gadgetId\":\"turn-evidence\",\"payload\":{\"title\":\"Evidence\",\"artifacts\":[{\"name\":\"shot.png\",\"path\":\"shot.png\",\"mediaType\":\"image/png\"}]},\"actions\":[]}\n```\n";
        let options = ChatBlockParseOptions {
            scope: GadgetScope {
                host_id: "h".into(),
                session_id: "s".into(),
                ..GadgetScope::default()
            },
            issued_at: "2026-01-01T00:00:00Z".into(),
            id_prefix: "m".into(),
        };
        let parsed = parse_chat_blocks(text, &options);
        assert!(parsed.contains_gadget, "{:?}", parsed.blocks);
        assert!(
            parsed
                .blocks
                .iter()
                .any(|b| matches!(b, praxis_ai::gadgets::contracts::ChatBlock::Gadget { .. })),
            "{:?}",
            parsed.blocks
        );
    }

    #[test]
    fn the_same_key_with_a_different_answer_is_not_a_retry() {
        assert_ne!(
            digest(&json!({ "kind": "choice", "selected": "a" })),
            digest(&json!({ "kind": "choice", "selected": "b" }))
        );
        assert_eq!(
            digest(&json!({ "a": 1, "b": 2 })),
            digest(&json!({ "b": 2, "a": 1 }))
        );
    }
}
