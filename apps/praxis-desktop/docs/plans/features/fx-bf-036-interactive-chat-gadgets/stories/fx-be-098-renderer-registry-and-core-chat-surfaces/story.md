---
**Status:** ✅ Complete
**Created:** 2026-09-10T10:48:08.261Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-098
title: "Renderer registry and core chat surfaces"
status: Done
feature: FX-BF-036
updated: 2026-09-13
dependencies: [FX-BE-097]
---

# FX-BE-098: Renderer registry and core chat surfaces

## Outcome

Add version-aware registration, unknown-kind fallback, error boundaries and renderer selection without Electron or Node imports.

## Tasks

- **TASK-279 Implement the browser-safe gadget renderer registry.**
- **TASK-280 Implement choice, confirmation, table and progress renderers.**
- **TASK-281 Implement chart, diff, artifact and handoff renderers.**

## Acceptance

The story is complete when its contracts or surfaces behave deterministically in the local-first desktop and mobile flows, preserve existing Praxis scope and policy boundaries, and expose enough evidence for the next dependent story. Failure, reconnect, unsupported-client and accessibility states are part of the acceptance surface.

## Evidence

Unit and contract tests, fixture repositories, renderer snapshots, accessibility results, captured event sequences and end-to-end evidence appropriate to the story.

## Description


## Dependencies



## Comments


