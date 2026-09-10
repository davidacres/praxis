---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-144
title: "Implement process lifecycle manager"
status: In Progress
story: FX-BE-055
updated: 2026-09-09
dependencies: [FX-BE-054]
---

# TASK-144: Implement process lifecycle manager

**Priority:** High
**Created:** 2026-09-07

## Goal

Track process ownership, ports and dependent start order; stream logs; enforce readiness timeout and terminate owned process trees on stop or partial startup failure.

## Implementation entry points

main/src/main/terminalManager.ts; main/src/main/aiBrowser.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-054
## Acceptance criteria

- Fixtures cover port collision, early exit, failed dependency, timeout and repeated stop on supported desktop platforms; never kill unrelated processes.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Status: the lifecycle manager itself is implemented and tested against real spawned processes for
every named fixture scenario; nothing yet wires it into the main process (no IPC, no push events to
the renderer, no UI). Left `in-progress` — that integration is TASK-146's explicit scope
("Integrate Run controls and recovery"), not this task's.**

**Implemented:** `packages/core/src/projects/runServiceManager.ts` (new) — `RunServiceManager`, an
`EventEmitter` owning at most one active run at a time (`start()` refuses a second run while one is
already active rather than losing track of a process tree it owns):

- **Dependency-ordered startup** — a DFS topological sort over `dependsOn` (assumes an
  already-validated, acyclic profile — `start()` calls TASK-141's `validateRunProfile` first and
  refuses an invalid one before anything spawns). Each service waits only for its own declared
  dependencies to reach `ready`; independent services start concurrently rather than one at a time.
  A dependency that ends `failed` marks everything depending on it `failed` too, with the failing
  dependency named in the message, and that service is never spawned at all.
- **Readiness probes** — all three kinds from TASK-141's schema: `log-line` matched inline as
  stdout/stderr lines arrive, `tcp` and `http` polled every 200ms (`net.createConnection` /
  `http.get`, both against `127.0.0.1`, both time-boxed per attempt so one slow probe can't stall the
  poll loop). A service with no declared probe is considered ready once it survives a short settle
  window (400ms) — long enough to distinguish a real launch from an instant crash, which is exactly
  what "early exit" (below) exercises. **Caught during implementation:** `RunHttpProbe` has no port
  of its own (it's relative to "the service's own base URL" per the schema doc comment) — a service
  with an http probe but no declared `port` would poll against `undefined` forever. `validateRunProfile`
  doesn't catch this (a schema-level gap, not this task's to fix), so the manager runs its own
  preflight check and fails the service before ever spawning it, with a message naming the problem.
- **Readiness timeout** — a per-start timer (`readinessTimeoutMs`, default 30s, overridable) that
  fails the service and kills its tree if no probe ever succeeds.
- **Port collision** — before spawning a service with a declared `port`, a throwaway server tries to
  bind that exact port; failing to bind means something else already holds it, and the service is
  failed with that reason *before* the real process is ever started — the same failure mode the real
  bind would hit, caught earlier and without leaving a half-started process behind.
- **Process-tree termination** — reuses `apps/praxis-desktop/main/src/main/workflowCheckProcess.ts`'s
  exact cross-platform approach rather than reinventing it: `detached: true` on POSIX makes each
  child its own process group leader, torn down via `process.kill(-pid, …)`; Windows has no process
  groups, so `taskkill /pid <pid> /T /F` walks the tree instead. `stop()` sends SIGTERM first, then
  SIGKILL after a 3s grace period if the tree hasn't exited. Only a pid this instance itself obtained
  from its own `spawn()` call is ever touched — there is no code path that accepts or infers a
  foreign pid, so "never kill unrelated processes" holds by construction.
- **Repeated stop** — idempotent: a `stopped` flag makes every call after the first a no-op, and
  `stopOne` skips a service already `failed` or `stopped` rather than re-issuing a kill.
- **Log streaming** — an `EventEmitter` `'log'` event per stdout/stderr line (`{ serviceId, stream,
  text, at }`), and a `'status'` event on every state transition (`pending → starting → ready |
  failed`, plus `stopping → stopped`), giving a caller (the eventual IPC layer) both a live feed and
  a point-in-time `status()` snapshot without polling the child processes itself.

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. `npm run test:core` (repo root) —
589/589 passing (15 new, all against real spawned `node -e <script>` processes per this session's
established convention, no mocks): no-probe settle, log-line probe, tcp probe, http probe, http probe
with no port (preflight rejection), port collision, early exit, failed dependency, dependency
ordering (asserted via the exact event sequence `db:starting, db:ready, api:starting, api:ready`),
readiness timeout, repeated stop, "does not touch a bystander process it never spawned" (spawns an
unrelated process outside the manager, confirms it survives `stop()`), post-ready unexpected exit,
refusing a second concurrent run, and refusing an invalid profile before spawning anything.
`npx tsc --noEmit -p .` in `apps/praxis-desktop/main` and `npm run check-types` in
`apps/praxis-desktop/renderer` — both clean (neither consumes the new module yet, but both re-resolve
core's built `.d.ts` output, so a compile-clean check here also proves the new export doesn't break
either workspace).

**Remaining limitations:** No main-process singleton, IPC surface, or renderer wiring exists yet —
`RunServiceManager` is a pure core class nothing in the app currently instantiates. Log/status events
are in-memory only; nothing persists them, so a relaunch loses run history (a running process itself
would also be orphaned from Praxis's point of view across an app restart — recovery on relaunch is
explicitly TASK-146's "recovery" half). Secret references (`${secret:NAME}` in `service.env`) are
passed through to the spawned process's env verbatim, unresolved — this manager has no access to
the secret store; resolving `${secret:...}` references before they reach `env` is the eventual IPC
layer's job, not this module's, so a profile containing one would currently launch with the literal
placeholder string in its environment rather than a real secret. Electron end-to-end verification was
not attempted (nothing Electron-specific exists yet to verify — the whole module runs and is tested
under plain `node --test`).

## Description


## Comments


