---
**Status:** Done
**Created:** 2026-10-03T18:00:00.000Z
**Type:** Feature
**Priority:** High
id: FX-BF-051
slug: ticket-context-and-tracker-mcp-tools
title: Rich Ticket Context and Universal Tracker MCP Tools for AI Sessions
status: Done
created: 2026-10-03
owner: Electron desktop app
---

# FX-BF-051: Rich Ticket Context and Universal Tracker MCP Tools for AI Sessions

## Description

When clicking "Start AI" on a ticket, Praxis automatically collects and passes the full ticket details, parent feature briefs, sibling task boundaries, dependencies, linked issues, and comments to the AI agent. Additionally, universal issue tracker tools are exposed to both ACP CLI agents and API Gateway agents via a local loopback MCP server (`praxis-tracker`), accompanied by strict lifecycle directives instructing the AI to acknowledge tasks, post milestone updates, and submit a completion summary with status transitions.

## Outcome

- AI agent sessions launched from tickets have complete awareness of what needs to be built, why, and how it fits into the surrounding plan hierarchy without manual copy-pasting.
- Sibling tasks are communicated with clear scope demarcations to avoid redundant or out-of-scope code changes.
- Direct dependencies (`dependsOn`) and blockers (`blocks`, `is blocked by`, `relates to`) are visible in the agent's initial prompt.
- The AI agent prompt includes explicit lifecycle directives: post an initial plan comment and transition to "In Progress", post milestone comments as work proceeds, and post a final completion summary before transitioning to "In Review" or "Done".
- Both CLI ACP agents (Claude Code, Codex, Copilot CLI) and API Gateway agents can read ticket details, list transitions, post comments, update ticket fields, and transition statuses.
- Flexible transition resolution matches target transitions by ID, action name, or destination status.

## Scope

- Core context resolution (`resolveTicketContext`) in `packages/core/src/ai/ticketContext.ts`.
- In-app loopback MCP server (`TrackerMcpServer`) in `packages/core/src/ai/trackerMcpServer.ts`.
- Desktop IPC wiring and session lifecycle binding in `apps/praxis-desktop/main/src/main/trackerMcp.ts`, `aiIpc.ts`, and `deleteAgentSession.ts`.
- Agent prompt integration in `packages/core/src/ai/agentPrompt.ts` with lifecycle directives.
- Comprehensive unit tests in `ticketContext.test.ts` and `trackerMcpServer.test.ts`.
- Playwright E2E and parity documentation updates in `apps/praxis-desktop/docs/desktop-feature-parity.md` and `packages/core/src/ai/AGENTS.md`.

## Story map

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-156 | Ticket context resolution, lifecycle directives, and tracker MCP server | Done | FX-BF-017, FX-BF-040 |

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-156 | Story | Ticket context resolution, lifecycle directives, and tracker MCP server | Done |
| TASK-413 | Task | Core rich ticket context and graph resolution | Done |
| TASK-414 | Task | Universal Tracker MCP Server and tool execution | Done |
| TASK-415 | Task | Agent prompt lifecycle directives and desktop IPC wiring | Done |
| TASK-416 | Task | Verification, tests, and AGENTS.md documentation | Done |

## Comments

### 2026-10-03 - Implementation & Verification Complete
- **Author:** Antigravity Agent
- **Status:** Shipped in commit `aef97143`.
- **Verification:**
  - `ticketContext.test.ts`: 100% pass (resolved main ticket fields, parent brief, sibling scope, dependencies, blockers, transitions, and comments).
  - `trackerMcpServer.test.ts`: 100% pass (tool definitions, fuzzy transition matching, tool call execution, read-only guardrails).
  - `npm run test:core`: All 1,372 tests passed.
  - `npm run check-types`: Clean across all monorepo packages.
  - Playwright e2e tests `e2e/issueDetail.spec.ts` and `e2e/aiSessions.spec.ts`: Passed.
  - Documentation updated in `packages/core/src/ai/AGENTS.md` and `apps/praxis-desktop/docs/desktop-feature-parity.md`.
