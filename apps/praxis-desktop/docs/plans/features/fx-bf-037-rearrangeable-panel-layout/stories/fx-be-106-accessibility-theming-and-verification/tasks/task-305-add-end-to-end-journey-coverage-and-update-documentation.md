---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-305
title: "Add end-to-end journey coverage and update documentation"
status: Proposed
story: FX-BE-106
feature: FX-BF-037
updated: 2026-09-13
dependencies: [TASK-303, TASK-304]
---

# TASK-305: Add end-to-end journey coverage and update documentation

## Objective

Add a full end-to-end journey spec that rearranges every panel through at least one full permutation (e.g. sidebar↔aux, main↔bottom), reloads the app, and confirms persistence; update `AGENTS.md`/relevant docs to describe the new layout system for future contributors, and update `docs/desktop-feature-parity.md` if it tracks shell/layout capability.

## Implementation notes

- Name the spec so it's obviously part of the standard suite (not a `*.live.spec.ts`), and keep it in the default `npm run test:desktop` run.
- Before changing any default (e.g. if this work changes a previously-fixed layout assumption elsewhere), grep the e2e directory for assertions on the old fixed arrangement per this repo's "changing a default cascades into the specs" guidance, and update those specs deliberately.
- Document the `PanelId`/`RegionId`/`LayoutConfig` model briefly in-repo (e.g. alongside the workspace/project/connection model docs) so the next contributor understands the separation of identity from position.

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results.
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run the full `npm run test:desktop` suite and confirm the new journey spec passes alongside all pre-existing specs with no unexpected regressions.

## Description


## Dependencies



## Comments
