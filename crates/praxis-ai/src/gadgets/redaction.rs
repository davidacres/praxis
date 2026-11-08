//! Secret pattern detection and masking for gadget payloads (`redaction.rs`).

use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

pub const REDACTION_PLACEHOLDER: &str = "[redacted]";

struct SecretPattern {
    name: &'static str,
    regex: Regex,
}

static SECRET_PATTERNS: LazyLock<Vec<SecretPattern>> = LazyLock::new(|| {
    vec![
        SecretPattern {
            name: "private-key",
            regex: Regex::new(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----")
                .expect("valid regex"),
        },
        SecretPattern {
            name: "github-token",
            regex: Regex::new(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b").expect("valid regex"),
        },
        SecretPattern {
            name: "github-pat",
            regex: Regex::new(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b").expect("valid regex"),
        },
        SecretPattern {
            name: "openai-key",
            regex: Regex::new(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b").expect("valid regex"),
        },
        SecretPattern {
            name: "aws-access-key",
            regex: Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b").expect("valid regex"),
        },
        SecretPattern {
            name: "slack-token",
            regex: Regex::new(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b").expect("valid regex"),
        },
        SecretPattern {
            name: "google-api-key",
            regex: Regex::new(r"\bAIza[0-9A-Za-z_-]{35}\b").expect("valid regex"),
        },
        SecretPattern {
            name: "bearer-token",
            regex: Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}").expect("valid regex"),
        },
        SecretPattern {
            name: "jwt",
            regex: Regex::new(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")
                .expect("valid regex"),
        },
        SecretPattern {
            name: "keyed-secret",
            regex: Regex::new(r#"(?i)\b((?:api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret))\b(\s*[:=]\s*)["']?([A-Za-z0-9_\-./+]{12,})["']?"#)
                .expect("valid regex"),
        },
    ]
});

/// Redacts secrets in a string, replacing detected tokens with `[redacted]`.
pub fn redact_secrets(text: &str) -> (String, Vec<&'static str>) {
    let mut result = text.to_string();
    let mut hits = Vec::new();

    for sp in SECRET_PATTERNS.iter() {
        if sp.regex.is_match(&result) {
            hits.push(sp.name);
            if sp.name == "keyed-secret" {
                result = sp
                    .regex
                    .replace_all(&result, format!("${{1}}${{2}}{REDACTION_PLACEHOLDER}"))
                    .to_string();
            } else {
                result = sp
                    .regex
                    .replace_all(&result, REDACTION_PLACEHOLDER)
                    .to_string();
            }
        }
    }

    (result, hits)
}

/// Recursively masks secret tokens in all string leaves of a JSON Value.
/// Returns the total number of pattern matches found.
pub fn redact_deep(value: &mut Value) -> usize {
    let mut count = 0;
    match value {
        Value::String(s) => {
            let (redacted, hits) = redact_secrets(s);
            if !hits.is_empty() {
                count += hits.len();
                *s = redacted;
            }
        }
        Value::Array(arr) => {
            for item in arr {
                count += redact_deep(item);
            }
        }
        Value::Object(map) => {
            for (_, item) in map.iter_mut() {
                count += redact_deep(item);
            }
        }
        _ => {}
    }
    count
}
