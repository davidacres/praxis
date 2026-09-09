---
type: Task
id: TASK-249
title: "Add Node / .NET / Python template variants"
status: planned
story: FX-BE-090
updated: 2026-09-09
dependencies: [TASK-248]
---

# TASK-249: Add Node / .NET / Python template variants

**Priority:** Low
**Created:** 2026-09-09

## Goal

Three `full-sdlc` variants differing only in check commands: Node (`eslint`, `tsc --noEmit`, `npm test` + coverage, semgrep, gitleaks, osv-scanner), .NET (`dotnet format --verify-no-changes`, `dotnet build`, `dotnet test` + coverlet, semgrep, gitleaks, .NET SCA), Python (`ruff`, `mypy`, `pytest` + coverage, semgrep, gitleaks, osv-scanner). Detection from `inspectFolder` picks the variant when a project instantiates the template; an undetected stack instantiates a named `full-sdlc (generic)` with commands left for the user to fill, not a broken run. The .NET review stage points at the repo's `csharp-dotnet-code-reviewer` agent with the `dotnet-solid-dry` skill.

## Implementation entry points

packages/core/src/workflows/workflowTemplates.ts (variant builders sharing one DAG factory), the template-instantiation path where a project copies a template (detection → variant selection), renderer template library (variants listed under `full-sdlc`).

## Dependencies

- TASK-248
## Acceptance criteria

- Each variant passes `validateWorkflow`; the three share an identical node/edge/gate structure and differ only in `command`/`args`.
- Instantiating for a detected Node / .NET / Python project selects the matching variant; an undetected stack yields `full-sdlc (generic)` with a clear "set commands" state, never a run that fails on an empty command.
- The .NET variant's review node references `csharp-dotnet-code-reviewer` + `dotnet-solid-dry`.
- The implementation satisfies the parent story's outcome and preserves existing unrelated templates.

## Verification

Core tests: structural equivalence of the three variants, detection → variant selection, generic fallback. Electron spec for the template library listing with inspected captures. `npm run test:core`, `npm run test:desktop:workflows`, `npm run check-types`. Update onboarding/user-guide template docs. Never point a Praxis write path at the repository's own plans.
