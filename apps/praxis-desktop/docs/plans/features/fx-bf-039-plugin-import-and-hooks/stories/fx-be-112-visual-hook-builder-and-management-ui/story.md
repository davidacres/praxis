---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Story
**Priority:** High
type: Story
id: FX-BE-112
title: "Visual hook builder and management UI"
status: Proposed
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-109, FX-BE-111]
---

# FX-BE-112: Visual hook builder and management UI

## Outcome

A Praxis user can create a native hook entirely through a visual builder — pick an
event, define a matcher, pick an action — with no JSON or scripting required, and
manage every active hook (native or imported) in one list with recent firing
history. This is the feature's clearest differentiator: neither Claude Code nor
Copilot offers any hook-authoring UI today; both require hand-writing `hooks.json`
and matcher scripts.

## Tasks

- **TASK-316 Build the visual hook builder** from FX-BE-109/TASK-311's design: the event/matcher/action authoring flow, writing out TASK-314's native hook contract.
- **TASK-317 Build the hook management view**: a list of every active hook (native, and imported/passthrough once FX-BE-113 lands), source, active host(s), last-fired time, drill-in firing history, and an immediate enable/disable toggle.

## Acceptance

A user builds a "before tool call, if the tool name contains delete, ask for
approval" hook using only the builder's three steps, with no field that requires
typing JSON or a script body, and sees it fire the next time a matching tool call
happens, in the management view's firing history. Disabling it from the list stops
it firing on the next matching event.

## Evidence

E2e coverage building a hook through all three builder steps, confirming it fires
correctly via TASK-315's engine, appears in the management view with a correct
firing-history entry, and stops firing once disabled.

## Description


## Dependencies



## Comments
