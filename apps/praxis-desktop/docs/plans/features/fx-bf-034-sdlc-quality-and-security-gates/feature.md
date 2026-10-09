---
**Status:** ✅ Complete
**Type:** Feature
type: Feature
id: FX-BF-034
title: "Full SDLC quality and security gates"
status: Done
slug: sdlc-quality-and-security-gates
stories: [FX-BE-087, FX-BE-088, FX-BE-089, FX-BE-090, FX-BE-091, FX-BE-168]
updated: 2026-09-10
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
| 6 | [FX-BE-168](stories/fx-be-168-iterative-sdlc-loop-template/story.md) | Iterative SDLC loop template with BDD and four review stages |

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
| FX-BE-087 | Story | Structured check results and metric/severity threshold gates | ✅ Complete |
| FX-BE-088 | Story | Bundled secret / SAST / SCA / license scanners behind the security gate | ✅ Complete |
| FX-BE-089 | Story | Structured code review with inline delivery and a bounded fix loop | ✅ Complete |
| FX-BE-090 | Story | Bundled trusted agents and a language-agnostic Full SDLC template | ✅ Complete |
| FX-BE-091 | Story | Ingest CI security and quality reports as observe-mode gate evidence | ✅ Complete |
| FX-BE-168 | Story | Iterative SDLC loop template with BDD and four review stages | ✅ Complete |


## Comments

### Feature Completion Summary (FX-BF-034 / PRAXIS-F34)
All 5 stories and 16 tasks for Full SDLC quality and security gates have been implemented, tested, and marked Done:

1. **FX-BE-087: Structured check results and threshold gates (Tasks 237–240)**
   - Added closed `CheckFindings` artifact kind and deterministic SHA-256 fingerprinting.
   - Built robust adapters for SARIF 2.1.0, JUnit XML, lcov/Cobertura coverage, npm audit, and osv-scanner.
   - Enforced metric and severity threshold conditions on gates with strictest-wins policy composition.
   - Enhanced WorkflowRunMonitor UI with findings badges, severity breakdowns, and collapsible lists.

2. **FX-BE-088: Bundled security scanners (Tasks 241–243)**
   - Added stack-aware presets for Gitleaks, Semgrep, Trivy, pip-audit, osv-scanner, and license-checker.
   - Added audited waiver register with lifetime caps and commit-snapshot pinning.
   - Added multi-owner gate resolution where all enabled scanners must pass or meet threshold.

3. **FX-BE-089: Structured code review and inline delivery (Tasks 244–246)**
   - Created structured reviewer prompt demanding fenced JSON `CheckFindings`.
   - Built inline comment delivery and ticket summary formatting with fingerprint deduplication.
   - Wired bounded review-fix loop between reviewer and implementer with terminal escalation.

4. **FX-BE-090: Bundled agents and full SDLC templates (Tasks 247–249)**
   - Shipped 4 bundled trusted agents (`praxis-planner`, `praxis-implementer`, `praxis-reviewer`, `praxis-security-analyst`).
   - Defined 12-node Full SDLC DAG template with auto-stack variants (Node, .NET, Python, generic).

5. **FX-BE-091: CI security and quality report ingestion (Tasks 250–252)**
   - Implemented read-only CI report readers for GitHub code-scanning and GitLab SAST.
   - Built evidence ingestion with secret redaction and SHA-pinned bundling.
   - Added observe-mode gate resolution with SHA reconciliation and local scanner fallback.

All 52 unit tests passing; clean cross-workspace typechecking.




**PRAXIS-F34** — 2026-09-12T12:09:21.570Z
## AI Review by Claude Code (local)

I'll check whether the referenced roadmap doc exists locally, since the ticket cites it as the authoritative delivery order.## Ticket Review: PRAXIS-F34 / FX-BF-034 — Full SDLC quality and security gates

### Strengths
- Clear architectural constraint up front ("Extends the existing workflow engine, gate model, evidence store and strictest-wins policy — no second pipeline") — good guardrail against scope creep into a parallel system.
- Ordered story table gives a concrete sequencing intent, and all five story files actually exist on disk, so the breakdown isn't aspirational.
- Links out to a roadmap doc for delivery order rather than duplicating it — verified `docs/sdlc-quality-gates-roadmap.md` exists.

### Clarity issues
- **Dependency ID scheme mismatch.** The ticket's `Depends On` field lists `PRAXIS-S12-20, PRAXIS-S13-24, PRAXIS-S15-33`, but the description body's `dependencies:` frontmatter and prose list `FX-BE-020, FX-BE-024, FX-BE-033`. If these are meant to be the same three dependencies expressed in two ID systems, the mapping should be stated explicitly (or the tracker should carry only one ID scheme) — as written, a reader can't confirm they're equivalent, only that the counts match.
- **Incomplete table row.** The stories table's last row (FX-BE-091) has no Outcome text, unlike the other four. Pulled from the story file directly: *"When CI already ran the scans, read them instead of running them again... import GitHub code scanning + Dependabot alerts and GitLab SAST + dependency-scanning report artifacts... let a `security`/`qa` gate rest on that imported evidence in observe mode."* Worth backfilling so the table is self-contained.
- **"Delivery priority" section is ambiguous against Status/Priority.** It says "Committed planning scope; implementation remains Planned," while the ticket's own fields say `Status: To Do`, `Priority: High`. It's unclear whether this ticket is ready to pull into implementation or is still in a planning-only holding state — that distinction matters a lot for a High-priority item.

### Completeness gaps
- **Hidden dependency not surfaced at the feature level.** FX-BE-091 (story 5) depends on `FX-BE-053`, which appears nowhere in the parent ticket's dependency list. If FX-BE-053 isn't done, story 5 is blocked independent of the three feature-level dependencies — this should either be rolled up into the ticket's dependency list or explicitly called out as a story-level exception.
- **No acceptance criteria at the feature level.** The Outcome paragraph bundles five distinct capabilities (threshold gates, four scanner types, structured code review with inline delivery, bundled agents/template, CI evidence ingestion) into one run-on sentence with no top-level "done" definition. Given this is a Feature (epic-like) ticket sitting above five stories, at minimum a one-line acceptance summary per story-outcome would help reviewers verify closure.
- **No sizing/estimate or target release.** High-priority feature with no estimate, sprint, or target date — makes it hard to judge urgency versus the "implementation remains Planned" framing.
- **No mention of what happens to existing gates/pipelines during rollout.** Given the explicit "no second pipeline" constraint, it's worth stating in the ticket (not just inferred from stories) whether existing workflows keep functioning unmodified while these gates roll out, or whether there's a migration/compat step.

### Missing technical context
- **No performance/latency budget for the security gate.** Bundling secret/SAST/SCA/license scanners behind a gate that presumably runs per-PR or per-deploy is a common source of pipeline slowdown complaints; the ticket doesn't state a target runtime or a strategy for incremental/cached scanning.
- **No supply-chain note on the bundled scanners themselves.** Ironic given the feature is about security gates — no mention of how the bundled scanner binaries/images are vetted, versioned, or updated, which is exactly the kind of thing an SCA/SAST gate would flag in someone else's dependency.
- **Evidence store schema impact unaddressed.** "Structured check results" and "findings" (per the FX-BE-091 snippet) imply new data shapes in the evidence store — no note on schema versioning/back-compat for existing evidence consumers.
- **Bounded fix loop (FX-BE-089) mentioned only in the stories table, not in the feature Outcome.** Worth pulling into the top-level description since it implies automated-write behavior (an agent modifying code to satisfy findings), which is a different risk profile than read-only gating and probably deserves a top-level callout (e.g., guardrails, opt-in/opt-out).

### Suggested edits before moving to "In Progress"
1. Reconcile `PRAXIS-S*` vs `FX-BE-*` dependency IDs into one scheme or add an explicit mapping note.
2. Fill in the FX-BE-091 Outcome cell in the stories table.
3. Clarify "planning scope vs. Planned implementation" against the High priority / To Do status — state explicitly whether this is implementation-ready.
4. Surface FX-BE-053 as a story-level dependency somewhere in the ticket, since it's not covered by the three feature-level dependencies.
5. Add a one-line note on scanner runtime performance expectations and on how the bundled agents/fix loop are bounded (given FX-BE-089's inline-fix capability).