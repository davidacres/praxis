# [P1] Refuse auto permission mode from project-sourced workflows and stop leaking the app environment to checks

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:54.775Z
**Type:** Bug
**Priority:** High
**Severity:** Medium
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P1 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-011** (Medium, CWE-829) — the two low-cost halves: `apps/praxis-desktop/main/src/main/workflowAgentStage.ts:239` (`autoApprovePermissions: workflowRun.permissionMode === 'auto'`) and `apps/praxis-desktop/main/src/main/workflowCheckProcess.ts:24-36` (`env: { ...process.env, … }`), loaded via `packages/core/src/workflows/workflowStore.ts:48,172-220`.

The workspace-trust model is the companion item, *Require workspace trust before a project-committed workflow can run*.

## Why this priority

Both are S and neither waits on the trust-prompt design, so they remove the sharpest edges of SEC-011 in the next iteration. A repository-supplied definition currently chooses the run's `permissionMode`, and `auto` makes every agent tool call in that run self-approving (`acpAgentHost.ts:344`, `vercelAgentService.ts:286`) — auto-approval should be an operator's choice at run start, never the repository's. Separately, every check child process inherits the Electron main process's entire environment, including any provider API keys present there; `hostLoader.ts:74` already ships the tighter pattern (`env: { PATH }`) for agent spawning.

## Change

- `packages/core/src/workflows/workflowStore.ts:172-220` (`loadProjectWorkflows`) — where `source` is the project folder, drop or downgrade `permissionMode: 'auto'` to `ask` at load time and report it through the warning/`invalid` channel the loader already has, so `workflowAgentStage.ts:239` can never be satisfied by a repo-authored file.
- `apps/praxis-desktop/main/src/main/workflowCheckProcess.ts:24-36` — replace `env: { ...process.env, … }` with an explicit allowlist (`PATH`, `HOME`/`USERPROFILE`, `TMPDIR`, `SystemRoot`, the existing `CI` and `PRAXIS_E2E_WORKERS` handling, plus anything the node declares).

## Verification

Extend `apps/praxis-desktop/main/src/main/workflowCheckProcess.test.ts` with a check node that prints its environment, and assert an injected secret-shaped variable is absent while `PATH` and `CI` are present. Add a case to `packages/core/src/workflows/workflowStore.test.ts` asserting a project-sourced definition declaring `permissionMode: 'auto'` loads as `ask` with a warning, and that a user-authored one is untouched. Run `npm run test:core && npm run test:desktop:workflows`.

## Effort

S

## Depends on

None.

## Risk

Check commands that quietly relied on an inherited variable (`NODE_OPTIONS`, npm proxy settings, a token a test needs) start failing, and the failure surfaces as an unrelated check error — allowlist what the repo's own workflow templates actually use, and log the stripped names once so the cause is findable. Downgrading `permissionMode` makes a team's own committed auto-approving workflow start prompting; that is intended, but it must be stated in the run log rather than appearing as a hang.

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

