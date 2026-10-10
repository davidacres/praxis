---
**Status:** 📋 To Do
**Created:** 2026-10-10T09:00:00.000Z
**Type:** Task
**Priority:** Low
id: TASK-439
title: Define the retry-decision value case and how the spike evidences it
status: To Do
story: FX-BE-136
feature: FX-BF-043
updated: 2026-10-10
---

# TASK-439: Define the retry-decision value case and how the spike evidences it

## Outcome

The spike has a falsifiable claim about what Jev would add for **deciding whether a
failed workflow stage should be retried**, a baseline to beat, and the exact
measurements that settle go / no-go. Written before any vendor call so the result
cannot be rationalised afterwards.

## What happens today (verified in code, 2026-10-10)

- A failed check stage is either `failed` (spends an attempt) or, when
  `classifyCheckEnvironmentFailure` fires, **paused for a person**
  (`pause: 'environment'`, `workflowCheckRunner.ts`). That classifier is deliberately
  narrow: command-not-found, plus registry-audit / auth / TLS / network signatures,
  and only for package-manager registry subcommands. `npm test` and `npm run …` are
  never second-guessed.
- Agent-stage provider limits are caught by `isProviderLimitError`.
- `maxAttempts` defaults to 1 (`workflowRecovery.ts`); a failed stage can always be
  re-run by a person, and `failureRecovery.maxAttempts` bounds automatic loops.
- So **the retry decision today is mostly a human one.** Anything outside the narrow
  signatures is a plain failure that waits for someone to look at it and click retry.

## Value hypothesis

Jev adds value only if it does at least one of these, measured on real Praxis logs:

1. **Recall of recoverable failures.** It identifies transient / environment failures
   the regexes miss (flaky test timeouts, `npm ci` dying mid-download, a rate-limit
   phrased in a way no signature knows), so those retry or pause with a useful hint
   instead of sitting as an opaque failure.
2. **Human time saved.** Each correct automatic retry removes a person noticing,
   reading the log and clicking retry. This is the number that matters.
3. **No new harm.** It almost never marks a real failure as retryable.

If (1) and (2) are not clearly above the rules, or (3) is violated, the answer is
**no-go**. "It is cleverer than regexes" is not value.

## Design: atomic questions, policy in code

One call per failed stage, all questions evaluated against the same scrubbed state
(command, exit code, last ~200 log lines, stage kind, attempt number). Jev's own
guidance is to ask gut-check questions and combine them in code.

| Id | Type | Question | Role |
| --- | --- | --- | --- |
| `code-error` | Noul | The log shows a compile, type, lint or assertion error in the changed code. | **Veto** — any value above the veto threshold means never retry |
| `environment` | Noul | The failure is caused by the machine, network or registry, not by the code change. | Retry gate |
| `transient` | Noul | The failure is intermittent in nature (timeout, flaky test, race, reset connection). | Retry gate |
| `provider-limit` | Noul | The log shows a provider rate limit or quota error. | Back off, do not retry immediately |
| `category` | Choice | `transient`, `environment`, `provider-limit`, `real-failure` | Routing and display; its confidence gates the rest |

Policy (code, unit-tested, tuned by constants):
`retry = !veto && max(environment, transient) ≥ T_retry && category.confidence ≥ T_conf && budget left`.
Anything else — including a failed call, timeout or low confidence — is **today's
behaviour**. The deterministic classifiers run first; a match never reaches the model.

## Evidence plan

### 1. Corpus

- Failed stage attempts from real run history (workflow runs persist per-node
  attempts with `outcome`, `error` and artifacts), plus the existing
  `checkEnvironmentFailure.test.ts` and provider-limit fixtures.
- Target **≥150 labelled failures**, at least 30 per class, deliberately including
  hard negatives: tests that fail on a real assertion while the log also contains
  the word "timeout" or "ECONNRESET".
- If real history is too thin, say so in the report and add clearly marked
  synthetic cases — never silently pad.
- Scrub secrets, tokens, absolute paths and repo content before anything is sent;
  record what the scrubber removes.

### 2. Ground truth that is not circular

Labels must not come from the rules or from Jev. Per failure, in order of strength:

- **Outcome-based:** a later attempt of the same stage on the same commit succeeded
  with no code change ⇒ recoverable. A later success only after a code change ⇒
  real failure.
- **Human-labelled** by a maintainer for the rest, blind to both systems' output.
- Label set: `transient`, `environment`, `provider-limit`, `real-failure`.
- Hold out a **test split** the thresholds are never tuned on; tune on the rest.

### 3. Systems compared on the same corpus

A. Current rules only (baseline). B. Rules, then Jev on what the rules did not
decide (the proposed product). C. Optional control: the same bundle sent to a small
general model with a JSON schema — answers "is Jev better, or is any model fine?".

### 4. Metrics and the bar for go

| Metric | Why | Bar for go |
| --- | --- | --- |
| **Unsafe-retry rate**: real failures that B would retry or hide ÷ all real failures | The harm metric | ≤ 1% on the test split, 95% upper bound reported; any systematic miss class is a no-go |
| **Recoverable recall**: recoverable failures B handles that A did not ÷ all recoverable failures A missed | The value metric | ≥ 40% of what the rules miss, and ≥ 10 absolute cases |
| Precision of retry decisions | Wasted attempts | ≥ 90% of automatic retries should have been recoverable |
| Coverage at threshold | Share of inputs Jev decides at all | Reported; low coverage caps the value |
| Calibration | Are the confidences honest? | Reliability table; the chosen `T_conf` must hold on the test split, not just the tuning split |
| p50 / p95 latency, cost per 1,000 decisions | Vendor claims | Reported; not a go criterion because stages run for minutes |
| Veto effectiveness | Does `code-error` stop confident wrong retries? | Count of unsafe retries with and without the veto |

The bar is stated here so it can be argued with now. A maintainer may change it, but
the change is recorded before the run, not after.

### 5. Turning accuracy into value

Report, from the same corpus: the share of failed stages that were actually
recoverable, how many of those A handled, how many B adds, and the estimated human
interventions per 100 failed stages removed. Multiply by a stated minutes-per-
intervention assumption so the maintainers can judge it in time, not percentages.
If that number is small, the report says "accurate but not worth shipping".

### 6. Honest limits to report

- Results are for this repo's stacks and logs; they do not transfer elsewhere.
- Small corpora give wide intervals — report them, do not round them away.
- Vendor terms (retention, training on inputs) can block a go regardless of accuracy.

## Acceptance criteria

- The bar above is recorded and unchanged before TASK-372 runs.
- TASK-371 builds the corpus and harness for exactly these systems and metrics.
- TASK-372's report states, for the retry decision: unsafe-retry rate with its
  bound, recoverable recall, estimated interventions removed, and a go / no-go
  against the bar.

## Description


## Comments

## Dependencies

- Informs TASK-371 and TASK-372.
