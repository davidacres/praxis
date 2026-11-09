//! Gadget text helpers for a client that shows gadgets but does not own the conversation's
//! publishing — the phone (`packages/core/src/ai/gadgets/answerText.ts`, `blockParser.ts`'s
//! `mayContainGadget` and `validation.ts`'s `isGadgetActionValue` port).
//!
//! Gadget envelopes stay `serde_json::Value`: the phone receives the envelope verbatim,
//! with publication and validation owned by the host gadget service.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

pub const GADGET_FENCE_LANGUAGE: &str = "praxis-gadget";

static FENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)[ \t]*```[ \t]*praxis-gadget[ \t]*\r?\n(?s:.*?)```[ \t]*$").expect("regex")
});
static OPEN_FENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)[ \t]*```[ \t]*praxis-gadget[ \t]*\r?\n").expect("regex"));
static CLOSE_FENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)```[ \t]*$").expect("regex"));
static BLANK_RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").expect("regex"));
static STREAMING_OPEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"```[ \t]*praxis-gadget").expect("regex"));

/// Cheap pre-check so a caller can skip parsing text that cannot contain a gadget.
pub fn may_contain_gadget(text: &str) -> bool {
    text.contains(GADGET_FENCE_LANGUAGE) || text.contains("\"kind\"")
}

/// A message's text with its gadget fences removed — the gadgets are drawn separately. An
/// opening fence with no closing fence anywhere after it (a reply cut short mid-gadget) is
/// hidden with everything after it.
pub fn strip_gadget_fences(text: &str) -> String {
    if !text.contains(GADGET_FENCE_LANGUAGE) {
        return text.to_owned();
    }
    let closed = FENCE.replace_all(text, "");
    // The TS uses a negative lookahead: the first opening fence with no close after it.
    let open = OPEN_FENCE
        .find_iter(&closed)
        .find(|m| !CLOSE_FENCE.is_match(&closed[m.end()..]))
        .map(|m| m.start());
    let without_open = match open {
        Some(index) => &closed[..index],
        None => &closed[..],
    };
    BLANK_RUNS
        .replace_all(without_open, "\n\n")
        .trim()
        .to_owned()
}

/// A streaming reply with its fences removed, and a fence still being written cut off too.
pub fn streaming_text(text: &str) -> String {
    let stripped = strip_gadget_fences(text);
    match STREAMING_OPEN.find(&stripped) {
        Some(m) => stripped[..m.start()].trim().to_owned(),
        None => stripped.trim().to_owned(),
    }
}

/// The key a message's gadgets are published under: its index among the conversation events.
pub fn gadget_message_key(conversation_index: i64) -> String {
    format!("msg-{conversation_index}")
}

/// Whether an event is one the desktop's conversation view counts (and so indexes gadgets by).
pub fn is_conversation_event(kind: &str, detail: Option<&str>, summary: &str) -> bool {
    (kind == "message" || kind == "user_input_completed")
        && (detail.is_some_and(|d| !d.is_empty()) || !summary.is_empty())
}

/// Narrows a submitted gadget answer's shape before it is trusted.
pub fn is_gadget_action_value(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("none") => true,
        Some("choice") => object.get("selected").is_some_and(Value::is_string),
        Some("confirmation") => object.get("confirmed").is_some_and(Value::is_boolean),
        Some("selection") => object
            .get("selected")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(Value::is_string)),
        Some("form") => object
            .get("fields")
            .and_then(Value::as_object)
            .is_some_and(|fields| {
                fields
                    .values()
                    .all(|v| v.is_string() || v.is_number() || v.is_boolean())
            }),
        _ => false,
    }
}

fn shown(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn option_label<'a>(options: Option<&'a Value>, wanted: &Value) -> Option<&'a str> {
    options?
        .as_array()?
        .iter()
        .find(|option| option.get("value") == Some(wanted))?
        .get("label")?
        .as_str()
}

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The follow-up message that reports an answer to the agent, or `None` when the answer is not
/// an open decision the agent is waiting on.
pub fn describe_gadget_answer(
    envelope: Option<&Value>,
    action_id: &str,
    value: &Value,
) -> Option<String> {
    let envelope = envelope?;
    let actions = envelope
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let effect = |action: &Value| str_field(action, "effect").to_owned();
    let gated = actions
        .iter()
        .find(|candidate| str_field(candidate, "actionId") == action_id)
        .is_some_and(|action| effect(action) != "informational");
    if gated {
        return None;
    }
    let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);
    let kind = str_field(value, "kind");
    match str_field(envelope, "kind") {
        "form" => {
            if kind != "form" || actions.iter().any(|a| effect(a) != "informational") {
                return None;
            }
            let fields = value.get("fields").and_then(Value::as_object)?;
            let answer = payload
                .get("fields")
                .and_then(Value::as_array)
                .map(|declared| {
                    declared
                        .iter()
                        .filter_map(|field| {
                            let raw = fields.get(str_field(field, "name"))?;
                            if raw.is_null() || raw.as_str() == Some("") {
                                return None;
                            }
                            let label = option_label(field.get("options"), raw)
                                .map_or_else(|| shown(raw), str::to_owned);
                            Some(format!("{}: {label}", str_field(field, "label")))
                        })
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .unwrap_or_default();
            (!answer.is_empty()).then(|| {
                format!(
                    "Gadget response — \"{}\": {answer}.",
                    str_field(&payload, "title")
                )
            })
        }
        "choice" => {
            let question = str_field(&payload, "question");
            let options = payload.get("options");
            match kind {
                "choice" => {
                    let selected = value.get("selected")?;
                    let label = option_label(options, selected)
                        .map_or_else(|| shown(selected), str::to_owned);
                    Some(format!("Gadget response — \"{question}\": {label}."))
                }
                "selection" => {
                    let labels: Vec<String> = value
                        .get("selected")?
                        .as_array()?
                        .iter()
                        .map(|selected| {
                            option_label(options, selected)
                                .map_or_else(|| shown(selected), str::to_owned)
                        })
                        .collect();
                    Some(format!(
                        "Gadget response — \"{question}\": {}.",
                        labels.join(", ")
                    ))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_closed_and_unterminated_fences() {
        let reply = "Two ways to fix it.\n```praxis-gadget\n{\"kind\":\"choice\"}\n```";
        assert_eq!(strip_gadget_fences(reply), "Two ways to fix it.");
        assert_eq!(
            strip_gadget_fences("Before\n```praxis-gadget\n{\"kind\":\"cho"),
            "Before"
        );
        assert_eq!(strip_gadget_fences("plain"), "plain");
        assert_eq!(
            streaming_text("Here is the choice.\n```praxis-gadget\n{\"kind\":\"cho"),
            "Here is the choice."
        );
    }

    #[test]
    fn validates_answer_shapes() {
        assert!(is_gadget_action_value(
            &json!({ "kind": "choice", "selected": "a" })
        ));
        assert!(is_gadget_action_value(
            &json!({ "kind": "form", "fields": { "a": 1, "b": true } })
        ));
        assert!(!is_gadget_action_value(
            &json!({ "kind": "choice", "selected": 1 })
        ));
        assert!(!is_gadget_action_value(
            &json!({ "kind": "form", "fields": { "a": [] } })
        ));
        assert!(!is_gadget_action_value(&json!("choice")));
    }

    #[test]
    fn describes_an_open_decision_but_not_a_gated_action() {
        let envelope = json!({
            "kind": "choice",
            "payload": { "question": "Which fix?", "options": [{ "value": "a", "label": "Patch" }] },
            "actions": [{ "actionId": "pick", "effect": "informational" }, { "actionId": "ok", "effect": "approval" }]
        });
        assert_eq!(
            describe_gadget_answer(
                Some(&envelope),
                "pick",
                &json!({ "kind": "choice", "selected": "a" })
            ),
            Some("Gadget response — \"Which fix?\": Patch.".to_owned())
        );
        assert_eq!(
            describe_gadget_answer(
                Some(&envelope),
                "ok",
                &json!({ "kind": "choice", "selected": "a" })
            ),
            None
        );
        let form = json!({
            "kind": "form",
            "payload": { "title": "Deploy", "fields": [{ "name": "env", "label": "Environment", "options": [{ "value": "p", "label": "Prod" }] }, { "name": "n", "label": "Count" }] },
            "actions": [{ "actionId": "send", "effect": "informational" }]
        });
        assert_eq!(
            describe_gadget_answer(
                Some(&form),
                "send",
                &json!({ "kind": "form", "fields": { "env": "p", "n": 2 } })
            ),
            Some("Gadget response — \"Deploy\": Environment: Prod; Count: 2.".to_owned())
        );
    }
}
