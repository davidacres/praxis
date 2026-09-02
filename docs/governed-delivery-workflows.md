# Governed delivery workflows

A workflow is a validated DAG of stages a project runs to deliver one unit of
work: agents implement, deterministic checks verify, and a human approves — with
every transition and artifact recorded. This is the observable behaviour of a
run and how to reason about one that is blocked.

Where it lives in the app: select a project, then **Workflows** in the sidebar.
The page has two views — **Design** (edit a workflow) and **Runs** (start and
watch one).

## The built-in template

**Governed delivery**: `Plan → Implement → (Review ∥ QA ∥ Security) → Gates → Approve`.

| Stage | Kind | Notes |
| --- | --- | --- |
| Plan | agent | read-only; produces a `plan` artifact |
| Implement | agent | writes the worktree; produces a `diff`; up to 2 attempts |
| Review | agent | read-only; satisfies the **review** gate |
| QA | check | `npm test`; satisfies the **qa** gate |
| Security scan | check | `npm audit`; satisfies the **security** gate |
| Gates | join | waits for all three branches |
| Approve | approval | requires review + qa + security; no bypass |

QA and security are **deterministic checks**, not agents, so an agent cannot
mark those gates passed by prose — their outcome is an exit code. Review, QA, and
security all inspect the *same immutable implementation snapshot* that Implement
froze, not whatever the worktree holds by the time each runs.

Agents are referenced by Agent Hub id only. The template stores no manifests; a
project points `praxis-planner` / `praxis-implementer` / `praxis-reviewer` at
real agents, and the designer's template list flags any id that does not
resolve *before* a run starts.

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

## Restart recovery

A run is persisted after every transition. On app start, any stage that was
*running* when the app last stopped is closed as **interrupted** (the app cannot
know whether an agent left the worktree half-written) and surfaced for an
explicit retry. Completed stages are untouched and never re-run — the run
monitor comes back showing exactly the progress it had.

## Driving stages

Until agent runtime session integration lands (FX-BF-011), the monitor advances
stages explicitly — **Mark done** / **Mark failed** on a ready stage. This is
the seam the real orchestrator plugs into: it will create an attributed agent
session per stage and record the same outcomes.
