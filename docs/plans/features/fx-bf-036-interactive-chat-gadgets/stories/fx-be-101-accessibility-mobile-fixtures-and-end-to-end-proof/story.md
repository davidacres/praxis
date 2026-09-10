---
type: Story
id: FX-BE-101
title: "Accessibility, mobile, fixtures and end-to-end proof"
status: planned
feature: FX-BF-036
updated: 2026-09-10
dependencies: [FX-BE-098, FX-BE-100]
---

# FX-BE-101: Accessibility, mobile, fixtures and end-to-end proof

## Outcome

Verify keyboard order, focus restoration, labels, live regions, contrast, reduced motion, touch targets and narrow mobile layouts.

## Tasks

- **TASK-288 Add accessibility and responsive visual verification.**
- **TASK-289 Create deterministic gadget fixture workflows and contract tests.**
- **TASK-290 Prove desktop/mobile end-to-end journeys and document operations.**

## Acceptance

The story is complete when its contracts or surfaces behave deterministically in the local-first desktop and mobile flows, preserve existing Praxis scope and policy boundaries, and expose enough evidence for the next dependent story. Failure, reconnect, unsupported-client and accessibility states are part of the acceptance surface.

## Evidence

Unit and contract tests, fixture repositories, renderer snapshots, accessibility results, captured event sequences and end-to-end evidence appropriate to the story.
