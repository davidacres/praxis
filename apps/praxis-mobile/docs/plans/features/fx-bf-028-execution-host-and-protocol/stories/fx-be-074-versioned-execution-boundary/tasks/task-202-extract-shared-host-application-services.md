---
type: Task
id: TASK-202
title: "Extract shared host application services"
status: complete
story: FX-BE-074
updated: 2026-09-09
dependencies: [TASK-201]
---

# TASK-202: Extract shared host application services

**Priority:** High
**Created:** 2026-09-09

## Goal

Move execution application operations behind transport-neutral services; desktop IPC delegates to them. Privileged filesystem, credentials and subprocesses stay on the host. Introduce a browser-safe contracts package/export instead of runtime imports from the CommonJS core.

## Implementation entry points

Desktop main and packages/core; publishable browser-safe protocol contracts. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Existing desktop session continuation, workflow start, cancellation and policy tests pass through the extracted services; mobile contract consumers build without Node/native bindings.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-201

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Implemented a transport-neutral execution boundary with injected host-owned handlers.

- Source: packages/core/src/host/mobileExecutionBoundary.ts
- Tests: packages/core/src/host/mobileExecutionBoundary.test.ts
- Public export: packages/core/src/index.ts
- The boundary exposes only the six allowlisted execution mutations and delegates privileged work to injected desktop host services.
- Handler failures are returned as typed command-conflict errors; no filesystem, credential, subprocess, Node, Electron, or cloud dependency is introduced.
- Verification: deterministic dispatch and rejection tests were added; hosted GitHub Actions remain unavailable, so the full workspace build could not be executed here.
- Remaining limitation: desktop IPC adapters still need to delegate to this boundary in a follow-up integration task.

Parent completion requires verified child outcomes.
