---
**Status:** 📋 Proposed
**Created:** 2026-09-05T07:33:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-036
title: Prove multi-file and terminal-using agent paths
status: To Do
feature: FX-BF-016
issue: docs/issues/features/fx-bf-016-packaging-github-backend-and-agent-proof/stories/fx-be-036-multi-file-and-terminal-proof/issue.md
updated: 2026-09-05
commits: [5222d3e]
dependencies: [FX-BE-031]
validation: [npm run check-types, npm run test:desktop]
---

# Prove multi-file and terminal-using agent paths

## User or operational impact

`FX-BE-031` proved the ticket-to-agent loop for a single-file, no-shell edit.
The plumbing supports multi-file changes and shell/terminal use — nothing in
the host or the sandbox is single-file-specific — but no test or real run has
exercised either as its own claim. "It can take a ticket and do the work" is
currently true only for the narrower case.

## What already exists

- `5222d3e` ("live coverage for a multi-file change and shell use") added a
  fixture exercising this shape, as part of hardening the ticket-to-agent
  flow — but it is coverage for the live-agent opt-in path, not a scripted,
  always-on proof the way `FX-BE-031`'s single-file case has.

## Scope (not started as a dedicated proof)

- A scripted (no-model-call) fixture, like `codingAcpAgent.mjs`, that edits
  two or more files in one turn and asserts all of them land correctly — the
  multi-file equivalent of the existing single-file test.
- A scripted fixture that runs a shell command through the ACP `shell` tool
  (or the local-tools shell path) and asserts its output reaches the
  transcript and its side effect (a file it wrote, a command it ran) is real.
- Both added to the normal suite (`aiCodingTask.spec.ts` or a sibling file),
  not gated behind the live-agent opt-in — the scripted harness already
  proves plumbing without a model call, same as the single-file case.

## Acceptance criteria

- A scripted test edits ≥2 files in one turn; all edits are verified on disk
  and each renders as its own diff in the transcript.
- A scripted test runs a shell command via the agent; its stdout appears in
  the transcript and a real side effect (e.g. a file the command wrote) is
  verified on disk.
- Both run in the normal suite, on every push, with no model call.

## Task list

Not yet broken into tasks.

## Close when

"It can take a ticket and do the work" holds for multi-file and
terminal-using tickets with the same scripted, always-on proof the
single-file case already has — not just plumbing that's assumed to work.

## Description


## Dependencies



## Comments


