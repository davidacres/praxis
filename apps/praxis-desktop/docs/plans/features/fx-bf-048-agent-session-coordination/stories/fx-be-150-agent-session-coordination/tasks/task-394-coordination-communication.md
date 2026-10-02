---
**Status:** 📋 Proposed
**Created:** 2026-10-02T10:59:50.748Z
**Type:** Task
**Priority:** Medium
id: TASK-394
type: Task
status: Backlog
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


