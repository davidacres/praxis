---
**Status:** 📋 Proposed
**Created:** 2026-09-05T07:33:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-031
title: Verify and harden the ticket-to-agent flow
status: Done
feature: FX-BF-015
issue: docs/issues/features/fx-bf-015-session-review-cost-and-correction/stories/fx-be-031-verify-and-harden-ticket-to-agent/issue.md
updated: 2026-09-05
commits: [14326bf, aa271de, b42a6ea, 3ae1789, c9e9463]
dependencies: [FX-BF-011]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# Verify and harden the ticket-to-agent flow

## User or operational impact

Before this, "can I hand Praxis a ticket and have an agent actually do the
work" was an assumption, not a proven fact. It's now proven two ways, and a
real correctness bug the proving found is fixed.

## Scope

- A scripted, no-model-call end-to-end test (`aiCodingTask.spec.ts` +
  `fixtures/codingAcpAgent.mjs`, a real ACP subprocess) proving a ticket
  reaches an agent, the agent edits a real file through Praxis's own
  `fs/read_text_file` / `fs/write_text_file` handlers, the edit is really on
  disk, and a read-only session's write is refused.
- An opt-in test against a real model (`aiLiveAgent.live.spec.ts`, gated by
  `PRAXIS_LIVE_AGENT=1`, excluded from every other Playwright project) proving
  a real agent handles a small, well-specified ticket sensibly — the half the
  scripted test can't touch.
- Bounded the agent host's cancel/stop path (`CANCEL_GRACE_MS`,
  `STOP_GRACE_MS`) so a wedged agent can't hang a session indefinitely.

## Bug found and fixed

An agent turn's reply was never recorded as a `message` conversation event —
it lived only in `responseText`, which the transcript still showed, so it
looked cosmetic. It wasn't: the next turn's prompt is built from `message`
events, so the agent lost its own answer to a prior turn the moment a
follow-up was sent. Fixed in `aa271de`; a regression test walks three turns
and confirms each one's reply is recorded once and carried forward.

## Acceptance criteria

- `aiCodingTask.spec.ts` passes in the normal suite, on every push, without a
  model call.
- `aiLiveAgent.live.spec.ts` never runs as part of `npm run test:desktop` and
  skips outright without `PRAXIS_LIVE_AGENT=1`.
- A follow-up message's prompt includes the agent's own prior-turn reply.

## Task list (retrospective — see commits, not forward-planned tasks)

- `14326bf` — End-to-end coverage for handing a ticket to an agent.
- `aa271de` — Fix: record each agent turn's reply as a conversation event.
- `b42a6ea` — Opt-in live-agent run against a real model.
- `3ae1789` — Record the ACP agent-session model and the ticket-to-agent test path (AGENTS.md).
- `c9e9463` — Bound the agent host's cancel path so a wedged agent can't hang a session.

## Close when

The scripted suite runs green on every push and the live-agent test is
reachable and useful on request, without either being able to interfere with
the other.

## Description


## Dependencies



## Comments


