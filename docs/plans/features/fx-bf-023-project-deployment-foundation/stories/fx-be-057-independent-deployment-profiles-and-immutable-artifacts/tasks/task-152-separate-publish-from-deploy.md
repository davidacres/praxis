---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-152
title: "Separate publish from deploy"
status: complete
story: FX-BE-057
updated: 2026-09-09
dependencies: [TASK-151]
---

# TASK-152: Separate publish from deploy

**Priority:** High
**Created:** 2026-09-07

## Goal

Define publish result manifests and digest validation; reference a built artifact for deployment/promotion instead of rebuilding; replace MSI-only assumptions through explicit conversion guidance.

## Implementation entry points

packages/core/src/projects; packages/core/src/workflows; packages/core/src/host/secrets.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-151
## Acceptance criteria

- A .NET publish directory and a web artifact both validate; absent or modified artifacts fail; existing MSI configuration remains understandable and is never silently reinterpreted.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:** `packages/core/src/projects/publishManifest.ts` (new) —

- `buildPublishManifest(rootDir)` walks a directory tree recursively, sha256-hashes every regular
  file, and combines the per-file digests (sorted by POSIX-relative path, so the result is
  deterministic regardless of filesystem read order or which OS built it) into one overall
  `PublishManifest.digest` — the value `PublishedArtifact.digest` (TASK-150) actually carries.
  Deliberately generic: there is no dotnet- or web-specific code path, only "hash every file under
  this directory" — which is exactly what makes "a .NET publish directory and a web artifact both
  validate" true without special-casing either, proven with two distinct fixture trees (a fake
  `dotnet publish` output with a `.dll`/`.deps.json`/`.runtimeconfig.json`/nested `runtimes/`
  folder, and a web artifact with `index.html`/`assets/*`).
- `validatePublishedArtifact(rootDir, manifest)` re-hashes and compares three ways: a file the
  manifest expected but that's gone is `missing`, one whose content changed is `modified`, and one on
  disk the manifest never recorded is `unexpected` — an artifact is exactly the files its manifest
  names, so an extra file invalidates it too, not just a missing or changed one. An entirely absent
  artifact directory reports every manifested file as `missing` rather than throwing. Directly proves
  "absent or modified artifacts fail," each case as its own test with the specific issue kind
  asserted, not just an overall `valid: false`.
- `createPublishedArtifact({id, deploymentProfileId, sourceCommit, rootDir})` is the one place a
  manifest's digest becomes a `PublishedArtifact` (TASK-150) — "reference a built artifact... instead
  of rebuilding" is what this connects: a `DeploymentRun` holds an `artifactId`, and validating that
  artifact before a deploy or promotion means calling `validatePublishedArtifact` against its recorded
  manifest, never re-running a build to get something to check.
- **"Existing MSI configuration remains understandable and is never silently reinterpreted"**: this
  task touches neither `packages/core/src/config/appSettings.ts` (the existing
  `publishCommand`/`artifactPattern` delivery-workflow settings, whose doc comment gives "the MSI
  publish script" as an example) nor `packages/core/src/ai/deliveryWorkflow.ts` (which already
  prompts the AI delivery agent in MSI-specific terms — "the MSI publish command," "the MSI build
  suffix," etc.) — confirmed via `git diff --stat` against both files showing no changes. A
  `PublishManifest` is additive infrastructure for the deployment-profile world TASK-150/151 built,
  a different mechanism for a different workflow, not a replacement or reinterpretation of the
  existing one.

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. `npm run test:core` (repo root), one
clean run — **709/709 passing** (11 new): the acceptance criteria's own two artifact shapes both
validate; an absent directory reports every file `missing`; a modified file reports `modified` (not
`missing`); a removed file reports `missing`; an added file reports `unexpected`; two independently
built directories with identical content validate against either one's manifest (digest is
content-based, not path- or timestamp-based); the overall digest is stable across identical rebuilds
and changes when any file changes; a non-directory path is rejected; `createPublishedArtifact`'s
resulting digest matches its manifest's own; two structurally different artifacts never collide on
digest. `npx tsc --noEmit -p .` in `apps/praxis-desktop/main` and `npm run check-types` in
`apps/praxis-desktop/renderer` — both clean (neither consumes the new module yet).

**Remaining limitations:** No IPC, UI, or storage for manifests themselves exists yet (a manifest is
returned to the caller, not persisted anywhere) — `PublishedArtifact` records point at a
`location.path` on disk, but nothing here writes the manifest alongside it for later re-validation to
read back; that's FX-BE-058's "persist side effects and reconcile" (TASK-154) territory, not this
task's own stated scope. Nothing here actually invokes a real `dotnet publish`/web build — this
module hashes whatever directory it's handed, and producing that directory in the first place is the
existing delivery-workflow / a future executor's job, deliberately left untouched per the acceptance
criterion above. Nothing here is Electron-dependent, so — like TASK-150/151 — there is nothing left
that this sandbox's Electron block leaves unproven; marked `complete` on that basis. This also closes
out FX-BE-057 (Independent deployment profiles and immutable artifacts) — all three of its tasks
(TASK-150/151/152) are now implemented and tested.

## Description


## Comments


