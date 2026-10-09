---
**Status:** ✅ Complete
**Created:** 2026-10-02T10:59:50.746Z
**Type:** Story
**Priority:** Medium
id: FX-BE-150
type: Story
status: Done
created: 2026-10-02
priority: High
---

# Coordinate session activity and exclusive resources

## Impact

A second session sees who owns the live UI, file, checkout or build output and waits before an interfering operation. Completion or verified cleanup releases ownership for the waiter.

## Scope

[Full design and primary research](../../../../../research/agent-session-coordination.md). Single writer broker, JSON snapshots, atomic multi-resource acquire, session messages, heartbeat and safe cleanup. No source implementation is part of this planning request.

## Acceptance criteria

- Register session/turn identity, worktree, actual branch/HEAD, activity, editing files and running tools; distinguish idle, waiting, active and terminal states.
- One broker grants resources across profiles/worktrees; all-or-none acquisition and authenticated owner capabilities prevent check-then-act races.
- Browser/live app ownership spans interaction sequences; desktop input conflicts across apps; isolated environments retain parallelism.
- Host-owned tools gate before side effects. Native tools use proven hooks or explicitly cooperative/observed coverage; Bypass permissions do not bypass contention.
- Finish/fail/cancel releases only after verified tool cleanup. Expiry/restart marks suspect claims and rejects old capabilities without unsafe automatic takeover.
- Bound event/history retention, redact secrets, maintain acknowledgements and revisions; projections never authorize an action.
- Native adapters map session/turn start, synchronous before-tool acquisition, after-tool result/cleanup and stop/interrupt/end reconciliation to the same broker. Record installed version, launch mode, hook trust/configuration, tool coverage and tested failure semantics before advertising support.
- Broker unavailability, hook errors/timeouts/malformed output, disabled hooks and uncovered tool paths cannot be mistaken for availability. Only paths with a proven execution gate qualify as enforced; reject unverified native shared-resource access in that mode.
- A grant rejected by subsequent permission policy, user denial or cancellation is reconciled without leaking ownership. Duplicate native-hook/host observations share an idempotent request; an absent completion callback does not prove the tool never started.
- Separate tool, UI-sequence and persistent-service claims. Track interactive/yielded commands and surviving process trees; a post-tool hook cannot release the surrounding test sequence prematurely.
- Distinct parent/subagent execution owners cannot silently share claims or release each other's work. Explicit delegation and parent/child dependency checks prevent self-deadlocks and simultaneous sibling access.
- Contention produces prompt denial and bounded waiting, cancellation and deduplicated opted-in wakeup. No hook sleeps until timeout or causes unbounded model retries; routine events do not start conversations.
- Preserve existing hooks and respect runtime trust/setup; global configuration is not rewritten automatically. Revalidate actual resource/branch/input identity before side effects and invalidate evidence on change.
- Scoped broker views avoid cross-project path/chat leakage; publication and queue limits apply explicit backpressure without evicting live claims.

## Dependencies

FX-BF-048. Existing session identity, tool mode, permission and workflow scheduler contracts remain in force.

## Tasks

- [TASK-391: Schema and conflict policy](tasks/task-391-coordination-contracts.md)
- [TASK-392: Broker and safe persistence](tasks/task-392-coordination-broker.md)
- [TASK-393: Runtime and tool gates](tasks/task-393-coordination-runtime.md)
- [TASK-394: Communication and status](tasks/task-394-coordination-communication.md)
- [TASK-395: Concurrency and recovery proof](tasks/task-395-coordination-verification.md)
- [TASK-438: Linux and Windows verification](tasks/task-438-coordination-linux-windows.md) — deferred (Backlog)

## Validation

Targeted core concurrency/process tests; complete build/type checks; desktop Git tests when applicable; full desktop E2E for UI changes and actual running-app waiting/release inspection. Use temporary coordination roots/profiles and preserve useful screenshots.

## Close conditions

Acceptance criteria pass with two real sessions, supported native hooks are proven and coverage limitations documented; crash/orphan/platform evidence is retained.

The research gap review maps every identified gap to tasks. The native adapter coverage report must distinguish documented capability from installed/launch-mode proof, and include failed/missing hooks, nested ownership and permission rejection. Implementation remains Backlog after this planning review.

## Issue mirror

[FX-BE-150 issue mirror](../../../../../issues/features/fx-bf-048-agent-session-coordination/stories/fx-be-150-agent-session-coordination/issue.md).

## Description


## Comments

## Progress 2026-10-09

TASK-391 to TASK-395 are done on macOS: services and process trees, bounded waiting, event
deltas, person takeover of the in-app browser, branch/HEAD revalidation, sleep- and
clock-proof leases, hook failure semantics, and live Claude Code and Codex hook denial.
Coverage is labelled honestly: gateway sessions are enforced; every ACP session and every
hook is cooperative; Copilot and Gemini adapters are unproven live and not advertised.
Linux and Windows verification is deferred to TASK-438 (Backlog) at the owner's direction.
