# FX-BE-045 — Folder boards read their workflow instead of declaring it

**Type:** Story  **Status:** Proposed  **Priority:** P1  **Depends on:** FX-BE-044

## Business or operational impact
`FolderService` is the only backend whose columns no human can define. Jira's come from the board a human configured, GitHub's from the `status: …` labels a human created; folder's are a TypeScript constant. A folder-backed project's declared workflow is silently ignored.

## Scope
- `BoardConfigFile` gains `workflow?: ProjectWorkflowStage[]` — the right home by that file's own charter ("a board's identity travels with its folder"), and a workflow is board identity.
- `FolderService` drops `STATUSES` and resolves: `board.praxis.json` → the folder-backed project's record → `DEFAULT_WORKFLOW`.
- Columns are built through the shared `buildBoardColumns(issues, { columnStatusOrder, rankStatus })` with `rankStatus` reading the stage category — the path Jira already uses — instead of a bespoke loop.
- `getFilterMetadata` and `getTransitions` derive from the resolved workflow; `syncBoardConfigToFolder()` persists it.

## Acceptance criteria
- A plans root with no `board.praxis.json` renders exactly today's five columns.
- A plans root declaring a workflow renders those columns, and a doc whose status names one lands there.
- Offered transitions are the declared workflow's stages.
- **Non-regression:** `folder.spec.ts`, `folderMulti.spec.ts`, `editIssue.spec.ts`, `newIssue.spec.ts` pass with an unchanged count before and after.

## Validation
- `npm run check-types`
- `npm run test:core`
- `npm run test:desktop`

## Close when
A folder board's columns come from its folder, and a folder that says nothing behaves exactly as it does today.
