---
type: Story
id: FX-BE-092
title: "Shared session context and handoff contracts"
status: planned
feature: FX-BF-035
updated: 2026-09-10
dependencies: [FX-BF-011, FX-BF-019]
---

# FX-BE-092: Shared session context and handoff contracts

## Outcome

Every provider receives deterministic task context and produces a machine-readable handoff another provider can consume.

## Tasks

- **TASK-253 Define versioned Task, Session, ContextSnapshot, Handoff and ChangeSet contracts.**
- **TASK-254 Generate bounded snapshots from the task graph, Git state, decisions and relevant files.**
- **TASK-255 Generate provider-specific prompts from the common session envelope.**
- **TASK-256 Validate handoffs, redact secrets and persist snapshot manifests and evidence links.**

## Acceptance

A fixture task started with one provider can be resumed by another using only repository artifacts and the snapshot. Snapshot content records source commit, included and excluded files, dependencies and generation version. Malformed handoffs block progression with a useful reason.

## Evidence

Contract tests, fixture repositories, captured provider output, failure and recovery tests, and visual or accessibility evidence where the story affects the desktop surface.
