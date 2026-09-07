---
type: Task
id: TASK-147
title: "Capture scoped browser evidence"
status: planned
story: FX-BE-056
updated: 2026-09-07
dependencies: [FX-BE-055]
---

# TASK-147: Capture scoped browser evidence

**Priority:** High
**Created:** 2026-09-07

## Goal

Add bounded console/network buffers and screenshot capture with run IDs, timestamps, redaction and capture-failure metadata; isolate sessions between projects.

## Implementation entry points

main/src/main/aiBrowser.ts; packages/core/src/ai/tools/browserTools.ts; packages/core/src/ai/browserMcpServer.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-055
## Acceptance criteria

- Seeded console error and failed API request appear in the correct run bundle; credentials and unrelated browser sessions do not enter attachments.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
