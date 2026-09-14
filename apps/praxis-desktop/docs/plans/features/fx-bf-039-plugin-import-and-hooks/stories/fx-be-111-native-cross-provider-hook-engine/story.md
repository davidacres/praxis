---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Story
**Priority:** High
type: Story
id: FX-BE-111
title: "Native cross-provider hook engine"
status: Proposed
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BF-038]
---

# FX-BE-111: Native cross-provider hook engine

## Outcome

Praxis has its own lifecycle hook concept — independent of Claude Code's, Copilot's,
or any single provider's — that fires the same way whether a session is bound to
Claude Code, Codex, Copilot, or a direct API provider. This is new capability, not
present anywhere in Praxis today, and it's the backend the visual hook builder
(FX-BE-112) authors against and the passthrough/import story (FX-BE-113) targets for
non-Claude-Code hosts.

## Tasks

- **TASK-314 Define the native hook contract**: event types (session start/end, before/after tool call, stage/session failure at minimum), a matcher shape, and an action shape — independent of any provider's own hook vocabulary, and expressive enough to represent what FX-BE-109's design validated against a real imported hook.
- **TASK-315 Execute native hooks against the session/workflow pipeline** for every runtime host, sandboxed and permissioned the same way a local tool call already is — never a wider trust boundary than the session itself already has.

## Acceptance

A native hook bound to "before tool call" fires identically for a Claude-Code-hosted,
Codex-hosted, Copilot-hosted, and direct-API session, with the same event payload
shape regardless of host. A hook that matches nothing never fires. A failing hook
script reports its failure into the session's own event log rather than crashing the
session or the host process.

## Evidence

Deterministic tests against a stub host proving identical hook firing/payload shape
across all four provider categories, plus an e2e test exercising a real hook action
(a simple deny-and-log rule) mid-session.

## Description


## Dependencies



## Comments
