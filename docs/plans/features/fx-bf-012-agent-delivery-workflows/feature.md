---
**Status:** 📋 Proposed
**Created:** 2026-09-01T19:20:12.656Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-012
slug: agent-delivery-workflows
title: Governed agent delivery workflows
status: proposed
owner: Electron desktop app
updated: 2026-09-01
issues: docs/issues/features/fx-bf-012-agent-delivery-workflows/feature-issues.md
stories: [FX-BE-018, FX-BE-019, FX-BE-020, FX-BE-021, FX-BE-022]
validation: [npm run check-types, npm run build:core, npm run build:renderer, npm run test:core, npm run test:desktop]
---

# FX-BF-012: Governed agent delivery workflows

## Outcome

Users can compose and run repeatable software-delivery workflows that assign trusted agents to controlled stages, enforce coding, review, QA, and security gates, and preserve artifacts and audit evidence.

## Scope

- Versioned workflow definitions and policy profiles stored globally or per project.
- Durable, resumable orchestration of agent sessions, deterministic checks, approvals, and artifact handoffs.
- Project-level visual designer and live run monitor built on the Agent Hub registry.
- Built-in Plan → Implement → Review/QA/Security → Approval delivery template.

## Story map

- `FX-BE-018` — Workflow definition, policy, and validation contracts.
- `FX-BE-019` — Workflow execution, persistence, and recovery.
- `FX-BE-020` — Agent session stages, gates, artifacts, and approvals.
- `FX-BE-021` — Visual workflow designer and template library.
- `FX-BE-022` — Run monitor, delivery template, and end-to-end verification.

## Dependencies

- `FX-BF-009` — Agent Hub catalog and navigation must be complete first.
- `FX-BF-010` — Agent and skill creation/import must be complete first.
- `FX-BF-011` — Runtime lifecycle and session integration must be complete first.
- `FX-BF-005` — Project/sidebar navigation foundation.

## Close when

A user can select a project delivery template, run it against a task, observe every stage and artifact, recover it after restart, and reach approval only when policy-required gates pass.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


