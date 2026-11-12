//! Prompt and session feedback reports (`ai:evaluatePrompt`, `ai:evaluateSession`).
//!
//! Every report carries the full `DeterministicFeedbackReport` shape the renderer reads, so a
//! surface that renders findings never meets a missing array.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;
const RUBRIC_VERSION: u32 = 3;

/// A report with nothing to flag: a full score and no findings.
pub fn empty_report(kind: &str, input: &Value, evaluated_at: String) -> Value {
    let prompt = input["promptText"].as_str().unwrap_or_default();
    let digest = format!("{:x}", Sha256::digest(format!("{kind}\u{0}{}\u{0}{prompt}", input["issueKey"].as_str().unwrap_or_default())));
    let mut report = json!({
        "schemaVersion": SCHEMA_VERSION,
        "rubricVersion": RUBRIC_VERSION,
        "reportId": Uuid::new_v4().to_string(),
        "evaluatedAt": evaluated_at,
        "kind": kind,
        "promptText": prompt,
        "inputDigest": digest,
        "overallScore": 100,
        "projectedScore": 100,
        "grade": "A",
        "projectedGrade": "A",
        "dimensions": [],
        "findings": [],
        "inventory": {
            "promptsAnalyzed": 0, "toolsUsed": [], "totalToolCalls": 0, "successfulToolCalls": 0, "failedToolCalls": 0,
            "retryLoopCount": 0, "shellSearchFallbackCount": 0, "mcpToolsUsed": [], "mcpServersConfigured": [],
            "skillsAttached": [], "skillsDetected": [], "skillsRecommended": []
        },
        "suggestedPrompt": prompt,
    });
    for field in ["issueKey", "sessionId", "turnIndex"] {
        if !input[field].is_null() {
            report[field] = input[field].clone();
        }
    }
    report
}
