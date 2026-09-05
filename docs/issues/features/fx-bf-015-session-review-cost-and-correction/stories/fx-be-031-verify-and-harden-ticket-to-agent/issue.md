# FX-BE-031 — Verify and harden the ticket-to-agent flow

**Type:** Story  **Status:** Complete  **Priority:** P1  **Depends on:** FX-BF-011

## Business or operational impact
Before this, "can I hand Praxis a ticket and have an agent actually do the work" was an assumption. It's now proven two ways, and a real correctness bug the proving found is fixed.

## Scope
- Scripted, no-model-call end-to-end coverage of ticket → agent → file edit, including the read-only refusal case.
- An opt-in test against a real model, fenced out of every other run.
- Bounded the agent host's cancel/stop path so a wedged agent can't hang a session.

## Acceptance criteria
- The scripted suite passes on every push with no model call.
- The live-agent test never runs unattended and skips without its opt-in variable.
- A follow-up turn's prompt includes the agent's own prior-turn reply (regression for the bug this story found).

## Validation
- `npm run check-types`
- `npm run test:core`
- `npm run test:desktop`

## Close when
The scripted suite runs green on every push and the live-agent test is reachable and useful on request, without either interfering with the other.
