---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-174
title: "Implement staged IIS installation"
status: planned
story: FX-BE-065
updated: 2026-09-07
dependencies: [FX-BE-064]
---

# TASK-174: Implement staged IIS installation

**Priority:** High
**Created:** 2026-09-07

## Goal

Specify supported copy/Web Deploy strategy during preflight; stage and verify digest, back up previous release, manage app-offline/pool steps and preserve configured data/config exclusions.

## Implementation entry points

deployment executor scripts/templates; packages/core/src/deployments. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-064
## Acceptance criteria

- Windows fixture proves correct site only is changed, locked files fail safely, and partial copy does not report success; document expected downtime.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


