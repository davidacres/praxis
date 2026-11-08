//! Human-readable text fallback generation for gadgets (`fallback.rs`).

use serde_json::Value;

use super::contracts::{GadgetEnvelope, GadgetKind};

fn bullet(items: &[String]) -> String {
    items
        .iter()
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("- {s}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn section(title: Option<&str>, body: &str) -> String {
    if let Some(t) = title {
        if !t.trim().is_empty() {
            return format!("{t}\n\n{body}");
        }
    }
    body.to_string()
}

/// Derives a plain-text representation of a gadget envelope for clients that cannot render UI.
#[must_use]
pub fn gadget_fallback_text(envelope: &GadgetEnvelope) -> String {
    let p = &envelope.payload;

    match envelope.kind {
        GadgetKind::Choice => {
            let question = p.get("question").and_then(Value::as_str);
            let mut opts = Vec::new();
            if let Some(arr) = p.get("options").and_then(Value::as_array) {
                for item in arr {
                    let label = item
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let desc = item.get("description").and_then(Value::as_str);
                    let dis = item.get("disabledReason").and_then(Value::as_str);
                    let dis_str = dis
                        .map(|d| format!(" (unavailable: {d})"))
                        .unwrap_or_default();
                    if let Some(d) = desc {
                        opts.push(format!("{label} — {d}{dis_str}"));
                    } else {
                        opts.push(format!("{label}{dis_str}"));
                    }
                }
            }
            section(question, &bullet(&opts))
        }
        GadgetKind::Confirmation => {
            let question = p
                .get("question")
                .and_then(Value::as_str)
                .unwrap_or("Confirm");
            let mut parts = vec![question.to_string()];
            if let Some(detail) = p.get("detail").and_then(Value::as_str) {
                parts.push(detail.to_string());
            }
            if let Some(consequences) = p.get("consequences").and_then(Value::as_array) {
                let cq: Vec<String> = consequences
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect();
                if !cq.is_empty() {
                    parts.push(format!("This will:\n{}", bullet(&cq)));
                }
            }
            parts.join("\n\n")
        }
        GadgetKind::Form => {
            let title = p.get("title").and_then(Value::as_str);
            let mut fields = Vec::new();
            if let Some(arr) = p.get("fields").and_then(Value::as_array) {
                for f in arr {
                    let label = f.get("label").and_then(Value::as_str).unwrap_or("Field");
                    let req = if f.get("required").and_then(Value::as_bool).unwrap_or(false) {
                        " (required)"
                    } else {
                        ""
                    };
                    let ftype = f.get("type").and_then(Value::as_str).unwrap_or("text");
                    fields.push(format!("{label}{req} — {ftype}"));
                }
            }
            section(title, &bullet(&fields))
        }
        GadgetKind::Table => {
            let title = p.get("title").and_then(Value::as_str);
            let mut lines = Vec::new();
            if let Some(cols) = p.get("columns").and_then(Value::as_array) {
                let col_names: Vec<String> = cols
                    .iter()
                    .filter_map(|c| c.get("label").and_then(Value::as_str))
                    .map(ToString::to_string)
                    .collect();
                lines.push(col_names.join(" | "));
                lines.push(
                    col_names
                        .iter()
                        .map(|c| "-".repeat(c.len()))
                        .collect::<Vec<_>>()
                        .join("-|-"),
                );

                if let Some(rows) = p.get("rows").and_then(Value::as_array) {
                    for row in rows {
                        let mut row_cells = Vec::new();
                        for col in cols {
                            let key = col.get("key").and_then(Value::as_str).unwrap_or_default();
                            let cell_val = row
                                .get(key)
                                .map(|v| match v {
                                    Value::String(s) => s.clone(),
                                    Value::Number(n) => n.to_string(),
                                    Value::Bool(b) => {
                                        if *b {
                                            "yes".to_string()
                                        } else {
                                            "no".to_string()
                                        }
                                    }
                                    _ => "—".to_string(),
                                })
                                .unwrap_or_else(|| "—".to_string());
                            row_cells.push(cell_val);
                        }
                        lines.push(row_cells.join(" | "));
                    }
                }
            }
            section(title, &lines.join("\n"))
        }
        GadgetKind::Chart => {
            let title = p.get("title").and_then(Value::as_str);
            let summary = p.get("summary").and_then(Value::as_str);
            let mut series_lines = Vec::new();
            if let Some(series) = p.get("series").and_then(Value::as_array) {
                for s in series {
                    let label = s.get("label").and_then(Value::as_str).unwrap_or("Series");
                    let pts_count = s
                        .get("points")
                        .and_then(Value::as_array)
                        .map(|a| a.len())
                        .unwrap_or(0);
                    series_lines.push(format!("{label}: {pts_count} points"));
                }
            }
            let body = format!("{}\n{}", bullet(&series_lines), summary.unwrap_or_default());
            section(title, &body)
        }
        GadgetKind::Progress => {
            let title = p.get("title").and_then(Value::as_str);
            let status = p.get("status").and_then(Value::as_str).unwrap_or("running");
            let pct = p
                .get("percent")
                .and_then(Value::as_u64)
                .map(|n| format!(" ({n}%)"))
                .unwrap_or_default();
            let body = format!("Status: {status}{pct}");
            section(title, &body)
        }
        GadgetKind::Diff => {
            let title = p.get("title").and_then(Value::as_str);
            let mut file_lines = Vec::new();
            if let Some(files) = p.get("files").and_then(Value::as_array) {
                for f in files {
                    let path = f.get("path").and_then(Value::as_str).unwrap_or("file");
                    let adds = f.get("additions").and_then(Value::as_u64).unwrap_or(0);
                    let dels = f.get("deletions").and_then(Value::as_u64).unwrap_or(0);
                    file_lines.push(format!("{path} (+{adds}/-{dels})"));
                }
            }
            section(title, &bullet(&file_lines))
        }
        GadgetKind::Artifact => {
            let title = p.get("title").and_then(Value::as_str);
            let mut arts = Vec::new();
            if let Some(items) = p.get("artifacts").and_then(Value::as_array) {
                for item in items {
                    let name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("artifact");
                    let path = item.get("path").and_then(Value::as_str).unwrap_or_default();
                    arts.push(format!("{name} ({path})"));
                }
            }
            section(title, &bullet(&arts))
        }
        GadgetKind::Image => {
            let title = p.get("title").and_then(Value::as_str);
            let mut imgs = Vec::new();
            if let Some(items) = p.get("images").and_then(Value::as_array) {
                for item in items {
                    let name = item.get("name").and_then(Value::as_str).unwrap_or("image");
                    imgs.push(name.to_string());
                }
            }
            section(title, &bullet(&imgs))
        }
        GadgetKind::Handoff => {
            let title = p.get("title").and_then(Value::as_str);
            let from = p
                .get("fromProvider")
                .and_then(Value::as_str)
                .unwrap_or("provider");
            let to = p
                .get("toProvider")
                .and_then(Value::as_str)
                .unwrap_or("provider");
            let summary = p
                .get("contextSummary")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let body = format!("Handoff from {from} to {to}:\n{summary}");
            section(title, &body)
        }
        GadgetKind::Conflict => {
            let title = p.get("title").and_then(Value::as_str);
            let mut confs = Vec::new();
            if let Some(items) = p.get("conflicts").and_then(Value::as_array) {
                for item in items {
                    let label = item
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or("conflict");
                    confs.push(label.to_string());
                }
            }
            section(title, &bullet(&confs))
        }
        GadgetKind::Approval => {
            let title = p.get("title").and_then(Value::as_str);
            let summary = p
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("Approval requested");
            let gate = p.get("gate").and_then(Value::as_str).unwrap_or("default");
            let body = format!("Gate: {gate}\n{summary}");
            section(title, &body)
        }
    }
}
