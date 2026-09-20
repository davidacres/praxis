---
**Status:** 📋 Proposed
**Type:** Feature
type: Feature
id: FX-BF-034
title: "Full SDLC quality and security gates"
status: planned
slug: sdlc-quality-and-security-gates
stories: [FX-BE-087, FX-BE-088, FX-BE-089, FX-BE-090, FX-BE-091]
updated: 2026-09-09
dependencies: [FX-BE-020, FX-BE-024, FX-BE-033]
---

# FX-BF-034: Full SDLC quality and security gates

**Priority:** High
**Created:** 2026-09-09

## Outcome

Raise the governed delivery workflow to a real quality and security bar: structured check results feeding metric and severity threshold gates, bundled secret / SAST / SCA / license scanners behind the security gate, a code review that returns structured findings and delivers them inline, out-of-the-box agents and a language-agnostic Full SDLC template, and ingestion of CI security and quality reports as observe-mode gate evidence. Extends the existing workflow engine, gate model, evidence store and strictest-wins policy — no second pipeline.

## Delivery priority

Committed planning scope; implementation remains Planned. Follow the dependency graph and the [SDLC quality gates roadmap](/docs/sdlc-quality-gates-roadmap.md) recommended delivery order.

## Dependencies

- FX-BE-020
- FX-BE-024
- FX-BE-033
## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-087](stories/fx-be-087-structured-check-results-and-threshold-gates/story.md) | Structured check results and metric/severity threshold gates |
| 2 | [FX-BE-088](stories/fx-be-088-bundled-security-scanners/story.md) | Bundled secret / SAST / SCA / license scanners behind the security gate |
| 3 | [FX-BE-089](stories/fx-be-089-structured-code-review-and-inline-delivery/story.md) | Structured code review with inline delivery and a bounded fix loop |
| 4 | [FX-BE-090](stories/fx-be-090-bundled-agents-and-full-sdlc-template/story.md) | Bundled trusted agents and a language-agnostic Full SDLC template |
| 5 | [FX-BE-091](stories/fx-be-091-ingest-ci-security-and-quality-reports/story.md) | Ingest CI security and quality reports as observe-mode gate evidence |

## Implementation boundaries

Shared domain logic belongs in core (`packages/core/src/workflows`, `packages/core/src/ai`); Electron main owns processes, filesystem, credentials and privileged IPC. Renderer imports core types only. Reuse the current workflow engine, gate kinds, evidence store, `redactEvidenceContent`, Agent Hub trust model and themed in-app dialogs. Scanners are bundled check presets — code chosen by detected stack — not connection modes and not catalogue data. Structured results are a single closed artifact kind (`findings`); nothing downstream parses raw tool formats. Policy composition stays strictest-wins. Files created by the application follow `<name>.praxis.<ext>` with shared filename constants; plan documents retain this repository's established feature/story/task names.

## Close when

Every story and child task is implemented and verified; scanner adapters have real captured-output fixture evidence and any live-scan proof is documented and opt-in. The feature is a completion roll-up, not a prerequisite for its own children. Planned dependencies are prerequisites to start; containment is recorded through feature/story metadata.

## Verification

Review the complete feature journey: a Full SDLC run on a Node and a .NET fixture, a seeded high-severity finding blocking approval, an expiring waiver clearing it on the event log, a structured review posting inline and re-driving implementation, and an imported CI code-scanning result satisfying a security gate for the matching SHA. Follow AGENTS.md for core boundaries, source schema inspection, UI verification and temporary fixtures. Do not claim production support from mocked tool output alone. Run the read-only `parsePlanFolder` over baseline and final plans for this planning change.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments
