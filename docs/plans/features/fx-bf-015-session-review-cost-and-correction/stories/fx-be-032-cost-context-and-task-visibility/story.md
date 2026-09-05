---
id: FX-BE-032
title: Cost, context, and task visibility
status: complete
feature: FX-BF-015
issue: docs/issues/features/fx-bf-015-session-review-cost-and-correction/stories/fx-be-032-cost-context-and-task-visibility/issue.md
updated: 2026-09-05
commits: [354cc9e, 3890b5d, 211d1d6, fca5812, faf4901, f5cd881, a14ad4e, f494822, a326db3, 56e5757, 532e56d, a02e98b]
dependencies: [FX-BF-011]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# Cost, context, and task visibility

## User or operational impact

A session that spends real money and can silently fail as its context fills
up used to report neither. It now reports both, honestly — an absent figure
where a provider reports nothing, never an invented zero — and the agent's own
task list stays visible while the conversation scrolls.

## Scope

- Token usage parsed from both wire formats the gateway speaks (OpenAI's final
  `usage` chunk, Anthropic's `message_start`/`message_delta` pair) and totalled
  per session; a running total is derived only once, at stream end, not on the
  first partial event.
- Context bounded two ways: `compactHistoryForReplay` on session resume,
  `trimToolOutputToBudget` inside the turn loop (elides oldest tool output,
  never the message itself). A composer banner shows `contextPressure` (the
  latest turn's prompt against the model's window), not a cumulative total.
- ACP's `usage_update` read (`used`/`size`/`cost`) and mapped to the same
  context banner plus a cost figure — the two things ACP actually reports,
  and nothing it doesn't (no cumulative token count over ACP).
- The agent's `plan` update (Claude Code's TodoWrite, Codex's plan tool)
  rendered live in the inspector (`SessionTasks`) as a wholesale-replaced
  snapshot, not a chat message.
- `ai.spendLimit`, a user-set budget (not a reported balance — no provider
  exposes one) checked against real reported cost, totalled per currency,
  explicit that nothing is blocked.
- Provider/model/tool/folder/worktree chips, the mode switch, and both
  banners consolidated onto the composer (`SessionsPage`'s
  `.composer-controls`), matching where Claude Code and Copilot put the same
  information, after an earlier pass had moved them into the sidebar.

## Acceptance criteria

- A CLI-hosted (ACP) session shows duration, steps, and cost but never an
  invented token total; an API-provider session shows tokens.
- The context banner reads `ok` under two-thirds, `warn` to 85%, `critical`
  above — driven by the latest turn's prompt, never a cumulative figure.
- A spend limit warns once total reported cost crosses the same two bands,
  totalled only when every contributing session reports one currency.
- The task list updates live as the agent's plan tool reports progress.

## Task list (retrospective — see commits, not forward-planned tasks)

- `354cc9e` — Report token usage for providers that send it.
- `3890b5d` — Bound a session's context, and show it filling up.
- `211d1d6` — Drive the context indicator through the real stack (test).
- `fca5812` — Put session chips and context back on the composer, not the sidebar.
- `faf4901` — Capture what the permission dock actually looks like (test).
- `f5cd881` — Give the permission dock the same warning tone as the context banner.
- `a14ad4e` — Stop the context banner's text falling below the composer's own scale.
- `f494822` — Put the mode switch on the composer, with the rest of the chips.
- `a326db3` — Show the agent's task list in the sessions inspector.
- `56e5757` — Read ACP `usage_update`, and document what the protocol actually offers.
- `532e56d` — Capture the ACP usage session (test).
- `a02e98b` — Warn against a spend limit you set, from cost agents actually report.

## Close when

Every session shows the truth about its own cost and context — including the
truth that a figure isn't known — and the agent's task list is visible without
scrolling the transcript.
