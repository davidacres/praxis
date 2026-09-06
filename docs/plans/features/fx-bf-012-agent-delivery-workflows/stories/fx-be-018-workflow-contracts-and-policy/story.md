---
**Status:** 📋 Proposed
**Created:** 2026-09-06T13:41:43.990Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-018
title: Workflow definition, policy, and validation contracts
status: complete
feature: FX-BF-012
issue: docs/issues/features/fx-bf-012-agent-delivery-workflows/stories/fx-be-018-workflow-contracts-and-policy/issue.md
updated: 2026-09-02
tasks: [TASK-092, TASK-093, TASK-094]
dependencies: [FX-BF-009, FX-BF-010, FX-BF-011]
validation: [npm run build:core, npm run test:core, npm run check-types]
---

# Workflow definition, policy, and validation contracts

## User or operational impact

Workflow authors have a stable, versioned contract that references Agent Hub identities without embedding executable manifests.

## Scope

- Define workflow nodes, typed edges, artifact contracts, policy profiles, and schema migration.
- Validate DAG structure, agent/skill references, permissions, joins, and required gates before save or run.
- Define global/project storage and explicit precedence without silent shadowing.

## Acceptance criteria

- Invalid cycles, dangling references, missing required inputs, and policy violations are rejected with actionable paths.
- Definitions reference trusted Agent Hub agent and skill IDs and preserve schema/version metadata.
- Project policies can require review, QA, security, and human approval; optional bypasses require an attributed reason.

## Task list

- `TASK-092` — Add workflow definition, node, edge, artifact, policy, and run-reference types.
- `TASK-093` — Implement workflow normalization, validation, and schema migration.
- `TASK-094` — Add global/project workflow and policy stores with explicit precedence.

## Close when

Core tests prove valid definitions round-trip and invalid or unsafe definitions fail closed.

## Description


## Dependencies



## Comments


