---
**Status:** ✅ Complete
**Type:** Task
type: Task
id: TASK-238
title: "Add SARIF / JUnit / lcov / npm-audit / osv-scanner adapters"
status: Done
story: FX-BE-087
updated: 2026-09-09
dependencies: [TASK-237]
---

# TASK-238: Add SARIF / JUnit / lcov / npm-audit / osv-scanner adapters

**Priority:** High
**Created:** 2026-09-09

## Goal

Pure adapters `parseSarif`, `parseJUnitXml`, `parseCoverage` (lcov + Cobertura), `parseNpmAudit` and `parseOsvScanner`, each returning `CheckFindings`. A check node names which adapter applies to a declared artifact path; the check runner runs it after the process exits, before building the evidence entry, and stores the normalised result alongside the raw output. A malformed or unrecognised report fails the node with a stated reason — never a pass with empty findings.

## Implementation entry points

packages/core/src/workflows/checkResultAdapters.ts (new, pure); apps/praxis-desktop/main/src/main/workflowCheckRunner.ts (invoke the named adapter on the captured output, attach `CheckFindings` to the node result, keep `redactEvidenceContent` before anything is stored or surfaced).

## Dependencies

- TASK-237
## Acceptance criteria

- Each adapter maps a checked-in real captured-output fixture to the expected `CheckFindings` (findings count, severities, one spot-checked location, and any coverage metric).
- A truncated/invalid fixture makes the adapter throw a named error and the node fails with that reason; the raw output is still retained as evidence.
- Redaction runs before the normalised result or the raw tail is surfaced.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Unit tests per adapter against fixture files; a check-runner test asserting a failing parse fails the node and retains evidence. `npm run test:core`, `npm run test:desktop:workflows`, `npm run check-types`, and the affected build paths. Never point a Praxis write path at the repository's own plans.

## Description


## Comments

- Built pure result parsers in `packages/core/src/workflows/checkResultAdapters.ts` covering:
  - `parseSarif`: SARIF 2.1.0 format with rule ID, location URI, line, and level mappings to critical/high/medium/low/info.
  - `parseJUnitXml`: JUnit test failures and errors mapped to findings; test counts and failure metrics extracted.
  - `parseCoverage`: lcov format and Cobertura XML with line/branch/function coverage percentage metrics.
  - `parseNpmAudit`: npm audit v1 and v2 formats with CVE/GHSA advisories and dependency paths.
  - `parseOsvScanner`: osv-scanner JSON output mapping ecosystem vulnerability IDs and package locations.
- Integrated adapter execution in `apps/praxis-desktop/main/src/main/workflowCheckRunner.ts` after check command completion, parsing outputs and attaching structured `CheckFindings` while preserving redacted raw evidence.
- Verified parsing and error handling for all adapters with unit tests in `packages/core/src/workflows/checkResultAdapters.test.ts`.


