---
type: Task
id: TASK-251
title: "Map imported reports to findings evidence bound to the SHA"
status: planned
story: FX-BE-091
updated: 2026-09-09
dependencies: [TASK-250, TASK-237]
---

# TASK-251: Map imported reports to findings evidence bound to the SHA

**Priority:** Medium
**Created:** 2026-09-09

## Goal

Convert an imported GitHub/GitLab report into `CheckFindings` (reusing the TASK-238 SARIF adapter where the provider emits SARIF, a dedicated map otherwise) and write it into the evidence store as a bundle bound to the report's commit SHA, redacted first. The stored shape is identical to a locally run scanner's, so downstream gate logic does not distinguish source.

## Implementation entry points

packages/core/src/ai (report → `CheckFindings` mapping), the evidence store from FX-BE-051 (a bundle whose source ref is the imported SHA, provenance recorded), `redactEvidenceContent` before storage.

## Dependencies

- TASK-250
- TASK-237
## Acceptance criteria

- A captured GitHub code-scanning payload and a GitLab dependency-scanning payload each map to `CheckFindings` with correct severities and at least one spot-checked location.
- The evidence bundle records `{ provider, runId, sha }`; content is redacted before it is written.
- An imported finding's fingerprint is computed the same way as a local one, so a local and an imported result for the same issue collide.
- The implementation satisfies the parent story's outcome and preserves existing unrelated evidence storage.

## Verification

Core tests for both provider maps against captured fixtures, redaction-before-store, and fingerprint parity with a local scanner result. `npm run test:core`, `npm run check-types`. Never point a Praxis write path at the repository's own plans.
