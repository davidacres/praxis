---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-119
title: Add the unattended-run E2E with a stub agent, and update the docs
status: complete
story: FX-BE-026
updated: 2026-09-02
dependencies: [TASK-115, TASK-117, TASK-118]
validation: [npm run build, npm run test:desktop]
---
## Add the unattended-run E2E with a stub agent, and update the docs
## Goal
Prove the built-in Governed delivery workflow runs on its own.
## Done when
- A stub agent host (or a fake `WorkflowSessionPort`) lets a desktop test start
  a run and watch it advance with no manual stage clicks.
- The E2E covers: template selection and start, parallel review/QA/security
  converging at the join, a failed required gate blocking approval with its
  evidence visible, approval once gates pass, restart recovery leaving completed
  stages untouched, and cancellation.
- `npm run desktop:copy-renderer` precedes the run; new visual snapshots are
  inspected.
- `docs/governed-delivery-workflows.md` is updated to describe real execution
  and drops the "stages are advanced explicitly" caveat.
## Notes
The FX-BE-022 spec already covers the manual-advance path; this replaces the
manual clicks with orchestrator-driven progress.

## Description


## Dependencies



## Comments


