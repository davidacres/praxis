---
**Status:** 📋 Proposed
**Created:** 2026-09-05T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-017
slug: ai-session-ux-and-workflow-ticket-integration
title: AI session UX and workflow ticket integration
status: complete
owner: Electron desktop app
updated: 2026-09-06
issues: docs/issues/features/fx-bf-017-ai-session-ux-and-workflow-ticket-integration/feature-issues.md
stories: [FX-BE-037, FX-BE-038, FX-BE-039, FX-BE-040, FX-BE-041]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# FX-BF-017: AI session UX and workflow ticket integration

## Note on how this feature file came to exist

The work shipped and was recorded in `docs/PLAN_MAP.md` and in
`docs/issues/features/fx-bf-017-…/`, but no `docs/plans/` folder was ever
created — so the feature and all five stories were invisible to Praxis's own
board. Backfilled on 2026-09-06 from those issue files and the shipping
commits; the issues remain the authoritative record.

## Outcome

Five gaps closed between the AI session surface and the rest of the app: a
ticket became findable from ⌘K, two unhandled ACP protocol updates became
usable controls, AI spend became answerable without reading every session,
a workflow run gained a source ticket and wrote its outcome back, and workflow
failures with no other surface reached the Output tab.

## Scope

- **`FX-BE-037` — Command palette issue search.** ⌘K indexed everything except
  the one thing users look for daily. Issues aren't in App state, so this is a
  debounced, race-guarded async path querying every board in the workspace in
  parallel (`Promise.allSettled`, so a dead connection can't suppress the rest).
- **`FX-BE-038` — ACP session modes and slash commands.** `available_commands_update`
  and `current_mode_update` went unhandled; `handleSessionUpdate`'s switch had
  no default, so a missing case read as "the protocol doesn't support this".
  Now recorded on the session and surfaced as composer chips.
- **`FX-BE-039` — Cost and token spend report.** Per-session cost existed; a
  total did not. Three pure functions over the existing `summariseSpend` (so
  its currency-safety rules aren't reimplemented) behind a report in
  Settings → AI Provider.
- **`FX-BE-040` — Ticket-triggered workflow runs with outcome write-back.** A
  run gains an optional source ticket and posts its outcome back as a comment.
  Every run-settling path routes through one `saveRun()` wrapper so a new call
  site cannot silently skip the write-back.
- **`FX-BE-041` — Workflow failures into the Output tab's log bus.** A
  `[workflow]`-tagged tee for failures that had no other visible surface —
  deliberately *not* a blanket per-stage logger, since stage failures already
  show in the run monitor.

## Story map

- `FX-BE-037` — Command palette issue search. ✅ Complete (`fd6a0f9`).
- `FX-BE-038` — Surface ACP session modes and slash commands. ✅ Complete (`dc91dcb`).
- `FX-BE-039` — Cost and token spend report. ✅ Complete (`7ceb086`).
- `FX-BE-040` — Ticket-triggered workflow runs with outcome write-back. ✅ Complete (`230329a`).
- `FX-BE-041` — Wire workflow failures into the Output tab's log bus. ✅ Complete (`acd5bbe`).

## Dependencies

- `FX-BF-015` — Session review, cost, and correction controls.
- Per story: `FX-BF-005` (037), `FX-BF-011` (038), `FX-BF-015` (039),
  `FX-BF-013` (040), `FX-BE-040` (041).

## Close when

A ticket is findable from ⌘K, an ACP agent's modes and slash commands are
usable from the composer, AI spend is answerable in one place, a workflow run
started from a ticket writes its outcome back whichever path settles it, and a
workflow failure with no other surface reaches the Output tab. — **Met.**

## Verification

Re-verified on 2026-09-05 after the merge from origin (`b0678e1`): check-types
clean, `test:core` green, `test:desktop` green, with UI captures taken for the
ACP mode/commands chips, the spend report, and the command-palette issue search.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-037 | Story | Command palette issue search | Complete |
| FX-BE-038 | Story | Surface ACP session modes and slash commands | Complete |
| FX-BE-039 | Story | Cost and token spend report | Complete |
| FX-BE-040 | Story | Ticket-triggered workflow runs with outcome write-back | Complete |
| FX-BE-041 | Story | Wire workflow failures into the Output tab's log bus | Complete |

## Description


## Comments


