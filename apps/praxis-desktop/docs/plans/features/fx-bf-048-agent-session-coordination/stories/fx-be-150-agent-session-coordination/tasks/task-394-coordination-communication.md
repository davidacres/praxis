---
**Status:** ✅ Complete
**Created:** 2026-10-02T10:59:50.748Z
**Type:** Task
**Priority:** Medium
id: TASK-394
type: Task
status: Done
created: 2026-10-02
priority: High
---

# Expose bounded messages and resource waiting status

## Files and integration points

Session instruction construction and coordination MCP adapter; main/preload IPC contracts; renderer existing SessionsPage/SessionInspector surfaces after reading renderer area notes.

## Scope

Provide scoped list/activity/message/ack and event deltas with sequence/compaction recovery. Show owner/reason/wait duration and completion handoffs. Treat peer text as untrusted data; redact secrets and avoid automatic LLM chat for heartbeat traffic. Handle manual takeover by pausing automation and invalidating evidence.

Expose bounded waiting and cancellation after a denied conflicting tool; deduplicate opted-in resource-available wakeups and require a fresh acquisition before execution. Avoid model retry loops and prevent resource requests from retaining unrelated claims while waiting. Show runtime coverage as enforced/cooperative/observed and a clear preflight failure reason. Keep cross-project blocker details minimal and surface explicit backpressure rather than silently dropping handoffs.

## Dependencies

TASK-393

## Done conditions and validation

Two sessions exchange activity/done messages; cancellation removes waiters; event resync and retention do not lose live claims; UI reflects real broker outcomes and existing permission modes.

Resource release notifies one opted-in waiting request without heartbeat-triggered turns; reconnects do not duplicate wakeups/messages. Waiting expires with a concrete blocker and no repeated tool attempts. Unsupported hook configuration is visible; another project's private paths/chat remain scoped out.

## Description


## Comments

## Progress 2026-10-09

Delivered: coordination MCP for ACP agents (`coordination_status` / `claim` / `release` /
`message`, peer text marked as information, secrets redacted, no retry loops);
inspector block showing coverage (enforced / cooperative / observed), what the session
holds, what other sessions in the repository hold or wait for, and a "Confirm stopped"
recovery that is attributed in the event log.

Then, the same day:

- **Bounded waiting.** Gateway `wait_for_files` and ACP `coordination_wait`: queued at the
  broker in turn order with a relative deadline (max 120 s), woken once by the release with a
  fresh grant started at once, cancelled by the agent's abort, its turn ending, or the
  timeout — leaving nothing queued and granting nothing late. Refusals point at the wait
  tool once; the tool says not to loop.
- **Event deltas.** `coordination_status` takes `since` and returns only what happened after
  it, or the whole picture with a note when the log was trimmed past that point (`resync`).
  Messages can ask for an acknowledgement; `coordination_ack` gives it.
- **Manual takeover.** Real input in the in-app browser (Electron's input pipeline, which the
  agent's `executeJavaScript` never touches) takes the browser from the agent at the broker;
  the agent is told what it saw is out of date and is refused it until the person has left
  it alone for 30 s. Only live surfaces can be taken; files and processes cannot.
- The inspector shows waiting sessions with how long, services with **Stop**, and times on
  the broker's clock.
