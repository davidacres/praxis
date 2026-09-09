---
type: Task
id: TASK-141
title: "Define run profile schema"
status: complete
story: FX-BE-054
updated: 2026-09-07
dependencies: [FX-BF-021]
---

# TASK-141: Define run profile schema

**Priority:** High
**Created:** 2026-09-07

## Goal

Create versioned run.praxis.json conventions using shared filename constants; include executable/args, cwd, service dependencies, readiness probes, ports and secret references.

## Implementation entry points

packages/core/src/projects; packages/core/src/host/ipcContracts.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BF-021
## Acceptance criteria

- Profiles round-trip with repo-relative paths; duplicate service IDs, dependency cycles, invalid probes and embedded secrets are rejected.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:** `packages/core/src/projects/runProfile.ts` (new) — `RUN_PROFILE_FILE_NAME =
'run.praxis.json'` (AGENTS.md's `<name>.praxis.<ext>` naming rule); `RunProfile`/`RunServiceDefinition`
(executable, args, repo-relative `cwd`, `dependsOn`, `readinessProbe`, `port`, `env`);
`RunReadinessProbe` as a closed union (`http`/`tcp`/`log-line`, so a probe kind and its own required
field are checked together, not left to be assumed). `validateRunProfile` fails closed, matching
`workflowValidation.ts`'s discipline:
- **Repo-relative paths** — `cwd` is checked with the existing `isPortableFolderPath`
  (`workspaces/workspacePaths.ts`), reused rather than re-implemented, which is also what catches a
  Windows-style `C:\...` path even when validated on a POSIX host.
- **Duplicate service ids** — rejected by name, matching the exact `WorkflowStore`/plan-parser style
  "Duplicate X within Y" message shape used elsewhere in this codebase.
- **Dependency cycles** — a DFS over `dependsOn` (the same DAG concern `workflowValidation.ts` checks
  for workflow edges), returning the actual cycle path in the error message, not just "a cycle
  exists." A `dependsOn` naming an unknown service id is a separate, also-rejected case.
- **Invalid probes** — each probe kind's own required field (`http.path`, `tcp.port` in 1-65535,
  `log-line.match`) is checked only once the kind itself is confirmed known.
- **Embedded secrets** — reuses `workspaceTypes.ts`'s `SECRET_SETTING_PATTERN` vocabulary
  (token/secret/password/apikey/pat), adapted for `SCREAMING_SNAKE_CASE` env var names: plain `\b`
  treats `_` as a word character, so `\bpat\b` alone never matches inside `MY_PAT` — this was caught
  by the test suite (see below), not by inspection, and fixed with an underscore-aware
  `(?:^|_)pat(?:_|$)`. A secret-shaped key must hold a `${secret:NAME}` reference; a literal value
  under that key is rejected outright, a plain non-secret key may hold a literal freely.
- `parseRunProfile`/`serializeRunProfile` — JSON round trip, rejecting an unrecognised future schema
  version rather than guessing at it.

**Commands run:** `npm run test:core` — 556/556 (24 new). One test failure surfaced the `\bpat\b`
underscore bug on first run (`MY_PAT` wasn't caught) — fixed, then reran clean; recorded here because
"prove every regression guard fails" cuts both ways: a test that catches its own author's bug on the
first run is doing its job. `npm run check-types` (root, all three workspaces) — clean.

**Remaining limitations:** No IPC, storage read/write (`readRunProfile`/`writeRunProfile` alongside
`board.praxis.json`'s established pattern), or UI editor yet — that is TASK-142 (resolving launch
configuration from real Node/ASP.NET project shapes) and TASK-143 (the editor) respectively. This
task is the schema and validation contract only, fully self-contained and independently testable, per
its own scope.
