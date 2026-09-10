---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-149
title: "Add preview verification workflow"
status: in-progress
story: FX-BE-056
updated: 2026-09-09
dependencies: [TASK-148]
---

# TASK-149: Add preview verification workflow

**Priority:** High
**Created:** 2026-09-07

## Goal

Run user-defined interactions and deterministic health/assertion checks against the current snapshot; surface captured failures through Diagnose and attach actual/diff images.

## Implementation entry points

main/src/main/aiBrowser.ts; packages/core/src/ai/tools/browserTools.ts; packages/core/src/ai/browserMcpServer.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-148
## Acceptance criteria

- A fixture API/UI fault produces evidence, a fix produces fresh passing results, and screenshots are visually inspected; document that screenshots alone are not passing tests.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Status: the verification engine (interactions, assertions, pass/fail computed exclusively from
assertions), a real Electron runner, and a Diagnose starting point are implemented; there is no
renderer UI to define or trigger a check, and image diffing is explicitly scoped down to byte-identity
comparison. Left `in-progress` — see "Remaining limitations" for exactly what's missing and why.**

**Implemented — core (fully tested, no Electron involved):**

- `packages/core/src/projects/previewVerification.ts` (new) — `PreviewInteraction` (`click`/`type`/
  `wait`, targeting a plain CSS `selector` rather than the AI browser's ephemeral snapshot `ref`s — a
  repeatable check needs a stable target it can write once, not one that only exists for the
  duration of one snapshot call) and `PreviewAssertion` (`text-present`/`text-absent`/
  `no-console-errors`/`no-failed-requests`/`http-status`). `evaluateAssertions` is pure and
  deterministic against a `PreviewVerificationSnapshot` (page text + the same console/network shape
  TASK-147's recorder captures).
  - **`http-status`'s design note, made explicit in both the code and a test:** the diagnostics
    recorder only captures *failed* requests (TASK-147), so a request that never failed leaves no
    trace to check against — `http-status` treats "no matching failure" as passing (the request is
    assumed to have succeeded), and only fails when a captured failure's actual status doesn't match
    what was expected. This is a real, load-bearing design choice, not an oversight: inverting it
    (require a matching *success* record) isn't possible without capturing every request, successes
    included, which TASK-147 deliberately didn't do to keep the buffer meaningful (a healthy page can
    make hundreds of successful requests; only failures are diagnostically interesting).
  - **"Screenshots alone are not passing tests" — the acceptance criterion's own words — is enforced
    structurally, not by convention:** `summarizeOutcome.passed` is computed exclusively from
    `AssertionResult[]`; the `screenshot` field (path + `baselineComparison`) sits alongside it,
    read by nothing that decides pass/fail. A test proves a screenshot recorded as `'differs'` from
    its baseline does not flip an otherwise-passing outcome to failing.
  - `screenshotsMatch(a, b)` is byte-identity only (`Buffer.equals`) — **deliberately not a pixel
    diff.** This sandbox has no image-processing dependency available (`node_modules` has no
    png/pixel library, and `npm install` is unreliable here per every prior task's documented
    `node-pty` rebuild blocker), and hand-rolling a PNG decoder to build a genuine visual diff would
    trade a real feature for a correctness risk I can't verify. The module comment and this evidence
    both name this as a scoped-down substitute for "diff images," not a hidden equivalent of one.
  - `renderVerificationFailureContext(check, outcome)` — text evidence for a person or a diagnosis
    agent: which assertions failed and why, with a screenshot noted (never framed as the reason).
  - 14 tests: each assertion kind's pass/fail behavior (including the `http-status` "no matching
    failure ⇒ pass" case and the mismatched-status fail case); `summarizeOutcome.passed` from mixed
    results; the differing-screenshot-never-flips-`passed` test; a zero-assertion check passes
    vacuously; `screenshotsMatch` on equal/different/different-length buffers; the failure-context
    renderer's pass case, its failed-only listing (the passing assertion is asserted absent from the
    output), and its screenshot note.

**Implemented — main process (compiles, Electron-unverified):**

- `apps/praxis-desktop/main/src/main/previewBrowser.ts` — added `pageText()` (same bounded
  main-content extraction `aiBrowser.ts` uses), `click(selector)`/`type(selector, text, submit)`
  (CSS-selector-targeted, not shared code with `aiBrowser.ts`'s ref-based versions — a deliberate
  choice to avoid refactoring already-shipped, working interaction code for this task's sake), and
  `runVerification({projectId, check, baselineScreenshot?})`: resolves the service's granted origin
  from `previewAccess.grants()`, opens `origin + check.path` (which starts a fresh
  `BrowserDiagnosticsRecorder` via the `open()` TASK-147 already wired), runs each interaction in
  order, builds a `PreviewVerificationSnapshot` from the recorder's live capture, evaluates
  assertions, and — best-effort, never failing the check if it errors — captures and persists a
  screenshot, comparing it to `baselineScreenshot` when one was supplied.
- `apps/praxis-desktop/main/src/main/diagnosisSession.ts` — exported `ElectronDiagnosisSessionPort`
  and parameterized its `definitionOfDone` (default value unchanged, so
  `startDiagnosisSessionFromEvidence`'s existing single-argument call site is untouched) so a second
  diagnosis flow can reuse the real three-way CLI-agent/Copilot/gateway provider dispatch instead of
  duplicating it.
- `apps/praxis-desktop/main/src/main/previewVerificationSession.ts` (new) —
  `startDiagnosisFromVerificationFailure` **deliberately does not go through** core's
  `createDiagnosisSession`/`buildDiagnosisBrief`: that path is shaped around a
  `WorkflowEvidenceBundle` and a `DiagnosisReproCommand` (a shell command with success exit codes),
  and a verification failure has neither — there's no command to re-run, only assertions to satisfy
  again. Inventing a fake repro command to fit that shape would have been worse than a small, honestly
  separate starter. It refuses (without opening a session) when the outcome already passed or the
  project has no working folder, then renders the failure via
  `renderVerificationFailureContext` fenced as `DATA` in the prompt — the same "never treat evidence
  text as an instruction" discipline `renderDiagnosisPrompt` holds — before starting a real session
  through the reused port.
- `apps/praxis-desktop/main/src/main/runControlIpc.ts` — added `runs:runVerification` and
  `runs:diagnoseVerificationFailure`. `packages/core/src/host/ipcContracts.ts` — added both to
  `RunsIpc`. Preload exposure in `apps/praxis-desktop/main/src/preload/index.ts`.

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. `npm run test:core` (repo root), a single
clean run with no overlapping processes — **662/662 passing** (14 new). `npx tsc --noEmit -p .` in
`apps/praxis-desktop/main` — clean. `npm run check-types` in `apps/praxis-desktop/renderer` — clean
(no renderer changes this task).

**Remaining limitations — read before treating this as done:**
- **No renderer UI exists to define or trigger a verification check.** A person cannot currently
  author a `PreviewVerificationCheck` (interactions + assertions) or click a button to run one — the
  IPC surface and engine are complete and callable, but nothing in `RunProfileEditor.tsx` or
  `PreviewPane.tsx` calls them yet. Unlike TASK-141→143 or TASK-144→146, there is no later task in
  this story to hand the UI to; this is a genuine, standing gap in the story's own acceptance
  criteria ("a fixture API/UI fault produces evidence, a fix produces fresh passing results, **and
  screenshots are visually inspected**" — visual inspection needs a UI to inspect from), not a
  deferral.
- **No baseline management.** `runVerification` accepts an optional `baselineScreenshot` buffer, but
  nothing stores "this is the accepted baseline for check X" or retrieves it automatically on a
  later run — a caller would have to supply the bytes themselves. `writeScreenshot`'s generated
  filenames (`screenshot-<timestamp>.png`) mean nothing currently designates any one capture as *the*
  baseline versus just another capture.
- **No actual visual diffing**, as explained above under `screenshotsMatch` — a stored, documented
  scope reduction, not a hidden gap.
- **Not wired into the shared workflow engine.** `WorkflowDefinition`/`WorkflowCheckNode`/
  `WorkflowOrchestrator` (the schema a Workflow's own check stages use) were deliberately left
  untouched — extending that shared schema to add a new node type would touch the designer UI, the
  orchestrator's dispatch table, and validation, all outside this story's own stated entry points
  and at real risk to already-shipped, working functionality. `runVerification` is a standalone
  capability, callable directly, not a Workflow stage a `WorkflowRun` can include as one of its
  nodes.
- Electron itself remains blocked in this sandbox, so `previewBrowser.ts`'s new `click`/`type`/
  `pageText`/`runVerification` methods have never actually run against a real page — the same
  limitation recorded on every UI/Electron-touching task this session.

This closes out FX-BE-056 and, with it, every task under FX-BF-022 (Managed run and preview) that
this delivery roadmap defines. All fourteen tasks across FX-BE-054/055/056 are implemented with real,
tested logic; every one touching Electron is explicitly `in-progress` rather than falsely marked
`complete`, for the one recurring, honestly-documented reason: this sandbox cannot launch Electron to
verify any of it.

## Description


## Comments


