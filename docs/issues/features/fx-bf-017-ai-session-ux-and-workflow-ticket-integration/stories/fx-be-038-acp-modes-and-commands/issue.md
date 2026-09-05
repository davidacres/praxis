# FX-BE-038 — Surface ACP session modes and slash commands

**Type:** Story  **Status:** Complete  **Priority:** P2  **Depends on:** FX-BF-011

## Business or operational impact
Two stable, protocol-defined ACP session updates — `available_commands_update` and `current_mode_update` — went unhandled. `handleSessionUpdate`'s switch has no default, so the gap read as "the protocol doesn't support this" when it was really just a missing case.

## Scope
- `acpAgentHost.ts` records the agent's own slash commands and current Session Mode onto the session record; modes are also read once at task start via `AcpClientWrapper.getSessionModes()` (mirrors `getModelOption()`, no extra cost).
- A new `setAcpMode(issueKey, modeId)` sends `session/set_mode` over the live connection and updates the record optimistically on success — not every agent echoes `current_mode_update` for a change it was explicitly asked to make.
- Composer gains a mode chip (visible only while the task is active — the ACP connection closes once a turn ends) and a commands chip (visible once terminal, like the follow-up box it feeds). Both reuse the `composer-provider-menu` portal pattern.
- Commands are plain prompt text over the same `session/prompt`, not a separate RPC — clicking one inserts `/name ` into the draft.
- Fields named `acpAvailableCommands`/`acpCurrentModeId`/`acpAvailableModes` throughout to stay unambiguous against Praxis's own `SessionMode` (chat/analysis/review) — a different concept that happens to share the word "mode."

## Acceptance criteria
- A session whose agent advertises Session Modes shows a mode chip while active; switching modes round-trips over the real connection.
- A session whose agent advertises slash commands shows a commands chip; clicking one inserts `/name ` into the follow-up box.
- Neither chip appears for a session whose agent reports neither.

## Validation
- `npm run check-types`
- `npm run test:desktop` (`aiAcpModesAndCommands.spec.ts`)

## Close when
Both previously-unhandled ACP updates are read, recorded, and usable from the composer — discoverable rather than requiring the user to already know they exist.
