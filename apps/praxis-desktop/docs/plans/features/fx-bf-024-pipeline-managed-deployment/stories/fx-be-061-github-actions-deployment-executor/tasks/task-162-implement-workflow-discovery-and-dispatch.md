---
**Status:** ✅ Complete
**Type:** Task
type: Task
id: TASK-162
title: "Implement workflow discovery and dispatch"
status: Done
story: FX-BE-061
updated: 2026-10-10
dependencies: [FX-BF-023]
---

# TASK-162: Implement workflow discovery and dispatch

**Priority:** High
**Created:** 2026-09-07

## Goal

Discover eligible workflows and declared inputs; validate configured ref, correlation input and artifact contract; persist intent before authenticated dispatch.

## Implementation entry points

packages/core/src/github/githubApiService.ts; packages/core/src/deployments (new). Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BF-023
## Acceptance criteria

- Mock invalid workflow, insufficient permission, rate limit and lost dispatch response; never claim a run ID from an unrelated latest run.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:**

- `packages/core/src/deployments/githubActionsExecutor.ts` (new) —
  `GitHubActionsDeploymentExecutor`, a standalone client following this
  codebase's existing "one self-contained client per concern" convention
  (`ci/githubActionsEvidenceProvider.ts`'s own module doc states this
  explicitly), rather than sharing `GitHubApiService`'s or the evidence
  provider's private request machinery — this one needs `actions:write` in
  addition to `actions:read`/`contents:read`, and keeping the client
  separate keeps that scope difference visible. `GitHubActionsConfig`'s
  *shape* (baseUrl/owner/repo/token) is reused as a type import from the
  evidence provider rather than duplicated, since it is genuinely
  identical.
  - **`listWorkflows()`** — every workflow the repo declares (including
    disabled ones — a caller decides whether to filter, this method does
    not hide them), normalized id/name/path/state.
  - **`getDeclaredInputs(workflowPath)`** / **`parseDeclaredInputs`** —
    fetches the workflow YAML via the Contents API, base64-decodes it, and
    parses `on.workflow_dispatch.inputs` with `js-yaml` (added as a new
    dependency — no YAML parser existed anywhere in this codebase, and
    hand-rolling one for a nested map/array structure this general would
    be the kind of "fabricate correctness" this codebase's own discipline
    refuses; `js-yaml` is small, MIT-licensed, and the de facto standard).
    Correctly treats `on: push` (bare string) and `on: [push,
    workflow_dispatch]` (array) as "no declared inputs" rather than an
    error — only the map form (`on: {workflow_dispatch: {inputs: ...}}`)
    can carry them; a `workflow_dispatch:` with no body is likewise "no
    inputs," not a failure. Unparsable YAML throws a clear, labeled error
    rather than silently returning an empty list, which would be
    indistinguishable from "this workflow genuinely has no inputs."
  - **`dispatchWorkflow(workflowId, ref, inputs)`** — the actual
    `POST .../dispatches` call. **Returns only `{ dispatchedAt }` — no run
    id field exists on the return type at all**, which is what makes
    "never claim a run ID from an unrelated latest run" true structurally:
    `workflow_dispatch` answers with 204 No Content, so there is nothing
    to claim, and the type signature makes it impossible for a caller to
    receive a fabricated one. Correlating the dispatch with the run it
    actually produced is deliberately out of this module's scope — that's
    TASK-163's own task, "observe existing continuous deployments."
  - **Mocked failure classification**, each proven with a fixture test:
    `GitHubActionsDispatchError` carries a `kind` —
    `'invalid-workflow'` (404 unknown workflow, 422 bad ref/inputs),
    `'insufficient-permission'` (403 with no rate-limit signal),
    `'rate-limited'` (429, or 403 with `X-RateLimit-Remaining: 0` —
    GitHub's own documented way of signalling a secondary rate limit
    through a 403), `'other'` as the fallback. **A lost dispatch
    response** — a network-level failure during the POST itself —
    propagates completely unwrapped rather than being caught and
    reclassified, so a caller can never mistake "the network dropped"
    for "GitHub actively refused," which matters because only the first
    case leaves genuine doubt about whether the dispatch reached GitHub
    at all.
  - **`validateDispatchRequest`** — a pure pre-flight check before the
    API call is ever made: refuses a missing ref, a missing required
    declared input, a value outside a declared `choice` input's options,
    and an input the workflow never declared at all (GitHub would refuse
    it anyway; caught here before spending the API call finding out).
    **Correlation input validation**: when a caller names which declared
    input it intends to use to correlate the dispatch with its resulting
    run (TASK-163's concern), this refuses to let the dispatch proceed
    unless that input is both declared by the workflow *and* actually
    supplied a value — dispatching without it would mean the resulting
    run can never be confidently identified afterward, so it is caught as
    a validation failure rather than discovered as a correlation failure
    later.
  - **"Persist intent before authenticated dispatch"** is deliberately
    this module's *caller's* responsibility, not reimplemented here: a
    caller drives `applyDeploymentRunCommand`'s `start-deploying`
    (TASK-153) and `DeploymentRunStore.save()` (TASK-154) before calling
    `dispatchWorkflow`, the exact same "save before dispatch" discipline
    `directDeploymentOrchestrator.ts` already follows for the
    direct-process executor. A dispatch that dies mid-flight leaves that
    persisted run with no `externalId`, which is precisely TASK-154's own
    "lost acknowledgement" reconciliation case — already built, generic,
    and unchanged by this task, since it never assumed anything about what
    an executor's `externalId` looks like.

**Reuse, not reinvention**: no new state machine, no new persistence layer,
no new run store — this task only adds the GitHub-Actions-specific
mechanics (discovery, input parsing, dispatch, validation); everything
about *persisting* and *reconciling* a pipeline-executor run reuses
TASK-153/154's `DeploymentRun`/`DeploymentRunStore` exactly as built for
the direct-process executor.

**Commands run:** `npm install js-yaml @types/js-yaml -w packages/core`
(registry reachable in this sandbox; verified `npm audit` shows only a
pre-existing, unrelated `hono` transitive advisory, not introduced by this
change). `npx tsc -p .` (`packages/core`) — clean. Targeted `node --test`
on `githubActionsExecutor.test.js` — 20/20. `npm run test:core` from the
repo root (confirmed no stray background test/tsc processes first) —
**855/855 passing** (up from 835; 20 new). `npx tsc --noEmit -p .` in
`apps/praxis-desktop/main` — clean (unaffected; no main-process file
touched, but `js-yaml` becoming a `@praxis/core` dependency is exercised
by this check resolving cleanly). `npm run check-types` in
`apps/praxis-desktop/renderer` — clean (unaffected).

**Remaining limitations:**

- No IPC, UI, or main-process wiring — this is the core mechanics only,
  matching the story's own task ordering (TASK-163 "observe," TASK-164
  "map logs and results," then FX-BE-063's "pipeline setup and recovery
  experience" for the UI). No caller in the app invokes this module yet.
- Correlating a dispatch with the workflow run it actually produced (the
  other half of "never claim a run ID from an unrelated latest run" — this
  task's own scope is "dispatch," not "identify what happened after")
  is explicitly TASK-163's task, not implemented here.
- No credential/token acquisition — `GitHubApiConfig.token` (and this
  module's identical `GitHubActionsConfig.token`) is assumed already
  resolved by the caller, the same as every existing GitHub client in this
  codebase; this task does not touch how a token gets from the connection
  store into a deployment profile's credentials.
- Nothing here is Electron-dependent, so — like the pure-core tasks in
  FX-BF-023 — there is nothing this sandbox's inability to launch Electron
  leaves unproven; marked `complete` on that basis.

## Description


## Comments

**2026-10-10:** Closed during backlog review: frontmatter already recorded Done and the code is present (workflow discovery/dispatch, observation, result mapping in packages/core/src/deployments/githubActions*); the header status was stale.
