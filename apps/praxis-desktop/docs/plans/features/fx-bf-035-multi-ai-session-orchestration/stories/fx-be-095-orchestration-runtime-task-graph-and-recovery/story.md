---
**Status:** 📋 Proposed
**Created:** 2026-09-10T10:48:08.260Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-095
title: "Orchestration runtime, task graph and recovery"
status: To Do
feature: FX-BF-035
updated: 2026-09-10
dependencies: [FX-BE-093, FX-BE-094, FX-BF-013]
---

# FX-BE-095: Orchestration runtime, task graph and recovery

## Outcome

Praxis dispatches dependency-ready stages, joins results and recovers safely from agent or host failures.

## Tasks

- **TASK-266 Implement a dependency-aware scheduler with bounded parallelism and durable run state.**
- **TASK-267 Add an append-only session event log with redaction and correlation identifiers.**
- **TASK-268 Implement timeout, cancellation, retry, resume and escalation policies.**
- **TASK-269 Add stage joins, validation execution and handoff gating.**
- **TASK-270 Add a deterministic stub-agent end-to-end workflow.**

## Acceptance

A workflow executes design, implementation, independent review and validation in order, while independent tasks may run in parallel. Restarting the host resumes durable state without duplicating completed stages. Failed validation prevents merge readiness.

## Evidence

Contract tests, fixture repositories, captured provider output, failure and recovery tests, and visual or accessibility evidence where the story affects the desktop surface.

## Description


## Dependencies



## Comments


