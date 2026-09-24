---
**Status:** 📋 Proposed
**Created:** 2026-09-24T00:00:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-139
title: "Connection test and capability probe"
status: Proposed
feature: FX-BF-044
updated: 2026-09-24
dependencies: [FX-BE-138]
validation: [npm run check-types, npm run test:core]
---

# FX-BE-139: Connection test and capability probe

## User or operational impact

"OpenAI-compatible" is a spectrum. The user sees exactly which parts of the
API an endpoint supports before they start a session that needs them.

## Scope

- `core/ai/providers/providerProbe.ts` — `probeOpenAiCompatible(opts, model?)`
  runs, in order, each with its own timeout and a result of
  `pass | fail | skipped` plus the HTTP status/message:
  1. **Reachable + auth** — `GET /models` (401/403 ⇒ auth fail; 404 ⇒
     "no model list", not a failure).
  2. **Chat** — 1-token non-streaming completion on the chosen/first model.
  3. **Streaming + usage** — streamed completion with
     `stream_options.include_usage`; a 400 naming `stream_options` retries
     without and records `streamUsage: false`.
  4. **Tool calling** — one trivial tool with `tool_choice: required`;
     pass only if a well-formed `tool_calls` entry comes back.
- `ProviderCapabilities = { models, chat, streaming, streamUsage, tools,
  probedAt, model }` stored on the instance (non-secret).
- IPC `ai.testCustomProvider(draft, apiKey?)` probes an **unsaved draft**
  (the form's Test button) without persisting the key; the existing
  `testProviderApiKey` delegates to the probe for saved instances.
- `AiProviderStatus` gains `label`, `kind`, `presetId?`, `capabilities?`
  so every renderer surface reads names/capabilities from status rather than
  a local literal.
- Probe cost: at most three 1-token completions; never runs automatically on
  render (only on Test / Save).

## Acceptance criteria

- Against `mockGatewayServer` configured four ways (all pass; no tools;
  rejects `stream_options`; no `/models`) the probe reports exactly the
  failing step and never throws.
- A 401 stops the probe after step 1 with "API key rejected".
- The API key never appears in a probe result or log line.
