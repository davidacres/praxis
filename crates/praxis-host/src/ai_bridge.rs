//! Opt-in AI runtime, provider preflight, gadget block parsing, ACP supervisor,
//! and usage accounting bridge.
use std::path::Path;

use chrono::{DateTime, Utc};
use praxis_ai::acp::host::{evaluate_permission_request, is_read_only_shell_command};
use praxis_ai::acp::protocol::AcpPermissionRequest;
use praxis_ai::gadgets::block_parser::{ChatBlockParseOptions, parse_chat_blocks};
use praxis_ai::gadgets::contracts::GadgetEnvelope;
use praxis_ai::gadgets::json_repair::parse_lenient_json;
use praxis_ai::gadgets::redaction::{redact_deep, redact_secrets};
use praxis_ai::gadgets::validation::validate_gadget_envelope;
use praxis_ai::mcp::builtin::read_only_files::resolve_sandboxed_path;
use praxis_ai::providers::custom_providers::{
    CustomProviderInput, custom_base_url_problem, validate_custom_provider,
};
use praxis_ai::providers::local_runtime_detection::detect_local_runtimes;
use praxis_ai::providers::model_pricing::{get_known_context_length, get_model_pricing};
use praxis_ai::providers::provider_limit_error::{
    extract_provider_limit_message, is_provider_limit_error,
};
use praxis_ai::providers::provider_preflight::{
    ProviderPreflightSpec, SystemPreflightProbes, run_provider_preflight,
};
use praxis_ai::providers::reasoning_support::{ReasoningEffort, reasoning_availability};
use praxis_ai::team_chat::personas::default_team_personas;
use praxis_ai::team_chat::transitions::conversation_payload_digest;
use praxis_ai::usage_stats::{
    AiUsageEvent, daily_usage, summarize_usage, summarize_usage_by_model, usage_trend,
};
use praxis_contracts::RustRpcError;
use praxis_workflows::types::AgentToolMode;
use serde_json::{Value, json};
use tokio::runtime::Handle;

use crate::HostContext;

fn failure(message: impl std::fmt::Display) -> RustRpcError {
    RustRpcError {
        code: "AI_ERROR".into(),
        message: message.to_string(),
    }
}

fn text(args: &[Value], index: usize) -> Result<&str, RustRpcError> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| failure("AI argument must be a string."))
}

fn opt_text(args: &[Value], index: usize) -> Option<&str> {
    args.get(index).and_then(Value::as_str)
}

fn value(args: &[Value], index: usize) -> Result<&Value, RustRpcError> {
    args.get(index)
        .ok_or_else(|| failure("AI argument is missing."))
}

fn parse_tool_mode(raw: Option<&str>) -> AgentToolMode {
    match raw.unwrap_or("read-only") {
        "full" => AgentToolMode::Full,
        "project-only" => AgentToolMode::ProjectOnly,
        _ => AgentToolMode::ReadOnly,
    }
}

fn parse_reasoning_effort(raw: Option<&str>) -> Option<ReasoningEffort> {
    match raw? {
        "off" => Some(ReasoningEffort::Off),
        "low" => Some(ReasoningEffort::Low),
        "medium" => Some(ReasoningEffort::Medium),
        "high" => Some(ReasoningEffort::High),
        _ => None,
    }
}

/// Registers AI runtime and supervisor channels onto `host`.
pub fn register_ai_channels(host: &HostContext, handle: &Handle) {
    // 1. Local AI runtimes detection
    host.register_handler("ai:detectLocalRuntimes", |_, args| {
        let path_str = opt_text(args, 0).unwrap_or("");
        let path = if path_str.is_empty() {
            std::env::var("PATH").unwrap_or_default()
        } else {
            path_str.to_string()
        };
        Ok(json!(detect_local_runtimes(&path)))
    });

    // 2. Custom provider validation
    host.register_handler("ai:validateCustomProvider", |_, args| {
        let input: CustomProviderInput =
            serde_json::from_value(value(args, 0)?.clone()).map_err(failure)?;
        Ok(json!(validate_custom_provider(&input)))
    });

    // 3. Custom base URL validation
    host.register_handler("ai:customBaseUrlProblem", |_, args| {
        let base_url = text(args, 0)?;
        Ok(json!(custom_base_url_problem(base_url)))
    });

    // 4. Reasoning availability
    host.register_handler("ai:reasoningAvailability", |_, args| {
        let provider = opt_text(args, 0);
        let model = opt_text(args, 1);
        let effort = parse_reasoning_effort(opt_text(args, 2));
        Ok(json!(reasoning_availability(provider, model, effort)))
    });

    // 5. Model pricing
    host.register_handler("ai:modelPricing", |_, args| {
        let provider = opt_text(args, 0);
        let model = opt_text(args, 1);
        Ok(json!(get_model_pricing(provider, model)))
    });

    // 6. Known context length
    host.register_handler("ai:knownContextLength", |_, args| {
        let model = opt_text(args, 0);
        let provider = opt_text(args, 1);
        Ok(json!(get_known_context_length(model, provider)))
    });

    // 7. Provider rate limit error extraction
    host.register_handler("ai:providerLimitError", |_, args| {
        let err_text = text(args, 0)?;
        let is_limit = is_provider_limit_error(err_text);
        let message = extract_provider_limit_message(err_text);
        Ok(json!({
            "isLimit": is_limit,
            "message": message
        }))
    });

    // 8. Provider preflight capability check
    let rt = handle.clone();
    host.register_handler("ai:preflightProvider", move |_, args| {
        let spec: ProviderPreflightSpec =
            serde_json::from_value(value(args, 0)?.clone()).map_err(failure)?;
        let probes = SystemPreflightProbes::new();
        let result = rt.block_on(run_provider_preflight(&spec, &probes));
        Ok(json!(result))
    });

    // 9. Gadget block parser
    host.register_handler("gadgets:parseChatBlocks", |_, args| {
        let raw_text = text(args, 0)?;
        let options: ChatBlockParseOptions =
            serde_json::from_value(value(args, 1)?.clone()).map_err(failure)?;
        Ok(json!(parse_chat_blocks(raw_text, &options)))
    });

    // 10. Gadget envelope validation
    host.register_handler("gadgets:validate", |_, args| {
        let mut envelope: GadgetEnvelope =
            serde_json::from_value(value(args, 0)?.clone()).map_err(failure)?;
        match validate_gadget_envelope(&mut envelope) {
            Ok(()) => Ok(json!({
                "valid": true,
                "envelope": envelope
            })),
            Err(err) => Ok(json!({
                "valid": false,
                "error": err
            })),
        }
    });

    // 11. Lenient JSON repair for gadget bodies
    host.register_handler("gadgets:repairJson", |_, args| {
        let raw_text = text(args, 0)?;
        match parse_lenient_json(raw_text) {
            Ok((val, repaired)) => Ok(json!({
                "ok": true,
                "value": val,
                "repaired": repaired
            })),
            Err(err) => Ok(json!({
                "ok": false,
                "error": err
            })),
        }
    });

    // 12. Gadget secret redaction
    host.register_handler("gadgets:redactSecrets", |_, args| {
        let target = value(args, 0)?;
        if let Some(text_str) = target.as_str() {
            let (redacted, hits) = redact_secrets(text_str);
            Ok(json!({
                "redacted": redacted,
                "hits": hits
            }))
        } else {
            let mut val = target.clone();
            let count = redact_deep(&mut val);
            Ok(json!({
                "value": val,
                "count": count
            }))
        }
    });

    // 13. ACP tool permission evaluation
    host.register_handler("acp:evaluatePermission", |_, args| {
        let request: AcpPermissionRequest =
            serde_json::from_value(value(args, 0)?.clone()).map_err(failure)?;
        let tool_mode = parse_tool_mode(opt_text(args, 1));
        let auto_approve = args.get(2).and_then(Value::as_bool).unwrap_or(false);
        let decision = evaluate_permission_request(&request, tool_mode, auto_approve);
        Ok(json!(decision))
    });

    // 14. ACP read-only shell command detection
    host.register_handler("acp:isReadOnlyShellCommand", |_, args| {
        let command = text(args, 0)?;
        Ok(json!(is_read_only_shell_command(command)))
    });

    // 15. ACP / MCP sandboxed relative path resolution
    host.register_handler("acp:resolveSandboxedPath", |_, args| {
        let root = text(args, 0)?;
        let requested = text(args, 1)?;
        match resolve_sandboxed_path(Path::new(root), requested) {
            Ok(resolved) => Ok(json!({
                "ok": true,
                "path": resolved.to_string_lossy()
            })),
            Err(err) => Ok(json!({
                "ok": false,
                "error": err
            })),
        }
    });

    // 16. Team chat personas list
    host.register_handler("teamChat:listPersonas", |_, _| {
        Ok(json!(default_team_personas()))
    });

    // 17. Team chat turn payload digest
    host.register_handler("teamChat:verifyTurn", |_, args| {
        let payload = value(args, 0)?;
        let digest = conversation_payload_digest(payload).map_err(failure)?;
        Ok(json!({ "digest": digest }))
    });

    // 18. AI usage ledger summary
    host.register_handler("aiUsage:summarize", |_, args| {
        let events: Vec<AiUsageEvent> =
            serde_json::from_value(value(args, 0)?.clone()).map_err(failure)?;
        Ok(json!(summarize_usage(&events)))
    });

    // 19. AI usage by model
    host.register_handler("aiUsage:byModel", |_, args| {
        let events: Vec<AiUsageEvent> =
            serde_json::from_value(value(args, 0)?.clone()).map_err(failure)?;
        Ok(json!(summarize_usage_by_model(&events)))
    });

    // 20. AI usage trend
    host.register_handler("aiUsage:trend", |_, args| {
        let events: Vec<AiUsageEvent> =
            serde_json::from_value(value(args, 0)?.clone()).map_err(failure)?;
        let days = args
            .get(1)
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .unwrap_or(30);
        let now = if let Some(now_str) = opt_text(args, 2) {
            DateTime::parse_from_rfc3339(now_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now())
        } else {
            Utc::now()
        };
        Ok(json!(usage_trend(&events, days, now)))
    });

    // 21. AI daily usage
    host.register_handler("aiUsage:daily", |_, args| {
        let events: Vec<AiUsageEvent> =
            serde_json::from_value(value(args, 0)?.clone()).map_err(failure)?;
        let days = args
            .get(1)
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .unwrap_or(30);
        let now = if let Some(now_str) = opt_text(args, 2) {
            DateTime::parse_from_rfc3339(now_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now())
        } else {
            Utc::now()
        };
        Ok(json!(daily_usage(&events, days, now)))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostConfig;
    use praxis_contracts::RustRpcRequest;

    fn test_host() -> (HostContext, tokio::runtime::Runtime) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = format!("/tmp/praxis-ai-test-{}-{nanos}", std::process::id());
        let settings = format!("{dir}/test-settings.json");
        let config = HostConfig::new(&dir, &settings, true, true).expect("config");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let host = HostContext::new(config);
        register_ai_channels(&host, rt.handle());
        (host, rt)
    }

    fn rpc(host: &HostContext, channel: &str, args: Vec<Value>) -> Value {
        let resp = host.dispatch_rpc(RustRpcRequest {
            id: "test-req".to_string(),
            channel: channel.to_string(),
            args,
        });
        assert!(resp.ok, "RPC {} failed: {:?}", channel, resp.error);
        resp.result.unwrap_or(Value::Null)
    }

    #[test]
    fn test_ai_detect_local_runtimes_registered() {
        let (host, _rt) = test_host();
        let res = rpc(&host, "ai:detectLocalRuntimes", vec![json!("")]);
        assert!(res.is_array());
    }

    #[test]
    fn test_ai_validate_custom_provider_channel() {
        let (host, _rt) = test_host();
        let input = json!({
            "name": "",
            "baseUrl": "ftp://invalid",
            "apiKey": "",
            "model": "",
            "headers": {},
            "headerNames": []
        });
        let res = rpc(&host, "ai:validateCustomProvider", vec![input]);
        let problems: Vec<String> = serde_json::from_value(res).expect("array of strings");
        assert!(!problems.is_empty());
        assert!(problems.iter().any(|p| p.contains("name is required")));
    }

    #[test]
    fn test_acp_permission_evaluation() {
        let (host, _rt) = test_host();
        let request = json!({
            "toolCallId": "tc-1",
            "toolName": "read_file",
            "kind": "read",
            "rawInput": { "path": "test.txt" }
        });
        let res = rpc(
            &host,
            "acp:evaluatePermission",
            vec![request, json!("read-only"), json!(false)],
        );
        assert_eq!(res.as_str(), Some("allow_once"));
    }

    #[test]
    fn test_gadgets_parse_blocks() {
        let (host, _rt) = test_host();
        let markdown = "Here is an option:\n\n```praxis-gadget\n{\n  \"version\": 1,\n  \"kind\": \"choice\",\n  \"gadgetId\": \"g1\",\n  \"payload\": {\n    \"question\": \"Proceed?\"\n  },\n  \"actions\": []\n}\n```\nAll done.";
        let options = json!({
            "scope": {
                "hostId": "h1",
                "sessionId": "s1"
            },
            "issuedAt": "2026-11-09T00:00:00.000Z",
            "idPrefix": "test"
        });
        let res = rpc(
            &host,
            "gadgets:parseChatBlocks",
            vec![json!(markdown), options],
        );
        assert_eq!(res["containsGadget"], json!(true));
        assert!(res["blocks"].as_array().expect("array").len() >= 2);
    }

    #[test]
    fn test_team_chat_personas_and_digest() {
        let (host, _rt) = test_host();
        let personas = rpc(&host, "teamChat:listPersonas", vec![]);
        assert_eq!(personas.as_array().expect("array").len(), 5);

        let digest_res = rpc(&host, "teamChat:verifyTurn", vec![json!([])]);
        assert_eq!(
            digest_res["digest"].as_str(),
            Some("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945")
        );
    }
}
