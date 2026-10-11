# [P1] Enforce ACP read-only mode on the tool kind, not the agent's prose

**Status:** Done
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

Additional acceptance checks:

- [x] Missing or unknown kinds and mutating kinds are denied in read-only mode, including under `permissionMode: 'auto'`; benign titles do not bypass denial.
- [x] Client-boundary tests refuse filesystem writes and terminal operations in read-only mode even if the peer labels the request as a read. Explicitly supported read-safe kinds continue to work.
- [x] The user sees a clear read-only refusal in the transcript and the agent receives a denial, with no silent stall and no secret/token content in the message.
- [x] Existing project-only behavior and explicitly authorized write-capable sessions remain covered by regression tests.

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


## Historical work order — 2026-10-11 (superseded by closeout below)

**Next implementation item: order 1 of 5**, selected under PRX-F107. This is the existing SEC-009 permission-bypass remediation, with no new dependency or added subsystem. Verify the reported behavior in the current checkout before changing code; completion requires the denial and allowed-read evidence above.

## Comments


### 2026-10-11 — closeout status and verification

Existing full-run log records `aiCliAgentHost.spec.ts` read-only denial passing for neutral titles, missing kinds and allow-only wire options, and the workflow read-only auto-approval regression passing. Core coverage checks safe kinds, denied kinds and filesystem/terminal method boundaries. This closes SEC-009 only; other F107 findings remain open.

The existing detached run (`/tmp/sd3-full.log`) finished: **590 passed, 3 skipped, 1 failed**. These are prior-run results, not a new run. E2E tests were not run during this closeout, as requested.
