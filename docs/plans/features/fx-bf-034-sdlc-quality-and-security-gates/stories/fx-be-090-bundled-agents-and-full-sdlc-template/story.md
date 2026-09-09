---
type: Story
id: FX-BE-090
title: "Bundled agents and a Full SDLC template"
status: planned
feature: FX-BF-034
updated: 2026-09-09
dependencies: [FX-BE-088, FX-BE-089, FX-BE-011]
---

# FX-BE-090: Bundled agents and a Full SDLC template

**Priority:** Medium
**Created:** 2026-09-09

## Outcome

Remove the onboarding cliff. Ship bundled, trusted agent manifests — `praxis-planner`, `praxis-implementer`, `praxis-reviewer`, `praxis-security-analyst` — mirrored into the trusted discovery root on first run, with briefs derived from `aiReviewService.ts`'s existing review prompts. Add a `full-sdlc` built-in template: `Plan → Implement → (Lint ∥ Type-check ∥ Unit tests + coverage ∥ SAST ∥ Secrets ∥ SCA ∥ AI review) → Gates(qa, security, review) → Approve`, optional trailing `Deploy`. Provide Node, .NET and Python variants: identical DAG, stack-detected check commands.

## Scope and implementation entry points

packages/core/src/ai/agentRuntime (bundled manifest discovery, first-run mirror); packages/core/src/workflows/workflowTemplates.ts (the `full-sdlc` definition and per-stack variants); app image assets for the manifests. Reuse the FX-BE-011 trust model — bundled agents install trusted because they ship in the image and run through the existing ACP host; a project still references them by id.

## Dependencies

- FX-BE-088
- FX-BE-089
- FX-BE-011
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-247](tasks/task-247-ship-bundled-trusted-agent-manifests.md) | Ship bundled trusted agent manifests |
| 2 | [TASK-248](tasks/task-248-add-the-full-sdlc-workflow-template.md) | Add the full-sdlc workflow template |
| 3 | [TASK-249](tasks/task-249-add-per-stack-template-variants.md) | Add Node / .NET / Python template variants |

## Acceptance criteria

- On a fresh profile, the four bundled agents are discovered and trusted without the user creating or importing anything; `assessTemplateReadiness` for `full-sdlc` reports `agentsOk` with no project configuration.
- A `full-sdlc` run completes end to end on a Node fixture and a .NET fixture, with each gate resting on the structures from FX-BE-087/088/089; the .NET variant uses the repo's `csharp-dotnet-code-reviewer` agent and `dotnet-solid-dry` skill for review inputs.
- Per-stack variants differ only in check commands; the DAG, gates and policy are identical, and an undetected stack falls back to a named generic variant rather than a broken run.
- A bundled manifest is never written into a user's project folder; the mirror target is the trusted discovery root only.
- All child tasks have implementation and verification evidence.

## Verification

Fresh-profile discovery test; `full-sdlc` template validation and readiness tests; a scripted end-to-end run on Node and .NET fixtures with scripted agents. Electron specs for the template library showing `full-sdlc` and its variants with inspected captures. Update onboarding docs, user guide and feature-parity. Live-agent proof stays opt-in.

## Exclusions

No marketplace agents gain trust through this path. No template auto-selection by issue content beyond the existing workflow-pack matching. Deploy stays an optional trailing node, not a required gate.
