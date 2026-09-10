---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-112
title: Implement deterministic check execution and artifact capture
status: Done
story: FX-BE-024
updated: 2026-09-02
dependencies: [TASK-111, TASK-113]
validation: [npm run build, npm run test:core, npm run test:desktop]
---

# TASK-112: Implement deterministic check execution and artifact capture
## Implement deterministic check execution and artifact capture
## Goal
Run a `WorkflowCheckNode`'s command and let its exit code decide the outcome —
the mechanism that keeps a QA or security gate off an agent's word.
## Done when
- The command runs with `args` in the run worktree, with the run's environment,
  killed at `timeoutMs` (→ `node-timed-out`).
- Exit code in `successExitCodes` (default `[0]`) → `node-succeeded`, else
  `node-failed` with the code and a tail of stderr in the error.
- stdout/stderr is written as a declared output artifact (`test-results` or
  `log`) at a path under the run's artifact directory.
- A check that declares a required artifact it did not write still fails, per the
  engine's contract.
## Notes
Plain `child_process`; no agent runtime involved. This is the story's
no-dependency core.

## Description


## Dependencies



## Comments


