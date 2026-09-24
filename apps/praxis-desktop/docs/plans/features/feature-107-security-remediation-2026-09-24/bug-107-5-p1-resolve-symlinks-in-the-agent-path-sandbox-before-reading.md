# [P1] Resolve symlinks in the agent path sandbox before reading

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:52.649Z
**Type:** Bug
**Priority:** High
**Severity:** Medium
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P1 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-007** (Medium, CWE-59 / CWE-22) — `packages/core/src/ai/tools/pathSandbox.ts:11-22` (`resolveSandboxedPath`); auto-approval at `packages/core/src/ai/tools/shellAllowlist.ts:84-87`; the read sink at `packages/core/src/ai/tools/localTools.ts:152-184`; the same sandbox also gates `apps/praxis-desktop/main/src/main/aiIpc.ts:610` (`ai:loadImagePreview`).

## Why this priority

Medium severity, but the exploit needs nothing from the user beyond opening a cloned repository and asking an agent to read it: `shouldAutoAllowToolPermission` returns true for every `read` and `list` with no prompt, and the sandbox is pure string arithmetic — the lexical containment is correct, but `fs.realpath` is never called, and `nodeFs.readFile` at `localTools.ts:182` follows the link. A committed `docs/notes.md -> ~/.aws/credentials` (git preserves symlinks on clone) returns host credentials into the model context, the provider API, the on-disk transcript and any workflow evidence file. S effort, so it leads P1.

## Change

- `packages/core/src/ai/tools/pathSandbox.ts` — keep the existing lexical check (it correctly rejects `../` and sibling-prefix escapes), then call `fs.promises.realpath` on the resolved candidate — and on the nearest existing ancestor when the target does not exist yet, for write paths — and re-assert containment against `realpath(workingDirectory)`. Throw `PathSandboxError` when the real location falls outside. The function becomes async.
- Update callers: the read/write/list paths in `packages/core/src/ai/tools/localTools.ts:152-184` and around, and `apps/praxis-desktop/main/src/main/aiIpc.ts:610`. Keep the synchronous lexical helper exported for any caller that only needs the string check.

## Verification

New `packages/core/src/ai/tools/pathSandbox.test.ts`: a temp working directory containing a symlink to a file outside it — the resolver must throw; an ordinary in-tree file still resolves; a not-yet-created file inside an in-tree directory resolves (the write path). Extend `localTools.test.ts` so `read_file` on that symlink returns an error rather than the outside file's contents. **Add the new file to `packages/core/package.json`'s `test` script** — it enumerates test files explicitly, so a new one is otherwise never run. Then `npm run test:core`.

## Effort

S

## Depends on

None.

## Risk

`realpath` adds a syscall per resolution on a very hot path (every read, list and glob) — measure on a large repository. The sharper risk is false rejection: if the project directory is itself reached through a symlink — common on macOS `/tmp`, and true of Praxis's own `.worktrees/` layout — every in-tree read starts failing. Resolve the root with `realpath` too and compare real-to-real.

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

