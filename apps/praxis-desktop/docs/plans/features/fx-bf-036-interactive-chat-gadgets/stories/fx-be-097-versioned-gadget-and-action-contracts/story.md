---
**Status:** 📋 Proposed
**Created:** 2026-09-10T10:48:08.260Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-097
title: "Versioned gadget and action contracts"
status: To Do
feature: FX-BF-036
updated: 2026-09-10
dependencies: [FX-BF-014, FX-BF-015]
---

# FX-BE-097: Versioned gadget and action contracts

## Outcome

Define the discriminated union for Markdown, choice, confirmation, form, table, chart, progress, diff, artifact and handoff blocks; include stable IDs, versions and scope.

## Tasks

- **TASK-276 Define ChatBlock, GadgetEnvelope and GadgetScope contracts.**
- **TASK-277 Define GadgetAction, result and fallback contracts.**
- **TASK-278 Validate payload size, schema, capability and safety policy.**

## Acceptance

The story is complete when its contracts or surfaces behave deterministically in the local-first desktop and mobile flows, preserve existing Praxis scope and policy boundaries, and expose enough evidence for the next dependent story. Failure, reconnect, unsupported-client and accessibility states are part of the acceptance surface.

## Evidence

Unit and contract tests, fixture repositories, renderer snapshots, accessibility results, captured event sequences and end-to-end evidence appropriate to the story.

## Description


## Dependencies



## Comments


