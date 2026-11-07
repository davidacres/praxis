---
**Created:** 2026-11-07T21:22:00.753Z
id: TASK-524
type: Task
status: To Do
---

# Port Anthropic, Gemini, and OpenAI streaming wire adapters

**Status:** To Do
**Type:** Task
**Priority:** High

## Description

Port `anthropicWire.ts`, `geminiWire.ts`, `wire.ts`, `customProviders.ts`, `reasoningSupport.ts`, `modelPricing.ts`, `providerPreflight.ts`, `localRuntimeDetection.ts`, and `aiUsageStats.ts` into `crates/praxis-ai::providers` using `reqwest` and `eventsource-stream`. Support streaming tool calls, thinking blocks, rate-limit classification (`providerLimitError`), and persistent spend/token accounting.

## Acceptance Criteria

- Provider wire unit tests (`anthropicWire`, `geminiWire`, `wire`, `customProviders`, `aiUsageStats`) pass in `cargo test -p praxis-ai`.
- `aiSessionMode.spec.ts` and `aiUsageDashboard.spec.ts` pass.

## Dependencies

- `FX-BE-197`

## Comments


