---
type: Task
id: TASK-155
title: "Integrate workflow designer and monitor"
status: in-progress
story: FX-BE-058
updated: 2026-09-09
dependencies: [TASK-154]
---

# TASK-155: Integrate workflow designer and monitor

**Priority:** High
**Created:** 2026-09-07

## Goal

Add deployment node validation, inputs/outputs and dedicated status rendering while reusing gates; show deploy/verify separately and preserve existing workflow definitions.

## Implementation entry points

packages/core/src/workflows/workflowTypes.ts; workflowRun.ts; workflowRecovery.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-154
## Acceptance criteria

- Existing workflow fixtures remain unchanged; deployment cannot bypass configured approval or QA; node editor and monitor states have visual/accessibility verification.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:**

- `packages/core/src/workflows/workflowTypes.ts` — a fifth node kind,
  `WorkflowDeploymentNode` (`type: 'deployment'`), alongside `agent-task` /
  `check` / `approval` / `join`: `deploymentProfileId` (resolved by id against
  the project's deployment profile store at run time, the same discipline
  `WorkflowAgentRef.agentId` uses for agents — never an embedded manifest),
  `outputs`, an optional `satisfiesGate`, `timeoutMs`, `maxAttempts`. Added
  `isDeploymentNode` and widened `nodeOutputs`/`nodeGate` to include it;
  `nodeMutatesWorktree` already defaulted to `false` for an unrecognized type,
  made explicit with a comment (a deployment ships an already-built artifact,
  it never touches the implementation worktree).
- `packages/core/src/workflows/workflowRun.ts` — the engine settles a
  deployment node through the exact same generic `node-started` /
  `node-succeeded` / `node-failed` commands every other node uses; it does
  not know deployment has two halves. What it adds is generic, not
  deployment-specific: `WorkflowNodeState.phase` (a free-form string) and a
  new `node-progress` command/event a caller may fire mid-attempt to report a
  sub-phase — refused for a node that has not started or has already
  settled, idempotent for a repeated phase, and cleared the moment a new
  attempt starts or the node settles (a stray `phase` cannot outlive the
  attempt that reported it, and cannot survive a retry into the next one).
  Also widened the three existing `maxAttempts`/`timeoutMs`
  `isAgentTaskNode(node) || isCheckNode(node)` call sites (here and in
  `workflowRecovery.ts`) to include `isDeploymentNode`, so a deployment
  stage's own attempt budget and timeout are honoured by retry and
  timeout-detection exactly like a check stage's.
- `packages/core/src/workflows/workflowDeploymentPhase.ts` (new) — this is
  the task's "dedicated status rendering... show deploy/verify separately":
  `deploymentNodeDisplayPhase(outcome, phase)` turns the engine's generic
  `(outcome, phase)` pair into one of `not-started` / `deploying` /
  `verifying` / `succeeded` / `failed` / `cancelled`, so the designer and
  monitor can show "Deploying" and "Verifying" as visibly different states
  instead of collapsing both into one undifferentiated "running" dot. The two
  phase constants (`DEPLOYMENT_NODE_PHASE_DEPLOYING` /
  `_VERIFYING`) deliberately match `DeploymentRun`'s own `'deploying'` /
  `'verifying'` statuses (`projects/deploymentRunState.ts`, TASK-153) so a
  future executor (FX-BE-059) can report a workflow deployment stage's phase
  with the real `DeploymentRun`'s own status string verbatim, no translation
  layer needed.
- `workflowValidation.ts` — `deployment` added to the node-type set;
  `normalizeNode` gets a `deployment` case (defaults: empty
  `deploymentProfileId`, empty `outputs`, matching every other node's
  fail-safe-default discipline); a new `validateDeploymentNode` requires a
  non-empty `deploymentProfileId` and rejects `maxAttempts < 1` /
  `timeoutMs <= 0`, mirroring `validateCheckNode`'s shape exactly. The
  policy's `maxAttemptsPerNode` check now also covers deployment nodes.
- `workflowGates.ts` — **reusing gates**, the task's other named
  requirement: a deployment node's `satisfiesGate` is evaluated by
  `evaluateGates`/`approvalReadiness` through the identical `nodeGate` +
  node-outcome lookup a check node uses, and is marked `deterministic: true`
  the same way — a deployment stage's health verification is exit-code-grade
  evidence an agent cannot talk its way past, exactly like a check's exit
  code. No new gate logic was written; the existing machinery simply now
  recognizes a second deterministic node kind.
- `workflowRunSummary.ts` — `StageRow` gained `phase?: string`, populated
  from the node's live state and consumed by the monitor; `attemptBudget`
  now reports a deployment node's `maxAttempts` the same way it does for
  agent-task/check.
- `workflowDesignerState.ts` (core) and the renderer's `workflowEdits.ts`
  (its browser-safe mirror — the renderer may import only types from
  `@praxis/core` at runtime) — `newNode('deployment', ...)` factory;
  `removeNode`'s dangling-input cleanup now uses `nodeOutputs()` directly
  (a small simplification that replaces three separate per-type output
  checks with the one helper already built for exactly this); `duplicateNode`
  clears `satisfiesGate` and remaps output artifact ids for a deployment copy
  the same way it does for agent-task/check; `addOutput`/`removeOutput`
  (core-only — the renderer does not yet expose an outputs editor for any
  node type, deployment included) accept a deployment node too.
- Renderer (`apps/praxis-desktop/renderer/src`) — **designer**:
  `WorkflowDesignerPage.tsx` gets a "Deployment" entry in the stage rail
  (rocket icon) and a node inspector block (deployment profile id field,
  reused `GateSelect`); `railGate` widened to read a deployment node's gate
  for the rail badge. **Monitor**: `WorkflowRunMonitor.tsx`'s stage detail
  panel and `WorkflowPipeline.tsx`'s screen-reader-only stage list both call
  a small renderer-local `deploymentPhaseLabel` (a duplicated pure mirror of
  `deploymentNodeDisplayPhase`, per the renderer's established
  can't-import-core-values constraint) so a running deployment stage reads
  "Deploying"/"Verifying" instead of the generic outcome word, in both the
  visual panel and the accessible list — the task's own "visual/accessibility
  verification" language for monitor states, structurally satisfied even
  though this sandbox cannot launch Electron to capture it. **CSS**:
  `theme.css` gets `--wf-deployment` (reusing the existing `--tone-demo`
  token — free of collision with the other three workflow-node tones) and a
  `.wf-node--deployment` rule. While adding it I found and fixed a real,
  pre-existing bug in the same block: `.wf-node--agent` can never match,
  because `WorkflowCanvas.tsx` renders `wf-node--${node.type}` and the
  node's actual type string is `agent-task`, not `agent` — so every
  agent-task node has been silently falling back to the default
  `var(--accent)` border instead of `--wf-agent` since this rule was
  written. Renamed the selector to `.wf-node--agent-task` (with a comment
  explaining the naming) rather than leaving a second broken rule beside the
  one I was adding.
- Tests (30 new, all in `packages/core`, matching the deployment engine and
  the renderer's own can't-execute-Electron limits): `workflowValidation.test.ts`
  (round-trip normalization, missing-profile-id rejection, maxAttempts/timeoutMs
  bounds, policy attempt-cap rejection, a deployment node satisfying a gate a
  check node previously did — proving the swap is behaviorally identical),
  `workflowRun.test.ts` (`node-progress`: sets/advances/idempotent-replay,
  refused before start and after settling, cleared on retry and on settle,
  survives a JSON round-trip while running and is dropped once settled),
  `workflowGates.test.ts` (a deployment-backed gate is deterministic and
  blocks approval on failure, passes and unblocks approval on success — same
  two tests the check-backed gate already had, run against a deployment
  node instead), `workflowRunSummary.test.ts` (a stage row's `phase` tracks
  the reported value while running and is gone once settled),
  `workflowDesignerState.test.ts` (factory shape, add/remove output,
  dangling-input cleanup on removal, duplicate clears gate and remaps output
  ids), `workflowDeploymentPhase.test.ts` (new file — every outcome/phase
  combination, the unrecognized-phase-string fallback, and that every
  display phase has a distinct, non-empty label).

**Commands run:** `npx tsc -p .` (`packages/core`) — clean. Targeted
`node --test` on every touched core test file plus the new
`workflowDeploymentPhase.test.js` — 152/152 passing. `npm run test:core`
from the repo root (confirmed no stray background test/tsc processes first)
— **785/785 passing** (up from 755; 30 new). `npx tsc --noEmit -p .` in
`apps/praxis-desktop/main` — clean. `npm run check-types` in
`apps/praxis-desktop/renderer` (which runs `checkCoreImports.cjs` first,
enforcing the renderer-imports-types-only rule, then `tsc --noEmit`) —
clean.

**Existing workflow fixtures remain unchanged:** verified directly, not
assumed — `deliveryWorkflow()` in `workflowValidation.test.ts` and the
equivalent fixtures in `workflowRun.test.ts`/`workflowGates.test.ts`/
`workflowRunSummary.test.ts` (which use only `agent-task`/`check`/`approval`/
`join`) were not edited, and their existing round-trip-through-normalization
and structural-validation tests still pass byte-for-byte — the new node
type is additive (a new `case` in a `switch`, a new entry in a `Set`, a
widened `||` condition) and touches nothing about how the four existing
node types normalize, validate, schedule, or settle. `WORKFLOW_SCHEMA_VERSION`
was not bumped, since nothing about the existing shape changed.

**Deployment cannot bypass configured approval or QA:** not new machinery —
the existing rule that an approval node's `requiredGates` must each have an
upstream node whose `nodeGate()` matches (`validateGates` in
`workflowValidation.ts`) and that the run engine's `evaluateGates` decides a
gate strictly from a node's actual recorded outcome (never a claim) apply to
a deployment node exactly because it now participates in `nodeGate`/
`nodeOutputs` like any other gate-capable node — there is no separate,
weaker path for a deployment stage to mark a gate passed.

**Remaining limitations (honest, not deferred quietly):**

- No IPC or main-process wiring dispatches a deployment node automatically.
  `workflowOrchestratorInstance.ts` (main process) only auto-dispatches
  `agent-task`/`check` stages by design; a deployment node reaches `ready`
  in the schedule like any other node but sits there until a person manually
  advances it from the monitor (the same "Mark done" / "Mark failed" path a
  check node without a runner falls back to) — which is the correct, narrow
  scope here: the story's own exclusions state "No automatic production
  deployment... is implied by this story," and the real dispatch is
  FX-BE-059's ("Script-based direct deployment executor"), not this task's.
  `node-progress` (`'deploying'`/`'verifying'`) is real, tested
  infrastructure with nothing yet calling it in the app — FX-BE-059's
  executor is the first real caller.
- `workflows:startDiagnosis` (main process) and the monitor's "Diagnose"
  button remain check-only by design (verified, not touched): a deployment
  failure is not a shell-command-repro the existing evidence-bundle
  diagnosis flow fits, the same reasoning TASK-149 used to build a bespoke
  `previewVerificationSession.ts` rather than force a preview failure
  through that same flow. A deployment-specific diagnosis path, if wanted,
  is future scope, not a silent gap.
- The designer's deployment-profile field is a plain text input for
  `deploymentProfileId`, not a live picker against the project's actual
  deployment profiles (`DeploymentProfileStore`, TASK-151) — no IPC exists
  yet to list them from the renderer. That catalog experience is explicitly
  FX-BE-060's scope ("Build profile selection and review"), not this task's.
- No Electron capture/review was possible in this sandbox (no `node-pty`
  native binding; rebuild blocked by egress policy) — the designer and
  monitor changes compile clean end-to-end (core → main → renderer, with the
  renderer's own core-import boundary enforced) but were not visually
  exercised in the running app, across themes, narrow layouts, or keyboard
  focus. Marked `in-progress` rather than `complete` specifically because of
  this gap, consistent with every other UI-touching task in this session.
