//! Lenient JSON string quote and raw newline repair (`json_repair.rs`).

use serde_json::Value;

const TERMINATORS: [char; 4] = [',', '}', ']', ':'];

fn next_significant(chars: &[char], from: usize) -> Option<char> {
    chars[from..]
        .iter()
        .copied()
        .find(|c| !matches!(c, ' ' | '\t' | '\r' | '\n'))
}

/// Repairs unescaped inner double-quotes and raw newlines inside string literals.
#[must_use]
pub fn repair_json_strings(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        if !in_string {
            if c == '"' {
                in_string = true;
            }
            out.push(c);
            i += 1;
            continue;
        }

        if c == '\\' {
            if i + 1 < chars.len() {
                out.push(c);
                out.push(chars[i + 1]);
                i += 2;
            } else {
                out.push_str("\\\\");
                i += 1;
            }
            continue;
        }

        if c == '"' {
            let following = next_significant(&chars, i + 1);
            if following.is_none() || following.map(|f| TERMINATORS.contains(&f)).unwrap_or(false) {
                in_string = false;
                out.push(c);
            } else {
                out.push_str("\\\"");
            }
            i += 1;
            continue;
        }

        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
        i += 1;
    }

    out
}

/// Parses JSON leniently: attempts strict parse first, falls back to string repair if strict fails.
/// Returns `(Value, repaired_flag)`.
pub fn parse_lenient_json(text: &str) -> Result<(Value, bool), String> {
    if let Ok(val) = serde_json::from_str::<Value>(text) {
        return Ok((val, false));
    }

    let repaired = repair_json_strings(text);
    if let Ok(val) = serde_json::from_str::<Value>(&repaired) {
        return Ok((val, true));
    }

    serde_json::from_str::<Value>(text)
        .map(|v| (v, false))
        .map_err(|e| e.to_string())
}
