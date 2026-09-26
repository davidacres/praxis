# Governed delivery workflows

A workflow is a validated DAG of stages a project runs to deliver one unit of
work: agents implement, deterministic checks verify, and a human approves — with
every transition and artifact recorded. This is the observable behaviour of a
run and how to reason about one that is blocked.

Where it lives in the app: select a project, then **Workflows** in the sidebar.
The page has two views — **Design** (edit a workflow) and **Runs** (start and
watch one).

## The built-in template

**Governed delivery**: `Plan → Implement → Praxis Test contracts → (Review ∥ (Install → Build → QA) ∥ Security) → Gates → Approve`.

| Stage | Kind | Tool Mode | Notes |
| --- | --- | --- | --- |
| Plan | agent | `read-only` | produces a `plan` artifact; inspects code without mutating |
| Implement | agent | `full` | writes the worktree; produces a `diff`; up to 2 attempts |
| Praxis Test contracts | agent | `full` | authors/updates test catalog & runs validator; mutates worktree; up to 2 attempts |
| Review | agent | `read-only` | inspects snapshot and change diff; satisfies the **review** gate |
| Install dependencies | check | — | `npm ci`; ensures clean dependency tree in the run worktree |
| Build | check | — | `npm run build --if-present`; verifies compilation |
| QA | check | — | `npm test`; satisfies the **qa** gate |
| Security scan | check | — | `npm audit`; audits against public registry; satisfies the **security** gate |
| Gates | join | — | waits for all three branches (Review, QA, Security) |
| Approve | approval | — | requires review + qa + security; no bypass |

### Stage tool modes

- **`read-only`**: The agent has local read tools (`read_file`, `list_dir`) sandboxed to the run's worktree. Shell execution (`run_shell`) and write tools (`write_file`) are disabled. Appropriate for planning, analysis, and code review.
- **`full`**: The agent has full read, write, and command execution tools (`read_file`, `list_dir`, `write_file`, `run_shell`) sandboxed to the worktree. Required whenever `mutatesWorktree: true` (such as `Implement` or authoring `Praxis Test contracts`).
- **`project-only`**: All filesystem tools are disabled. Reserved for folderless projects or non-code conversations; should not be used on code workflow stages that need to read or mutate repository files.

QA and security are **deterministic checks**, not agents, so an agent cannot
mark those gates passed by prose — their outcome is an exit code. Review, QA, and
security all inspect the *same immutable implementation snapshot* that Implement
and Test contracts froze, not whatever the worktree holds by the time each runs.

Agents are referenced by Agent Hub id only. The template stores no manifests; a
project points `praxis-planner` / `praxis-implementer` / `praxis-test-author` /
`praxis-reviewer` at real agents, and the designer's template list flags any id
that does not resolve *before* a run starts.

## Reading a run

The run detail pane opens with a one-sentence explanation of where the run is:

- **"Stage in progress: …"** — an agent session or check is running.
- **"… failed and can be retried or the run cancelled."** — a stage failed and
  still has attempts left. The stage row shows the error; use **Retry**.
- **"waiting for a human approval"** — every required gate has resolved.
- **"The run failed: Required stage … failed."** — a required stage exhausted
  its attempts. The run is terminal.
- **"The run was cancelled: …"** / **"completed: every required stage passed …"**

**Branch groups** show the parallel branches feeding each join and whether they
have **converged**. An advisory branch (an edge marked not-required) is labelled
as such; the run does not wait for it and its failure does not sink the run.

**Gates** lists each required gate, its state (`pending` / `passed` / `failed` /
`bypassed` / `missing`), and whether it rests on a deterministic check.

## What blocks approval

Approve is unavailable until every required gate — the union of the approval
stage's `requiredGates` and the project policy's — is `passed` or `bypassed`. A
`pending` gate cannot be bypassed: it has not failed, it simply has not
finished, and waving through running work is a race, not an exemption. A bypass,
where policy and the stage both allow one, records who did it, when, and why,
and stays on the run's event log.

Project policy composes over the global default **strictest-wins**: a project
can add required gates, demand human approval, or lower the attempt cap, but it
can never drop a gate the org requires. The designer reports any field the
global policy tightened.

## How a run advances

Starting a run hands it to the orchestrator, which drives it with no further
input:

- One **git worktree per run** is branched off the project's current branch on
  the first stage that needs it, shared by every stage, and removed when the
  run settles. A project with no git folder cannot run agent stages.
- A **deterministic check** spawns its command in that worktree, is killed at
  `timeoutMs` if set, and its exit code decides the outcome (`successExitCodes`,
  default `[0]`). Its stdout/stderr is saved as the node's declared artifact.
- An **agent stage** runs a real, attributed session: preflight fails closed
  first (an untrusted, invalid, unavailable, or capability-incompatible agent
  never opens a session), the session runs in the run worktree under the
  stage's tool mode, and a mutating stage's worktree is committed on
  completion — that commit is the immutable snapshot every downstream review,
  QA, and security stage inspects.
- **Joins and approvals** settle in the engine: a join with converged branches
  advances itself; an approval waits for a person.

The run monitor updates live as this happens — you do not need to be looking at
it. A stage past its `timeoutMs` is failed with a stated reason and offered for
retry within its attempt budget.

**Mark done / Mark failed** in the monitor remain for stages the orchestrator
declines: an agent stage in a project with no configured AI provider, or any
stage in a project with no working folder. A declined stage stays `ready` for
you to advance by hand.

## Restart recovery

A run is persisted after every transition. On app start, any stage that was
*running* when the app last stopped is closed as **interrupted** (the app cannot
know whether an agent left the worktree half-written) and surfaced for an
explicit retry; the orchestrator then re-enters the loop and picks up anything
still runnable. Completed stages are untouched and never re-run — the run
monitor comes back showing exactly the progress it had, and the run re-attaches
to its existing worktree rather than branching a second one.
