# FX-BE-043 — Stage category as a first-class field

**Type:** Story  **Status:** Proposed  **Priority:** P1  **Depends on:** —

## Business or operational impact
`ProjectWorkflowStage` is `{ id, name }`. With no category there is no way to map a freeform status onto an arbitrary workflow — the single reason `FolderService` hard-codes five statuses rather than reading the project's. Every other status-aware part of the codebase already carries a category; the project's own workflow type is the outlier.

## Scope
- `category: 'todo' | 'indeterminate' | 'done'` on `ProjectWorkflowStage` — Jira's vocabulary, already used by `folderService.STATUSES` and `jiraShape.statusCategoryRank`, so no new concept enters the codebase.
- All four templates (software, product, research, experiment) declare categories.
- `projectStore` validation gains: at least one `todo`, exactly one terminal `done`.
- Category-less stored records repair on read — name synonym first, then position (first `todo`, last `done`, rest `indeterminate`) — rather than needing a one-shot migration script.

## Acceptance criteria
- Every shipped template's stages carry a category and each terminal stage is `done`.
- A `ProjectRecord` written before this story loads with sensible categories and is not rejected.
- A workflow with no `done` stage, or two, is refused at save with a named reason.

## Validation
- `npm run check-types`
- `npm run test:core`

## Close when
A workflow stage carries enough information for any backend to resolve a freeform status onto it.
