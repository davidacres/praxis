---
**Status:** Done
**Type:** Story
type: Story
id: FX-BE-061
title: "GitHub Actions deployment executor"
status: Done
feature: FX-BF-024
updated: 2026-09-07
dependencies: [FX-BF-023]
---

# FX-BE-061: GitHub Actions deployment executor

**Priority:** High
**Created:** 2026-09-07

## Outcome

Add explicit pipeline connection, workflow/ref/input selection and correlated dispatch or observation.

## Scope and implementation entry points

packages/core/src/github/githubApiService.ts; packages/core/src/deployments (new). Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BF-023
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-162](tasks/task-162-implement-workflow-discovery-and-dispatch.md) | Implement workflow discovery and dispatch |
| 2 | [TASK-163](tasks/task-163-observe-existing-continuous-deployments.md) | Observe existing continuous deployments |
| 3 | [TASK-164](tasks/task-164-map-logs-and-verified-results.md) | Map logs and verified results |

## Acceptance criteria

- Mock invalid workflow, insufficient permission, rate limit and lost dispatch response; never claim a run ID from an unrelated latest run.
- A merge-triggered run is attached once; multiple candidate runs require explicit selection; stale run from another SHA cannot satisfy deployment.
- Fixtures cover cancelled jobs, approval waits, successful pipeline with unhealthy app, expired logs and reconnect to the same external run.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments


