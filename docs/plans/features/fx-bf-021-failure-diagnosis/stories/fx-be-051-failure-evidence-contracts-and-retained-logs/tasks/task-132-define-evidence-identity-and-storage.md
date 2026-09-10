---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-132
title: "Define evidence identity and storage"
status: complete
story: FX-BE-051
updated: 2026-09-07
dependencies: [FX-BE-024, FX-BE-025, FX-BE-041]
---

# TASK-132: Define evidence identity and storage

**Priority:** High
**Created:** 2026-09-07

## Goal

Define log, test-result and attachment references with provenance, timestamps, truncation, redaction and retention metadata; distinguish missing evidence from an empty successful result.

## Implementation entry points

packages/core/src/workflows; main/src/main/workflowCheckRunner.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-024
- FX-BE-025
- FX-BE-041
## Acceptance criteria

- Round-trip a bundle; reject cross-project references and path traversal; explicitly represent unknown commit and missing artifacts.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:** `packages/core/src/workflows/workflowEvidence.ts` (new), exported from
`packages/core/src/index.ts`. Defines `WorkflowEvidenceBundle` (versioned, keyed by
project/run/node/attempt/source-commit) and `WorkflowEvidenceEntry` (log/test-results/attachment)
with presence (`present`/`empty`/`missing`, distinguishing a capture that never ran from a command
that legitimately printed nothing), timestamps, truncation (`truncateUtf8Tail` keeps the tail
without splitting a multi-byte UTF-8 character), redaction flag, and retention (`default` with an
expiry, or `legal-hold`). `validateEvidenceBundle`/`parseEvidenceBundle` fail closed on an
unsupported schema version, a cross-project reference, a path-traversal attempt in a stored entry
path, or a source that is neither a real commit sha nor the explicit `{ kind: 'unknown' }` value.
`writeEvidenceBundle`/`readEvidenceBundle`/`readEvidenceContent` persist a bundle and its entry
content under `<storageRoot>/<projectId>/<runId>/<nodeId>/<attempt>/`, validating every path
segment before touching disk (mirrors the defence-in-depth already used in `workflowStore.ts` for
project-committed workflows, applied here to `nodeId`, which a workflow author controls).

Did not modify `workflowCheckRunner.ts` — wiring this into real timeout/spawn-failure capture is
TASK-133, which this task's `missing`/`empty` distinction and retained-content storage exist to
support. Noted for that task: `runArtifactDir` in `workflowCheckRunner.ts` currently joins
`runId`/`nodeId` into a filesystem path with no safety check, unlike the guard added here.

**Commands run:** `npm run test:core` (`packages/core`) — 468/468 passing, including 23 new tests
in `workflowEvidence.test.js` covering round-trip serialize/parse, cross-project rejection, path
traversal rejection, unknown-commit representation, missing-vs-empty, truncation (including a
multi-byte UTF-8 boundary case), retention expiry, and full write/read-back through a temp
directory. `npm run check-types` (root, all three workspaces) — clean.

**Remaining limitations:** No UI or IPC surface yet (out of scope for this task; TASK-134 exposes
evidence in the run monitor). Retention is defined as data (`WorkflowEvidenceRetention` +
`isEvidenceExpired`) but nothing sweeps expired bundles yet — no task in this story currently
covers a reclaim pass, and one may be needed before real retention limits take effect.

## Description


## Comments


