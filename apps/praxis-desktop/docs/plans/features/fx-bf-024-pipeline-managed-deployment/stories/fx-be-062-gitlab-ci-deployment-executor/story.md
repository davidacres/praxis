---
**Status:** 📋 Proposed
**Type:** Story
type: Story
id: FX-BE-062
title: "GitLab CI deployment executor"
status: To Do
feature: FX-BF-024
updated: 2026-09-07
dependencies: [FX-BE-061]
---

# FX-BE-062: GitLab CI deployment executor

**Priority:** High
**Created:** 2026-09-07

## Outcome

Implement the same deployment contract for GitLab pipeline trigger and observation with provider-specific mapping confined to its adapter.

## Scope and implementation entry points

packages/core/src/gitlab/gitLabApiService.ts; packages/core/src/deployments (new). Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-061
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-165](tasks/task-165-implement-pipeline-preflight-and-trigger.md) | Implement pipeline preflight and trigger |
| 2 | [TASK-166](tasks/task-166-observe-pipelines-and-environments.md) | Observe pipelines and environments |
| 3 | [TASK-167](tasks/task-167-prove-cross-provider-parity.md) | Prove cross-provider parity |

## Acceptance criteria

- Mock missing project, protected ref, permission failure and uncertain trigger response; tracker may be Jira or folder.
- Existing pipeline is attached without another trigger; repeated events and reconnect produce one durable deployment record.
- Both providers preserve exact source/artifact identity and distinguish pipeline success from app health; document supported scopes and limitations.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments


