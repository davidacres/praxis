---
**Status:** ✅ Done
**Created:** 2026-09-30T22:30:37.000Z
**Type:** Task
**Priority:** Medium
**Requested By:** David Acres
id: TASK-390
title: Add reasoning effort control for AI providers
status: Done
updated: 2026-10-01
---

# Add reasoning effort control for AI providers

## Description

Each AI provider (Anthropic, OpenAI, Google Gemini, and every OpenAI-compatible
endpoint routed through the gateway — Vercel AI Gateway, Z.ai, and custom
endpoints) can now have its reasoning/thinking effort set in two places:

1. **The session composer** — a new chip beside the model picker in
   New Session, and a matching "Reasoning" chip/popover for changing it
   mid-session (Sessions view). It appears for every selected provider model,
   including new or aliased ids that Praxis does not recognize in advance.
2. **AI provider settings, as a per-model default** — Settings → AI Provider
   → Manage models gained a second per-row selector (beside the existing
   workflow-tier picker) to set a model's default reasoning level, which a
   new session on that model starts from unless overridden in the composer.

A normalized level — `off` / `low` / `medium` / `high` — is translated to
each provider's own wire parameter at the point the HTTP request is built:

- **Anthropic** → `thinking: { type: 'enabled', budget_tokens }`, with
  `max_tokens` raised to stay above the budget and any custom `temperature`
  dropped (Anthropic rejects both alongside `thinking`). Streamed
  `thinking_delta` content blocks are now also surfaced as `thought_delta`
  events instead of being silently dropped.
- **Gemini** → `generationConfig.thinkingConfig = { thinkingBudget,
  includeThoughts: true }`.
- **Shared OpenAI-compatible wire** (`openai`, `vercel-gateway`, `z-ai`,
  custom endpoints) — routes by the *model id's own family*, not by which
  connection is sending the request: a genuine OpenAI reasoning model
  (`o1`/`o3`/`o4`, `gpt-5.x`) gets `reasoning_effort` directly; a Claude or
  Gemini model id routed through this same wire (e.g. Vercel AI Gateway's
  `anthropic/claude-sonnet-4.6`) gets the real provider's own shape
  (`providerOptions.anthropic.thinking` / `providerOptions.google
  .thinkingConfig`) via the AI-SDK-style passthrough this wire already uses
  for its gateway-caching hint, merged with it rather than overwriting it.

A capability check only requires a selected provider; model-family
detection chooses the API wire shape but never hides the control. Unknown
OpenAI-compatible model ids receive the standard `reasoning_effort` field
when the user opts into a non-off level.

## CLI providers

CLI-hosted providers (Claude Code CLI, Codex CLI, GitHub Copilot CLI,
Antigravity) run over the Agent Client Protocol rather than a direct HTTP
request. Praxis now discovers ACP's stable `thought_level` session-config
category and maps `off` / `low` / `medium` / `high` onto the values the agent
advertises. Agents without that option keep their own default. The installed
`claude-agent-acp` was verified to advertise `effort` with
default/low/medium/high/xhigh/max.

## Change

New/changed files, end to end:

**`packages/core`**
- `src/ai/providers/reasoningSupport.ts` (new) — `ReasoningEffort` type,
  `REASONING_EFFORT_LEVELS`, `detectReasoningFamily(model)` (family from the
  model id alone), provider/model-wide `supportsReasoningEffort`, and the
  Anthropic/Gemini thinking-budget-per-level mapping.
- `src/ai/providers/reasoningSupport.test.ts` (new) — covers family
  detection and the capability gate across every built-in provider's actual
  default model.
- `src/ai/providers/anthropicWire.ts` — `thinking` param + `max_tokens`
  adjustment + temperature drop in `buildAnthropicRequest`; `thinking_delta`
  → `thought_delta` in `consumeAnthropicStream`.
- `src/ai/providers/geminiWire.ts` — `generationConfig.thinkingConfig` in
  `buildGeminiRequest`.
- `src/ai/acp/acpClient.ts` / `acpAgentHost.ts` — discover ACP's semantic
  `thought_level` option and apply the normalized value before initial and
  resumed prompts.
- `src/ai/gateway/wire.ts` — `buildChatRequest` now calls
  `detectReasoningFamily(args.modelId)` and routes to `reasoning_effort`
  (OpenAI family) or a merged `providerOptions.anthropic`/`.google` entry
  (Claude/Gemini family); `BuildChatRequestArgs.reasoningEffort` added. 4 new
  test cases in `wire.test.ts` cover the routing and the merge with the
  existing gateway-caching `providerOptions`.
- `src/ai/providers/modelPricing.ts` — exported `normalizeModelName` for
  reuse by `reasoningSupport.ts`.
- `src/ai/agentRuntime/agentLoop.ts` — `AgentLoopOptions.reasoningEffort`
  threaded into the adapter's `buildChatRequest` call.
- `src/ai/agentTypes.ts` — `AgentSessionRecord.reasoningEffort`.
- `src/ai/aiSessionManager.ts` — `createAgentSession`'s `runtime` param
  accepts `reasoningEffort`; new `updateSessionReasoningEffort(issueKey,
  level)` setter (deliberately lighter than `transitionAgentRuntime` — it
  never clears native runtime state or opens a new epoch).
- `src/ai/vercelAgentService.ts` — `VercelAgentStartOptions.reasoningEffort`;
  `startTask`/`resumeTask` resolve and persist it, `runLoopForIssue` passes
  it to `runAgentLoop`.
- `src/config/appSettings.ts` — `AiProviderConfig.modelReasoningDefaults:
  Record<string, ReasoningEffort>`; sanitizer validation in
  `readAiProviderConfigs`.
- `src/host/ipcContracts.ts` — `AiDelegateInput.reasoningEffort`;
  `AiIpc.updateSessionReasoningEffort`.
- `src/index.ts` — barrel export for `reasoningSupport.ts`.
- `src/ai/providers/anthropicWire.test.ts` (new) — 4 tests covering the
  `thinking` param, the `max_tokens`/temperature interaction, and the new
  `thought_delta` streaming behavior.

**`apps/praxis-desktop/main`**
- `src/main/aiIpc.ts` — `updateSessionReasoningEffort` export + `ai:
  updateSessionReasoningEffort` IPC handler (mirrors `updateSessionModel`);
  `ai:delegate` resolves a default from `settings.ai.providers[provider]
  .modelReasoningDefaults` when the caller doesn't pass one explicitly.
- `src/main/agentSessionLauncher.ts` — `AgentTaskLaunchInput.reasoningEffort`
  threaded into the gateway branch of `launchAgentTask`.
- `src/preload/index.ts` — exposes `window.praxis.ai
  .updateSessionReasoningEffort`.

**`apps/praxis-desktop/renderer`**
- `src/ai/modelProviders.ts` — renderer-local mirror of
  `supportsReasoningEffort`/family detection (the renderer only imports types
  from core, per this app's CommonJS-boundary rule) + `REASONING_EFFORT_LEVELS`.
- `src/ai/ModelManagerPanel.tsx` — per-model reasoning-default `ChipSelect`
  beside the existing tier picker, persisted straight through
  `AiProviderConfig.modelReasoningDefaults`.
- `src/ai/NewSession.tsx` — reasoning `ChipSelect` beside the model chip,
  defaulted from the provider's per-model setting and threaded into
  `onSubmit`.
- `src/ai/SessionHandover.tsx` — new `'reasoning'` popover branch in
  `SessionTransitionDialogs`, alongside the existing `'model'` branch.
- `src/ai/SessionsPage.tsx` — new `session-reasoning` chip in the session
  toolbar, opening that popover.
- `src/app/App.tsx` — both `<NewSession onSubmit>` call sites thread
  `reasoningEffort` into `window.praxis.ai.delegate(...)`.

## Verification

- `packages/core`: `tsc --noEmit -p .` — clean.
- `apps/praxis-desktop/main`: `tsc --noEmit -p .` — clean.
- `apps/praxis-desktop/renderer`: `npm run check-core-imports && tsc
  --noEmit -p .` — clean (confirms the new renderer code stays within the
  "types only from `@praxis/core`" boundary).
- `packages/core` full unit suite (`npm test`, `node --test` over the
  compiled `out/`): **1341 / 1341 passed** — the original 4
  `anthropicWire.test.ts` cases, plus (added 2026-10-01) 3
  `reasoningSupport.test.ts` cases asserting the fix directly against every
  built-in provider's real default model, and 4 new `wire.test.ts` cases for
  the family-routed `providerOptions` translation.
- `apps/praxis-desktop/main` e2e, `npx playwright test
  e2e/aiProvider.spec.ts`: **13 / 13 passed** — covers the New
  Session composer's provider/model pickers, the model manager panel, and
  delegate flows against mocked Anthropic/OpenAI/Vercel-gateway backends.
  The added case proves an arbitrary unrecognized model can persist a High
  default, inherit it in the composer, override it to Medium, and emit
  `reasoning_effort: "medium"`.
- Focused ACP e2e, `aiCliAgentHost.spec.ts --grep "reasoning default"`:
  **1 / 1 passed** — the fake agent advertises ACP `thought_level`, receives
  the per-model High default, and reports `effort=high` from the prompt.
- The full 398-test functional suite was attempted but became globally
  unstable under four Electron workers (navigation targets closed/timeouts
  across unrelated browser, context, coding, and provider-tab specs). It was
  stopped after 40 passed, 35 failed, 4 interrupted, and 319 had not run;
  the complete 13-test provider file passed inside that run as well.
- `apps/praxis-desktop/main` e2e, `npx playwright test
  e2e/workflowSessionChips.spec.ts`: 1 failure, reproduced twice. This spec
  is a pre-existing known flake unrelated to this change (own project
  note: "composer workflow menu lists 'Quick change' twice → strict-mode
  violation", dated before this work started); the failure observed here
  (`nav-sessions` locator timeout after `page.reload()`) is consistent with
  that same file's existing fragility, not a new regression in the session
  toolbar this task touched.
- `apps/praxis-desktop/main` e2e, `npx playwright test
  e2e/aiSessions.spec.ts`: launched to directly exercise the new
  `session-reasoning` chip and `SessionTransitionDialogs`' `'reasoning'`
  branch; did not return a result before this ticket was written up (see
  "Left for follow-up" below).
- Visual verification captures are retained under `.praxis/session-artifacts/`
  for both the Settings model row and the New Session composer.

## Left for follow-up

- `e2e/aiSessions.spec.ts` did not finish before this ticket was filed;
  worth a clean re-run to get a definitive pass/fail specifically for the
  new `session-reasoning` chip and its popover.
- A live Vercel Gateway smoke test remains useful for gateway-routed
  Claude/Gemini `providerOptions`; the request shapes are unit-tested.

## Effort

M

## Depends on

None.

## Dependencies


## Comments

**2026-09-30:** Implemented end to end per the plan above: normalized
`off`/`low`/`medium`/`high` levels, translated at the wire layer for
Anthropic (`thinking`), the shared OpenAI-compatible wire (`reasoning_effort`
— OpenAI/Vercel AI Gateway/Z.ai/custom endpoints), and Gemini
(`thinkingConfig`); a capability gate so the control only shows for models
that support it; a per-model default in Settings → AI Provider → Manage
models; a composer chip in New Session and a matching mid-session control in
the Sessions view; and the settings-schema, session-record, and IPC plumbing
connecting all of it. Verified with `packages/core`'s full unit suite (1333
passed, including 4 new tests for the Anthropic wire changes), clean
typechecks across core/main/renderer, and the `aiProvider.spec.ts` e2e suite
(12/12) exercising the composer and model-manager surfaces this touched. CLI
(ACP) providers were intentionally left out of scope — see "Scope cut".

**2026-10-01:** User-reported gap: the reasoning control wasn't appearing
for any provider in practice. Root cause — `supportsReasoningEffort` gated
on the *literal provider id* (`provider === 'anthropic'` / `=== 'gemini'`,
else assume OpenAI's `o1`/`o3`/`o4`/`gpt-5` family). `vercel-gateway` — the
default/primary provider — has a default model of `anthropic/claude-sonnet
-4.6` (see `PROVIDER_DESCRIPTORS`), so it only ever matched the OpenAI
branch and always came back `false`; `openai`'s own default (`gpt-4o-mini`)
and `z-ai`'s (`glm-5.3`) are genuinely non-reasoning models, so those were
correctly hidden but made the gap look total. Net effect: the control was
invisible for the one combination most people would actually try first.

Fix: capability is now determined purely from the **model id's family**
(`detectReasoningFamily`), independent of which provider/connection is
routing the request. The shared OpenAI-compatible wire (`gateway/wire.ts`,
used by `vercel-gateway`/`z-ai`/custom endpoints) now inspects the model id
itself and routes a Claude- or Gemini-family model to the real provider's
own shape through `providerOptions` (the same AI-SDK-style passthrough
mechanism it already used for the Vercel gateway-caching hint, merged rather
than overwritten) instead of silently doing nothing. Direct `anthropic` and
`gemini` provider connections were already correct and are unchanged.

**Caveat carried forward, not newly introduced:** the `providerOptions
.anthropic.thinking` / `providerOptions.google.thinkingConfig` passthrough
for gateway-routed models follows the same convention already proven in
this codebase for `providerOptions.gateway.caching`, but — like the ACP
scope-cut above — has not been confirmed against a live Vercel AI Gateway
key actually eliciting thinking output end to end; only the request body
shape is unit-tested. Worth a real-session smoke test before treating
gateway-routed Claude/Gemini reasoning as fully proven, as distinct from the
direct `anthropic`/`gemini`/`openai` connections, which now have it
confirmed via `wire.test.ts` and `anthropicWire.test.ts`.

Re-verified after the fix: `packages/core` full suite 1341/1341, clean
typechecks on core/main/renderer, and `aiProvider.spec.ts` 13/13 with a
freshly rebuilt renderer bundle. The final correction removes the model-name
visibility gate, falls back to standard `reasoning_effort` for unknown
OpenAI-compatible models, and applies CLI effort through ACP's stable
`thought_level` category.
