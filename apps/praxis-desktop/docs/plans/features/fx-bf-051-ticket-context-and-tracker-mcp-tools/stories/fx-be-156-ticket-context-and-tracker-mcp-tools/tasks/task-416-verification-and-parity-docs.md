---
**Status:** Done
**Created:** 2026-10-03T18:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-416
type: Task
status: Done
created: 2026-10-03
priority: Medium
story: FX-BE-156
---

# Verification, tests, and AGENTS.md documentation

## Files and integration points

- `packages/core/package.json`
- `packages/core/src/ai/AGENTS.md`
- `apps/praxis-desktop/docs/desktop-feature-parity.md`

## Scope

- Register new test suites (`ticketContext.test.ts`, `trackerMcpServer.test.ts`) in `packages/core/package.json`.
- Execute full monorepo typecheck via `npm run check-types` verifying no banned `@praxis/core` value imports in the renderer.
- Run `npm run test:core` verifying all 1,372 unit tests pass.
- Run Playwright E2E tests (`e2e/issueDetail.spec.ts`, `e2e/aiSessions.spec.ts`) confirming no UI or prompt regression.
- Document architectural patterns and operational guidelines in `packages/core/src/ai/AGENTS.md` under "Ticket context, dependencies, and tracker tools".
- Update `apps/praxis-desktop/docs/desktop-feature-parity.md` to reflect full ticket context injection and `praxis-tracker` loopback MCP tooling.

## Comments

### 2026-10-03 - Completed and Verified
- **Commit:** `aef97143`
- All unit and e2e tests executed and passed.
- `AGENTS.md` and feature parity documentation updated and committed.
