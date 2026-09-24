---
**Status:** 📋 Proposed
**Created:** 2026-09-24T00:00:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-138
title: "OpenAI-compatible preset catalog and wire options"
status: Proposed
feature: FX-BF-044
updated: 2026-09-24
dependencies: [FX-BE-137]
validation: [npm run check-types, npm run test:core]
---

# FX-BE-138: OpenAI-compatible preset catalog and wire options

## User or operational impact

The catalog the Add provider dialog shows, and the request-level knobs that
make one adapter serve many hosts correctly.

## Scope

- `core/ai/providers/providerPresets.ts` — pure data, unit-tested:

  | presetId | Label | Group | Base URL | Auth | Notes |
  | --- | --- | --- | --- | --- | --- |
  | `openrouter` | OpenRouter | Cloud | `https://openrouter.ai/api/v1` | bearer | optional `HTTP-Referer`/`X-Title` headers |
  | `groq` | Groq | Cloud | `https://api.groq.com/openai/v1` | bearer | |
  | `mistral` | Mistral | Cloud | `https://api.mistral.ai/v1` | bearer | |
  | `deepseek` | DeepSeek | Cloud | `https://api.deepseek.com/v1` | bearer | |
  | `xai` | xAI | Cloud | `https://api.x.ai/v1` | bearer | |
  | `together` | Together AI | Cloud | `https://api.together.xyz/v1` | bearer | |
  | `fireworks` | Fireworks | Cloud | `https://api.fireworks.ai/inference/v1` | bearer | |
  | `cerebras` | Cerebras | Cloud | `https://api.cerebras.ai/v1` | bearer | |
  | `ollama` | Ollama | Local | `http://localhost:11434/v1` | none | tools depend on model |
  | `lm-studio` | LM Studio | Local | `http://localhost:1234/v1` | none | |
  | `vllm` | vLLM | Local | `http://localhost:8000/v1` | bearer (optional) | |
  | `llama-cpp` | llama.cpp server | Local | `http://localhost:8080/v1` | none | |
  | `custom` | Custom OpenAI-compatible | Custom | *(user)* | *(user)* | |

  Each entry: `{ id, label, group, baseUrl, apiPath, auth, keyRequired,
  keyUrl?, docsUrl?, headers?, iconName? }`. **No default model ids** — they
  go stale; the model comes from `/models` or the user. Every URL above is
  re-verified against the vendor's docs at implementation time.
- Built-in providers are described to the renderer through the same IPC
  (`ai.listProviderCatalog()` → `{ builtIns, presets }`) so the renderer
  literal `AI_PROVIDERS` shrinks to UI-only strings and the
  `antigravity-cli` command drift (`antigravity-acp` vs `agy`) is resolved by
  reading core's value.
- `GatewayOptions` gains `auth`, `headers` and `streamUsage`;
  `buildHeaders` honours `auth.kind` (`none` sends no `Authorization`,
  `header` sends the key under the given name).
- `buildChatRequest`: `stream_options` only when `streamUsage !== false`;
  `providerOptions.gateway.caching` only when the provider is
  `vercel-gateway`. **Today it is sent to any provider whose model id
  contains "claude"/"anthropic"/"minimax"** — an OpenRouter
  `anthropic/claude-…` id would carry it. Built-in behaviour for
  `vercel-gateway` stays identical.
- `endpoint()`: when an instance supplies `apiPath` explicitly, use
  `baseUrl + apiPath + suffix` with no heuristic. Built-ins unchanged.
- `listCatalogModels`: for a custom instance, fall back to `manualModels`
  when `/models` fails or returns empty (generalising the Z.ai fallback
  without touching it).

## Acceptance criteria

- `wire.test.ts`: `providerOptions` absent for non-Vercel providers,
  present for Vercel with a Claude id (existing behaviour).
- `auth: none` request has no `Authorization` header; `header api-key`
  sends `api-key: <key>` and no bearer.
- Preset catalog test: ids unique, URLs parse, no header name matches the
  secret pattern.
