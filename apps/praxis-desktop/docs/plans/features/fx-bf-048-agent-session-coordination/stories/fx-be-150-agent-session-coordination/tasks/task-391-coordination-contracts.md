---
**Status:** 📋 Proposed
**Created:** 2026-10-02T10:59:50.746Z
**Type:** Task
**Priority:** Medium
id: TASK-391
type: Task
status: Backlog
created: 2026-10-02
priority: High
---

# Define coordination schema and resource conflicts

## Files and integration points

Proposed new core ai/coordinationTypes.ts and coordinationPolicy.ts; link existing ai/agentTypes.ts session identities.

## Scope

Define register/activity/acquire/renew/release/message/finish contracts, schemaVersion/epoch/revision, idempotency, scoped snapshots, file/directory/worktree hierarchy, stable reads, branch/index and app/browser/desktop/build resources. Preserve permissions and tool modes.

Before committing to native adapter design, produce a capability matrix for installed Claude Code, Codex and Gemini CLI where present: actual launch mode/ACP, version, enabled/trusted hook configuration, payload and correlation fields, synchronous denial, covered tools, failures/timeouts and stop/interrupt/subagent events. Missing runtimes are unsupported until proven, not presumed compatible. This implementation preflight must not modify global configuration automatically.

Define reserved/executing/cleaning-up/released/recovery-required states and distinct session/turn/execution-owner/request identity. Specify idempotent duplicate observations, tool/sequence/service lifetimes, explicit parent-to-child delegation, concurrent sibling conflicts and parent/child wait-cycle rejection. Distinguish enforcement at a proven side-effect gate from cooperative hook coverage.

## Dependencies

FX-BE-150

## Done conditions and validation

Table-driven policy tests prove same-resource exclusion, independent-worktree concurrency, directory/symlink conflicts and all-or-none resource sets; document canonicalization and filename exception.

Capability report and hook event contract are reviewed before TASK-392/TASK-393 architecture is finalized. Tests cover owner identity, nested sequence claims, delegated authority and rejected permission after reservation. Document hook failure routes that require direct gates or unsupported/cooperative classification.

## Description


## Comments


