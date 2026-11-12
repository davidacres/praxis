//! The persisted feedback state (port of `sessionFeedbackStore.ts`): reports, human feedback, and
//! per-finding reviews with muted rules. Pure over a JSON document; the host reads and writes it.

use serde_json::{Map, Value, json};

use super::scorer::finding_rule_key;

pub const STORAGE_KEY: &str = "praxis.sessionFeedback.v1";

/// `<key>` or `<key>#turn:<n>`.
pub fn record_key(issue_or_session: &str, turn_index: Option<usize>) -> String {
    let base = issue_or_session.trim();
    turn_index.map_or_else(|| base.to_owned(), |t| format!("{base}#turn:{t}"))
}

fn empty_state() -> Value {
    json!({ "schemaVersion": 1, "reviews": {}, "mutedRules": [], "reportsByKey": {}, "userFeedbackByKey": {} })
}

/// A stored state, or a fresh one when the document is missing, damaged, or from another schema.
pub fn normalize(raw: Option<&Value>) -> Value {
    let Some(raw) = raw.filter(|r| r["schemaVersion"] == 1) else {
        return empty_state();
    };
    let object = |key: &str| {
        if raw[key].is_object() {
            raw[key].clone()
        } else {
            json!({})
        }
    };
    json!({
        "schemaVersion": 1, "reviews": object("reviews"),
        "mutedRules": if raw["mutedRules"].is_array() { raw["mutedRules"].clone() } else { json!([]) },
        "reportsByKey": object("reportsByKey"), "userFeedbackByKey": object("userFeedbackByKey"),
    })
}

pub fn get_report<'a>(state: &'a Value, key: &str, turn_index: Option<usize>) -> Option<&'a Value> {
    Some(&state["reportsByKey"][record_key(key, turn_index)]).filter(|r| !r.is_null())
}

pub fn get_user_feedback<'a>(
    state: &'a Value,
    key: &str,
    turn_index: Option<usize>,
) -> Option<&'a Value> {
    Some(&state["userFeedbackByKey"][record_key(key, turn_index)]).filter(|r| !r.is_null())
}

fn map_mut<'a>(state: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    if !state[key].is_object() {
        state[key] = json!({});
    }
    state[key].as_object_mut().expect("just ensured")
}

pub fn save_report(state: &mut Value, key: &str, report: &Value, turn_index: Option<usize>) {
    let record = record_key(key, turn_index);
    map_mut(state, "reportsByKey").insert(record.clone(), report.clone());
    if !report["userFeedback"].is_null() {
        map_mut(state, "userFeedbackByKey").insert(record, report["userFeedback"].clone());
    }
}

pub fn save_user_feedback(
    state: &mut Value,
    key: &str,
    feedback: &Value,
    turn_index: Option<usize>,
) {
    map_mut(state, "userFeedbackByKey").insert(record_key(key, turn_index), feedback.clone());
}

pub fn list_reports(state: &Value) -> Vec<&Value> {
    state["reportsByKey"]
        .as_object()
        .map(|m| m.values().collect())
        .unwrap_or_default()
}

/// Reviews for one assessment, plus every rule's tallies across all assessments.
pub fn finding_feedback(state: &Value, input_digest: &str) -> Value {
    let muted: Vec<&str> = state["mutedRules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let mut rules: Vec<Value> = Vec::new();
    let mut mine: Vec<Value> = Vec::new();
    for review in state["reviews"]
        .as_object()
        .into_iter()
        .flat_map(Map::values)
    {
        let rule_key = review["ruleKey"].as_str().unwrap_or_default();
        let position = rules.iter().position(|r| r["ruleKey"] == rule_key);
        let index = position.unwrap_or_else(|| {
            rules.push(json!({ "ruleKey": rule_key, "useful": 0, "contextClear": 0, "wrong": 0, "muted": false }));
            rules.len() - 1
        });
        let field = match review["verdict"].as_str() {
            Some("useful") => "useful",
            Some("wrong") => "wrong",
            _ => "contextClear",
        };
        let count = rules[index][field].as_u64().unwrap_or(0) + 1;
        rules[index][field] = json!(count);
        rules[index]["muted"] = json!(muted.contains(&rule_key));
        if review["inputDigest"] == input_digest {
            mine.push(review.clone());
        }
    }
    json!({ "reviews": mine, "rules": rules })
}

/// Records a verdict and/or mute for one finding of a report this host evaluated.
pub fn review_finding(
    state: &mut Value,
    report: &Value,
    request: &Value,
    now: &str,
) -> Result<Value, String> {
    let invalid = || "Invalid finding review.".to_owned();
    let finding_id = request["findingId"].as_str().ok_or_else(invalid)?;
    let finding = report["findings"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|f| f["id"] == finding_id)
        .ok_or_else(invalid)?;
    let verdict = request["verdict"].as_str();
    let muted = request["muted"].as_bool();
    if report["inputDigest"] != request["inputDigest"]
        || verdict.is_some_and(|v| !["useful", "context-clear", "wrong"].contains(&v))
        || (verdict.is_none() && muted.is_none())
    {
        return Err(invalid());
    }
    let rule_key = finding_rule_key(report, finding_id);
    let digest = report["inputDigest"].as_str().unwrap_or_default();
    if let Some(verdict) = verdict {
        let mut review = json!({
            "inputDigest": digest, "findingId": finding_id, "ruleKey": rule_key, "verdict": verdict,
            "promptText": report["promptText"], "title": finding["title"], "evidence": finding["evidence"],
            "rubricVersion": report["rubricVersion"], "updatedAt": now,
        });
        if !report["clarity"].is_null() {
            review["model"] = report["clarity"]["model"].clone();
            review["assessment"] = report["clarity"].clone();
            review["checklistVersion"] = report["clarity"]["checklistVersion"].clone();
        }
        if !report["reviewContext"].is_null() {
            review["context"] = report["reviewContext"].clone();
        }
        map_mut(state, "reviews").insert(format!("{digest}/{finding_id}"), review);
    }
    if let Some(muted) = muted {
        let mut rules: Vec<Value> = state["mutedRules"].as_array().cloned().unwrap_or_default();
        rules.retain(|r| r != &json!(rule_key));
        if muted {
            rules.push(json!(rule_key));
        }
        state["mutedRules"] = Value::Array(rules);
    }
    Ok(finding_feedback(state, digest))
}

/// The badge summary stamped onto a session record.
pub fn session_summary(report: &Value) -> Value {
    let mut summary = json!({
        "overallScore": report["overallScore"], "grade": report["grade"],
        "findingCount": report["findings"].as_array().map_or(0, Vec::len), "updatedAt": report["evaluatedAt"],
    });
    if let Some(verdict) = report["userFeedback"]["verdict"].as_str() {
        summary["verdict"] = json!(verdict);
    }
    summary
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn report() -> Value {
        json!({ "rubricVersion": 3, "inputDigest": "d1", "promptText": "p", "clarity": { "checklistVersion": 4, "model": "a/b" },
            "findings": [{ "id": "clarity-target", "title": "t", "evidence": "e" }] })
    }

    #[test]
    fn records_reviews_and_mutes_by_rule() {
        let mut state = normalize(None);
        let result = review_finding(&mut state, &report(), &json!({ "inputDigest": "d1", "findingId": "clarity-target", "verdict": "wrong", "muted": true }), "now").unwrap();
        assert_eq!(result["reviews"][0]["verdict"], "wrong");
        assert_eq!(result["reviews"][0]["assessment"]["checklistVersion"], 4);
        assert_eq!(result["rules"][0]["wrong"], 1);
        assert_eq!(result["rules"][0]["muted"], true);
        let result = review_finding(
            &mut state,
            &report(),
            &json!({ "inputDigest": "d1", "findingId": "clarity-target", "muted": false }),
            "now",
        )
        .unwrap();
        assert_eq!(result["rules"][0]["muted"], false);
        assert_eq!(finding_feedback(&state, "other")["reviews"], json!([]));
    }

    #[test]
    fn rejects_mismatched_or_empty_reviews() {
        let mut state = normalize(None);
        assert!(
            review_finding(
                &mut state,
                &report(),
                &json!({ "inputDigest": "x", "findingId": "clarity-target", "verdict": "wrong" }),
                "n"
            )
            .is_err()
        );
        assert!(
            review_finding(
                &mut state,
                &report(),
                &json!({ "inputDigest": "d1", "findingId": "clarity-target" }),
                "n"
            )
            .is_err()
        );
        assert!(
            review_finding(
                &mut state,
                &report(),
                &json!({ "inputDigest": "d1", "findingId": "nope", "verdict": "wrong" }),
                "n"
            )
            .is_err()
        );
        assert!(
            review_finding(
                &mut state,
                &report(),
                &json!({ "inputDigest": "d1", "findingId": "clarity-target", "verdict": "bad" }),
                "n"
            )
            .is_err()
        );
    }

    #[test]
    fn keys_reports_per_turn_and_resets_foreign_documents() {
        let mut state = normalize(Some(&json!({ "schemaVersion": 7 })));
        save_report(
            &mut state,
            "S-1",
            &json!({ "overallScore": 80, "userFeedback": { "verdict": "helpful" } }),
            Some(1),
        );
        assert!(get_report(&state, "S-1", Some(1)).is_some());
        assert!(get_report(&state, "S-1", None).is_none());
        assert_eq!(
            get_user_feedback(&state, "S-1", Some(1)).unwrap()["verdict"],
            "helpful"
        );
    }
}
