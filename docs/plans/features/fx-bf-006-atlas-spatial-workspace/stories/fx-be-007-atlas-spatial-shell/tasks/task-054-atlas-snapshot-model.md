---
id: TASK-054
title: Atlas snapshot model and builder in core
status: proposed
story: FX-BE-007
updated: 2026-08-27
dependencies: [TASK-053]
validation: ["npm run core:check-types", "npm run test --workspace @praxis/core"]
---

## Atlas snapshot model and builder in core

## Goal

Add `AtlasSnapshot` types and a pure `AtlasSnapshotBuilder` in `packages/core`
that composes projects to boards to issues to sessions into one serializable
tree with stable ids. Issue fields: id, type, status, priority, time horizon,
dependency link ids. Session fields: id, lifecycle state, startedAt,
lastActivityAt, awaitingApproval. No rendering, no IPC calls inside core.

## Done when

- The builder has unit tests for a multi-project fixture, missing or partial
  data, and issues with and without dependency links.
- Output is JSON-serializable and byte-stable for a fixed input.
- The model does not import from Jira, GitLab, Git, board UI, or AI provider
  modules.
