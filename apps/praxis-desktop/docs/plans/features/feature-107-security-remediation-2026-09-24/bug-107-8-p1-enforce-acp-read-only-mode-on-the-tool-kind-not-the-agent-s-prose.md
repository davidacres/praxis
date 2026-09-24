# [P1] Enforce ACP read-only mode on the tool kind, not the agent's prose

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:53.705Z
**Type:** Bug
**Priority:** High
**Severity:** Medium
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P1 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-009** (Medium, CWE-184 / CWE-863) — `packages/core/src/ai/acp/acpAgentHost.ts:335-343`; input origin `packages/core/src/ai/acp/acpClient.ts:190-197`.

## Why this priority

The `read-only` guarantee is surfaced to users (Analysis and Review sessions) and to paired mobile devices as `toolAccess: 'read-only'`, but the decision is a keyword regex over `${request.kind ?? ''} ${request.title}` — and both fields are forwarded verbatim from the ACP peer at `acpClient.ts:193-197`. A tool call titled "Apply the suggested patch" with `kind` omitted contains none of the denylisted words and falls through to the approval queue; under a workflow stage with `permissionMode: 'auto'` it is then self-approved at `acpAgentHost.ts:344-346`. S effort and self-contained, so it is a P1 quick win. (`project-only` denies unconditionally and is unaffected.)

## Change

- `packages/core/src/ai/acp/acpAgentHost.ts:335-343` — replace the `permissionText` regex with an explicit allowlist over the structured `request.kind`: under `read-only`, permit only read-safe kinds (`read`, `search`, `fetch`, and any other read-only kind the ACP schema defines) and treat a missing or unrecognised `kind` as *not* read-safe. Leave the `project-only` behaviour as it is.
- `packages/core/src/ai/acp/acpClient.ts` — additionally assert the session's tool mode at the client-method boundary where `fs_write_text_file` and the terminal methods are served, so the decision rests on the method actually invoked, which the peer cannot restate.

## Verification

Extend `packages/core/src/ai/acp/acpAgentHost.test.ts`: a request titled "Apply the suggested patch" with no `kind` under `toolMode: 'read-only'` resolves to `deny`; a `kind: 'read'` request is still permitted; `fs_write_text_file` is refused at the client boundary in read-only mode even when the title looks benign. `npm run test:core`. The `aiAcpModesAndCommands.spec.ts` e2e spec covers the mode end to end — run `npm run test:desktop` to confirm no regression there.

## Effort

S

## Depends on

None.

## Risk

An allowlist that is too narrow denies legitimate read-only work and the agent sees only a refusal — enumerate the kinds real agents actually send (the repo's `e2e/fixtures/codingAcpAgent.mjs` harness is a cheap way to observe them) before tightening. Agents that omit `kind` entirely will now be denied in read-only sessions; that is the intent, but it should produce a clear event in the transcript rather than a silent stall.

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

