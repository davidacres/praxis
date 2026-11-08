//! Schema validation and payload boundary enforcement for gadgets (`validation.rs`).

use serde_json::Value;

use super::contracts::{
    GADGET_CONTRACT_VERSION, GadgetActionValue, GadgetEnvelope, GadgetError, GadgetKind,
};
use super::fallback::gadget_fallback_text;
use super::limits::{
    ACTIONS, ARTIFACTS, CHART_POINTS, CHART_SERIES, CHOICE_OPTIONS, DIFF_FILES, ENVELOPE_BYTES,
    FORM_FIELDS, IMAGES, TABLE_COLUMNS, TABLE_ROWS,
};
use super::redaction::redact_deep;

/// Validates and normalizes a gadget envelope: clamps collections to hard limits,
/// redacts secrets, derives fallback text if empty, and verifies version.
pub fn validate_gadget_envelope(envelope: &mut GadgetEnvelope) -> Result<(), GadgetError> {
    if envelope.version != GADGET_CONTRACT_VERSION {
        return Err(GadgetError::new(
            "unsupported-version",
            format!("Unsupported gadget contract version {}", envelope.version),
        ));
    }

    // Check envelope serialized byte limit
    let serialized = serde_json::to_string(&envelope)
        .map_err(|e| GadgetError::new("schema-invalid", format!("Serialization error: {e}")))?;

    if serialized.len() > ENVELOPE_BYTES {
        return Err(GadgetError::new(
            "payload-too-large",
            format!(
                "Envelope size ({} bytes) exceeds maximum allowed {ENVELOPE_BYTES} bytes",
                serialized.len()
            ),
        ));
    }

    // Secret redaction pass
    let redacted_count = redact_deep(&mut envelope.payload);
    if redacted_count > 0 {
        envelope.redacted = Some(true);
    }

    // Bound actions
    if envelope.actions.len() > ACTIONS {
        envelope.actions.truncate(ACTIONS);
    }

    // Kind-specific collection trimming and normalization
    match envelope.kind {
        GadgetKind::Choice => {
            if let Some(opts) = envelope
                .payload
                .get_mut("options")
                .and_then(Value::as_array_mut)
            {
                if opts.len() > CHOICE_OPTIONS {
                    opts.truncate(CHOICE_OPTIONS);
                }
            }
        }
        GadgetKind::Form => {
            if let Some(fields) = envelope
                .payload
                .get_mut("fields")
                .and_then(Value::as_array_mut)
            {
                if fields.len() > FORM_FIELDS {
                    fields.truncate(FORM_FIELDS);
                }
            }
        }
        GadgetKind::Table => {
            if let Some(cols) = envelope
                .payload
                .get_mut("columns")
                .and_then(Value::as_array_mut)
            {
                if cols.len() > TABLE_COLUMNS {
                    cols.truncate(TABLE_COLUMNS);
                }
            }
            if let Some(rows) = envelope
                .payload
                .get_mut("rows")
                .and_then(Value::as_array_mut)
            {
                if rows.len() > TABLE_ROWS {
                    rows.truncate(TABLE_ROWS);
                    envelope.payload["truncated"] = Value::Bool(true);
                }
            }
        }
        GadgetKind::Chart => {
            if let Some(series) = envelope
                .payload
                .get_mut("series")
                .and_then(Value::as_array_mut)
            {
                if series.len() > CHART_SERIES {
                    series.truncate(CHART_SERIES);
                }
                for s in series.iter_mut() {
                    if let Some(pts) = s.get_mut("points").and_then(Value::as_array_mut) {
                        if pts.len() > CHART_POINTS {
                            pts.truncate(CHART_POINTS);
                        }
                    }
                }
            }
        }
        GadgetKind::Diff => {
            if let Some(files) = envelope
                .payload
                .get_mut("files")
                .and_then(Value::as_array_mut)
            {
                if files.len() > DIFF_FILES {
                    files.truncate(DIFF_FILES);
                    envelope.payload["truncated"] = Value::Bool(true);
                }
            }
        }
        GadgetKind::Artifact => {
            if let Some(arts) = envelope
                .payload
                .get_mut("artifacts")
                .and_then(Value::as_array_mut)
            {
                if arts.len() > ARTIFACTS {
                    arts.truncate(ARTIFACTS);
                }
            }
        }
        GadgetKind::Image => {
            if let Some(imgs) = envelope
                .payload
                .get_mut("images")
                .and_then(Value::as_array_mut)
            {
                if imgs.len() > IMAGES {
                    imgs.truncate(IMAGES);
                }
            }
        }
        _ => {}
    }

    if envelope.fallback_text.trim().is_empty() {
        envelope.fallback_text = gadget_fallback_text(envelope);
    }

    Ok(())
}

/// Validates that a user-submitted action value conforms to the gadget's schema definition.
pub fn validate_gadget_action_value(
    envelope: &GadgetEnvelope,
    value: &GadgetActionValue,
) -> Result<(), GadgetError> {
    match envelope.kind {
        GadgetKind::Choice => match value {
            GadgetActionValue::Choice { selected } => {
                let options = envelope
                    .payload
                    .get("options")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        GadgetError::new("schema-invalid", "Missing options in choice gadget")
                    })?;

                let exists = options.iter().any(|opt| {
                    opt.get("value")
                        .and_then(Value::as_str)
                        .map(|v| v == selected)
                        .unwrap_or(false)
                });

                if !exists {
                    return Err(GadgetError::new(
                        "value-invalid",
                        format!("Selected option '{selected}' is not in the offered choices"),
                    ));
                }
                Ok(())
            }
            GadgetActionValue::Selection { selected } => {
                let options = envelope
                    .payload
                    .get("options")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        GadgetError::new("schema-invalid", "Missing options in choice gadget")
                    })?;

                for sel in selected {
                    let exists = options.iter().any(|opt| {
                        opt.get("value")
                            .and_then(Value::as_str)
                            .map(|v| v == sel)
                            .unwrap_or(false)
                    });
                    if !exists {
                        return Err(GadgetError::new(
                            "value-invalid",
                            format!("Selected option '{sel}' is not in the offered choices"),
                        ));
                    }
                }
                Ok(())
            }
            _ => Err(GadgetError::new(
                "value-invalid",
                "Choice gadget requires a choice or selection action value",
            )),
        },
        GadgetKind::Confirmation => match value {
            GadgetActionValue::Confirmation { .. } => Ok(()),
            _ => Err(GadgetError::new(
                "value-invalid",
                "Confirmation gadget requires a confirmation action value",
            )),
        },
        GadgetKind::Form => match value {
            GadgetActionValue::Form { fields } => {
                let form_fields = envelope
                    .payload
                    .get("fields")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        GadgetError::new("schema-invalid", "Missing fields in form gadget")
                    })?;

                for ff in form_fields {
                    let name = ff.get("name").and_then(Value::as_str).unwrap_or_default();
                    let label = ff.get("label").and_then(Value::as_str).unwrap_or(name);
                    let required = ff.get("required").and_then(Value::as_bool).unwrap_or(false);

                    let supplied = fields.get(name);
                    if required {
                        match supplied {
                            None | Some(Value::Null) => {
                                return Err(GadgetError::new(
                                    "value-invalid",
                                    format!("Field '{label}' is required"),
                                ));
                            }
                            Some(Value::String(s)) if s.trim().is_empty() => {
                                return Err(GadgetError::new(
                                    "value-invalid",
                                    format!("Field '{label}' cannot be empty"),
                                ));
                            }
                            _ => {}
                        }
                    }
                }
                Ok(())
            }
            _ => Err(GadgetError::new(
                "value-invalid",
                "Form gadget requires form fields",
            )),
        },
        GadgetKind::Conflict => match value {
            GadgetActionValue::Form { fields } => {
                let conflicts = envelope
                    .payload
                    .get("conflicts")
                    .and_then(Value::as_array)
                    .ok_or_else(|| GadgetError::new("schema-invalid", "Missing conflicts array"))?;

                for conf in conflicts {
                    let id = conf.get("id").and_then(Value::as_str).unwrap_or_default();
                    let label = conf.get("label").and_then(Value::as_str).unwrap_or(id);

                    let res = fields.get(id).and_then(Value::as_str).ok_or_else(|| {
                        GadgetError::new(
                            "value-invalid",
                            format!("Conflict '{label}' is unresolved"),
                        )
                    })?;

                    if res != "ours" && res != "theirs" {
                        return Err(GadgetError::new(
                            "value-invalid",
                            format!("Conflict '{label}' must resolve to 'ours' or 'theirs'"),
                        ));
                    }
                }
                Ok(())
            }
            _ => Err(GadgetError::new(
                "value-invalid",
                "Conflict gadget requires resolutions per conflict",
            )),
        },
        _ => {
            // Informational kinds
            match value {
                GadgetActionValue::None | GadgetActionValue::Confirmation { .. } => Ok(()),
                _ => Err(GadgetError::new(
                    "value-invalid",
                    "This gadget does not take a value",
                )),
            }
        }
    }
}
