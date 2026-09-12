---
**Status:** ✅ Complete
**Type:** Story
type: Story
id: FX-BE-088
title: "Bundled security scanners behind the security gate"
status: Done
feature: FX-BF-034
updated: 2026-09-09
dependencies: [FX-BE-087]
---

# FX-BE-088: Bundled security scanners behind the security gate

**Priority:** High
**Created:** 2026-09-09

## Outcome

Replace `npm audit` as the whole of the security gate with bundled check presets for secret scanning (gitleaks), SAST (semgrep, curated ruleset), SCA (osv-scanner / Trivy filesystem) and license policy. Detection of language and manifests picks the default set; each preset is a normal `check` node emitting SARIF into `findings`. An audited, expiring waiver register suppresses individual findings by fingerprint, composed strictest-wins with the org. The `security` gate then means every enabled scanner ran and the combined un-waived findings are under the policy bar.

## Scope and implementation entry points

packages/core/src/workflows (check presets, gate composition, waiver register, policy); packages/core/src/projects (stack detection reuse from `inspectFolder`); apps/praxis-desktop/main/src/main (scanner process execution, waiver persistence in `<name>.praxis.<ext>` form); apps/praxis-desktop/renderer/src/workflows (designer preset picker, waiver UI). Scanners are code, not catalogue data.

## Dependencies

- FX-BE-087
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-241](tasks/task-241-add-secret-sast-sca-and-license-check-presets.md) | Add secret / SAST / SCA / license check presets with stack detection |
| 2 | [TASK-242](tasks/task-242-add-an-audited-waiver-register.md) | Add an audited, expiring waiver register |
| 3 | [TASK-243](tasks/task-243-compose-the-security-gate-over-enabled-scanners.md) | Compose the security gate over the union of enabled scanners |

## Acceptance criteria

- On a deliberately vulnerable fixture repo, the detected preset set runs, each emits SARIF normalised to `findings`, and a seeded high-severity finding blocks approval.
- A waiver keyed by that finding's fingerprint, with actor, reason and `expiresAt`, clears the block and is recorded on the run event log; past `expiresAt` the finding re-blocks; a waiver never matches a finding on a different source snapshot.
- The `security` gate reports which scanners ran and the combined un-waived count against the bar; a disabled scanner is named as disabled, not silently absent; adding a scanner or lowering a project's waiver lifetime composes, loosening the org bar is refused.
- A missing scanner binary fails its node with an actionable reason (how to install / disable), not a silent pass.
- All child tasks have implementation and verification evidence.

## Verification

Run each preset against captured vulnerable-fixture output and the live binary where available (opt-in). Core tests for detection, waiver expiry and gate composition; Electron specs for the designer preset picker and waiver dialog with inspected captures. Prove the waiver-expiry and loosen-refusal guards fail against the pre-change behaviour. Update feature-parity and user-guide security sections.

## Exclusions

No IaC, container-image or DAST scanning in this story (candidate follow-ons). No cloud-posture assessment. No automatic remediation. Waivers suppress findings only; they do not override a whole failing gate — that remains the audited bypass.

## Description


## Comments

- Delivered Story FX-BE-088 across all three child tasks:
  - TASK-241: Created bundled check presets (`checkPresets.ts`) for secret scanning (Gitleaks), SAST (Semgrep), SCA (OSV-Scanner, Trivy), and license policy with automatic stack detection and actionable missing-binary error reporting.
  - TASK-242: Implemented the waiver register (`waiverRegister.ts`) with temporal expiry, snapshot binding, and strictest-wins composition.
  - TASK-243: Supported multi-owner convergence for security gates in `workflowGates.ts`, combining findings, applying waivers, evaluating threshold conditions, and reporting enabled/disabled scanners.
- Verified with unit tests (`checkPresets.test.ts`, `waiverRegister.test.ts`, `workflowMultiOwnerGates.test.ts`), `npm run test:core`, and `npm run check-types`.


