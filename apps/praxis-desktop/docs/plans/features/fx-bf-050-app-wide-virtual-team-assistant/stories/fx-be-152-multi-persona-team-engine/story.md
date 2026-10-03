---
**Status:** 📋 Proposed
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Story
**Priority:** High
id: FX-BE-152
type: Story
status: Backlog
created: 2026-10-03
owner: Electron desktop app
---

# Multi-persona team engine and assistant IPC

## Impact

The application gains a flexible, multi-persona AI backend capable of answering page-aware queries through specialized engineering lenses: Tech Lead, Software Engineer, QA Specialist, Security Engineer, and Product Researcher. The engine handles single turns, `@mentioned` persona routing, and coordinated multi-persona "Team Reviews" that evaluate user work from multiple perspectives.

## Scope

- Shared type definitions in `@praxis/core` for `AssistantPersona`, `AssistantRole`, `PageAssistantContext`, `AssistantMessage`, and `AssistantTurnResult`.
- System prompts tailored to each persona's domain:
  - **Tech Lead:** Architecture, trade-offs, scope breakdown, synthesis.
  - **Dev:** Implementation specifics, TypeScript idioms, refactoring, algorithms.
  - **QA:** Edge cases, missing inputs, boundary states, failure verification.
  - **Security:** OWASP risks, secret handling, permissions, injection, sanitization.
  - **Product:** User value, requirement clarity, acceptance criteria completeness.
- IPC handlers in the main process:
  - `assistant:turn`: Executes a prompt turn against an active persona or the lead orchestrator.
  - `assistant:teamReview`: Dispatches a sequential team pass (Dev → QA → Security → Lead summary), returning distinct persona turns.
- Page context serialization: A standard contract for bundling the current page state (board, ticket, workflow, diff) into the prompt context safely.

## Tasks

| Ref | Task | Status | Priority |
| --- | --- | --- | --- |
| TASK-401 | Assistant persona definitions and multi-agent system prompts in core | Backlog | High |
| TASK-402 | Page context protocol and assistant IPC handlers in main | Backlog | High |
| TASK-403 | Unit tests for persona dispatch, team review orchestration, and context serialization | Backlog | Medium |

## Dependencies

- `FX-BF-017` — AI session UX and workflow ticket integration.
- `FX-BF-044` — AI provider catalog and OpenAI-compatible endpoints.

## Description


## Comments


