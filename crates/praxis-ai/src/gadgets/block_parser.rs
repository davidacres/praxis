//! Markdown and gadget block parser (`block_parser.rs`).

use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

use super::contracts::{
    ChatBlock, GADGET_CONTRACT_VERSION, GadgetEnvelope, GadgetKind, GadgetScope,
};
use super::fallback::gadget_fallback_text;
use super::json_repair::parse_lenient_json;

pub const GADGET_FENCE_LANGUAGE: &str = "praxis-gadget";

static GADGET_FENCE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)```[ \t]*praxis-gadget[ \t]*\r?\n([\s\S]*?)```[ \t]*$")
        .expect("valid fence regex")
});

pub struct ChatBlockParseOptions {
    pub scope: GadgetScope,
    pub issued_at: String,
    pub id_prefix: String,
}

pub struct ParsedChatBlocks {
    pub blocks: Vec<ChatBlock>,
    pub contains_gadget: bool,
    pub malformed: usize,
}

fn parse_gadget_kind(raw: &str) -> Option<GadgetKind> {
    match raw {
        "choice" => Some(GadgetKind::Choice),
        "confirmation" => Some(GadgetKind::Confirmation),
        "form" => Some(GadgetKind::Form),
        "table" => Some(GadgetKind::Table),
        "chart" => Some(GadgetKind::Chart),
        "progress" => Some(GadgetKind::Progress),
        "diff" => Some(GadgetKind::Diff),
        "artifact" => Some(GadgetKind::Artifact),
        "image" => Some(GadgetKind::Image),
        "handoff" => Some(GadgetKind::Handoff),
        "conflict" => Some(GadgetKind::Conflict),
        "approval" => Some(GadgetKind::Approval),
        _ => None,
    }
}

/// Splits text containing markdown and ````praxis-gadget ... ```` blocks into ordered chat blocks.
#[must_use]
pub fn parse_chat_blocks(raw_text: &str, options: &ChatBlockParseOptions) -> ParsedChatBlocks {
    let mut blocks = Vec::new();
    let mut last_index = 0;
    let mut found = 0;
    let mut malformed = 0;
    let mut md_index = 0;

    for mat in GADGET_FENCE_REGEX.captures_iter(raw_text) {
        let whole_match = mat.get(0).expect("capture group 0");
        let start = whole_match.start();
        let end = whole_match.end();

        // Push preceding markdown if non-empty
        if start > last_index {
            let md_slice = &raw_text[last_index..start].trim();
            if !md_slice.is_empty() {
                blocks.push(ChatBlock::Markdown {
                    block_id: format!("{}-md-{}", options.id_prefix, md_index),
                    markdown: md_slice.to_string(),
                });
                md_index += 1;
            }
        }

        last_index = end;
        found += 1;

        let fence_body = mat.get(1).map(|m| m.as_str()).unwrap_or_default();
        let lenient_result = parse_lenient_json(fence_body);

        let Ok((mut json_val, _repaired)) = lenient_result else {
            malformed += 1;
            blocks.push(ChatBlock::Markdown {
                block_id: format!("{}-md-{}", options.id_prefix, md_index),
                markdown: format!("```json\n{}\n```", fence_body.trim()),
            });
            md_index += 1;
            continue;
        };

        let kind_opt = json_val
            .get("kind")
            .and_then(Value::as_str)
            .and_then(parse_gadget_kind);

        let Some(kind) = kind_opt else {
            malformed += 1;
            blocks.push(ChatBlock::Markdown {
                block_id: format!("{}-md-{}", options.id_prefix, md_index),
                markdown: format!("```json\n{}\n```", fence_body.trim()),
            });
            md_index += 1;
            continue;
        };

        let supplied_id = json_val
            .get("gadgetId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);

        let gadget_id = supplied_id.unwrap_or_else(|| format!("{}-{}", options.id_prefix, found));
        let block_id = format!("{}-{gadget_id}", options.id_prefix);

        let payload = json_val
            .get_mut("payload")
            .map(|p| p.take())
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));

        let actions = json_val
            .get("actions")
            .and_then(|a| serde_json::from_value(a.clone()).ok())
            .unwrap_or_default();

        let mut envelope = GadgetEnvelope {
            version: GADGET_CONTRACT_VERSION,
            gadget_id,
            kind,
            scope: options.scope.clone(),
            issued_at: options.issued_at.clone(),
            expires_at: json_val
                .get("expiresAt")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            supersedes: json_val
                .get("supersedes")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            fallback_text: String::new(),
            payload,
            actions,
            state: Some("active".to_string()),
            answer: None,
            redacted: None,
        };

        envelope.fallback_text = gadget_fallback_text(&envelope);

        blocks.push(ChatBlock::Gadget {
            block_id,
            gadget: Box::new(envelope),
        });
    }

    // Push remaining trailing markdown
    if last_index < raw_text.len() {
        let md_slice = &raw_text[last_index..].trim();
        if !md_slice.is_empty() {
            blocks.push(ChatBlock::Markdown {
                block_id: format!("{}-md-{}", options.id_prefix, md_index),
                markdown: md_slice.to_string(),
            });
        }
    }

    ParsedChatBlocks {
        blocks,
        contains_gadget: found > 0,
        malformed,
    }
}
