---
type: Task
id: TASK-241
title: "Add secret / SAST / SCA / license check presets with stack detection"
status: planned
story: FX-BE-088
updated: 2026-09-09
dependencies: [FX-BE-087]
---

# TASK-241: Add secret / SAST / SCA / license check presets with stack detection

**Priority:** High
**Created:** 2026-09-09

## Goal

Bundled `check`-node presets: secret scan (gitleaks), SAST (semgrep, curated ruleset shipped with the app), SCA (osv-scanner, with Trivy filesystem as the container/OS-package option), license policy. Each runs a pinned command, writes SARIF to a declared artifact path and names the TASK-238 adapter. `inspectFolder`'s detected languages/manifests pick the default enabled set. Presets are code the designer lists, adds, removes and re-points — not catalogue data.

## Implementation entry points

packages/core/src/workflows/checkPresets.ts (new: preset definitions, detection → default set); packages/core/src/projects (reuse `inspectFolder` detection output); apps/praxis-desktop/main/src/main (scanner process execution with a missing-binary check); apps/praxis-desktop/renderer/src/workflows (designer preset picker).

## Dependencies

- FX-BE-087
## Acceptance criteria

- On a vulnerable Node fixture the default set is secrets + semgrep + osv-scanner; on a .NET fixture it includes the .NET SCA target; each preset produces SARIF normalised to `findings`.
- A missing scanner binary fails its node with an actionable reason (install or disable), never a silent pass.
- The curated semgrep ruleset ships in the app image and is referenced by path, not fetched at run time.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows (the existing `npm audit` security node still works if a template keeps it).

## Verification

Core tests for detection → default set and preset shape; check-runner tests against captured scanner SARIF fixtures and a missing-binary case. Electron spec for the designer preset picker with inspected captures. Live-binary scans opt-in. Never point a Praxis write path at the repository's own plans.
