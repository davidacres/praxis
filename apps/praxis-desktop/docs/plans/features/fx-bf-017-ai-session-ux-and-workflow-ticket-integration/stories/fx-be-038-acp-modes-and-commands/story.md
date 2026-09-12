---
**Status:** 📋 Proposed
**Created:** 2026-09-06T13:13:26.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-038
title: Surface ACP session modes and slash commands
status: Done
feature: FX-BF-017
issue: docs/issues/features/fx-bf-017-ai-session-ux-and-workflow-ticket-integration/stories/fx-be-038-acp-modes-and-commands/issue.md
updated: 2026-09-06
commits: [dc91dcb]
dependencies: [FX-BF-011]
validation: [npm run check-types, npm run test:desktop]
---

# Surface ACP session modes and slash commands

## User or operational impact

Two stable, protocol-defined ACP session updates — `available_commands_update`
and `current_mode_update` — went unhandled. `handleSessionUpdate`'s switch has
no `default`, so the gap read as "the protocol doesn't support this" when it
was really just a missing case.

## As built (`dc91dcb`)

- `acpAgentHost.ts` records the agent's own slash commands and current Session
  Mode onto the session record. Modes are also read once at task start via
  `AcpClientWrapper.getSessionModes()` — mirrors `getModelOption()`, no extra
  round trip.
- `setAcpMode(issueKey, modeId)` sends `session/set_mode` over the live
  connection and updates the record **optimistically on success**: not every
  agent echoes `current_mode_update` for a change it was explicitly asked to
  make.
- The composer gains a **mode chip** (only while the task is active — the ACP
  connection closes when a turn ends) and a **commands chip** (once terminal,
  like the follow-up box it feeds). Both reuse the `composer-provider-menu`
  portal pattern.
- Commands are plain prompt text over the same `session/prompt`, not a separate
  RPC — clicking one inserts `/name ` into the draft.
- Fields are named `acpAvailableCommands` / `acpCurrentModeId` /
  `acpAvailableModes` throughout, to stay unambiguous against Praxis's own
  `SessionMode` (chat/analysis/review) — a different concept that happens to
  share the word "mode".

## Acceptance criteria — verified

- An agent advertising Session Modes shows a mode chip while active; switching
  round-trips over the real connection.
- An agent advertising slash commands shows a commands chip; clicking one
  inserts `/name ` into the follow-up box.
- Neither chip appears when the agent reports neither.

## Tests

`aiAcpModesAndCommands.spec.ts` (e2e), with captures
`output/playwright/acp-session-modes.png` and `acp-slash-commands.png`.

## Description


## Dependencies



## Comments


