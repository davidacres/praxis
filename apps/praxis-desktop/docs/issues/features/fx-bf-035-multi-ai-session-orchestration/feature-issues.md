# FX-BF-035 — Multi-AI session orchestration

**Type:** Feature  
**Status:** In Progress

This feature's completed session follow-up work is represented by the stories
below. The original feature plan remains the source of scope and dependencies.

- [FX-BE-130 — Provider extensions and session allowance correctness](stories/fx-be-130-provider-extensions-and-session-allowance-correctness/issue.md)
- [FX-BE-131 — Image attachments in session chat](stories/fx-be-131-image-attachments-in-session-chat/issue.md)
- [FX-BE-132 — Native browser pane geometry at app zoom](stories/fx-be-132-native-browser-pane-zoom-alignment/issue.md)

## Review 2026-09-25 — status corrected from To Do to In Progress

Substantial delivery now exists, so To Do is no longer accurate, but the
feature is not fully closed either.

- Shipped: multi-provider session execution through the governed workflow
  engine (scheduler, stage sessions, recovery), worktree governance, session
  handover with a living brief, and opt-in multi-AI conversation.
- All three follow-up stories (FX-BE-130, FX-BE-131, FX-BE-132) are Complete,
  and FX-BE-115 is Done.
- Verified in this review: `npm run build:core` and `npm run test:core`
  (1311 tests, 0 failures).

### FX-BE-092…096 audit (same review)

Each of the five original stories was checked against its acceptance criteria
and its plan-side status corrected:

- **FX-BE-093 Provider adapters and capability preflight → Done.**
  `providerPreflight.ts` implements the four required states
  (`unavailable | denied | failed | ready`) plus a capability manifest;
  provider version and capabilities are recorded on the session record.
- **FX-BE-095 Orchestration runtime, task graph and recovery → Done.**
  `workflowScheduler.ts` dispatches dependency-ready nodes and joins results;
  durable run state and an append-only event log support restart and retry;
  merge readiness is gated on validation.
- **FX-BE-096 Session operations and review experience → Done.**
  `SessionsPage` distinguishes the required operational states,
  `SessionInspector`/`SessionChanges` show what a provider was told and
  changed, and destructive controls state their impact and protect dirty
  worktrees.
- **FX-BE-092 Shared session context and handoff contracts → In Progress.**
  The versioned handover envelope shipped with FX-BE-115, but TASK-254's
  bounded context snapshot (source commit, included/excluded files,
  dependencies) and TASK-256's malformed-handoff validation are missing.
- **FX-BE-094 Worktree, file claims and change governance → In Progress.**
  Worktree lifecycle, dirty-worktree protection and change attribution are
  delivered; TASK-263 path claims/overlap detection and TASK-265 out-of-scope
  change policy are not implemented.

The feature therefore stays **In Progress**: FX-BE-092 and FX-BE-094 carry
real remaining scope. It can close once TASK-254, TASK-256, TASK-263 and
TASK-265 are delivered.
