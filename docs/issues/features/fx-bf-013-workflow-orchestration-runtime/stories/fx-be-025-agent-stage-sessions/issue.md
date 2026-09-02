# FX-BE-025 — Agent stage sessions and completion

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-020, FX-BE-024

## Business or operational impact
An agent stage must run a real, preflighted, attributed session and feed its
result back into the run as typed artifacts and a snapshot.

## Scope
- `WorkflowSessionPort` over the existing agent hosts.
- Completion wiring: session terminal state → artifacts + snapshot commit →
  orchestrator command.
- `workflowRunId` / `workflowNodeId` on `AgentSessionRecord`, shown in the
  Sessions view.

## Acceptance criteria
- Preflight runs before any host call; a failing binding never opens a session.
- A completed stage records its declared artifacts; a stage that produced none
  of its required artifacts fails whatever the agent reported.
- Cancelling a run cancels its in-flight stage sessions.
- A stage session is visible in the Sessions view labelled with its run and node.

## Validation
- `npm run build`
- `npm run test:core`
- `npm run test:desktop`

## Close when
An agent stage in the built-in template runs as a real session and its diff and
report reach the downstream gates.
