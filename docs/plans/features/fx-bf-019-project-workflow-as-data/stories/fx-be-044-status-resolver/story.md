---
type: Story
id: FX-BE-044
title: Resolve a freeform status against a declared workflow
status: complete
feature: FX-BF-019
updated: 2026-09-06
commits: []
dependencies: [FX-BE-043]
validation: [npm run check-types, npm run test:core]
---

# Resolve a freeform status against a declared workflow

## Why

`mapMarkdownStatusToPlanStatus` hard-codes both halves of its job: the synonym
table *and* the five names it is allowed to return. Those are separate
concerns. The synonym table is real and worth keeping — plan docs are written
in prose by people and agents. The fixed target set is what blocks a folder
board from having the workflow its project declares.

## Scope

- New `resolveStatus(raw: string, stages: ProjectWorkflowStage[]): string` in
  core, replacing `mapMarkdownStatusToPlanStatus`. Resolution order:
  1. exact stage-name match, case-insensitive and punctuation/emoji tolerant;
  2. the existing synonym table, mapping to a **category** rather than a name
     (`complete|done|✅` → `done`, `block` → `indeterminate`,
     `progress|doing|wip|🔄` → `indeterminate`,
     `to do|todo|pending|planned|proposed|backlog` → `todo`);
  3. the first stage of the resolved category;
  4. the first stage overall.
- `DEFAULT_WORKFLOW` exported from core: today's exact five, in today's order,
  with today's categories — so a caller with no declared workflow behaves
  identically to today.
- `markdownPlanParser` calls `resolveStatus(raw, stages)`, taking the workflow
  from its caller and defaulting to `DEFAULT_WORKFLOW`.

## Acceptance criteria

- Against `DEFAULT_WORKFLOW`, every input the current mapper handles resolves
  to the same output — proven by porting its existing cases verbatim.
- Against a `software` workflow, a doc whose status reads `Architecture`
  resolves to the Architecture stage; one reading `✅ Complete` resolves to
  `Done`; one reading `🚧 In progress` resolves to `Implementation` (the first
  `indeterminate` stage).
- An unrecognised status resolves to the first stage, never to `undefined` and
  never dropped.

## Validation

- `npm run check-types`
- `npm run test:core` — a `statusResolver.test.ts` covering the four resolution
  tiers plus the ported legacy cases.
