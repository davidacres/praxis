---
**Status:** ✅ Complete
**Created:** 2026-09-18T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-041
slug: session-usage-and-provider-allowance-visibility
title: Session usage and provider allowance visibility
status: Complete
owner: Electron desktop app
updated: 2026-09-18
issues: docs/issues/features/fx-bf-041-session-usage-and-provider-allowance-visibility/feature-issues.md
stories: [FX-BE-129]
validation: [npm run check-types --workspace=@praxis/core, npm run check-types --workspace=@praxis/desktop-renderer, npm run check-types --workspace=@praxis/desktop-main, npm run build --workspace=@praxis/desktop-renderer, node --test packages/core/out/ai/aiUsageStats.test.js]
---

# FX-BF-041: Session usage and provider allowance visibility

## Outcome

Praxis Desktop makes AI consumption visible where work happens: a selected
session shows its token and cost usage, recent hourly/daily/weekly/monthly
totals, model attribution, and warnings before a configured allowance is
exceeded. Provider-specific account data is optional and never guessed.

## Scope

- Add a provider-neutral usage snapshot contract and adapter registry.
- Surface an expandable usage summary in the session composer.
- Extend the durable usage ledger views with hourly buckets.
- Show per-session and per-model token/cost totals when providers report them.
- Support OpenAI organization completion usage and cost reads through an Admin
  API key held in the OS keychain.
- Show provider credits, limits, and reset information only when an adapter
  supplies those fields; explain unavailable account data explicitly.
- Warn at the existing Praxis spend-limit thresholds without blocking work.

## Story map

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-129 | Session usage, cost, and provider allowance visibility | Complete | FX-BF-015, FX-BF-035 |

## Dependencies

- `FX-BF-015` — session review and cost/context presentation.
- `FX-BF-035` — multi-provider session orchestration and runtime attribution.
- Existing `AiUsageLog`, `AgentSessionRecord.tokenUsage`, `AgentSessionRecord.cost`, and OS-backed secrets.

## Risks or open questions

- Account limits and credit balances are not consistently exposed by AI
  providers. Praxis must show “unavailable” rather than infer a balance from
  tokens or pricing.
- OpenAI Admin usage data is organization-level and may require permissions
  separate from the model API key.
- Provider pricing changes must not be hard-coded into the renderer; adapters
  own provider-specific cost/allowance interpretation.

## Close when

The session composer exposes local usage over hourly, daily, weekly, and
monthly windows; warnings are visible at configured thresholds; OpenAI usage
can be read with a securely stored Admin API key; and a provider-neutral adapter
contract allows additional providers without changing the renderer contract.

## Delivery order

1. Define the provider-neutral snapshot and IPC contract.
2. Add hourly ledger aggregation and the session usage summary.
3. Add secure OpenAI Admin usage/cost retrieval and settings entry.
4. Verify core, main, renderer, and focused usage tests.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments
