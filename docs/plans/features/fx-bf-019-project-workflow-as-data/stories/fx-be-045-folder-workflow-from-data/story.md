---
type: Story
id: FX-BE-045
title: Folder boards read their workflow instead of declaring it
status: proposed
feature: FX-BF-019
updated: 2026-09-06
commits: []
dependencies: [FX-BE-044]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# Folder boards read their workflow instead of declaring it

## Why

`FolderService` is the only backend whose columns no human can define. Jira's
come from the Jira board a human configured; GitHub's from the `status: …`
labels a human created. Folder's are a TypeScript constant.

## Scope

- `BoardConfigFile` gains `workflow?: ProjectWorkflowStage[]`. This is the
  right home by that file's own charter — it exists "so a board's identity
  travels with its folder instead of living only in the app's `settings.json`",
  and a workflow is board identity.
- `FolderService` drops the `STATUSES` constant. It resolves its workflow as:
  `board.praxis.json` → the folder-backed project's record → `DEFAULT_WORKFLOW`.
- Columns are built through the shared `buildBoardColumns(issues, {
  columnStatusOrder, rankStatus })` rather than a bespoke loop, with
  `rankStatus` reading the stage category — the same path Jira already uses.
- `getFilterMetadata` and `getTransitions` derive from the resolved workflow.
- `syncBoardConfigToFolder()` writes the workflow, so setting it in the app
  persists it beside the plans.

## The non-regression gate

**A folder with no declared workflow must behave byte-identically to today.**
The resolution chain ends at `DEFAULT_WORKFLOW`, which is the current five in
the current order. Run `folder.spec.ts`, `folderMulti.spec.ts`,
`editIssue.spec.ts` and `newIssue.spec.ts` before and after; the pass count
must be unchanged.

## Acceptance criteria

- A plans root with no `board.praxis.json` renders exactly today's five columns.
- A plans root whose `board.praxis.json` declares a workflow renders those
  columns instead, and a plan doc whose status names one of them lands there.
- Transitions offered on a ticket are the declared workflow's stages.

## Validation

- `npm run check-types`
- `npm run test:core`
- `npm run test:desktop` — the four folder specs above, plus a new case for a
  declared workflow.
