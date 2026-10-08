---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-428
slug: skeptic-agent-and-refute-pattern
title: Bundled skeptic agent and refute-before-loop pattern
status: Backlog
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 164
---

# TASK-428: Bundled skeptic agent and refute-before-loop pattern

## Description

Add a read-only `praxis-skeptic` bundled agent (in `bundledAgents.ts`) whose brief is to refute a plan or findings list and return each item as confirmed or refuted with evidence, and provide the pattern as a reusable template fragment: Review → Skeptic → findings edge.

## Acceptance criteria

- The skeptic returns the same findings JSON shape with a `verdict` per finding; `parseReviewFindings` (or a sibling parser) reads it and refuted findings are excluded from edge predicates but kept on the run as refuted.
- A skeptic that returns no parsable block fails its stage; it never silently confirms everything.
- The agent appears in the catalog, preflight and the designer palette and is covered by `bundledAgents.test.ts`.
- Documented guidance: use it on review findings that would trigger a loop, not on deterministic check output.

## Dependencies

- TASK-427

## Comments
