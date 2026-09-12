---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-151
title: "Persist portable profiles and references"
status: Done
story: FX-BE-057
updated: 2026-09-09
dependencies: [TASK-150]
---

# TASK-151: Persist portable profiles and references

**Priority:** High
**Created:** 2026-09-07

## Goal

Use deployment.praxis.json naming constants and repository-relative paths; store credential references only; keep machine-local destination bindings outside portable configuration where necessary.

## Implementation entry points

packages/core/src/projects; packages/core/src/workflows; packages/core/src/host/secrets.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-150
## Acceptance criteria

- Export/open on another machine rebinds local destinations and secrets explicitly; plaintext credentials never appear in committed profile fixtures.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:**

- `packages/core/src/projects/runProfile.ts` — exported `isSecretShapedKey`/`isSecretReferenceValue`
  (previously private `SECRET_KEY_PATTERN`/`SECRET_REFERENCE_PATTERN` regex tests), so
  `deploymentProfile.ts`'s credential validation reuses the exact `${secret:NAME}` vocabulary
  TASK-141 already established for `RunServiceDefinition.env`, rather than a second copy.
- `packages/core/src/projects/deploymentProfile.ts` (extends TASK-150) — added
  `DeploymentProfile.credentials?: Record<string, string>` and validation requiring **every** value
  to be a `${secret:NAME}` reference (not just secret-shaped key names, unlike `RunServiceDefinition.env`
  — a field literally named `credentials` is a credential by definition, so the enforcement doesn't
  need a keyword scan to decide whether a given entry counts). Added repo-relative-path validation for
  `DirectoryTargetRef.path` (required *and* portable) and `LocalProcessTargetRef.cwd` (optional, portable
  when set) — reusing `isPortableFolderPath`, the same check `RunServiceDefinition.cwd` already uses.
  This closes a gap TASK-150 itself left open (its own schema had no portability enforcement yet) and is
  exactly what "repository-relative paths" in this task's goal names.
- `packages/core/src/projects/deploymentProfileStore.ts` (new) —
  - **Portable storage**: `readDeploymentProfile`/`writeDeploymentProfile`/`listDeploymentProfiles`
    against `<projectFolder>/.praxis/deployments/<id>.deployment.praxis.json` — the
    `deployment.praxis.json` naming this task's goal asks for, one file per profile id (a project can
    have "staging"/"production"/… side by side, unlike `run.praxis.json`'s one-per-project shape).
    Same fail-closed discipline as `runProfileStore.ts`: `writeDeploymentProfile` re-validates and
    refuses to write an invalid profile; `readDeploymentProfile` treats a missing file as "no profile
    yet" (not an error) and a malformed hand-edited file as a visible reason (not a silent empty
    result); `listDeploymentProfiles` skips a malformed file rather than letting one corrupt profile
    hide every other one.
  - **"Export/open on another machine rebinds... secrets explicitly"**: `evaluateCredentialBindings(profile,
    lookup)` extracts the `NAME` out of each `${secret:NAME}` reference and checks it against a secret
    lookup function (the exact shape of `host/secrets.ts`'s existing `SecretsStore.get` — passed in
    rather than imported directly, so this stays testable without Electron or a real
    `safeStorage`-backed store). On a fresh machine with an empty secret store, **every** credential
    comes back `bound: false` — proven directly by a test — which is what makes "rebinds secrets
    explicitly" true rather than aspirational: nothing here ever assumes a credential is present: a
    caller (a future deploy action) checking `allCredentialsBound` before proceeding would refuse to
    deploy, not silently attempt one with an empty/wrong credential.
  - **Local destinations already need no rebinding for this feature's scope**: `directory`/
    `local-process` targets are repo-relative by the validation added above, so they resolve
    identically wherever the tree is checked out — the same portability property `RunServiceDefinition.cwd`
    already has. There is nothing target-side to rebind until a target kind that is inherently
    machine-specific (`iis`'s site identity) is actually implemented (FX-BF-025) — building
    speculative rebinding machinery for a target this feature doesn't even run would be premature; see
    "Remaining limitations."

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. `npm run test:core` (repo root), one
clean run — **698/698 passing** (6 new validation tests on `deploymentProfile.ts` — repo-relative
path enforcement for both target kinds, plaintext-credential rejection regardless of key name,
reference acceptance, empty/absent-credentials parity, and a test proving a plaintext credential is
rejected before it could ever be written to a committed file — plus 12 new
`deploymentProfileStore.test.ts` tests covering storage round-trip/overwrite/malformed-file/listing
and all `evaluateCredentialBindings` scenarios: fully unbound, fully bound, partially bound, no
credentials at all, and an empty-string secret value treated as unbound rather than bound).
`npx tsc --noEmit -p .` in `apps/praxis-desktop/main` and `npm run check-types` in
`apps/praxis-desktop/renderer` — both clean (neither consumes the new module yet).

**Remaining limitations:** No IPC or UI exists to read/write/list deployment profiles from the app, or
to show a person which credentials still need binding on this machine — this task's own acceptance
criteria and goal describe persistence and reference discipline only, not an editor (that is
FX-BE-060's "Deployment profile and history experience", not this story). Nothing here actually calls
the real `host/secrets.ts` `SecretsStore` — `evaluateCredentialBindings` takes a lookup function by
design, and wiring it to the real store is main-process integration work with no task of its own yet
named in this story (a natural companion to whatever main-process code eventually executes a
deployment, since that's the point at which credentials actually get resolved and used). No
machine-local target-destination override mechanism exists for `iis` (or any future
inherently-machine-specific target) — deliberately not built now since no target requiring it is
implemented until FX-BF-025; building it speculatively would be storage-schema guessing ahead of the
feature that actually needs it. Nothing here is Electron-dependent, so — like TASK-150 — there is
nothing left that this sandbox's Electron block leaves unproven; marked `complete` on that basis.

## Description


## Comments


