---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-139
title: "Add failure selection and refresh"
status: in-progress
story: FX-BE-053
updated: 2026-09-07
dependencies: [TASK-138]
---

# TASK-139: Add failure selection and refresh

**Priority:** High
**Created:** 2026-09-07

## Goal

Offer failed run/job selection and import into the evidence store with cancellation, bounded downloads and visible freshness; preserve provider errors and source links.

## Implementation entry points

packages/core/src/github; packages/core/src/gitlab; renderer/src/workflows. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-138
## Acceptance criteria

- Selecting an older failed attempt never silently substitutes the latest attempt; retrying import does not duplicate the evidence bundle.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Status: the import mechanism is implemented and tested; no picker UI exists yet to drive it. Left
`in-progress`.**

**Implemented:**
- `packages/core/src/workflows/workflowEvidence.ts`: added optional `sourceUrl?: string` to
  `WorkflowEvidenceBundle` (additive, no schema bump needed), threaded through `createEvidenceBundle`
  and `parseEvidenceBundle` — "preserve... source links."
- `CiEvidenceProvider.getJobLog` now takes an optional `AbortSignal`, forwarded to `fetch` by both
  TASK-138 providers — "cancellation."
- `packages/core/src/ci/ciEvidenceImport.ts` (new): `importCiRunAsEvidence` reuses TASK-132's
  `captureEvidenceEntry` directly, so an imported log gets the exact same truncation/bounded-size,
  presence and retention treatment a locally captured one does — "bounded downloads" and "visible
  freshness" are not reimplemented, they are inherited. A provider error is returned verbatim as
  `{ ok: false, error }`, never rewrapped. An **expired** log (the provider says so, not an error)
  becomes explicit `missing` evidence with a stated reason — the same presence vocabulary a local
  capture already uses. `ciEvidenceKey(projectId, providerKind, run, jobId)` derives the evidence
  bundle key from the **CI run's own** id/attempt (namespaced under `ci-<provider>-<runId>`, distinct
  from any local workflow run's key space), which is what makes retrying an import deterministically
  overwrite the same bundle rather than duplicate it, and what makes an older attempt's key provably
  different from the latest attempt's — never silently substituted.

**Commands run:** `npm run test:core` — 529/529 (7 new: a full import round-tripped through real
`writeEvidenceBundle`/`readEvidenceBundle` on disk proving retry-overwrites-not-duplicates, an
expired log becoming `missing`, a provider error preserved verbatim, older-vs-latest attempt keys
never colliding, and cancellation forwarded through to the provider). `check-types` (root, all three
workspaces) — clean.

**Remaining limitations:** No renderer UI exists to browse failed runs/jobs and trigger an import —
`importCiRunAsEvidence` is a ready mechanism with no caller yet. Building that caller needs a CI
credential/connection concept this app does not have today (a GitHub Actions or GitLab CI source is
not the same as this app's existing GitHub/GitLab *issue-tracker* connection, per this story's own
outcome: "without coupling project issue backend to CI provider") — inventing that connection UX is a
real design decision, not a mechanical wiring step, so it was not rushed here. No IPC/preload surface
exists for this yet either.

## Description


## Comments


