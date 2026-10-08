# Agent notes: `apps/praxis-desktop/renderer/src/workflows`

Area-specific guidance, moved out of the root [AGENTS.md](../../../../../AGENTS.md).
The root file still holds the rules that apply to every change; read it too.

## Workflow runs: tree nodes and the run workspace

There is **no Runs page**. A project's runs are child nodes under `Workflows > Runs`
in the sidebar (`Sidebar.tsx`; the list is `runsByProjectId`, lifted into `App` so the
command palette shares it). A node carries hover-revealed **cancel** (live runs only)
and **delete**; `+` on the group and a workflow row's play button open
`workflows/StartRunDialog.tsx`. Opening a node routes to
`workflows` / `workflowView: 'runs'` / `workflowRunId` and renders
`workflows/WorkflowRunPage.tsx`:

- **Centre** — the session doing the work: the running stage's, else the last stage
  that has one (so a run waiting on a person still shows the conversation behind it).
  It is `App`'s own `renderSessionsPage(sessionKey)`, the same console the Sessions
  route uses — do not fork `SessionsPage` for it. A stage with no session (check,
  approval, deployment, or not started) shows a short explanation instead.
  Picking a step in the pipeline pins it; "Follow live" un-pins.
- **Right pane** — `WorkflowPipelineVertical` (steps top to bottom, parallel steps
  bracketed), then status/controls, the selected stage's findings and evidence, gates,
  timeline, and the stage session's inspector under "Session details". It portals into
  `auxSlot` like the designer does. Step buttons keep the `Name (type): lane`
  `aria-label` the specs select by.

**Deleting a run** (`workflows:deleteRun`) cancels it first if it is live, then removes
the run, its stage sessions (`stageSessionKey`), and its entry in the controller's
`workflowRunIds`. It shares `deleteAgentSession` with `ai:deleteSession` — do not
re-implement session teardown. `removeControllerRun` only *detaches* a run from a
session; it is not delete.

**Run permission mode.** `WorkflowRun.permissionMode` (`'ask'` default | `'auto'`) is chosen
in the start-run dialog and **fixed for the life of the run**. `auto` makes each stage
session start with `allowPermissionsForTask` on (`autoApprovePermissions` through
`launchAgentTask` to both hosts) and is recorded on the session record so follow-up turns
keep it. It sits *behind* the tool-access checks — a read-only/project-only stage is still
denied writes and commands first — and it never touches the human approval gate, which
needs a person in either mode. Anything other than an explicit `'auto'` is treated as ask.

**A stage that could not judge is paused, not failed.** An attempt can stop for a reason that
says nothing about the work: `WorkflowNodeAttempt.pause` is `'provider-limit'` (the AI account
ran out of credit/quota — see `isProviderLimitError`) or `'environment'` (the stage's tooling
could not run). A paused stage keeps the run open and its worktree, does not spend
`maxAttempts` (`attemptsSpent`), takes none of its failure/always edges, leaves its gate
`pending` rather than `failed`, and is resumed with Retry. `classifyCheckEnvironmentFailure`
(core, used by `workflowCheckRunner`) decides `environment`, and it is **deliberately narrow**:
only a missing command, or a package manager doing *registry work* (audit/install/ci/view/…)
with a specific registry/network/auth/TLS signature. `npm test`, `npm run …` and every other
command run user code and are never second-guessed — a false "environment" hides a real failure
behind a pause, which is worse than a false failure. Add a signature with a fixture of real
output and a negative case in `checkEnvironmentFailure.test.ts`. (Real example: `npm audit`
against a default registry with no audit endpoint, e.g. GitHub Packages, exits 1 having checked
nothing; the Governed delivery template now audits against `registry.npmjs.org` for that reason.)

**Switching AI on a paused or running stage.** When an AI provider limit pauses a stage (or the
user changes provider from the stage menu), the user can switch to another configured provider
and select which model to use with it. The switch persists on `run.stageProviders[nodeId]` and
`run.stageModels[nodeId]`. `runWorkflowAgentStage` / `chooseStageModel` prioritize the
switched model before falling back to tier mapping or defaults, and the switch event records both
provider and model in the run timeline.

**A person can always retry a failed stage; `maxAttempts` only bounds the run continuing alone.**
`retryNode` no longer checks the attempt budget, and a `node-retry` on a **failed** run reopens it
(the one command besides `gate-decided`/`node-stopped` a settled run accepts; a `cancelled` run stays
cancelled). Siblings the orchestrator stopped when the run failed (`cancelled`) go back to `pending`
with it. `canRetry` is still what `settleRunIfDone` uses to decide whether the run keeps going by
itself, so it still fails a run whose budget is spent — it just no longer makes that final. Reopening
re-acquires the worktree, and a released worktree's branch still exists, so
`prepareDeliveryWorktree` **re-attaches an existing `WF-<run8>-<slug>` branch** (with its commits, and
without the clean-base check, which only applies when creating the branch) instead of
`worktree add -b`, which fails on the name. The pipeline's retry icon is a *sibling* of the step
button (a button cannot nest in a button), shown for any step with a `retry-stage` action.

**A stage names a model tier, not a model.** `WorkflowAgentTaskNode.modelTier` (`fast`/`standard`/
`strong`), optional `model` (exact id, wins), `escalateOnRetry` (default on). `ai.modelTiers[provider]`
in settings maps tiers to ids because ids are provider-specific — there is no honest universal
ranking, so never hard-code one. It is edited **in the provider's own row** (Settings → AI Provider →
Providers → open a provider → Model tiers, `ProviderModelTiers`) as a pick from that provider's fetched
models — never free text where a list exists, since a mistyped id fails the launch — and from the
other side in Manage models, where each model row's tier select writes the same map (a tier holds one
model, so a model holds at most one tier). `chooseStageModel` (core, `stageModel.ts`) is the only resolver:
exact model → mapped tier → run model → provider default; **an unmapped tier falls back to the run's
model rather than guessing an id** (a wrong id fails the launch). Each failed attempt after the first
moves one tier up; attempts that paused (provider limit / environment) never spent the stage and never
escalate. `instantiateTemplateForProject` gives every unset agent stage a default tier, so mapping the
tiers takes effect without editing stages; unmapped, nothing changes. "Suggest model tiers" in the
designer (`workflows:recommendModelTiers`, sibling of the template recommender) only fills the *unsaved
draft* for stages with no choice yet. **`normalizeWorkflow` (`workflowValidation.ts`) whitelists node
fields** — a new node field that is not copied there is silently dropped on save and the feature does
nothing; that is exactly how `modelTier` first failed, and only an e2e that saved and ran the workflow
showed it. Add the field to the sanitizer and to its round-trip test.

**A stage starts from what earlier stages concluded.** A report artifact has no file — its text only
ever lived on the producing stage's session — so a downstream stage used to be told a report existed
and could not read it. `runWorkflowAgentStage` now appends `formatUpstreamReports` (core, capped at
6000 chars per report, head and tail kept, the cap announced) to the stage's scope, read from the
producing session's `responseText`. Artifacts with a path are still referenced by path.

**A run's worktree starts with no dependencies, so the template installs them.** `node_modules` is
gitignored, so a fresh worktree has none; tools only appear to work when something up the tree
supplies them (the parent checkout's root `node_modules`), and a workspace package with its own
nested dependencies fails with `Cannot find module` — which is how QA failed FX-BF-036 with every
real test green. The Governed delivery and Full SDLC (node) templates therefore have an `Install
dependencies` stage (`installDependenciesNode`) that runs `npm ci` after Implement; only the stages
that need `node_modules` wait for it. Two decisions worth not undoing: it **installs** rather than
symlinking the main checkout's `node_modules` (a link is shared mutable state — an agent's
`npm install` would write into the user's real checkout — and goes stale when a stage changes the
lockfile), and it passes **`--registry=https://registry.npmjs.org/`** (with a private default
registry npm rewrites the lockfile's `registry.npmjs.org` tarball URLs to it and every public
package 404s on a cold cache — verify with `npm ci --cache=<empty dir>`, since a warm cache hides
it). `workflowInstallDeps.spec.ts` proves both halves on a real repository with a local tarball.
Praxis also relies on the desktop package's `postinstall` hook: node-pty 1.1.0's macOS prebuild
ships `spawn-helper` without an executable bit, so a cold `npm ci` otherwise lets Electron load
the addon but every terminal creation fails with `posix_spawnp failed`. Keep
`scripts/fixNodePtyPermissions.cjs` wired into `postinstall`; `--ignore-scripts` is not a valid
way to prepare a worktree that will run the desktop E2E suite.
The same goes for **build output**: `dist/`, `out/` and a copied renderer are gitignored too, so a `Build`
stage (`npm run build --if-present`, optional log) runs before QA. Without it an Electron/Playwright
suite that loads a pre-built renderer opens a **blank window** in the run worktree (the FX-BF-036 QA
symptom) — nothing about the failure says "build". `--if-present` keeps it a silent no-op for projects
with no build script, which is why its log is `required: false` (a required log with no output fails the
stage for having nothing to say). `workflowBuildStage.spec.ts` covers it, including the no-script case.
The root `npm run build` compiles `@praxis/mobile-protocol` before desktop main; main imports its types,
so omitting that workspace makes a genuinely cold Build depend on output left by an earlier command.

**A finished run leaves nothing running.** When a required stage fails the run, the orchestrator
stops every sibling still in flight and records it `cancelled` (`stopInFlight`, the post-settle
`node-stopped` command — the only command besides `gate-decided` a settled run absorbs). Recovery
repairs older records that still show stages `running` in a finished run. Do not let results fall
on a settled run and vanish.

**A run's work is its branch, and deleting the run does not decide its fate.** A governed run's
output is commits on `WF-<run8>-<slug>` (found by its `WF-<run8>` prefix — `runWork.ts`),
checked out in a worktree while the run is live. Three rules, each pinned by a test:
- **Releasing a worktree never deletes the branch** (`removeDeliveryWorktree(…, { keepBranch: true })`).
  The old release passed `WF-<run8>` to `git branch -D`, which only failed to match the real
  `WF-<run8>-<slug>` name by luck — one naming change from deleting a finished run's delivered work.
- **Uncommitted changes are kept, not discarded.** `git worktree remove --force` throws them away, so
  `release` first commits them to the branch (`preserveUncommittedWork`); if that fails, release throws
  and the worktree is left in place.
- **Deleting a run asks.** `workflows:inspectRunWork` reports the branch, the commits that exist on *no
  other* branch (`--not --exclude=<bare name> --branches --remotes` — give `--exclude` the bare branch
  name, not `refs/heads/…`, or it silently excludes nothing and reports 0 at risk), and uncommitted
  files. `useDeleteRun` (shared by the sidebar node and the run panel) shows them and offers an
  **unchecked** "Also delete branch" option; only `deleteRun(runId, { deleteWork: true })` removes
  the worktree and branch, and never a branch checked out in the main working tree.

**Session hierarchy.** `AgentSessionRecord.parentSessionKey` is the session that spawned
this one. It is set when a stage session is created (from `run.controllerSessionKey`)
and back-filled for older records in `recoverWorkflowRunsOnStartup`. `SessionsNav`
nests children under a parent that is in the list; a child whose parent is missing
(archived, other workspace) stays a top-level row rather than vanishing. Archiving or
deleting a parent cascades to its children (delete asks first). A run started with no
controller has no parent, so its stage sessions are top-level rows in Sessions — but two or
more from the same run gather under one run header (`SessionsNav`'s `rootItems`, labelled from
the run's workflow name via `runNames`; a lone one stays a plain row). The header is not a
session: it cannot be selected or renamed and never becomes a `parentSessionKey`. It does carry **archive
and delete** (`session-run-archive-btn` / `session-run-delete-btn`) that act on the whole group exactly as
they do on a parent session — every stage session under it, children before their stage, deleting asks
first and names the count. The *run itself* is untouched (it stays under Workflows → Runs; deleting the
run is `workflows:deleteRun`), and archived sessions are restored one by one from the Sessions tab.

**What a stage hands on, and how a run ends.**

- **Agent stages deliver `findings` from their reply.** `stageOutcomeFromSession` reads the last fenced
  ```json block holding a `findings` array (`parseReviewFindings`), and the brief tells the stage that
  format (`FINDINGS_BLOCK_INSTRUCTIONS`). Before this, no agent stage could satisfy a required `findings`
  output, so every agent review stage in the Full SDLC templates failed.
- **Check logs travel inline.** A check's log lives in the evidence store, outside the worktree that
  gateway agents' file tools are sandboxed to (`resolveSandboxedPath`), so `workflowAgentStage` inlines
  `log` inputs (`formatUpstreamLogs`) the same way reports are inlined (`formatUpstreamReports`, 24k cap).
  A report past that cap is also written whole to `<worktree>/.praxis-run/<contract>.md` and the brief
  names it, but **only for a read-only, non-mutating stage** (it could otherwise be committed by a
  freeze); the folder is removed when the session ends. Real review reports run to ~70k characters.
- **`publishTo: 'board'` on a `plan` output** creates the plan on the run's project board: the stage ends
  with a `praxis-plan` block (`workflowPlanPublishing.ts`), and the app creates a feature plus items via the
  project connection's `createIssue` (real plan markdown for a folder-backed project) and records the
  feature key on `WorkflowArtifactRef.reference`.
  `CreateIssueInput.priority` / `severity` / `sections` carry P0–P3 (as Highest…Low), severity and a
  Bug's steps/expected/actual into the folder template; other boards ignore them. Leave template
  sections present: `FolderService`'s upgrade pass re-adds any missing one on every load.
- **`optional: true` on an approval** offers **Skip** (`skipApproval`), which skips everything after it.
  It is opt-in so that a delivery sign-off can never be skipped.
- **`advanceJoins` also settles branches that can no longer run** (the scheduler's `skip` list), except
  those closed by a *failure*, which a person can still retry. Without this, an untaken branch kept a
  finished run at `running` forever.
- **`normalizeWorkflowRun` keeps node `findings`.** It used to drop them on reload, so a run read back
  from disk showed no findings and passed every severity threshold.
- **`normalizeWorkflow` copies fields one by one.** Every save/load runs through it, so a node field it
  does not copy is silently deleted on the first save. Approval `gateThresholds`/`waivers` and a check's
  `adapter`/`reportPath`/`observe` were missing, which stripped every Full SDLC security threshold and
  SARIF parse. Add any new node field there; `workflowPlanPublishing.test.ts` round-trips the shipped
  templates to catch this.

## Loops, findings routing, map stages and run parameters (FX-BF-108)

A workflow can now go back: route on what a stage *found*, loop to an earlier stage a
bounded number of times, fan a stage out over a run-time list, and ask for a goal when
it starts. The rules below each fail silently if broken.

- **Loop edges are not part of the DAG.** An edge with `loop: { maxIterations }` is the one
  sanctioned cycle. Every walk that follows edges — readiness, `findSnapshot`, ancestry,
  reachability, `downstreamNodeIds`, the pipeline's levels, the estimator — must use
  `dagEdges(definition)` (core `workflowEdges.ts`). Walking `definition.edges` directly makes
  "downstream of Implement" the whole loop, hands a stage the snapshot of work that runs after
  it, and pushes a loop's body down a level per pass. The validator still rejects any other
  cycle, and a loop edge must point back to a stage upstream of its source.
- **A loop is taken only when nothing in the run is running.** `pendingLoop` decides; while one
  is pending the scheduler starts nothing, skips nothing and `settleRunIfDone` does not settle —
  so a failing stage with a failure loop edge keeps the run open instead of failing it. The
  orchestrator applies `loop-taken` (which calls `reworkWorkflowRun` from the edge's target) once
  the band has settled. A spent budget is a **derived** needs-decision state, not a stored one:
  `loop-decided` records accept (reason required, covers that source attempt only), grant (never
  past `WORKFLOW_MAX_LOOP_ITERATIONS`) or stop. Iteration counts derive from `loopHistory`.
- **Attempt budgets are per revision.** A loop sets `revisionBase` on every reopened stage and
  `attemptsSpent` counts from there; `reworkWorkflowRun` preserves it. The stage row's
  `attemptsThisRevision` is what the pipeline shows next to `maxAttempts`.
- **Keep-best never rewrites history.** A worse pass sets `pendingRestore`; the orchestrator calls
  `WorkflowWorkspaceProvider.restore`, which commits the best iteration's content on top
  (`restoreWorktreeTo`, `git restore --source=<ref> --staged --worktree`) before anything else runs.
- **Findings edges and gates read the same arithmetic** (`countAtOrAbove`, `compareMetric` in
  `workflowEdges.ts`). Refuted findings (`verdict: 'refuted'`, set by a `refutes` skeptic stage
  by fingerprint) and waived ones never count; a findings edge waits for a pending skeptic.
- **What a stage is told when it runs again** is `formatIterationContext` (core): the findings that
  sent it round, repeats called out, waived ones named, its last failure. A first clean pass gets
  nothing, so its brief is byte-identical to before.
- **Map items get their own branches, named `wfitem-<run8>-<node>-<n>`** — deliberately *not* under
  the run's `WF-<run8>` prefix, or `findRunBranch` could return an item's branch as the run's. The git
  half is `main/mapWorktrees.ts` (Electron-free, tested on a real repo); merges go back in item order
  and a conflict is backed out and named, never left half-merged.
- **Run parameters are prose, never commands.** `resolveRunParameters` checks and coerces them at
  start; they reach briefs through `formatRunParameters` only. An integer parameter can set a loop's
  budget (`bindsLoopEdge`) and a loop's metric target can come from one (`valueFromParameter`).
- **The manual seam attests a clean result.** "Mark done" (`advanceStage`) on a stage that declares
  findings records an empty findings list unless findings are passed — that is how the e2e suite and
  a person both drive Governed delivery, whose review and security now deliver findings.
- **`toHaveScreenshot` here is a weak guard.** `maxDiffPixelRatio: 0.02` with `threshold: 0.2` let the
  Governed delivery designer baseline keep "matching" after its stages moved and two loop edges were
  added, because cards and dashed lines on this palette sit inside the colour tolerance. When a change
  moves the canvas, delete the baseline and regenerate it, then open it — `--update-snapshots` alone
  does not rewrite a file that still "matches".

Specs: `workflowLoops.spec.ts` (designer round-trip, a looping run to a recorded decision, the start
dialog's parameters and estimate, dark mode). Core: `workflowLoops.test.ts`, `workflowImprove.test.ts`,
`workflowMap.test.ts`, `workflowEstimate.test.ts`.
