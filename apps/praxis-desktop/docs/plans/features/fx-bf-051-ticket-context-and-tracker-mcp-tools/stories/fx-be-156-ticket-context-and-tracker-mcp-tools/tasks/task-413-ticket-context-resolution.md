---
**Status:** Done
**Created:** 2026-10-03T18:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-413
type: Task
status: Done
created: 2026-10-03
priority: High
story: FX-BE-156
---

# Core rich ticket context and graph resolution

## Files and integration points

- `packages/core/src/ai/ticketContext.ts`
- `packages/core/src/ai/ticketContext.test.ts`
- `packages/core/src/index.ts`

## Scope

- Implement `resolveTicketContext(service: IssueTrackerService, issueKey: string, options?: ResolveTicketContextOptions): Promise<TicketContextResult>` in `@praxis/core`.
- Fetch the primary issue via `service.getIssue(issueKey)` including comments and attachments.
- Resolve the parent issue (if `issue.parentId` or `issue.parentKey` is set) to obtain the parent brief, requirements, and definition of done.
- Resolve sibling tasks belonging to the same parent using `service.getSubtasks(parentKey)` or board issue queries to establish scope boundaries.
- Resolve direct dependencies (`issue.dependsOn`) and linked issues (`issue.linkedIssues`), looking up their summary and status.
- Query available transitions via `service.getTransitions(issueKey)`.
- Format a clean markdown package containing structured sections: Active Ticket, Parent Context, Sibling Tasks & Scope Boundaries, Dependencies & Blockers, Available Workflow Transitions, and AI Execution Directives.
- Ensure strict backwards compatibility with existing E2E prompt tests (`- Key: ${issue.key}`, `- Summary: ${issue.summary}`, `- Type: ${issue.issueType}`, `- Status: ${issue.status}`).

## Comments

### 2026-10-03 - Completed and Verified
- **Commit:** `aef97143`
- Implemented `packages/core/src/ai/ticketContext.ts`.
- Added unit tests in `packages/core/src/ai/ticketContext.test.ts` testing parent brief resolution, sibling task demarcation, dependency mapping, comments rendering, and read-only directives.
- All unit tests pass cleanly.
