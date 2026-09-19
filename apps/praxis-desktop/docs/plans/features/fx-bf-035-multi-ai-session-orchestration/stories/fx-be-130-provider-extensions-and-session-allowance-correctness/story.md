---
**Status:** ✅ Complete
**Created:** 2026-09-20
**Type:** Story
**Priority:** High
type: Story
id: FX-BE-130
title: "Provider extensions and session allowance correctness"
status: Complete
feature: FX-BF-035
issue: docs/issues/features/fx-bf-035-multi-ai-session-orchestration/stories/fx-be-130-provider-extensions-and-session-allowance-correctness/issue.md
updated: 2026-09-20
tasks: [TASK-354, TASK-355, TASK-356]
dependencies: [FX-BE-093, FX-BE-115, FX-BF-041]
validation: [npm run check-types --workspace=@praxis/core, npm run check-types --workspace=@praxis/desktop-renderer, npm run check-types --workspace=@praxis/desktop-main, npm run test:core, npm run build --workspace=@praxis/desktop-renderer, git diff --check]
---

# FX-BE-130: Provider extensions and session allowance correctness

## Outcome

Praxis supports Z.ai as a first-class OpenAI-compatible provider and keeps
session usage, budget estimates, runtime-limit state, and provider pickers
accurate as users change providers or models.

## Scope

- Z.ai API registration, endpoint routing, model discovery, secrets, reviews,
  recommendations, and published model pricing estimates.
- Per-turn Z.ai cost accumulation through the existing usage ledger and spend
  warning surfaces; account-level quota remains explicitly unavailable.
- Clearing stale limit/error state on runtime changes and hiding unconfigured
  providers from provider-selection lists.

## Acceptance criteria

- A configured Z.ai key can use the shared OpenAI-compatible transport through
  `https://api.z.ai/api/paas/v4` and its model catalog.
- Known Z.ai model token usage produces a maintained cost estimate; unknown or
  unsupported account-level allowance data remains visibly unavailable.
- Switching provider/model clears the previous provider's limit and error state.
- Provider pickers show only configured providers, while preserving the active
  provider if it becomes unconfigured.

## Tasks

- `TASK-354` — Add Z.ai provider support and pricing-aware usage estimates.
- `TASK-355` — Verify Z.ai cost/budget reporting boundaries and regression paths.
- `TASK-356` — Clear stale session limit state and hide unconfigured providers.

## Close when

Provider registration, usage estimation, runtime switching, and provider-list
behavior are implemented, tested, and type-safe. **Met.**

## Description


## Dependencies



## Comments


