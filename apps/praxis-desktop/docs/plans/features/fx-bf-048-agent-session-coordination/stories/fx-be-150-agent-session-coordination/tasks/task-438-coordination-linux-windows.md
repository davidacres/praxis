---
**Status:** 📋 Backlog
**Created:** 2026-10-09
**Type:** Task
**Priority:** Medium
id: TASK-438
type: Task
status: Backlog
created: 2026-10-09
priority: Medium
---

# Verify session coordination on Linux and Windows

## Context

Deferred from TASK-395 on 2026-10-09 at the owner's direction: everything else in FX-BF-048
is built and proven on macOS. Until this runs, the capability matrix lists both platforms as
deferred and nothing is claimed for them.

## Scope

- **Linux:** run `coordinationHost.test.ts`, `coordinationInstance.test.ts`,
  `coordinationHook.test.ts`, core `coordination.test.ts` and `localTools.test.ts`, and the
  coordination e2e specs. The code path is the macOS one (Unix socket, `ps` / `lsof` for
  process groups and ports); confirm `lsof` is present or degrade port detection with a stated
  reason.
- **Windows:** the broker speaks over a named pipe whose ACL is the platform default, so the
  token file is the only protection — verify, and tighten the pipe ACL if it can be done
  without native code. `run_shell` keeps plain `exec` there: no process groups, so no service
  tracking — decide between a job object and stating it as a limit.
- Record the results in `docs/research/coordination-capability-matrix.md`.

## Dependencies

TASK-395

## Done conditions

Both platforms' rows in the capability matrix carry evidence, or a stated limit, for
election, takeover, persistence, socket/pipe protection and service tracking.

## Description


## Comments
