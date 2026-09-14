---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-318
title: "Pass hooks.json straight through to Claude Code CLI"
status: Proposed
story: FX-BE-113
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-113, TASK-308]
---

# TASK-318: Pass hooks.json straight through to Claude Code CLI

## Objective

When a session's bound runtime host is `claude-code-cli`, hand an installed
plugin's `hooks/hooks.json` (and its matcher scripts) to that CLI's own hook
mechanism unmodified, rather than routing it through Praxis's native hook engine.

## Implementation notes

- Locate the exact working-directory/config convention Claude Code CLI expects for
  plugin-provided hooks and reproduce it for the ACP-hosted session's own working
  directory, rather than inventing a Praxis-side reimplementation of Claude Code's
  hook loader.
- Scope this to sessions whose host is genuinely `claude-code-cli` — a session
  bound to any other host must never see this plugin's `hooks.json` treated as
  passthrough; it falls to TASK-319's translation instead.
- The plugin's hook scripts still go through the same trust gate as any other
  installed plugin content (FX-BE-114) before Praxis will place them where Claude
  Code CLI can execute them — passthrough is about *where hooks run*, not *whether
  they're trusted*.

## Acceptance criteria

- A Claude-Code-hosted session with a hook-bearing plugin installed exercises those
  hooks exactly as a standalone Claude Code CLI session would.
- No other host ever receives this plugin's raw `hooks.json` as passthrough.
- Passthrough hooks are still gated by the same install-time trust decision as
  everything else from the plugin.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:desktop` for the passthrough e2e journey and `npm run check-types`
across workspaces.

## Description


## Dependencies



## Comments
