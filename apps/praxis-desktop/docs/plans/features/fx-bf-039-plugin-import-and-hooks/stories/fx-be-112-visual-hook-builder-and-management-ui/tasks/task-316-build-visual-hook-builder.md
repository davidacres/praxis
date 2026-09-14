---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-316
title: "Build the visual hook builder"
status: Proposed
story: FX-BE-112
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-112, TASK-311, TASK-314]
---

# TASK-316: Build the visual hook builder

## Objective

Implement FX-BE-109/TASK-311's three-step design — event, matcher, action — as a
working builder that writes out TASK-314's native `HookEvent`/`HookMatcher`/
`HookAction` records, with no JSON or scripting required for the common case.

## Implementation notes

- Every step reads in plain language per the signed-off design — this is the task
  most at risk of quietly regressing into "a form with JSON-shaped fields." Hold the
  line: a matcher condition is composed from a small set of named, typed inputs
  (event field + comparator + value), not a free-text expression box.
  An action that genuinely needs a script (the sandboxed-script action) still needs
  script input somewhere, but it is the exception inside one step, not the whole
  builder's baseline interaction.
- Save-as-you-go or an explicit multi-step wizard — either is fine — but the builder
  must let a user go back and change an earlier step without restarting; this is a
  common real editing flow, not an edge case.
- The built hook is trust-gated exactly like an imported one before its action can
  fire — see FX-BE-114 — the builder does not grant an implicit pass because the
  user authored it themselves. A locally-authored script action still needs to be
  approved, since it is still code that will execute.

## Acceptance criteria

- A hook expressible in FX-BE-109's design review is buildable end-to-end through
  the UI with zero JSON/script input, except the sandboxed-script action itself.
- Editing an earlier step of an in-progress hook works without restarting.
- A newly built hook goes through the same trust gate as an imported one before it
  can fire.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:desktop` for the builder e2e journey (build → save → fire) and
`npm run check-types` across workspaces.

## Description


## Dependencies



## Comments
