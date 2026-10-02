---
**Status:** 📋 Proposed
**Created:** 2026-10-02T10:59:50.747Z
**Type:** Task
**Priority:** Medium
id: TASK-392
type: Task
status: Backlog
created: 2026-10-02
priority: High
---

# Design and implement the single local broker

## Files and integration points

Proposed core ai/sessionCoordination.ts and coordinationStore.ts; main/src/main/sessionCoordinationInstance.ts and startup/shutdown wiring.

## Scope

Prototype cross-process election and authenticated local IPC on all supported platforms; use a stable OS-user coordination root and test override. Serialize grant/persist/ack; bounded fair waiters, owner identity, epoch/generation checks, snapshots, retention and corruption recovery. Repository projections use canonical git common directory. Never take over from a merely expired owner.

Support prompt contention responses and a separate bounded wait/subscription API so before-tool hooks do not sleep until timeout. Deduplicate pending requests and cancellation, enforce owner/delegation boundaries, and reconcile reserved-but-not-executed grants through lifecycle evidence. Bound sessions, messages, request queues and publication rates with explicit backpressure; never evict live claims. Scoped views expose only authorized messages and minimal cross-project contention information.

## Dependencies

TASK-391

## Done conditions and validation

Two contenders elect one authority; crash and partial-write tests preserve ownership; old epoch requests fail; projection loss does not release grants. Verify flush/replacement semantics by platform.

Prove bounded wait/cancel, duplicate acquisition/acknowledgement, owner delegation, backpressure and scope filtering; broker loss never returns an implicit grant. Keep ownership suspect until actual cleanup is known.

## Description


## Comments


