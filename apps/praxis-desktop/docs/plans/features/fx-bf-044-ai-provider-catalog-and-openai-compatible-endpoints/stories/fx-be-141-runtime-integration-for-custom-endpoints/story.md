---
**Status:** 📋 Proposed
**Created:** 2026-09-24T00:00:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-141
title: "Runtime integration for custom endpoints"
status: Proposed
feature: FX-BF-044
updated: 2026-09-24
dependencies: [FX-BE-137, FX-BE-139]
validation: [npm run check-types, npm run test:core, npx playwright test aiSessions.spec.ts aiTicketReview.spec.ts workflowModelTiers.spec.ts aiSpendReport.spec.ts]
---

# FX-BE-141: Runtime integration for custom endpoints

## User or operational impact

A custom endpoint behaves like any API provider everywhere a provider is
chosen or used — and fails with a named reason where it can't.

## Scope

- `aiInstance.ts`: `resolveConnectionOptions(id)` builds `GatewayOptions`
  from the instance (URL, path, auth, headers, streamUsage);
  `buildProviderStatus` covers instances (configured = key present, or
  `auth: none` and URL set).
- `resolveProviderAdapter(id)` → `openAiCompatibleAdapter` for every
  `custom:` id.
- `aiReviewRuntime.ts`: replace `provider === 'openai' || provider === 'z-ai'`
  with a dispatch on the resolved adapter/protocol so custom instances review
  tickets without another branch.
- Pickers (`NewSession`, workflow stage agent, recommendation provider):
  instances listed under their label; an instance whose last probe failed
  **tools** is shown disabled in agent/workflow pickers with the reason
  ("This endpoint didn't pass tool calling — run Test connection"), but
  remains selectable for recommendation and ticket review.
- `resolveRecommendationProvider` / `ai:delegate` accept `custom:` ids and
  apply the existing enabled/usable rule.
- Session records store `providerLabel` at start so history still reads
  correctly after an instance is renamed or removed; resuming a session on a
  removed instance goes through `providerFallback.ts` with "endpoint removed".
- Usage ledger / Spend tab: custom instances aggregate under their label,
  tokens only.
- `docs/desktop-feature-parity.md`: add the provider catalog row.

## Acceptance criteria

- e2e: agent session against `mockGatewayServer` via a custom instance
  streams, runs a tool call and records token usage.
- e2e: a no-tools instance is disabled in the session provider picker with the
  reason, and ticket review on it succeeds.
- Deleting an instance leaves its sessions listed and readable.
- Existing provider e2e specs pass unchanged apart from the deliberate
  row-visibility updates in FX-BE-140.
