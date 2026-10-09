---
**Status:** ✅ Complete
**Created:** 2026-10-02T10:59:50.632Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-048
type: Feature
status: Done
created: 2026-10-02
priority: High
---

# Agent session communication and resource coordination

## Outcome

Agents can announce activity, communicate completion and reserve conflicting resources before acting, including the live app/browser, checkout edits, builds and test environments.

## Scope

One OS-user-local broker across sessions, runtimes, runs, repositories and worktrees. Publish the requested `agent.sessions.chat.json`; prevent concurrent ownership through broker acquisition, not direct multi-writer JSON edits. Enforced host tools and cooperative native hooks must be labeled accurately. Remote coordination is deferred.

Native before/after/session hooks are first-class broker adapters. Verify the installed runtime and actual launch mode before enabling them; preserve existing hook configuration. Hook failures, interactive commands, parallel subagents and missing callbacks must be covered by the ownership protocol. A hook-only path that can fail open remains cooperative; enforced shared-resource access requires a proven gate.

## Research and design

[Requirement analysis, sources, schema, conflict matrix and recovery protocol](../../../research/agent-session-coordination.md).

## Story map

- [FX-BE-150: Coordination contract, broker and runtime integration](stories/fx-be-150-agent-session-coordination/story.md).

## Dependencies

Related: FX-BF-035 (multi-AI sessions), FX-BF-047 (shared subagents). Reuse existing identities and lifecycle; neither unfinished plan is a blocking prerequisite.

## Close conditions

Exactly one participating owner per exclusive resource; independent resources remain concurrent; stale/orphan execution never silently permits takeover; agents receive bounded handoffs; runtime coverage and platform verification are documented. Planning complete does not mean implementation complete.

The research document records the gap review and each task's correction. Two real agents must demonstrate UI contention, safe handoff and failure recovery without a losing tool executing. Runtime hook capability, event correlation, failure semantics and configuration preflight are explicit delivery gates, not assumed capabilities.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments

## Progress 2026-10-09

Complete on macOS (see FX-BE-150 and the
[capability matrix](../../../research/coordination-capability-matrix.md)): broker, gates,
services, bounded waiting, takeover, revalidation, sleep/clock handling, and native hooks for
Claude Code and Codex proven live. Linux and Windows verification is deferred to TASK-438.
