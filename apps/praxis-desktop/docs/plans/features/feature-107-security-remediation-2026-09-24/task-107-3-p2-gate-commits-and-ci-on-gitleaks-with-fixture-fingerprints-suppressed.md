# [P2] Gate commits and CI on gitleaks with fixture fingerprints suppressed

**Status:** ✅ Complete
**Created:** 2026-09-24T15:41:56.538Z
**Type:** Task
**Priority:** Medium
**Parent:** PRX-F107

## Description
**Priority:** P2 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-003** (High, CWE-540) — the prevention half. Rotation and untracking are the companion P0 item, *Rotate the credentials exposed in git history and untrack .vscode/settings.json*.

## Why this priority

P2 only because the immediate exposure is handled by the P0 rotation item; this is what stops the next leak. It matters that the two ship close together: gitleaks currently reports 40 leaks of which 36 are noise (28 confirmed test fixtures plus the four real ones), and a scanner with that signal-to-noise ratio trains people to skim it — which is how the four real credentials in SEC-003 stayed unaddressed. Suppressing the fixtures is part of the same change, not a follow-up.

## Change

- Add a `.gitleaksignore` covering the 28 confirmed-fixture findings the review triaged — all in `*.test.ts`/`*.spec.ts`: `chatGadgets.spec.ts:134`, `workflowRun.spec.ts:878,899`, `aiSessions.spec.ts:626,667,785`, `mobileRunProjection.test.ts:64`, `workflowCheckRunner.test.ts:207`, `mobilePairingInvitation.test.ts:13,19,24`, `mobileWorkflowRuns.test.ts:33,34`, `acpAgentHost.test.ts:37`, `gitWorktreeManager.test.ts:81`, `validation.test.ts:149`, `deploymentProfile.test.ts:189,210`, `browserDiagnostics.test.ts:52,61`, `runProfile.test.ts:171` and the `workflowEvidence.test.ts` entries (several of which exist precisely to prove `redactEvidenceContent` strips secrets).
- Add a gitleaks job to `.github/workflows/build.yml` — it already sets `permissions: contents: read` and uses `pull_request` rather than `pull_request_target`, so it is the right host — failing the build on any new leak, and make it a required check on the branch protection rule.
- Add a pre-commit hook script under `scripts/`, scoped to staged files, wired the way the repo wires its other checks.

## Verification

Run gitleaks locally and confirm a clean exit on the current tree with the ignore file in place. Add a fake credential in a scratch commit and confirm both the hook and the CI job fail, then drop it. The job only matters once it is *required* — confirm that in the branch protection settings.

## Effort

S

## Depends on

Rotate the credentials exposed in git history and untrack .vscode/settings.json

## Risk

Gitleaks fingerprints are line-anchored, so they go stale whenever a fixture file moves and the gate then fails on known-good code — prefer path-based allowances for test files where the tool supports it, and expect to re-generate fingerprints after any large refactor. A hook that is slow or noisy gets bypassed with `--no-verify`, which is why the CI check, not the hook, is the control that actually holds.

## Dependencies


## Comments
- 2026-09-30: Done. `.gitleaks.toml` (path-based allowlist for `*.test.*` / `*.spec.*` / `*_test.dart` fixtures and build output, rather than line-anchored fingerprints), `scripts/check-secrets.sh` (`--tree`, `--range`, staged by default), `.githooks/pre-commit` (enable with `npm run hooks:install`) and a `Secret scan` job in `.github/workflows/build.yml`. Verified locally with gitleaks 8.30.1: clean tree exits 0; a staged fake AWS key exits 1. Still to do by the owner: mark `Secret scan` a required check in branch protection.
