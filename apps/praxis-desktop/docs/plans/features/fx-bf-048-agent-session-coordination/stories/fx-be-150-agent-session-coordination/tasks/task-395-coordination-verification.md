---
**Status:** 🔄 In Progress
**Created:** 2026-10-02T10:59:50.748Z
**Type:** Task
**Priority:** Medium
id: TASK-395
type: Task
status: In Progress
created: 2026-10-02
priority: High
---

# Prove contention, isolation and safe recovery

## Files and integration points

Core coordination process tests and desktop e2e session-coordination fixtures; main/e2e/launchTestApp.ts seams; documentation and retained session artifacts.

## Scope

Exercise simultaneous multi-resource requests, independent worktrees, cross-repository desktop contention, shared UI, isolated apps, stable build inputs, FIFO/cancel, retries/reconnects, SIGKILL, broker restart, sleep/clock changes, malformed state and orphan tools on supported platforms.

For every supported installed runtime and launch mode, prove before-tool denial happens before any losing side effect; cover shell/edit/MCP routes, existing hook coexistence, disabled/missing/untrusted configuration, broker outage, hook crash/timeout/malformed output, after-hook failure and missing end callbacks. Test downstream permission rejection, repeated startup/compaction, duplicate hook/host events and adapters avoiding recursion. Verify hook failures cannot pass an enforced resource route; document any cooperative downgrade.

Exercise distinct parent/subagent identities, explicit delegation, sibling exclusion and parent/child wait cycles; UI sequence retention; yielded commands and interactive input with no fresh before-hook; surviving descendants and service transfer; external branch/identity changes; bounded waiting/cancel/wakeup deduplication; scoped disclosure and queue backpressure. Preserve a per-runtime coverage report and exact process/launch evidence.

## Dependencies

TASK-393, TASK-394

## Done conditions and validation

Core/type/build and applicable Git checks pass; full desktop E2E passes after renderer copy; actual two-session waiting/release flow visually inspected and useful screenshots retained. Report coverage limits, failing checks and environment constraints accurately.

The reviewed gap matrix in the research document has matching evidence for each implemented correction. Passing JSON/parser checks or hook telemetry alone does not satisfy runtime exclusion. Any unproven hook/runtime combination is unsupported or cooperative, with exclusive shared-resource access refused in enforced mode.

## Description


## Comments

## Progress 2026-10-09

Delivered: contention, multi-resource all-or-none, FIFO and reservation lapse, deadlock
refusal, sibling executions, delegation, scoped disclosure, message bounds, a randomised
3,000-step safety property (`coordination.test.ts`); two real processes, leader SIGKILL
takeover, live-lock refusal, malformed state, wrong token (`coordinationHost.test.ts`);
hook denial / release / outage / malformed payload (`coordinationHook.test.ts`); live
Claude Code denial (`coordinationHook.live.test.ts`, `PRAXIS_LIVE_CLAUDE=1`); the e2e
journey (`e2e/coordination.spec.ts`); full functional e2e suite green with a broker per
app launch.

Remaining: Linux and Windows runs, sleep / clock changes, hook crash, other runtimes'
adapters, surviving descendants and service transfer.
