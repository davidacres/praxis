//! Lossless presentation metadata for ACP streams; no provider policy is inferred from prose.
use serde_json::{Value, json};

pub(super) fn push_segment(segments: &mut Vec<Value>, update: &Value, timestamp: &str) -> String {
    let id = update["messageId"].clone();
    let phase = update["_meta"]["jetbrains"]["air"]["phase"].clone();
    let text = update["content"]["text"].as_str().unwrap_or_default();
    let same = segments
        .last()
        .is_some_and(|last| last["messageId"] == id && last["phase"] == phase);
    if same {
        if let Some(last) = segments.last_mut() {
            let combined = format!("{}{text}", last["text"].as_str().unwrap_or_default());
            last["text"] = json!(combined);
        }
    } else {
        segments.push(json!({"messageId":id,"phase":phase,"text":text,"timestamp":timestamp}));
    }
    segments
        .iter()
        .filter(|part| part["phase"] != "commentary")
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(super) fn merge_tool(previous: &mut Value, update: &Value) {
    if !previous.is_object() {
        *previous = json!({});
    }
    for key in [
        "name",
        "title",
        "kind",
        "locations",
        "status",
        "content",
        "rawOutput",
    ] {
        if let Some(value) = update.get(key) {
            previous[key] = value.clone();
        }
    }
    if let Some(input) = update["rawInput"].as_object() {
        if !previous["rawInput"].is_object() {
            previous["rawInput"] = json!({});
        }
        for (key, value) in input {
            previous["rawInput"][key] = value.clone();
        }
    }
}

pub(super) fn usage(usage: &Value) -> Option<Value> {
    let input = usage["inputTokens"].as_u64();
    let output = usage["outputTokens"].as_u64();
    if input.is_none() && output.is_none() {
        return None;
    }
    let mut value = json!({"inputTokens":input.unwrap_or(0),"outputTokens":output.unwrap_or(0),
        "totalTokens":usage["totalTokens"].as_u64().unwrap_or(input.unwrap_or(0)+output.unwrap_or(0))});
    for (from, to) in [
        ("thoughtTokens", "reasoningTokens"),
        ("reasoningOutputTokens", "reasoningTokens"),
        ("cachedReadTokens", "cachedInputTokens"),
        ("cachedInputTokens", "cachedInputTokens"),
        ("cachedWriteTokens", "cachedWriteTokens"),
        ("cacheWriteInputTokens", "cachedWriteTokens"),
    ] {
        if let Some(count) = usage[from].as_u64() {
            value[to] = json!(count);
        }
    }
    Some(value)
}

pub(super) fn model_usage(response: &Value, reply_model: Option<&str>) -> Vec<Value> {
    response["_meta"]["quota"]["model_usage"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some(json!({"model":row["model"].as_str()?,
            "role":if Some(row["model"].as_str()?)==reply_model {"reply"}else{"additional"},
            "tokenUsage":usage(&row["token_count"])?}))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn message_ids_and_phases_survive_without_commentary_in_the_answer() {
        let mut parts = vec![];
        let update = |id: &str, phase: &str, text: &str| json!({"messageId":id,"_meta":{"jetbrains":{"air":{"phase":phase}}},"content":{"text":text}});
        assert_eq!(
            push_segment(
                &mut parts,
                &update("progress", "commentary", "Reading"),
                "t0"
            ),
            ""
        );
        push_segment(&mut parts, &update("progress", "commentary", " file"), "t1");
        assert_eq!(
            push_segment(
                &mut parts,
                &update("answer", "final_answer", "Answer"),
                "t2"
            ),
            "Answer"
        );
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["text"], "Reading file");
        assert_eq!(parts[1]["messageId"], "answer");
        assert_eq!(
            push_segment(
                &mut parts,
                &json!({"messageId":"other","content":{"text":"More"}}),
                "t3"
            ),
            "Answer\n\nMore"
        );
        assert!(parts[2]["phase"].is_null());
    }
    #[test]
    fn sparse_tool_refinements_retain_identity_location_and_input() {
        let mut tool = json!({});
        merge_tool(
            &mut tool,
            &json!({"name":"Read","title":"Read File","kind":"read"}),
        );
        merge_tool(
            &mut tool,
            &json!({"title":"Read fixture.txt","locations":[{"path":"fixture.txt","line":1}],"rawInput":{"file_path":"fixture.txt"}}),
        );
        merge_tool(&mut tool, &json!({"status":"completed"}));
        assert_eq!(tool["name"], "Read");
        assert_eq!(tool["kind"], "read");
        assert_eq!(tool["title"], "Read fixture.txt");
        assert_eq!(tool["locations"][0]["line"], 1);
        assert_eq!(tool["rawInput"]["file_path"], "fixture.txt");
        assert!(tool["rawOutput"].is_null());
    }
    #[test]
    fn cache_writes_and_additional_models_are_independent_of_primary_totals() {
        let value=usage(&json!({"inputTokens":6,"outputTokens":278,"cachedReadTokens":47977,"cachedWriteTokens":27957,"totalTokens":76218})).expect("usage");
        assert_eq!(value["cachedWriteTokens"], 27957);
        assert_eq!(value["totalTokens"], 76218);
        let rows = model_usage(
            &json!({"_meta":{"quota":{"model_usage":[{"model":"sonnet","token_count":{"inputTokens":6,"outputTokens":278,"cachedInputTokens":47977,"cachedWriteTokens":27957,"totalTokens":76218}},{"model":"haiku","token_count":{"inputTokens":3183,"outputTokens":22,"totalTokens":3205}}]}}}),
            Some("sonnet"),
        );
        assert_eq!(rows[0]["role"], "reply");
        assert_eq!(rows[1]["role"], "additional");
        assert_eq!(rows[0]["tokenUsage"]["cachedWriteTokens"], 27957);
    }
}
