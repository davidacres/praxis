---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-245
title: "Deliver review findings as inline PR / ticket comments with dedupe"
status: planned
story: FX-BE-089
updated: 2026-09-09
dependencies: [TASK-244]
---

# TASK-245: Deliver review findings as inline PR / ticket comments with dedupe

**Priority:** Medium
**Created:** 2026-09-09

## Goal

After a review stage settles, post each finding as an inline review comment at its file/line on the project's GitHub/GitLab PR when one is associated with the run; otherwise post a single structured ticket comment listing the findings. Dedupe against the previous run's finding fingerprints so a re-review only adds what changed and marks resolved what is gone. Delivery is best-effort: a failure to post is reported on the run event log and does not by itself sink the run.

## Implementation entry points

apps/praxis-desktop/main/src/main (PR/MR review-comment IPC, reusing the GitHub/GitLab REST clients and their auth headers), packages/core/src/workflows (fingerprint dedupe set carried on the run), packages/core/src/ai (map a finding to a comment body). Reuse Local Peer Review's comment-thread rendering for the in-app view.

## Dependencies

- TASK-244
## Acceptance criteria

- On a fixture PR, each finding posts once at the correct file/line; a re-review of an unchanged snapshot posts nothing (dedupe) and marks nothing new.
- With no PR, one structured ticket comment is posted with the findings grouped by severity.
- A posting failure is on the run event log with the reason; the run continues to its gate evaluation regardless.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Fixture GitHub/GitLab API servers; core tests for the dedupe set across two runs and for comment-body mapping. Electron spec for the in-app review findings view with inspected captures across theme axes and keyboard focus. Read-only vs write token scope documented. Never point a Praxis write path at the repository's own plans.

## Description


## Comments


