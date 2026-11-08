---
**Created:** 2026-11-07T21:22:00.753Z
id: TASK-524
type: Task
status: In Progress
---

# Port Anthropic, Gemini, and OpenAI streaming wire adapters

**Status:** In Progress
**Type:** Task
**Priority:** High

## Description

Port `anthropicWire.ts`, `geminiWire.ts`, `wire.ts`, `customProviders.ts`, `reasoningSupport.ts`, `modelPricing.ts`, `providerPreflight.ts`, `localRuntimeDetection.ts`, and `aiUsageStats.ts` into `crates/praxis-ai::providers` using `reqwest` and `eventsource-stream`. Support streaming tool calls, thinking blocks, rate-limit classification (`providerLimitError`), and persistent spend/token accounting.

## Acceptance Criteria

- Provider wire unit tests (`anthropicWire`, `geminiWire`, `wire`, `customProviders`, `aiUsageStats`) pass in `cargo test -p praxis-ai`.
- `aiSessionMode.spec.ts` and `aiUsageDashboard.spec.ts` pass.

## Dependencies

- `FX-BE-195`

## Comments


- 2026-11-08: Status corrected to In Progress. Committed in `crates/praxis-ai/src/providers/`: `anthropic_wire`, `gemini_wire`, `wire` (shared SSE consumer, via `eventsource-stream`), `custom_providers`, `model_pricing`, `reasoning_support`, `provider_limit_error`, `provider_preflight` and `local_runtime_detection`, plus `usage_stats`. Its unit tests can't be run until the `praxis-ai` test target compiles again (see `TASK-534`). The listed e2e specs have not been run against Rust: no `ai:*` channel is delegated.
