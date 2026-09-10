---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-133
title: "Preserve failed process evidence"
status: Done
story: FX-BE-051
updated: 2026-09-07
dependencies: [TASK-132]
---

# TASK-133: Preserve failed process evidence

**Priority:** High
**Created:** 2026-09-07

## Goal

Capture stdout/stderr and process status on exit, timeout, cancellation and spawn error; return artifact references whenever capture succeeded and expose persistence failure explicitly.

## Implementation entry points

packages/core/src/workflows; main/src/main/workflowCheckRunner.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-132
## Acceptance criteria

- A timed-out command retains its emitted marker and timeout reason; a spawn failure is visible; output-write failure cannot masquerade as complete evidence.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:** `apps/praxis-desktop/main/src/main/workflowCheckRunner.ts` (rewritten) now builds a
`WorkflowEvidenceBundle` for every attempt via TASK-132's `captureEvidenceEntry`/`writeEvidenceBundle`,
replacing the previous raw, unkeyed `fs.writeFile` to `output.log`.

- **Missing vs. retained is decided once, correctly:** `spawnFailed = code === null && !timedOut &&
  !signal.aborted` is the only case content becomes `undefined` (evidence `missing`, with
  `missingReason` from the spawn error). A timeout or a cancellation both mean the process *ran*, so
  whatever it emitted stays `present`/`empty` evidence — previously both discarded their artifact
  reference outright (`artifacts: []`), even though the output had already been written to disk and
  was then orphaned.
- **The source commit** is resolved via `git rev-parse HEAD` against the check's cwd, falling back to
  TASK-132's explicit `unknown` marker on any error (no repo, no git, a bare tree) rather than a
  guess.
- **Output-write failure cannot masquerade as complete evidence:** `writeEvidenceBundle` is awaited
  and its failure caught explicitly; a check that exited 0 but whose evidence failed to persist is
  now reported as `failed` with an explicit reason, not `succeeded` with a silently-missing log. Every
  other failure path appends `(evidence not persisted: ...)` rather than swallowing the write error.
- **Made the file unit-testable.** It previously imported `electron` directly (for
  `app.getPath('userData')`), which is why it had no test coverage — `require('electron')` doesn't
  resolve under plain `node --test`. `evidenceStorageRoot()` moved to
  `workflowOrchestratorInstance.ts` (which already imports `electron` for `BrowserWindow`) and is
  passed into `runWorkflowCheck` as an explicit `evidenceRoot` parameter, the same way `fallbackCwd`
  already was. `workflowCheckRunner.ts` now matches `workflowCheckProcess.ts`/`gitService.ts`'s
  electron-free, directly-testable shape.

**Commands run:**
- `npm run test:core` (`packages/core`) — 468/468 passing (unchanged; this task did not touch core).
- `npm run test:desktop:workflows` (root) — 13/13 passing, 8 new in
  `workflowCheckRunner.test.ts` using real spawned fixture processes (matching
  `workflowCheckProcess.test.ts`'s existing pattern, no mocked spawn): a successful check, a failing
  check, a timeout that retains its emitted marker and states the timeout reason, a spawn failure
  (nonexistent command) that comes back as explicit `missing` evidence with a reason and no artifact,
  a cancellation that retains what ran before it was stopped, a forced persistence failure (evidence
  root pointed at a file instead of a directory) that is surfaced rather than hidden, and the two
  pre-existing no-cwd / no-command guards.
- `npm run check-types` (root, all three workspaces) — clean.

**Remaining limitations:** No UI surface for reading a retained bundle yet — that is TASK-134. Only
one evidence entry is captured per attempt (`combined`, stdout+stderr merged, matching
`spawnCheck`'s existing single output stream); there is no separate stdout/stderr split. Every
declared `node.outputs` contract still maps to the same single stored file, which is pre-existing
behaviour this task did not change.

## Description


## Comments


