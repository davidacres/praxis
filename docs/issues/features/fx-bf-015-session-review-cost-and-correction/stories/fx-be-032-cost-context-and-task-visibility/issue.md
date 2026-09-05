# FX-BE-032 — Cost, context, and task visibility

**Type:** Story  **Status:** Complete  **Priority:** P1  **Depends on:** FX-BF-011

## Business or operational impact
A session that spends real money and can silently fail as its context fills up used to report neither. It now reports both honestly — an absent figure where a provider reports nothing, never an invented zero.

## Scope
- Token usage from both gateway wire formats, totalled per session.
- Context bounded on resume and in-loop, with a composer banner driven by the latest turn's prompt.
- ACP `usage_update` read into the same context banner plus a cost figure.
- The agent's `plan` update surfaced live in the inspector.
- A user-set spend limit checked against real reported cost.
- Runtime chips, mode switch, and both banners consolidated onto the composer.

## Acceptance criteria
- ACP sessions never show an invented token total; API-provider sessions do show tokens.
- The context and spend banners share the same warn (two-thirds) / critical (85%) bands.
- The task list updates live as the agent's plan tool reports progress.

## Validation
- `npm run check-types`
- `npm run test:core`
- `npm run test:desktop`

## Close when
Every session shows the truth about its own cost and context, and the agent's task list is visible without scrolling the transcript.
