---
**Status:** 📋 Proposed
**Created:** 2026-10-04T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-052
slug: capture-changefeed-daily-review
title: Quick Capture, What Changed, and Daily Review
status: Backlog
created: 2026-10-04
priority: Medium
---

# FX-BF-052: Quick Capture, What Changed, and Daily Review

## Outcome

Praxis gains three lightweight, always-available planning surfaces:

1. **Quick capture** — jot a task from anywhere in the app without leaving the current context.
2. **What changed?** — a summarized view of recent project updates (tickets, plans, sessions, git).
3. **Daily review** — a short, focused surface that surfaces overdue and blocked work.

Together these close the loop between capturing intent, understanding project motion, and acting on stalled work — the highest-frequency daily interactions that currently have no first-class UI.

## Why

1. Capture friction: ideas arrive while looking at a diff, board, or session; forcing navigation to a board drops context and the thought.
2. Change blindness: with plans, sessions, git, and tickets all moving, there is no single "what happened since I last looked" summary.
3. Stalled work hides: overdue and blocked tickets sit quietly on the board instead of being surfaced in a deliberate daily moment.

## Story map

- [FX-BE-158: Quick capture box](stories/fx-be-158-quick-capture-box/story.md)
- [FX-BE-159: What changed view](stories/fx-be-159-what-changed-view/story.md)
- [FX-BE-160: Lightweight daily review](stories/fx-be-160-lightweight-daily-review/story.md)

## Non-goals

1. No AI summarization requirements in v1 (deterministic summaries first; AI polish is a follow-up).
2. No notifications/scheduling; the daily review is opened deliberately.
3. No cross-project aggregation; scoped to the active project in v1.

## Dependencies

Reuses the existing project/ticket data layer (folder-backed `docs/` tree and board store). No blocking dependencies on in-flight features.

## Close conditions

All three stories meet their acceptance criteria; the three surfaces are reachable within one interaction from anywhere; `npm run check-types` and existing desktop E2E pass with new coverage included.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |

## Description


## Comments


