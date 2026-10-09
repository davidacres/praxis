---
**Status:** ✅ Complete
**Created:** 2026-10-02T10:59:50.748Z
**Type:** Task
**Priority:** Medium
id: TASK-395
type: Task
status: Done
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

Then, the same day:

- **Sleep and clock changes.** The broker's clock is monotonic (a system-clock change moves
  no lease); a gap between its beats extends every lease by the gap before any is judged, and
  a really-gone owner still expires one lease after waking (core and host tests).
- **Hook failures.** A silent broker and one that dies mid-request both deny the edit with why
  (`coordinationHook.test.ts`); a killed hook process lets Claude Code run the tool (live).
- **Other runtimes.** Codex live denial and release (`PRAXIS_LIVE_CODEX=1`); Copilot and
  Gemini adapters tested against their contracts, unproven live (see the matrix).
- **Surviving descendants.** A backgrounded server keeps its process and port claims after
  the tool and the turn, released only when the group is gone (`localTools.test.ts`); a
  service claim that went to recovery when its session ended is cleared with that evidence.
- **Waiting / release, visually.** `e2e/coordinationWait.spec.ts`: a refused agent waits once,
  is shown waiting in the inspector, is woken by the release and writes; a left-running server
  is stopped from the inspector; a real click in the in-app browser takes it from an agent.
  Screenshots: `.praxis/session-artifacts/session-coordination-waiting.png`,
  `session-coordination-woken.png`, `session-coordination-service.png`.
- The randomised safety property now includes person takeovers.

Linux and Windows runs are deferred to TASK-438 at the owner's direction.
