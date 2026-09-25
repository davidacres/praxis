---
id: FX-BE-124
title: Agent Hub host execution for interactive and stage sessions
status: Done
feature: FX-BF-040
issue: docs/issues/features/fx-bf-040-connected-agent-workflow-sessions/stories/fx-be-124-agent-hub-host-execution/issue.md
updated: 2026-09-25
tasks: [TASK-338, TASK-339, TASK-340]
dependencies: [FX-BF-011, FX-BF-013, FX-BF-038]
validation: [npm run check-types, npm run build:core, npm run build:desktop, npm run test:core, npm run test:desktop]
---

# Agent Hub host execution for interactive and stage sessions

Parent feature folder: `fx-bf-040-connected-agent-workflow-sessions`

## User or operational impact

Choosing an Agent Hub agent changes the executable session transport, not just
the prompt attribution. The host, provider, profile, skills, tool mode, and
capability decisions shown to the user match what actually ran.

## Scope

- Implement the runtime-host adapter boundary behind the existing
  `AgentBinding` and `WorkflowSessionPort` contracts.
- Use one launch compiler for New Session, workflow stages, and recovery.
- Enforce scope, trust, fingerprint, capability, sandbox, working-directory,
  and tool-mode constraints before launch.

## Acceptance criteria

- A selected trusted ACP host receives the session through its declared entry
  point and protocol; the configured provider is used only where the host
  adapter declares that provider integration.
- Interactive and workflow stage sessions share the same binding and launch
  path, with no provider-only fallback that silently ignores the selected
  host.
- An unavailable, untrusted, wrong-scope, incompatible, or scaffold-only host
  fails closed with a useful readiness reason.
- Session records distinguish selected binding metadata from actual runtime
  adapter/transport and retain launch diagnostics without secrets.

## Task list

- `TASK-338` — Define and implement the runtime-host adapter launch contract.
- `TASK-339` — Route interactive delegation and workflow stages through one launch compiler.
- `TASK-340` — Enforce host scope, trust, capability, sandbox, and tool-mode preflight.

## Validation

- Core adapter/preflight tests with deterministic stub hosts.
- Desktop E2E with a real local ACP fixture proving the declared host command
  was launched and received the task.

## Close when

The selected Agent Hub host is the actual transport for both a normal session
and a workflow stage, and the app proves that fact in tests and session audit.

## Review 2026-09-25 — status corrected from Planned to Done

Found shipped in the codebase during the board review; the ticket was left stale
at Planned (updated 2026-09-17).

- The Electron main host runs both interactive and governed stage sessions
  through the `@praxis/core` workflow runtime, with start/stop/restart lifecycle
  controls surfaced by the runtime dashboard.
- Session records capture host transport in audit data and return it to the
  renderer, matching the acceptance criteria here.

Status set to Done as part of the 2026-09-25 board review. Re-confirm with
`npm run check-types`, `npm run build:core`, `npm run build:desktop`,
`npm run test:core` and `npm run test:desktop` before release. Task files
TASK-338 to TASK-340 were not re-verified individually.
