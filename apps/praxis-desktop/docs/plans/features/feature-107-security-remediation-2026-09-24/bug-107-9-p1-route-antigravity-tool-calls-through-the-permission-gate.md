# [P1] Route Antigravity tool calls through the permission gate

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:54.068Z
**Type:** Bug
**Priority:** High
**Severity:** Medium
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P1 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-004** (Medium, CWE-862 / CWE-250) — `packages/antigravity-acp/antigravity_acp/server.py:136`.

## Why this priority

For this provider, Praxis's entire human-in-the-loop model is inert. `--dangerously-skip-permissions` is unconditional — no setting, no environment variable, no caller control — and the wrapper never implements or forwards ACP's `session/request_permission`, unlike the generic client at `acpClient.ts:190-203`. The pending-permission queue, the `read-only`/`project-only` block at `acpAgentHost.ts:336-341` and the mobile `permissions.respond` capability all have nothing to act on: a prompt-injected agent writes files and runs commands with no prompt and no `permission_requested` event, and a phone holding only `view` cannot even see it. Medium because the provider must be deliberately selected; P1 because the failure is silent and total. M effort — it needs protocol work in the Python wrapper — so the interim mitigation should ship first.

## Change

- `packages/antigravity-acp/antigravity_acp/server.py:136` — remove `--dangerously-skip-permissions` from the `cmd` list and implement the ACP `session/request_permission` client call so `agy`'s prompts are relayed over the ACP channel into the existing pending-permission queue. `packages/core/src/ai/acp/acpClient.ts:190-203` shows the desktop side of the same contract.
- **Verify first** that `agy` can emit permission prompts under `--output-format stream-json`. If it cannot, ship the interim instead: make the flag conditional on an explicit provider setting whose copy states plainly that no tool call will be prompted, and exclude Antigravity from `read-only` and `project-only` tool modes at selection time rather than silently ignoring them.

## Verification

An integration check that starting an Antigravity session and requesting a file write produces a pending permission in the queue — model it on the repo's model-free ACP harness at `apps/praxis-desktop/main/e2e/fixtures/codingAcpAgent.mjs`. Plus a CI grep asserting `--dangerously-skip-permissions` never appears unconditionally in `server.py`. For the interim path, confirm manually that the provider cannot be selected for a read-only session and that the opt-in copy is shown.

## Effort

M

## Depends on

None.

## Risk

Removing the flag without a working relay makes `agy` prompt on its own stdin and the session hangs with no visible cause — land the relay and the flag removal together, behind the setting, and keep a timeout so a stalled prompt surfaces as an error. Excluding the provider from read-only modes invalidates existing session and workflow-stage configurations; say why rather than failing silently.

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

