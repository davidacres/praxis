---
type: Story
id: FX-BE-096
title: "Session operations and review experience"
status: planned
feature: FX-BF-035
updated: 2026-09-10
dependencies: [FX-BE-095, FX-BF-014, FX-BF-015]
---

# FX-BE-096: Session operations and review experience

## Outcome

Users can understand multi-provider work, inspect context and evidence, and make safe operational decisions.

## Tasks

- **TASK-271 Add session list, provider and model status, stage state and live event display.**
- **TASK-272 Add context snapshot, file claims, changed-file and handoff inspection.**
- **TASK-273 Add retry, cancel, resume, reassign-provider and abandon controls with confirmation.**
- **TASK-274 Add a merge-readiness ledger showing validation, conflicts, policy and approval state.**
- **TASK-275 Add accessibility, responsive, theme and end-to-end verification.**

## Acceptance

The monitor distinguishes running, waiting, blocked, failed, cancelled, completed and awaiting-approval states. A user can inspect exactly what a provider was told and what it changed. Destructive controls explain impact and protect dirty worktrees.

## Evidence

Contract tests, fixture repositories, captured provider output, failure and recovery tests, and visual or accessibility evidence where the story affects the desktop surface.
