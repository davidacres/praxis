---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-143
title: "Build project Run profile editor"
status: in-progress
story: FX-BE-054
updated: 2026-09-09
dependencies: [TASK-142]
---

# TASK-143: Build project Run profile editor

**Priority:** High
**Created:** 2026-09-07

## Goal

Use existing form primitives and themed dialogs, display validation and unavailable-runtime states, and register Run navigation in sidebar and command palette.

## Implementation entry points

packages/core/src/projects; packages/core/src/host/ipcContracts.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-142
## Acceptance criteria

- Profiles remain project-owned with any tracker backend; keyboard, theme and responsive captures show the profile editor and invalid inputs.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Status: storage, IPC, and a renderer editor are all implemented and type-checked; the editor itself
is not verified running (Electron is blocked in this sandbox — see below). Left `in-progress`.**

**Implemented:**

- `packages/core/src/projects/runProfileStore.ts` (new) — `readRunProfile(projectFolder)` /
  `writeRunProfile(projectFolder, profile)` read/write `<projectFolder>/run.praxis.json`, the same
  tier as `project.praxis.md`/`board.praxis.json` (project identity, not `.praxis/workflows/`'s
  one-file-per-id library). A missing file is `{ issues: [] }`, not an error — most projects have no
  Run profile yet; a hand-edited malformed file comes back with `issues` describing why, rather than
  a silent empty profile. `writeRunProfile` re-runs TASK-141's `validateRunProfile` and refuses to
  write (throws) an invalid profile — fail-closed, matching the rest of this story.
- `apps/praxis-desktop/main/src/main/runProfileIpc.ts` (new) — `registerRunProfileIpc()` registers
  `projects:getRunProfile`, `projects:saveRunProfile`, `projects:discoverRunServices`, and
  `projects:validateRunProfile`. `discoverRunServices` does a shallow scan (project root plus
  immediate subdirectories, skipping dotfiles and `node_modules`) reading `package.json` and
  `Properties/launchSettings.json`, handing their content to TASK-142's pure
  `proposeNodeRunService`/`proposeDotnetRunService` — nothing here is ever executed, only read.
  `validateRunProfile` runs the same fail-closed check as the write path without touching disk, for
  the editor's live feedback. Registered in `apps/praxis-desktop/main/src/main/index.ts` alongside
  the other `registerXIpc()` calls.
- `packages/core/src/host/ipcContracts.ts` — added `getRunProfile`/`saveRunProfile`/
  `discoverRunServices`/`validateRunProfile` to `ProjectsIpc`, and preload exposure in
  `apps/praxis-desktop/main/src/preload/index.ts`.
- `apps/praxis-desktop/renderer/src/projects/RunProfileEditor.tsx` (new) — the editor itself: a
  service list (add/remove/edit id, name, executable, one-argument-per-line args, repo-relative
  `cwd`, port, `dependsOn` as checkboxes against the profile's other service ids, a readiness-probe
  editor covering all three kinds, and an env-variable key/value list), a "Discover services" panel
  that lets the user select which of `discoverRunServices`' proposals to import rather than applying
  them automatically, and a Save button disabled while invalid or unchanged. Live validation issues
  are shown per-field (`services[n].path` errors filtered against each service card) and at the
  profile level.
  - **Caught during implementation:** the first draft imported `validateRunProfile` and
    `RUN_PROFILE_SCHEMA_VERSION` directly as *values* from `@praxis/core`. AGENTS.md is explicit that
    the renderer imports types only from core at runtime (a value import pulls `chokidar` and other
    Node-only code into the browser bundle) — the repo's own `check-core-imports` script catches
    this and failed the build immediately. Fixed by adding a `projects:validateRunProfile` IPC
    handler (mirroring `WorkflowsIpc.validate`, called the same 120ms-debounced way
    `WorkflowDesignerPage` already validates a workflow definition) and inlining the schema version
    as a local constant with a comment pointing at its source of truth.
  - **Caught during implementation:** the route-rendering fallback in `App.tsx`,
    `if (selectedProject && route.feature !== 'git') return <ProjectWorkspace .../>`, ran *before*
    the new `route.feature === 'run'` branch — with a project selected (the only way to reach Run),
    this fallback matched first and the Run editor was unreachable. Fixed by excluding `'run'` from
    that condition too.
- Sidebar/navigation: `Sidebar.tsx` gained a `'run'` `FeatureId`, a `Run` tree row per project
  (next to Repository/Workflows, using the `server` icon), and an `onSelectRun` callback. `App.tsx`
  wires `FEATURE_TITLES.run`, the centre-pane render branch, the Sidebar callback (navigates to
  `{ projectId, feature: 'run' }`), and two command-palette entries — the generic per-feature "Go to
  Run" entry (extended to carry the selected project, the same way "Go to Git Graph" already does)
  and a per-project `project-run:<id>` entry.
- `theme.css` — a `run-*` class block (`.run-page`, `.run-service-card`, `.run-depends-list`,
  `.run-env-row`, `.run-probe-editor`, `.run-discover-panel`, etc.) in the same idiom as the existing
  `conn-*`/`wf-*` blocks.

**Commands run:**
- `npx tsc -p .` in `packages/core` — clean (recompiled after the `ipcContracts.ts` change so the
  renderer and main workspaces, which consume core's built `.d.ts` output, saw the new
  `validateRunProfile` method).
- `npx tsc --noEmit -p .` in `apps/praxis-desktop/main` — clean.
- `npm run check-types` in `apps/praxis-desktop/renderer` (runs `check-core-imports` then
  `tsc --noEmit`) — clean; this is what caught the value-import mistake above.
- `npm run test:core` (repo root) — 574/574 passing (unchanged by this task; TASK-143 added no new
  core module beyond `runProfileStore.ts`, whose 5 tests were already counted).

**Remaining limitations — UI verification is not done:** Electron cannot launch in this sandbox
(`node-pty`'s native binding is missing and rebuilding it needs `nodejs.org`, blocked by the
session's egress policy — the same documented blocker as every prior task's e2e attempt this
session). No Playwright spec was added for this editor and no manual click-through happened; "display
validation and unavailable-runtime states" and the acceptance criterion's "keyboard, theme and
responsive captures show the profile editor and invalid inputs" are unverified beyond type-checking
and reading the rendered JSX by hand. The editor's behavior (load/save/discover/validate round-trips,
add/remove service, dependency checkboxes, probe-kind switching, env row editing) is plausible from
the code and from the IPC layer's own passing tests, but nobody has actually seen it run. This is why
the task stays `in-progress` rather than `complete`.

## Description


## Comments


