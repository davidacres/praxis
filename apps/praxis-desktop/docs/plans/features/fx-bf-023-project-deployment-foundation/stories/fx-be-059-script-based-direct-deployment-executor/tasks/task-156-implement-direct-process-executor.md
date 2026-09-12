---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-156
title: "Implement direct process executor"
status: Done
story: FX-BE-059
updated: 2026-09-09
dependencies: [FX-BE-058]
---

# TASK-156: Implement direct process executor

**Priority:** High
**Created:** 2026-09-07

## Goal

Spawn configured executable and argument arrays with scoped cwd/environment, cancellation and timeouts; pass artifact/target inputs without command-string interpolation.

## Implementation entry points

main/src/main; packages/core/src/deployments (new). Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-058
## Acceptance criteria

- Paths with spaces and metacharacters are data; fixture scripts produce typed results; startup failure and timeout preserve logs and operation identity.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:**

- `packages/core/src/deployments/directProcessExecutor.ts` (new) —
  `runDirectProcessDeployment(input)`: spawns `input.executable` with
  `input.args` (an array, `shell: false`) and a caller-scoped `cwd`, and
  passes typed inputs (e.g. the published artifact's path, a target's path)
  as `PRAXIS_DEPLOY_<key>` environment variables. **"Pass artifact/target
  inputs without command-string interpolation"** is structural, not a rule
  enforced at runtime — there is no code path anywhere in this module that
  concatenates a value into a string that is later parsed as shell syntax;
  every value is either an `execve` argv element or an environment variable,
  both of which are literal byte strings to the OS. **"Paths with spaces and
  metacharacters are data"** is proven directly by a test that passes
  `` /tmp/my dir; rm -rf / && echo pwned $(whoami) `echo x` "quo'ted" `` as
  a typed input and asserts the fixture script receives it back
  byte-identical.
- **Operation identity.** `operationId` is a required *caller-supplied*
  input (not generated internally) and is echoed back verbatim in the
  result on every path — success, non-zero exit, a startup failure that
  never obtained a pid, a timeout, and a cancellation. This is
  deliberately the same "persist identity before dispatch" discipline
  `deploymentRunStore.ts` documents (TASK-154): a caller mints and durably
  records the id *before* calling this function, so this function's only
  job regarding identity is to never lose or replace it — it does not
  invent one, because inventing one here would defeat the "before dispatch"
  half of that discipline.
- **Startup failure and timeout preserve logs and operation identity** —
  both proven directly: a nonexistent executable resolves with
  `operationId` intact, `exitCode: null`, an `error` message, and whatever
  `output` was captured (none, in that case, since nothing ever wrote to a
  stream); a timeout kills the process tree, sets `timedOut: true`, and
  keeps every byte written to stdout/stderr before the kill. A companion
  test proves the kill is real (`process.kill(pid, 0)` throws `ESRCH`
  immediately after the call resolves), not merely reported.
- **Bounded output**, matching `workflowCheckProcess.ts`'s own 200,000-byte
  cap (`output = (output + chunk).slice(-MAX_OUTPUT_BYTES)`), so a runaway
  script cannot grow the captured log without bound.
- **Cancellation** via `AbortSignal`: an already-aborted signal short-circuits
  before ever spawning (`cancelled: true`, no `pid`); an abort mid-run kills
  the process tree the same way a timeout does.
- **Reuse, not reinvention** — extracted `killProcessTree` (POSIX process-group
  signal / Windows `taskkill /T`) out of `projects/runServiceManager.ts`
  into a new shared `host/processTree.ts`, and pointed both
  `runServiceManager.ts` and this new executor at it. Before this task there
  were two independent, byte-identical private copies of this ~15-line
  kill-tree implementation (one here in core, one in
  `apps/praxis-desktop/main/src/main/workflowCheckProcess.ts`); adding a
  third call site inside the same package made extracting the shared one
  the right call rather than writing a fourth copy. The main-process
  `workflowCheckProcess.ts` copy was left untouched — it is a different
  package/execution context and changing it was not required by this task.
  `runServiceManager.test.ts`'s existing 32 tests pass unchanged, proving
  the extraction is behavior-preserving.

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. Targeted
`node --test` on `directProcessExecutor.test.js` (11/11) and
`runServiceManager.test.js` (21/21, confirming the shared
`killProcessTree` extraction changed nothing observable) together —
32/32. `npm run test:core` from the repo root (confirmed no stray
background test/tsc processes first) — **796/796 passing** (up from 785;
11 new). `npx tsc --noEmit -p .` in `apps/praxis-desktop/main` — clean
(unaffected; this task touched no main-process file).
`npm run check-types` in `apps/praxis-desktop/renderer` — clean
(unaffected).

**Remaining limitations:**

- This is the low-level spawn primitive only — nothing yet calls
  `runDirectProcessDeployment` from a real deployment flow. There is no
  `DeploymentRun` integration (minting the `operationId`, calling
  `DeploymentRunStore.save()` before dispatch per TASK-154's own
  discipline, or driving `applyDeploymentRunCommand('start-deploying'/
  'record-external-id'/...)` around a real call), no target-type dispatch
  (this executor knows nothing about `LocalProcessTargetRef` vs
  `DirectoryTargetRef` — it just spawns an executable/args/cwd/inputs a
  caller supplies), no health verification, and no IPC/UI wiring. Those are
  explicitly TASK-157 ("Add local directory target and health
  verification") and TASK-158 ("Expose direct deployment actions").
- `operationId` is not yet tied to a real reconciliation `isAlive` check —
  `DeploymentRunStore.reconcileDeploymentRun` (TASK-154) still takes an
  externally supplied `isAlive` predicate; wiring a real one (almost
  certainly `pid:<n>` parsed back out of a caller-chosen `operationId`
  format, checked via `process.kill(pid, 0)` the same way
  `runReconciliation.ts`'s `isPidAlive` works) is this executor's future
  caller's job, not this module's — it deliberately makes no assumption
  about what an `operationId` even looks like beyond "a string the caller
  gave it."
- Nothing here is Electron-dependent, so — like every other pure-core task
  in this feature — there is nothing this sandbox's inability to launch
  Electron leaves unproven; marked `complete` on that basis.

## Description


## Comments


