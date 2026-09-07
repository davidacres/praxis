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
