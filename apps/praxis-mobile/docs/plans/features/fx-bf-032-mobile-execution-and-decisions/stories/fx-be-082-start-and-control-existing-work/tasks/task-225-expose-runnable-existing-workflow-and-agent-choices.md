---
type: Task
id: TASK-225
title: "Expose runnable existing workflow and agent choices"
status: planned
story: FX-BE-082
updated: 2026-09-09
dependencies: [FX-BE-081]
---

# TASK-225: Expose runnable existing workflow and agent choices

**Priority:** High
**Created:** 2026-09-09

## Goal

Return read-only project-scoped configured agents/workflows with capabilities and readiness reasons. Select an existing issue or enter a free-form task; use host-owned context and credentials. Freeze workflow definition/version for the run.

## Implementation entry points

Mobile Work start form; host execution services and existing agent/workflow catalog. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Untrusted/unconfigured agents and invalid workflows cannot start; no workflow template instantiation or editing is required on mobile. Folder, GitHub and other backends retain their actual capability limits.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-081

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.
