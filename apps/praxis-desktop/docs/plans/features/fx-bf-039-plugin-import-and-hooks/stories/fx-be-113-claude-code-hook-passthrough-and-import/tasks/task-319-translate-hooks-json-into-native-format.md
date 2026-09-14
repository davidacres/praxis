---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-319
title: "Best-effort translate hooks.json into the native hook format"
status: Proposed
story: FX-BE-113
feature: FX-BF-039
updated: 2026-09-14
dependencies: [TASK-314, TASK-318, TASK-317]
---

# TASK-319: Best-effort translate hooks.json into the native hook format

## Objective

For a runtime host other than `claude-code-cli`, translate as much of a plugin's
`hooks.json` as maps cleanly onto the native `HookEvent`/`HookMatcher` contract
(TASK-314), and produce a clear, per-hook report — visible in TASK-317's hook
management view — of what didn't translate and why.

## Implementation notes

- Claude Code's own hook events (`PreToolUse`, `PostToolUse`, `Stop`,
  `UserPromptSubmit`, etc., confirmed against `hookify`'s `hooks.json` during
  scoping) map reasonably onto native events (before/after tool call, session
  end, session start) — build an explicit mapping table, not a heuristic guess,
  so every unmapped Claude-Code-specific event is a deliberate, visible omission.
  A matcher that only makes sense against Claude Code's own tool-name vocabulary is
  reported as Claude-Code-only, never force-mapped onto Praxis's tool taxonomy
  where it would only superficially resemble the original condition.
- The report lands directly in TASK-317's management view, in the same row a
  working hook would occupy — "this hook only works under Claude Code" needs to be
  something a user sees before they bind the plugin to a Codex or Copilot session
  and wonder why nothing happened, not something buried in a log.
- A hook matcher's script itself (Python/shell in the observed examples) is not
  reinterpreted line-by-line — only the *matcher* (event + condition) translates;
  the *action* still runs as a sandboxed script under the native engine's own
  action execution (TASK-315), gated the same way.

## Acceptance criteria

- Every `hooks.json` event type has an explicit mapped-or-flagged-unsupported
  outcome — no silent drops.
- The translation report is visible in the hook management view at install time,
  not only in a log file.
- A translated hook's action still runs under the native engine's own sandbox, not
  a bespoke execution path.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:core` for the translation-table tests (using `hookify`'s real
`hooks.json` as the primary fixture) and `npm run check-types` across workspaces.

## Description


## Dependencies



## Comments
