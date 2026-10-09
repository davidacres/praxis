---
**Status:** ✅ Complete
**Type:** Task
type: Task
id: TASK-437
title: "Add the iterative SDLC loop template with BDD and four review stages"
status: Done
story: FX-BE-168
updated: 2026-09-10
dependencies: [TASK-249]
---

# TASK-437: Add the iterative SDLC loop template with BDD and four review stages

**Priority:** Medium
**Created:** 2026-09-10

## Goal

A `full-sdlc-loop` template family: plan → author BDD scenarios → implement → parallel (lint ∥ typecheck ∥ unit tests ∥ BDD run ∥ SAST ∥ secrets ∥ SCA ∥ code review ∥ test review ∥ security review ∥ advisory UX review) → gates → approve → optional deploy, iterating on any failing stage.

## Implementation entry points

packages/core/src/workflows/sdlcLoopTemplates.ts, packages/core/src/workflows/workflowTemplates.ts (marketplace registration), renderer/src/workflows/workflowTemplateGuidance.ts (library copy), core test script.

## Dependencies

- TASK-249
## Acceptance criteria

- Every variant passes `validateWorkflow`; all four share an identical DAG and differ only in commands.
- BDD scenarios artifact flows into implement, the BDD run check (JUnit adapter), and the test review.
- Gate ownership: qa = lint/typecheck/unit-test/bdd-run; security = sast/secrets/sca/security-review; review = code review + test review; ux-review satisfies no gate.
- Review stages require a findings artifact; prose alone fails the node.
- A high-or-worse finding from any reviewer holds the run at approval; a clean run's gates all pass; coverage below 80% fails the QA threshold.
- Failed stages are retryable within their own `maxAttempts` budgets.

## Verification

New `sdlcLoopTemplates.test.ts` (9 tests) covering validation, DAG shape, gate ownership, findings contract, retry budgets, threshold behavior, instantiation, and cross-variant structural equivalence. Full core suite: 1146 tests passing. Renderer typecheck clean. Never point a Praxis write path at the repository's own plans.

## Description


## Comments

Completed implementation:
- `sdlcLoopTemplates.ts` with `sdlcLoopTemplate(variant)` and `sdlcLoopMarketplaceTemplates()`, registered into `fullSdlcMarketplaceTemplates()`.
- Updated the template-library composition test to expect the four new marketplace entries.
- Added renderer template guidance for all four variants.
- Wired `out/workflows/sdlcLoopTemplates.test.js` into the core test script.
