---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-134
title: "Expose evidence in the run monitor"
status: In Progress
story: FX-BE-051
updated: 2026-09-07
dependencies: [TASK-133]
---

# TASK-134: Expose evidence in the run monitor

**Priority:** High
**Created:** 2026-09-07

## Goal

Add typed IPC and evidence links in the existing stage detail/Output surfaces with loading, truncated, expired and unavailable states; redact before model exposure.

## Implementation entry points

packages/core/src/workflows; main/src/main/workflowCheckRunner.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-133
## Acceptance criteria

- An Electron fixture opens a failed check's retained log; keyboard navigation and theme captures cover failure and empty states.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Status: implemented and verified where this environment allows; the Electron-fixture acceptance
criterion is written but unrun — see Remaining limitations. Left `in-progress`, not `complete`, per
the story's own rule that a plan being committed is not evidence of a finished task.**

**Implemented:**
- `packages/core/src/workflows/workflowEvidence.ts`: `redactEvidenceContent(content)` — pattern-based
  redaction (key=value secret assignments keeping the key, Bearer tokens keeping the scheme, bare
  AWS/GitHub-token shapes, PEM private-key blocks) applied in `workflowCheckRunner.ts` before a
  check's captured output ever becomes an evidence entry — before storage, and before it can land in
  a run's own error text. Not wired to an actual model call (none exists yet in this story; that is
  FX-BE-052), but the redaction gate itself is real, tested, and exercised on every check run.
- `packages/core/src/host/ipcContracts.ts`: `WorkflowEvidenceView` type and
  `WorkflowsIpc.getEvidence(runId, nodeId, attempt)`.
- `apps/praxis-desktop/main/src/main/workflowEvidenceStorage.ts` (new): the one `electron`-touching
  `evidenceStorageRoot()` helper, shared by `workflowOrchestratorInstance.ts` (capture) and
  `workflowIpc.ts` (read), so neither the check runner nor its tests need Electron.
- `workflowIpc.ts`: `workflows:getEvidence` handler — resolves the run's `projectId`, reads the
  bundle, and withholds `content` once `isEvidenceExpired` is true even though the entry itself still
  says `present` (retention enforced on read, ahead of any future reclaim sweep — none exists yet,
  same limitation already noted in TASK-132).
- `preload/index.ts`: `workflows.getEvidence` exposed on `window.praxis`.
- `renderer/src/workflows/WorkflowRunMonitor.tsx`: a "View log" / "Hide log" toggle in the stage
  detail panel (shown once `stage.attempts > 0`), rendering five mutually exclusive states —
  loading, unavailable (`entry` undefined), expired, missing (with its reason), empty ("produced no
  output"), and present (content, with a truncated-size banner reusing
  `session-changes-file-truncated`'s styling). Resets on stage/run reselection via a `useEffect`
  keyed on `[selectedRunId, selectedStageId]`, matching `SessionChanges.tsx`'s file-viewer pattern.
- `theme.css`: `.wf-evidence*` — same box treatment as `.session-changes-file*`, all via existing
  theme tokens (no hardcoded colours).
- `e2e/workflowRun.spec.ts`: two new tests extending the existing real-check-process pattern (no
  mocked spawn) — a failing check whose retained log is opened by keyboard activation (`.focus()` +
  Enter, not a click) and asserts the echoed fake secret is redacted in the panel; and the timeout
  fixture's "produced no output" empty state.

**Commands run:**
- `npm run test:core` — 474/474 (28 new: 6 truncation/round-trip tests already counted in TASK-132,
  plus 6 redaction tests here). `npm run test:desktop:workflows` — 14/14 (1 new: an end-to-end
  redaction test using a real spawned Node process, asserting the secret is absent from both the
  `StageOutcome.error` text and the on-disk evidence file, and that `entry.redacted === true`).
- `npm run check-types` (root, all three workspaces, including `check-core-imports`) — clean. The new
  `WorkflowEvidenceView` import in `WorkflowRunMonitor.tsx` is `import type`, so it doesn't trip the
  renderer's core-value-import guard.
- `npm run build:core && npm run build:renderer && npm run desktop:copy-renderer && npm run build:desktop`
  — all clean.

**Remaining limitations — read before trusting this task's UI as fully proven:**
- **The Electron e2e specs were written but could not be run in this session.** Every e2e test in
  this repo — not just the two added here — fails in this sandbox: Electron's main process throws an
  uncaught exception on startup (`terminalManager.js` → `require('node-pty')`, missing native
  binding) before any window opens, so `electronApplication.firstWindow()` times out for every spec.
  This is a pre-existing gap in this session's environment (`node-pty` has no bundled linux-x64
  prebuild in this package version, and rebuilding from source needs `nodejs.org`, which this
  session's egress policy does not allow), not something introduced by this task. I confirmed the
  cause by launching Electron directly outside Playwright and reading its stderr, and confirmed a
  plain (non-Electron) Chromium **does** launch fine here — so the sandbox itself is capable of
  browser automation; the blocker is specific to this repo's Electron main process depending on
  node-pty at startup. I do not have a way to route around a `nodejs.org` egress denial, and would
  not attempt to regardless. **A maintainer or CI run with a working `node-pty` build needs to
  execute `npm run test:desktop:workflows` won't cover this — run
  `npx playwright test --project=functional e2e/workflowRun.spec.ts` in `apps/praxis-desktop/main`
  — before this task can be marked `complete`.**
- No `toHaveScreenshot` theme capture was added to `workflowThemes.spec.ts`. This repo's existing
  baselines are macOS-specific (`-darwin.png`); this sandbox is Linux, so any baseline I generated
  here would not match what CI compares against on the next run and could leave that spec red rather
  than actually verifying anything. The `.wf-evidence*` CSS uses only existing theme tokens (same
  discipline as every other panel in this file), so it should hold up, but that is a design argument,
  not a captured proof — a maintainer on macOS should add a capture of the evidence panel to
  `workflowThemes.spec.ts` alongside the existing monitor/designer/inspector captures when convenient.
- Evidence is still capped at one entry per attempt (`combined`, matching `spawnCheck`'s single
  merged stdout+stderr stream) — unchanged from TASK-133.

## Description


## Comments


