# Task Designer Master Plan

**Status:** Proposed
**Type:** Master Plan
**Priority:** P2
**Dependencies:** None
**Complexity:** Low
**Risk:** Low
**Confidence:** High

## Description
Master planning index for feature-level artifacts under plans/features, maintained to provide a deterministic execution overview across multiple planned initiatives.

## Goals
1. Execute planned tickets in deterministic topological order.
2. Keep graph dependencies explicit and reviewable in markdown.
3. Persist a local master plan artifact under plans/.

## Non-Goals
1. Does not execute or mutate tickets automatically.
2. Does not infer extra dependencies beyond directed links.
3. Does not modify manually-authored plan files outside generated artifacts.

## Phase Overview
1. **Phase 1 — KAMAI-4:** Modern Example Admin App
2. **Phase 2 — Feature 06:** Analysis Window Gate Before AI Assignment

## Dependencies
1. No explicit directed dependencies are currently defined.

## Verification
1. Generate the master plan artifact from Task Designer and confirm the metadata block includes status, type, priority, dependencies, complexity, risk, and confidence.
2. Verify each dependency row maps to an explicit connector in the graph.
3. Re-generate without changing the graph and confirm the file content is unchanged.
4. Run `npm run check-types`.

## Praxis execution and delivery roadmap

The historical Task Designer phases above remain unchanged. The new project execution initiative is indexed in [the delivery/debugging roadmap](../delivery-debugging-roadmap.md) and [Plan Map](../PLAN_MAP.md).

Recommended order: FX-BF-021 diagnosis → FX-BF-022 previews → FX-BF-023 deployment foundation → FX-BF-024 pipeline deployment → FX-BF-025 IIS → FX-BF-026 interactive/agent debugging. FX-BF-027 is deferred. Hard prerequisites and permitted parallel implementation are recorded in each item's Dependencies section and the roadmap; this recommendation is priority order, not an extra inferred dependency.


## Praxis Mobile companion

The mobile initiative has its own folder-backed PRAXISMOBILE project at [apps/praxis-mobile](../../apps/praxis-mobile/README.md). Its canonical [Plan Map](../apps/praxis-mobile/docs/PLAN_MAP.md) and [master plan](../apps/praxis-mobile/docs/plans/master-plan.md) contain 6 features, 13 stories and 36 tasks: FX-BF-028–033, FX-BE-074–086, TASK-201–236. Local work is planned first; cloud integration is deferred.

The root desktop board is unchanged. Add the mobile folder as a separate project to see its work. No dependency on the deferred shared-executor or deployment/debugging roadmap is implied.

## Local-first priority (2026-09-09)

GenericSystem and Roleover are not running. Deliver account-free LAN pairing, mobile continuation, workflow execution, decisions and a usable local release before cloud integration. No local completion gate requires these services or Azure. Keep internet features unavailable until the real integration is verified; use fixtures only for development. FX-BF-030 is deferred, including optional notifications moved to FX-BE-086. See the mobile master plan for the revised order.


## Multi-AI session orchestration

The multi-provider execution initiative is indexed in the [multi-AI orchestration roadmap](../multi-ai-session-orchestration-roadmap.md) and [Plan Map](../PLAN_MAP.md). It is delivered after the existing agent runtime and governed workflow foundations: FX-BE-092 → FX-BE-093/094 → FX-BE-095 → FX-BE-096. Provider capability discovery and local fixture workflows are required before any unattended real-provider execution is treated as supported.
