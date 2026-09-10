---
**Status:** 📋 Proposed
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-015
slug: session-review-cost-and-correction
title: Session review, cost, and correction controls
status: Done
owner: Electron desktop app
updated: 2026-09-05
issues: docs/issues/features/fx-bf-015-session-review-cost-and-correction/feature-issues.md
stories: [FX-BE-031, FX-BE-032, FX-BE-033]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# FX-BF-015: Session review, cost, and correction controls

## Note on how this feature file came to exist

Written retrospectively. Every item below shipped as a direct commit on
`main` between 2026-09-02 and 2026-09-05, with no feature/story/task behind it
at the time — `FX-BF-011`'s "As built" record stops at its 2026-09-03 shell
revision, and nothing since was tracked anywhere. This backfills that gap so
the plan docs describe what actually exists rather than what existed two days
ago. Because it is a backfill, task lists below cite the commits that did the
work instead of forward-planned `TASK-NNN` records — inventing task IDs for
work that was never broken into tasks up front would misrepresent the process,
not just the docs.

## Outcome

A finished agent session is something you can trust and correct without
leaving the conversation: you can see what it actually did to your files, what
it cost, how full its context is, and undo the specific parts you don't want —
instead of re-reading a chat transcript or writing a follow-up message asking
the agent to fix its own mistake.

## Scope

- End-to-end proof that a ticket reaches a real ACP agent and lands on disk
  (scripted, in CI) plus one opt-in run against a real model; a real
  context-loss bug this testing found and fixed.
- A session's changeset reviewable in place — diff, whole-file view, commit,
  discard — read from the working tree rather than reconstructed from the
  transcript.
- Token, context, and cost visibility for the providers that actually report
  them, with an honest absence (not an invented zero) everywhere else; a
  user-set spend limit checked against real reported cost.
- The agent's self-reported task list surfaced live in the inspector.
- Correction without negotiation: discard one hunk instead of a whole file;
  undo one recorded edit from the transcript row that shows it.

## Story map

- `FX-BE-031` — Verify and harden the ticket-to-agent flow.
- `FX-BE-032` — Cost, context, and task visibility.
- `FX-BE-033` — Review and correction controls.

## Dependencies

- `FX-BF-011` — Agent runtime and session integration (the Sessions shell this
  builds on: sidebar navigation, `SessionInspector`, `sessionNav.ts`).

## Close when

A user can hand a ticket to an agent, watch it work, see exactly what it
changed and what it cost, commit or discard the result, and undo a single
edit or hunk they don't want — all without leaving the Sessions console.

## As built (2026-09-05)

See each story's own "As built" section for detail. Summary:

- **FX-BE-031** — `aiCodingTask.spec.ts` proves the flow with a real ACP
  subprocess (no model call, runs in CI); `aiLiveAgent.live.spec.ts` proves it
  once against a real model, opt-in only. Found and fixed a real bug along the
  way: an agent turn's reply was never recorded as a conversation event, so a
  follow-up silently dropped the agent's own prior answer from context.
- **FX-BE-032** — `formatTokens` / `contextPressure` / `formatCost` /
  `spendPressure` in `sessionNav.ts`; `usage_update` read from ACP
  (`AcpAgentHost`); `SessionTasks` renders the agent's `plan` snapshot; a
  composer banner shows context and spend pressure with the same warn/critical
  bands.
- **FX-BE-033** — `SessionChanges` (diff / whole-file view / commit / discard
  / per-hunk discard) and the transcript's per-edit "Undo edit" button
  (`ai:undoToolFileChange`, gated by `isLatestEditToPath`).

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-031 | Story | Verify and harden the ticket-to-agent flow | Complete |
| FX-BE-032 | Story | Cost, context, and task visibility | Complete |
| FX-BE-033 | Story | Review and correction controls | Complete |

## Comments

## Description

