---
**Status:** Done
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-417
slug: structured-provider-unavailable-codes
title: Structured Provider Unavailable Codes in Core and Adapters
status: Done
created: 2026-10-04
owner: Electron desktop app
featureId: 107
storyId: 157
---

# TASK-417: Structured Provider Unavailable Codes in Core and Adapters

## Description

Introduce a machine-readable reason code on `ProviderUsageSnapshot` so a display layer can distinguish an unconfigured provider from an unsupported one and from a genuine read failure. The existing human-readable `unavailableReason` string is retained for display, so no caller breaks.

## Acceptance criteria

- `ProviderUsageUnavailableCode` is defined in `packages/core/src/ai/providerUsage.ts` as `'not-configured' | 'not-supported' | 'cli-unavailable' | 'fetch-failed'`, mirroring the existing `MobileProviderUnavailableReason` union.
- `unavailable()` in `aiUsageIpc.ts` accepts a code alongside the message.
- The OpenAI adapter reports a missing Admin key as `not-configured`; the generic fallback reports `not-supported`.
- Codex and MiniMax report request failures as `fetch-failed` and a missing binary as `cli-unavailable`.
- The Claude adapter reports a session-limit message through a dedicated `notice` field rather than `unavailableReason`.
- `providerUsageBatch.ts` normalises every result, defaulting a prose-only snapshot to `fetch-failed`.

## Design note

`disabled` was deliberately omitted from the union. The batch layer already filters disabled providers out of the request, so the code would never be produced and an unused variant would be dead weight.

## Verification

- `providerUsageBatch.test.ts` pins each code, and pins the default applied to a prose-only snapshot. A test for the default failed first, exposing the untagged pass-through in the source.
- `npm run check-types` clean; `npm run build` succeeded.

## Dependencies

- FX-BF-107, FX-BE-157

## Comments


