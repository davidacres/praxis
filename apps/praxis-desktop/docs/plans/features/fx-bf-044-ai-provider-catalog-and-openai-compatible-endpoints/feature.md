---
**Status:** ✅ Complete
**Created:** 2026-09-24T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-044
slug: ai-provider-catalog-and-openai-compatible-endpoints
title: AI provider catalog and OpenAI-compatible endpoints
status: Complete
owner: Electron desktop app
updated: 2026-09-24
stories: [FX-BE-137, FX-BE-138, FX-BE-139, FX-BE-140, FX-BE-141]
validation: [npm run check-types, npm run test:core, npm run build, npm run desktop:copy-renderer, npx playwright test aiProvider.spec.ts aiProviderTabs.spec.ts aiSessions.spec.ts workflowModelTiers.spec.ts]
---

# FX-BF-044: AI provider catalog and OpenAI-compatible endpoints

## Outcome

Settings → AI Provider becomes a list of the providers *you use*, with an
**Add provider** catalog to pick from. The catalog carries the existing
built-in providers plus a data-driven set of OpenAI-compatible presets
(OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Fireworks, Cerebras,
Ollama, LM Studio, vLLM, llama.cpp …) and a **Custom OpenAI-compatible
endpoint** entry. Adding a preset or custom endpoint creates a provider
*instance* — so two Ollama hosts, or a work and a personal OpenRouter key,
are two rows — without a code change, a new `AiProvider` union member, or a
new adapter.

## Why this shape

Today every provider is compiled in. Adding Z.ai took edits in ~10 places
across three workspaces:

| Where | What is hand-listed |
| --- | --- |
| `packages/core/src/types.ts` | `AiProvider` closed string union |
| `core/ai/providers/registry.ts` | `PROVIDER_DESCRIPTORS`, `ADAPTERS` |
| `core/config/appSettings.ts` | `KNOWN_AI_PROVIDERS` (sanitize + merge iterate it) |
| `core/ai/providerSecrets.ts` | `API_KEY_PROVIDERS`, recommendation list |
| `core/ai/providers/modelCatalog.ts` | per-id branches (`z-ai` fallback list) |
| `core/ai/providers/modelPricing.ts` | per-id price maps |
| `core/ai/gateway/gatewayClient.ts` | Z.ai host/path fallback logic |
| `renderer/settings/SettingsPage.tsx` | `AI_PROVIDERS` display literal, Z.ai-only field |
| `renderer/ai/modelProviders.ts` | `PROVIDER_LABELS`, `API_MODEL_PROVIDERS`, icon switch |
| `renderer/ai/sessionNav.ts` | price map copy |
| `main/aiReviewRuntime.ts` | `openai \|\| z-ai` branch |

Most of those providers differ only in **base URL, path, auth header and a
few capability quirks** — they already share `openAiCompatibleAdapter`. That
is data, not code. The adapter split in `registry.ts` stays exactly where the
wire protocol genuinely differs (Anthropic Messages, Gemini, ACP CLIs).

The mirrors have already drifted once: `antigravity-cli`'s default command is
`antigravity-acp` in core and `agy` in the renderer literal. A third
hand-maintained list for presets would make that worse, so the renderer gets
the catalog over IPC instead (the renderer may only import *types* from core —
see root `AGENTS.md`).

## Decisions

1. **Two tiers, one list.** Built-in providers keep their `AiProvider` ids and
   bespoke code. Presets and custom endpoints are *instances* with ids of the
   form `custom:<slug>`. The public id type becomes
   `AiProviderId = AiProvider | \`custom:${string}\``. Built-ins are not
   migrated to presets in this feature (OpenAI and Z.ai could be later; Z.ai's
   endpoint-fallback code makes it a poor first candidate).
2. **Presets are templates, not providers.** Adding "Groq" writes a
   `CustomProviderConfig` with `presetId: 'groq'` and the preset's URL/path/
   auth copied in. Editing the instance never edits the preset; a preset
   update in a new app version never rewrites a user's saved URL.
3. **The Providers tab lists added providers only.** A row shows when it is
   configured (key saved / CLI found on PATH), is the default, or was
   explicitly added. Existing setups see the same configured rows they see
   today; unconfigured built-ins move into the catalog. This is the one
   visible behaviour change and it touches `aiProvider.spec.ts` /
   `aiProviderTabs.spec.ts`, which click unconfigured rows.
4. **Capabilities are probed, not assumed.** "OpenAI-compatible" servers vary
   — many local models have no tool calling, some reject
   `stream_options.include_usage`, some have no `/models`. A connection test
   records what worked; agent sessions and workflows (which need tools) only
   offer endpoints whose probe passed tool calling; chat-only endpoints remain
   usable for recommendation/review prompts.
5. **Secrets stay in the keychain, keyed by instance.**
   `praxis.customProvider.<slug>.apiKey`. Non-secret extra headers (e.g.
   OpenRouter's `HTTP-Referer` / `X-Title`) live in settings; a header whose
   *name* matches the workspace-file secret pattern
   (`token|secret|password|apikey|api_key|pat`) is refused as a plain header
   and must go in the key field.
6. **No invented prices.** Custom endpoints report tokens only, matching the
   existing spend rule (`AiSettings.spendLimit` doc comment). Per-model user
   price entry is a follow-up, not this feature.

## Scope

- Open the provider identity type and add `ai.customProviders` to settings
  (sanitize, merge, `settingsDefaults.ts` mirror). — FX-BE-137
- Core preset catalog + per-instance wire options (auth style, API path,
  extra headers, stream-usage flag); fix Vercel-only request fields leaking to
  other OpenAI-compatible hosts. — FX-BE-138
- Connection test that probes models / chat / tool calling / stream usage and
  stores the result. — FX-BE-139
- Settings UI: added-only list, **Add provider** catalog dialog, custom
  endpoint form, remove. — FX-BE-140
- Sessions, pickers, recommendation resolver, ticket review, usage ledger and
  fallback handle `custom:` ids. — FX-BE-141

## Out of scope

- Anthropic- or Gemini-protocol custom endpoints (e.g. a Bedrock/Vertex
  proxy). The instance model allows a `protocol` field later; v1 is
  `openai-chat` only.
- Azure OpenAI's deployment-path API. Its newer `/openai/v1` surface may fit
  the custom form with `auth: header api-key` — verify against a real
  resource before adding a preset.
- Moving OpenAI / Z.ai from built-ins to presets.
- User-entered model pricing.
- Mobile app changes (it follows desktop settings; re-check once FX-BE-141
  lands).

## Story map

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-137 | Open provider identity and custom endpoint settings | Proposed | — |
| FX-BE-138 | OpenAI-compatible preset catalog and wire options | Proposed | FX-BE-137 |
| FX-BE-139 | Connection test and capability probe | Proposed | FX-BE-138 |
| FX-BE-140 | Provider catalog settings UI | Proposed | FX-BE-137, FX-BE-138, FX-BE-139 |
| FX-BE-141 | Runtime integration for custom endpoints | Proposed | FX-BE-137, FX-BE-139 |

## Dependencies

- `FX-BF-035` — multi-provider sessions and runtime attribution.
- `FX-BF-041` — usage ledger (custom ids must aggregate cleanly).
- Existing `openAiCompatibleAdapter`, `modelCatalog.ts` cache (already keyed
  by provider + URL + key hash, so it works unchanged for instances), and
  `mockGatewayServer.ts` for e2e.

## Risks or open questions

- **Persisted sessions reference a provider id.** Deleting a custom endpoint
  must not break session history: the id stays on the record, the label is
  captured at session start, and resuming shows "endpoint removed" with the
  existing provider-fallback path.
- **Plain HTTP.** Local runtimes are `http://localhost:…`. Sending an API key
  over plain HTTP to a non-loopback host gets a visible warning in the form;
  it is not blocked (LAN inference boxes are a real use).
- **`endpoint()` path heuristics** in `gatewayClient.ts` guess whether to
  append `/v1`. With an explicit per-instance `apiPath` the guess is skipped
  for custom instances; built-ins keep today's behaviour byte-identical.
- **Row visibility change** (decision 3) needs the provider e2e specs
  updated deliberately, not just re-snapshotted.

## Close when

A user can open Settings → AI Provider → Add provider, pick "Ollama" or
"Custom OpenAI-compatible endpoint", fill in URL (+ key if needed), run the
test, see which capabilities passed, and start an agent session on it from the
composer — and existing users see no change to their configured providers,
stored keys, default provider or running sessions.

## Delivery order

1. FX-BE-137 (types + settings, no UI) — lands dark.
2. FX-BE-138 (catalog + wire) — unit-tested against `mockGatewayServer`.
3. FX-BE-139 (probe) — IPC only.
4. FX-BE-141 (runtime) and FX-BE-140 (UI) in parallel; UI last to merge.

## Delivered

All five stories are implemented on `claude/ai-provider-selection-s7mvpr`. Where the build
differs from the plan above, the story says so under **Delivered**. Two changes outside the
story list, both from the "no overlapping buttons" requirement:

- The built-in API key row's buttons (`Save key` / `Test key` / `Clear`) wrapped their labels
  and ran off the row in a narrow window; they now sit in a wrapping cluster
  (`.ai-key-controls`), guarded by a geometric e2e check that was proven against the old layout.
- On Windows/Linux the title bar's centred group overlapped the layout buttons below ~1650px
  (61px at 1280px) because the window controls sit on the right there. Below that width it now
  joins the flex row; measured overlap-free from 1000px to 1800px.

Still open: the renderer's `AI_PROVIDERS` literal and core's `PROVIDER_DESCRIPTORS` still
disagree on Antigravity's default command (`agy` vs `antigravity-acp`), and the mobile app has
not been checked against `custom:` provider ids.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


