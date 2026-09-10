---
**Status:** 📋 Proposed
**Type:** Story
type: Story
id: FX-BE-091
title: "Ingest CI security and quality reports"
status: To Do
feature: FX-BF-034
updated: 2026-09-09
dependencies: [FX-BE-087, FX-BE-053]
---

# FX-BE-091: Ingest CI security and quality reports

**Priority:** Medium
**Created:** 2026-09-09

## Outcome

When CI already ran the scans, read them instead of running them again. Extend FX-BE-053's read-only CI evidence providers to import GitHub code scanning + Dependabot alerts and GitLab SAST + dependency-scanning report artifacts, map them to `findings` in the evidence store bound to the exact source SHA, and let a `security` or `qa` gate rest on that imported evidence in observe mode — reconciled the way an observed deployment is.

## Scope and implementation entry points

packages/core/src/ai (CI evidence providers from FX-BE-053), packages/core/src/workflows (observe-mode gate resolution, snapshot binding); apps/praxis-desktop/main/src/main (provider credentials, read-only token scope). Token scope stays `actions:read` / `contents:read` / `security_events:read` for GitHub and `read_api` for GitLab — nothing dispatches or re-runs a job.

## Dependencies

- FX-BE-087
- FX-BE-053
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-250](tasks/task-250-add-read-only-ci-quality-and-security-providers.md) | Add read-only CI quality and security report providers |
| 2 | [TASK-251](tasks/task-251-map-imported-reports-to-findings-evidence.md) | Map imported reports to findings evidence bound to the SHA |
| 3 | [TASK-252](tasks/task-252-add-an-observe-mode-gate-on-ci-evidence.md) | Add an observe-mode gate resting on imported CI evidence |

## Acceptance criteria

- A GitHub code-scanning result and a GitLab dependency-scanning report for a known SHA import to `findings` with the same shape a local scanner produces, redacted before storage.
- An observe-mode `security` gate for a run whose snapshot matches the imported SHA passes/fails from that evidence without a local scan running; a snapshot mismatch falls back to the local check rather than trusting stale evidence.
- Imported evidence carries its CI run provenance (provider, run id, SHA) on the run event log; a missing or not-yet-available report produces an unknown/reconciling state, not a blind pass.
- Read-only token scope is enforced and documented; no code path here triggers, cancels or re-runs CI.
- All child tasks have implementation and verification evidence.

## Verification

Fixture GitHub/GitLab API servers serving captured real report payloads; core tests for mapping, SHA binding and observe/fallback resolution. Commit-availability preflight reused from FX-BE-053. Electron specs for the provider/picker UI with inspected captures. Update feature-parity CI-evidence rows and the user guide.

## Exclusions

No writing to CI, no triggering pipelines, no SonarQube-server quality-gate API integration in this story (candidate follow-on). Observe mode is opt-in per gate; the default stays a local check.

## Description


## Comments


