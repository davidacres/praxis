---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-113
title: "Claude Code hook passthrough and best-effort import"
status: Proposed
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-108, FX-BE-111, FX-BE-112]
---

# FX-BE-113: Claude Code hook passthrough and best-effort import

## Outcome

An imported plugin's own `hooks/hooks.json` runs completely unmodified when the
session it's attached to is actually hosted by Claude Code CLI — Praxis does not
reinterpret it, it lets Claude Code's own hook engine run it natively. For every
other host, the same `hooks.json` is translated into the native hook format on a
best-effort basis, with anything that depends on Claude-Code-specific behavior
explicitly flagged as unsupported — visible in FX-BE-112's management view, not
silently skipped or misapplied.

## Tasks

- **TASK-318 Pass `hooks/hooks.json` straight through to Claude Code CLI** when and only when the bound runtime host is `claude-code-cli`, wiring it into the ACP host's own startup the same way the CLI would pick it up standalone.
- **TASK-319 Best-effort translate `hooks.json` matchers into the native hook format** for every other host, producing a per-hook report — surfaced in FX-BE-112's hook management view — of what translated cleanly versus what needs Claude Code specifically and why.

## Acceptance

Installing a plugin with hooks and binding it to a Claude-Code-hosted session runs
those hooks exactly as they would running Claude Code directly, with no Praxis
reinterpretation in the path. Binding the same plugin to a Codex- or Copilot-hosted
session runs whatever native-hook translation succeeded, and the hook management
view clearly lists any hook that only works under Claude Code and why — never a
hook that silently does nothing with no explanation.

## Evidence

An e2e test installing a real hook-bearing plugin (`hookify`, inspected during
scoping) against a Claude-Code-hosted session, proving its hooks fire via Claude
Code's own engine untouched, plus a translation-report test proving each of its
hooks is correctly classified as translated vs. Claude-Code-only and visible in the
management view accordingly.

## Description


## Dependencies



## Comments
