---
**Status:** ✅ Complete
**Created:** 2026-09-20T11:55:00.000Z
**Type:** Task
**Priority:** High
id: TASK-366
title: Render message timestamp, duration, token/cost chips, and model attribution in chat UI
status: Complete
story: FX-BE-134
feature: FX-BF-042
updated: 2026-09-20
---

# TASK-366: Render message timestamp, duration, token/cost chips, and model attribution in chat UI

## Outcome

The chat interface renders clear, elegant, and readable telemetry on messages.
Every message displays a formatted time with a full date/time tooltip; assistant
messages render a compact footer with elapsed duration, token count, cost, and
model attribution badge.

## Scope

- In `apps/praxis-desktop/renderer/src/ai/SessionsPage.tsx` (and related message
  components):
  - Add formatted timestamps to user and assistant message headers or footers
    with full date/time tooltip (e.g. `11:42 AM` with tooltip `Sunday, 20 September 2026, 11:42:15`).
  - Render an assistant message telemetry strip showing:
    - Duration chip (e.g. `⏱️ 2.4s`).
    - Token chip (e.g. `🔤 850 tokens`, tooltip breakdown of prompt/completion/reasoning).
    - Cost chip (e.g. `💲 $0.0014`).
    - Model badge chip (e.g. `🤖 glm-5.3-flash`).
- Ensure styling uses semantic tokens (`--text-muted`, `--bg-surface-elevated`,
  `--border-subtle`) across all four theme axes (dark, light, accent, material).

## Acceptance criteria

- All messages render a formatted timestamp (e.g. `11:42 AM`).
- Assistant messages display duration, token count, cost, and model badge when
  available.
- Chips wrap gracefully on smaller widths or narrow panel configurations without
  overflowing or breaking layout.
- High contrast and keyboard focus guidelines are respected.

## Validation

- `npm run check-types --workspace=@praxis/desktop-renderer`
- `npm run build --workspace=@praxis/desktop-renderer`

## Description


## Dependencies


## Comments
