# [P2] Require workspace trust before a project-committed workflow can run

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:55.075Z
**Type:** Bug
**Priority:** Medium
**Severity:** Medium
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P2 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-011** (Medium, CWE-829) — the main remediation: `packages/core/src/workflows/workflowStore.ts:48,172-220` (`loadProjectWorkflows` reads every `<projectFolder>/.praxis/workflows/*.json`); `apps/praxis-desktop/main/src/main/workflowCheckProcess.ts:24-36` (`spawn` of the repo-declared `command`/`args`); mobile reach at `mobileHostServices.ts:334-341` (`workflowRuns.start`).

## Why this priority

The exposure is real — cloning a repository to review a PR is exactly what this app is for, and nothing in the loading path distinguishes a workflow the user authored from one that arrived with the clone. `shell: false` is correct and blocks metacharacter injection, but the command itself is repo-controlled so no injection is needed. It is P2 rather than P1 because the honest fix is a new trust model with UI, persistence and a migration for already-opened projects (L), and because the companion P1 item has already removed the auto-approval and environment-inheritance amplifiers. Starting its design during the P1 phase is sensible.

## Change

- Add a per-project, persisted trust decision recorded the first time a project containing `.praxis/workflows` is opened, stored alongside existing project settings.
- `packages/core/src/workflows/workflowStore.ts:172-220` keeps loading definitions so they can be *displayed*, but a project-sourced workflow is not startable until granted. The prompt must show the user the actual `command` and `args` each check node will spawn.
- Enforce the gate at run start in the orchestrator and on the mobile path (`mobileHostServices.ts` `workflowRuns.start`), not only in the renderer — a paired phone holding `execute` is otherwise transitively granted whatever the repository defines.

## Verification

Tests asserting that starting a project-sourced definition is rejected without a trust grant and succeeds with one, and the same assertion through the mobile command dispatcher. An e2e asserting that opening a project containing `.praxis/workflows` shows the prompt, that the workflow is not startable until it is answered, and that the grant survives a restart. Run `npm run test:core && npm run test:desktop:workflows && npm run test:desktop:mobile`.

## Effort

L

## Depends on

Refuse auto permission mode from project-sourced workflows and stop leaking the app environment to checks

## Risk

A prompt that appears too often trains people to click through it — scope it per project, persist it, and never show it for projects with no `.praxis/workflows`. Existing users must be migrated (grant-on-upgrade for already-opened projects), or everyone's committed workflows silently stop working after the update. The mobile path returning a new "needs trust" failure needs a matching message in the app, or a phone just sees a run that failed for no stated reason.

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

