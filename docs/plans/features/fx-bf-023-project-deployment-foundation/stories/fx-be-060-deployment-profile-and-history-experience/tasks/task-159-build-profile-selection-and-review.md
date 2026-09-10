---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-159
title: "Build profile selection and review"
status: in-progress
story: FX-BE-060
updated: 2026-09-09
dependencies: [FX-BE-059]
---

# TASK-159: Build profile selection and review

**Priority:** High
**Created:** 2026-09-07

## Goal

Render executor and target as separate selectors with connection-based suggestions only; review artifact, environment, changes and checks before execution.

## Implementation entry points

renderer/src/deployments (new); renderer/src/app; docs/user-guide.md. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-059
## Acceptance criteria

- Switching issue backend never rewrites deployment target; profile editor supports missing credentials and machine-local bindings.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:**

- **Main process — profile CRUD IPC** (`apps/praxis-desktop/main/src/main/deploymentProfileIpc.ts`, new):
  `deployments:listProfiles/getProfile/saveProfile/validateProfile/
  preflightCapabilities/evaluateCredentials`, each a thin wrapper over
  TASK-151's `deploymentProfileStore.ts` and TASK-150's
  `validateDeploymentProfile`/`preflightDeploymentCapabilities`. This layer
  did not exist before this task — TASK-151/152 were deliberately core-only
  — and TASK-158 deliberately deferred it ("picking which profile... is
  FX-BE-060's UI concern"), so this is where it belongs. `saveProfile`
  rejects an invalid profile with its errors rather than persisting it, the
  same discipline `workflows:save` follows. `evaluateCredentials` resolves
  each credential name against the shared `getSecretsStore()` singleton
  (`connectionStoreInstance.ts`) — safeStorage-encrypted, local to this
  machine — never against a value the renderer could see; only bound/missing
  booleans cross the IPC boundary.
- **`host/ipcContracts.ts`** gained `DeploymentsIpc.{listProfiles,getProfile,
  saveProfile,validateProfile,preflightCapabilities,evaluateCredentials}`
  alongside TASK-158's run actions; `preload/index.ts` exposes all six on
  `window.praxis.deployments`.
- **Renderer** (`apps/praxis-desktop/renderer/src/deployments/`, new):
  - `deploymentEdits.ts` — the renderer-safe, types-only mirror
    `workflowEdits.ts`/`RunProfileEditor.tsx` each already establish for
    their own domain (the renderer may import only types from
    `@praxis/core` at runtime): factories for each executor/target kind,
    `updateProfile`/`setExecutor`/`setTarget`. **No function anywhere in
    this file, or in `DeploymentsPage.tsx`, takes a project's tracker
    connection as an input** — there is no parameter to leak through, which
    is what makes "switching issue backend never rewrites deployment
    target" true by construction rather than by a runtime check. `target`/
    `executor` are only ever changed by an explicit `setTarget`/
    `setExecutor` call the user's own field edit triggers.
  - `DeploymentsPage.tsx` — a profile rail (list, select, "+ New") beside an
    editor form and a save/review aside, reusing the workflow designer's
    existing three-column grid (`.wf-designer`/`.rail`/`.inspector` — shared
    layout primitives already used across features, not workflow-specific
    despite the class name) rather than inventing new layout CSS.
    - **Executor and target as separate selectors** (this task's own
      acceptance line): two independent `<select>`s, each defaulting to a
      fresh, fully-formed value for the chosen kind — choosing an executor
      never touches `target` and vice versa. Every kind (including the two
      schema-valid-but-unimplemented executors and the IIS target) is
      listed with an explicit "(not yet implemented)" suffix rather than
      hidden, matching `SUPPORTED_EXECUTOR_KINDS`/`SUPPORTED_TARGET_KINDS`'s
      own "schema-valid now, not yet runnable" stance.
    - **Missing credentials and machine-local bindings**: a credentials
      editor (name + `${secret:NAME}`-shaped reference) with each entry's
      live bound/missing status from `evaluateCredentials`, and explanatory
      copy that a binding is local to the machine deploying — a credential
      bound here will show missing on a different machine, by design, not
      as a bug to work around.
    - **Review panel**: environment, target summary, live capability
      preflight issues, and credential-binding status — "review... before
      execution" as far as this task's own data is available; an
      artifact/changes/checks section is explicitly a placeholder pointing
      at "deployment history" (TASK-160) rather than fabricating data that
      does not exist yet at this point in the story.
  - **`App.tsx`/`Sidebar.tsx` wiring**: a `'deployments'` `FeatureId`, a
    per-project "Deployments" sidebar row (rocket icon, after "Run"),
    `FEATURE_TITLES`/command-palette entries, and a route branch. Found and
    fixed the same latent bug TASK-143 found for `'run'`: the generic
    `ProjectWorkspace` fallback (`if (selectedProject && route.feature !==
    'git' && route.feature !== 'run')`) is checked *before* any
    feature-specific branch further down the function, so a new feature
    branch placed after it is silently unreachable unless also excluded
    from that condition — added `&& route.feature !== 'deployments'`
    verified against the actual branch order (`grep`-confirmed: the
    fallback is at line 1371, `'deployments'` at line 1444).

**Commands run:** `npx tsc -p .` (`packages/core`) — clean (type-only
`ipcContracts.ts` change; no core logic touched, so `npm run test:core`
was re-run for confidence rather than because behavior changed — **829/829
passing**, unchanged from TASK-158). `npx tsc --noEmit -p .` in
`apps/praxis-desktop/main` — clean. `npm run check-types` in
`apps/praxis-desktop/renderer` (including `checkCoreImports.cjs`) —
clean; caught and fixed one real TypeScript narrowing issue along the way
(`profile.target.kind === 'local-process'`'s narrowing does not survive
into a nested `onChange` closure, so spreading `profile.target` there was
a type error — fixed by extracting `LocalProcessTargetFields`/
`IisTargetFields` subcomponents that receive an already-narrowed `target`
prop, which is what TypeScript can actually track).

**Remaining limitations:**

- No Electron capture/verification was possible in this sandbox (no
  `node-pty` native binding; rebuild blocked by egress policy) — the full
  chain (core contract → main IPC → preload → renderer page → sidebar/route
  wiring) compiles clean end-to-end but was never exercised against a
  running app, a real `BrowserWindow`, light/dark themes, a narrow
  viewport, or keyboard focus order. Marked `in-progress` specifically for
  this reason, consistent with every other UI task in this feature.
- No profile deletion — `deploymentProfileStore.ts` (TASK-151) never built
  a remove function, only `write`/`read`/`list`, so there is nothing for
  this task's IPC or UI to wrap. Adding one is a small, real gap worth
  flagging rather than fabricating a delete button with no IPC behind it.
- No artifact publish trigger and no deployment-run actions (prepare/
  approve/deploy/rollback, all already built in TASK-158) are wired into
  this page yet — the review panel names "deployment history" as where
  that surfaces, and building it is explicitly TASK-160's job ("Add
  deployment history and promotion"), not this one's.
- The health-check probe editor accepts a `log-line` kind for schema parity
  with a Run profile's own probe editor, with an explicit inline note that
  a deploy will refuse it (`verifyDirectoryHealth`, TASK-157, already
  refuses that kind for either target) — shown rather than hidden, so a
  user picking it sees why it will not work instead of it silently
  vanishing from the option list.

## Description


## Comments


