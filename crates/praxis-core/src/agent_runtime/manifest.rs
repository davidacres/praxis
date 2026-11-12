//! `agent.json` validation. Mirrors `manifest.ts` rule for rule.

use serde_json::{Value, json};

pub const TRANSPORTS: &[&str] = &["acp", "copilot-sdk", "http", "gateway", "custom"];

/// A non-empty (after trimming) string.
pub(crate) fn is_text(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
}

fn error(path: &str, message: impl Into<String>) -> Value {
    json!({ "path": path, "message": message.into() })
}

/// Returns `[{ path, message }]`; empty means valid.
pub fn validate_agent_manifest(value: &Value, manifest_path: &str) -> Vec<Value> {
    let Some(candidate) = value.as_object() else {
        return vec![error(manifest_path, "Manifest must be a JSON object.")];
    };
    let mut errors = Vec::new();
    if candidate.get("schemaVersion") != Some(&json!(1)) {
        errors.push(error("schemaVersion", "Only schemaVersion 1 is supported."));
    }
    for field in ["id", "name", "type"] {
        if !is_text(candidate.get(field)) {
            errors.push(error(field, format!("{field} is required.")));
        }
    }
    if is_text(candidate.get("type")) {
        let transport = candidate["type"].as_str().unwrap_or_default();
        if !TRANSPORTS.contains(&transport) {
            errors.push(error("type", format!("Unsupported transport: {transport}")));
        }
    }
    match candidate.get("entry") {
        Some(Value::String(entry)) if !entry.trim().is_empty() => {
            if entry.contains("..") {
                errors.push(error(
                    "entry",
                    "Entry paths may not contain traversal segments.",
                ));
            }
        }
        Some(Value::Object(entry)) => {
            if !is_text(entry.get("command")) && !is_text(entry.get("url")) {
                errors.push(error("entry", "entry requires command or url."));
            }
            if let Some(args) = entry.get("args")
                && !args
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string))
            {
                errors.push(error("entry.args", "args must be an array of strings."));
            }
        }
        _ => errors.push(error(
            "entry",
            "entry must be a command/path string or an entry object.",
        )),
    }
    if let Some(skills) = candidate.get("skills")
        && !skills
            .as_array()
            .is_some_and(|items| items.iter().all(|item| is_text(Some(item))))
    {
        errors.push(error(
            "skills",
            "skills must be an array of non-empty paths.",
        ));
    }
    if let Some(activation) = candidate.get("activation")
        && activation != "onDemand"
        && activation != "startup"
    {
        errors.push(error(
            "activation",
            "activation must be onDemand or startup.",
        ));
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn messages(value: &Value) -> Vec<String> {
        validate_agent_manifest(value, "agent.json")
            .iter()
            .map(|e| e["message"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    #[test]
    fn accepts_a_command_manifest_and_rejects_an_unknown_transport() {
        let good = json!({"schemaVersion":1,"id":"a","name":"A","type":"acp","entry":{"command":"node","args":["x.js"]}});
        assert!(messages(&good).is_empty());
        let bad =
            json!({"schemaVersion":1,"id":"b","name":"B","type":"telepathy","entry":"run.js"});
        assert_eq!(messages(&bad), vec!["Unsupported transport: telepathy"]);
    }

    #[test]
    fn rejects_traversal_missing_fields_and_bad_args() {
        let value = json!({"schemaVersion":2,"entry":"../x","skills":[""],"activation":"later"});
        let found = messages(&value);
        assert!(found.contains(&"Only schemaVersion 1 is supported.".to_owned()));
        assert!(found.contains(&"id is required.".to_owned()));
        assert!(found.contains(&"Entry paths may not contain traversal segments.".to_owned()));
        assert!(found.contains(&"skills must be an array of non-empty paths.".to_owned()));
        assert!(found.contains(&"activation must be onDemand or startup.".to_owned()));
        let args = json!({"schemaVersion":1,"id":"a","name":"A","type":"acp","entry":{"command":"n","args":[1]}});
        assert_eq!(messages(&args), vec!["args must be an array of strings."]);
        assert_eq!(
            messages(&json!([])),
            vec!["Manifest must be a JSON object."]
        );
    }
}
