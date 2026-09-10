---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-140
title: "Connect CI evidence to diagnosis"
status: In Progress
story: FX-BE-053
updated: 2026-09-07
dependencies: [TASK-139]
---

# TASK-140: Connect CI evidence to diagnosis

**Priority:** High
**Created:** 2026-09-07

## Goal

Map the imported revision into the project repository and launch the existing diagnosis flow; stop when the revision or required environment is unavailable.

## Implementation entry points

packages/core/src/github; packages/core/src/gitlab; renderer/src/workflows. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-139
## Acceptance criteria

- An Electron fixture imports a failed CI job then reaches verified repair; unavailable commits and logs yield an explicit blocked state; document read-only credential scopes.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Status: the mechanism is implemented and unit-verified; the Electron-fixture acceptance criterion
("imports a failed CI job then reaches verified repair") needs a live agent and a live CI account, so
it is not run here — see Remaining limitations. Left `in-progress`.**

**Implemented:**
- `packages/core/src/ai/diagnosisBrief.ts`: `DiagnosisBlockReason` gains `'revision-unavailable'`;
  `preflightDiagnosis`/`createDiagnosisSession` accept a caller-supplied `revisionAvailable?: boolean`
  (a `git` lookup is a host concern, kept out of core) and block with a named commit and an explicit
  reason when it is `false` — "stop when the revision... is unavailable." `buildDiagnosisBrief`'s
  `node` parameter is narrowed to a new `DiagnosisReproCommand` (`Pick<WorkflowCheckNode, 'command' |
  'args' | 'successExitCodes'>`) rather than a full `WorkflowCheckNode` — a CI job on a remote runner
  has no local `WorkflowCheckNode` of its own to point at. Backward compatible: every existing
  `WorkflowCheckNode` still satisfies the narrower type, so TASK-135's callers are unchanged.
- `apps/praxis-desktop/main/src/main/ciEvidenceDiagnosis.ts` (new): `isCommitAvailable(cwd, sha)` —
  `git cat-file -e <sha>^{commit}`, **never a fetch** — pulling a ref implicitly on a project's behalf
  would be exactly the kind of unannounced network mutation this app avoids elsewhere. Deliberately
  a check, not a remediation; if the commit needs fetching, that's a distinct, explicit user action,
  not something this task rushes into an automatic side effect. `startDiagnosisFromCiImport` chains
  TASK-139's `importCiRunAsEvidence` → `writeEvidenceBundle` → `isCommitAvailable` →
  TASK-135's `createDiagnosisSession`, so "map the imported revision... and launch the existing
  diagnosis flow" is literally the existing flow, not a parallel one.
- `docs/desktop-feature-parity.md`: added rows for both capabilities under "Developer workflow",
  each marked `~` (core-only) with an explicit note on read-only credential scope
  (`actions:read`/`contents:read` for GitHub, `read_api` for GitLab) — "document read-only credential
  scopes."

**Commands run:** `npm run test:core` — 532/532 (3 new: a commit reported unavailable blocks with the
sha named in the message and never opens a session, `revisionAvailable` left `undefined` never blocks
by itself, and `buildDiagnosisBrief` accepting the minimal command literal). `npm run
test:desktop:workflows` — unaffected, 14/14. `npm run check-types` (root, all three workspaces) —
clean.

**Remaining limitations:**
- The acceptance criterion "an Electron fixture imports a failed CI job then reaches verified repair"
  needs a real (or scripted) agent actually fixing something and a real CI account to import from —
  neither is exercisable in this sandbox (the same pre-existing `node-pty`/Electron gap noted on
  TASK-134, compounded here by needing live GitHub/GitLab credentials, which this story's own
  Verification section keeps as an explicit opt-in, not something to fabricate).
- No caller exists yet for `startDiagnosisFromCiImport` — same picker-UI gap TASK-139 already
  disclosed (no CI connection/credential concept in this app yet). The mechanism it would call is
  complete and tested; the UI to reach it is not.
- `startDiagnosisFromCiImport` assumes exactly one evidence entry per imported job (the job's whole
  log), matching TASK-139's current shape.

## Description


## Comments


