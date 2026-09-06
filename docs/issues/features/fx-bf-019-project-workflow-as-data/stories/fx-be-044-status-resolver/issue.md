# FX-BE-044 — Resolve a freeform status against a declared workflow

**Type:** Story  **Status:** Proposed  **Priority:** P1  **Depends on:** FX-BE-043

## Business or operational impact
`mapMarkdownStatusToPlanStatus` hard-codes both halves of its job: the synonym table *and* the five names it may return. The synonym table is worth keeping — plan docs are prose written by people and agents. The fixed target set is what stops a folder board having the workflow its project declares.

## Scope
- `resolveStatus(raw, stages)` replaces it, resolving in four tiers: exact stage name (case/emoji tolerant) → synonym table mapping to a **category** → first stage of that category → first stage.
- `DEFAULT_WORKFLOW` exported from core: today's five, in today's order, with today's categories, so a caller with no declared workflow is unchanged.
- `markdownPlanParser` takes the workflow from its caller, defaulting to `DEFAULT_WORKFLOW`.

## Acceptance criteria
- Against `DEFAULT_WORKFLOW` every input the current mapper handles resolves identically — proven by porting its cases verbatim.
- Against a `software` workflow: `Architecture` → Architecture; `✅ Complete` → Done; `🚧 In progress` → Implementation (first `indeterminate`).
- An unrecognised status resolves to the first stage — never `undefined`, never dropped.

## Validation
- `npm run check-types`
- `npm run test:core` (`statusResolver.test.ts`)

## Close when
A freeform markdown status resolves correctly onto any declared workflow, and identically to today onto the default one.
