---
**Status:** 📋 Proposed
**Created:** 2026-09-05T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-016
slug: packaging-github-backend-and-agent-proof
title: Packaging, GitHub backend, and multi-file/terminal proof
status: In Progress
owner: Electron desktop app
updated: 2026-09-05
issues: docs/issues/features/fx-bf-016-packaging-github-backend-and-agent-proof/feature-issues.md
stories: [FX-BE-034, FX-BE-035, FX-BE-036]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# FX-BF-016: Packaging, GitHub backend, and multi-file/terminal proof

## Note on how this feature file came to exist

Three items from an ad-hoc, unpublished improvement review (never itself
tracked in `docs/plans/`) that remain genuinely open after `FX-BF-015`
shipped everything else the review found. Grouped here so they're tracked
rather than living only as bullets in a chat response.

## Outcome

Praxis ships as something a user installs and trusts rather than builds from
source; a GitHub-tracked repo gets a real board behind it, not a metadata-only
connection; and the claim "the agent loop handles multi-file changes and
terminal use" is proven rather than assumed.

## Scope

- **Signed, notarized auto-update.** The publish/update-check wiring exists
  (`30ead0b`); actual code signing and notarization need the project owner's
  Apple/Windows developer credentials, which this feature cannot supply.
- **A real GitHub backend.** ✅ Shipped (`580613c` / `fe77ae8`, `FX-BE-035`).
  `packages/core/src/github/` — a REST client, a `GitHubBoardService
  implements IssueTrackerService` modeled on `FolderService` (columns
  synthesized from discovered `status: …` labels, refusals in folder's voice),
  and one `ConnectionForm` branch — no new component or CSS token. The folder
  non-regression gate held at 13 passed before and after.
- **Multi-file and terminal-using agent paths, proven.** The plumbing
  supports both (the fixture harness can drive multi-file edits and shell
  commands — `5222d3e` added one such fixture), but no test or real run has
  exercised either as its own claim. "It can take a ticket and do the work"
  is proven today only for single-file, no-shell tasks (`FX-BE-031`).

## Story map

- `FX-BE-034` — Signed auto-update (blocked on credentials).
- `FX-BE-035` — Real GitHub backend. ✅ Complete.
- `FX-BE-036` — Prove multi-file and terminal-using agent paths.

## Dependencies

- `FX-BF-015` — Session review, cost, and correction controls (the console
  this backend and these proofs sit behind).

## Close when

A user can install a signed build, connect a GitHub-tracked repo with a real
board behind it, and see multi-file and terminal-using agent tickets proven
end to end the same way single-file edits already are.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-034 | Story | Signed auto-update | Blocked (needs signing credentials) |
| FX-BE-035 | Story | Real GitHub backend | Complete (`580613c` / `fe77ae8`) |
| FX-BE-036 | Story | Prove multi-file and terminal-using agent paths | Planned |

## Comments

## Description

