---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-321
title: "Deterministic fixtures, full e2e coverage, and documentation"
status: Proposed
story: FX-BE-114
feature: FX-BF-039
updated: 2026-09-14
dependencies: [TASK-320]
---

# TASK-321: Deterministic fixtures, full e2e coverage, and documentation

## Objective

Build the feature's test fixtures from real content pulled from
`anthropics/claude-plugins-official` and `github/copilot-plugins` (the same
`example-plugin`/`hookify`/`spark` content inspected during scoping), cover the full
import → convert → preview → install → bind → hook-build → hook-fire journey end to
end, and document the import model, the card-based marketplace, and the hook engine
for users and maintainers.

## Implementation notes

- Snapshot the specific plugin content used as fixtures (marketplace.json entries,
  a subagent .md, a SKILL.md, an .mcp.json, a hooks.json) into this repo's own test
  fixtures rather than fetching live from GitHub in tests — deterministic, and
  survives the upstream repos changing shape later.
- Cover at minimum: install → agent selectable in designer; install → skill
  selectable in composer; install → MCP server usable; hook-bearing plugin bound to
  each of the four provider categories (native passthrough for Claude Code,
  translated-or-flagged for the other three, visible in the management view);
  a hook built entirely through the visual builder firing correctly; untrusted
  plugin's hook never fires; trust revocation stops a previously firing hook.
- Documentation lives alongside this feature's own `docs/plans/features` entry and,
  if user-facing, in `apps/praxis-desktop/docs` per this repo's existing convention
  (see the docs reorg that consolidated everything there) — not a new top-level
  docs location.

## Acceptance criteria

- Fixtures are frozen snapshots of real upstream content, not synthetic stand-ins.
- The full journey (import through hook-fire, including the visual builder) has e2e
  coverage across all four provider categories.
- `npm run check-types`, `npm run test:core`, and `npm run test:desktop` all pass in
  a full local checkout, matching this feature's own definition of done.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run check-types`, `npm run test:core`, and `npm run test:desktop` in a full
local checkout — the same three commands this feature's own validation requires.

## Description


## Dependencies



## Comments
