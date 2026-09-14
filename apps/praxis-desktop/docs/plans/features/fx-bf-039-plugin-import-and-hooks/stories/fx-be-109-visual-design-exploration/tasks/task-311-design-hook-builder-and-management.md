---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-311
title: "Design the visual hook builder and hook management surfaces"
status: Proposed
story: FX-BE-109
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-109]
---

# TASK-311: Design the visual hook builder and hook management surfaces

## Objective

Produce a reviewable visual design for building a native hook without writing JSON
or a script (event → matcher → action), and for a management view listing every
active hook with its recent firing history.

## Implementation notes

- Structure the builder as three plain steps a non-engineer can follow: pick an
  event (session start/end, before/after tool call, stage/session failure), define
  a matcher (a small set of composable conditions, not a free-text expression
  field), pick an action (sandboxed script, log-to-session, allow/deny a pending
  permission). Every step should read in plain language — "When a tool is about to
  run and its name contains 'delete', ask for approval" — not as configuration keys.
  This is the feature's actual differentiator; do not let it default to a JSON
  textarea with a nicer border.
- Validate the design against `hookify`'s real `hooks.json` (inspected during
  scoping): its `PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit` hooks should
  each be expressible, or the design should make clear which of the three steps
  can't represent that hook and why — this is the same design question FX-BE-113's
  translation task will need answered.
- The management view needs to show, per hook: source (native, or imported from
  which plugin), which host(s) it's active under, last-fired time, and a way to
  drill into recent firing history (matched event payload, action result). Native
  and passthrough/imported hooks share one list — do not split them into separate
  views the user has to remember to check both of.
- Disabling a hook must be immediate and obvious (a toggle on the list row, not
  buried in an edit dialog).

## Acceptance criteria

- Mocked states: empty hook list, the three-step builder mid-flow, a populated
  management list, and a firing-history entry expanded.
- At least one real `hookify` hook is walked through the builder's three steps in
  the design review, with an explicit note if any step can't fully represent it.
- Reviewed and signed off before FX-BE-112 begins implementation against it.
- Relevant documentation and plan references are updated.

## Verification

Design review against Praxis's light/dark/surface-pack theme matrix, same bar as
TASK-310.

## Description


## Dependencies



## Comments
