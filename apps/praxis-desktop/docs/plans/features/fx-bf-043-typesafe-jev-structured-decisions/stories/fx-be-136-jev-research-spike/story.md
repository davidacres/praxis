---
**Status:** 📋 To Do
**Created:** 2026-09-21T09:00:00.000Z
**Type:** Story
**Priority:** Low
type: Story
id: FX-BE-136
title: "Research spike: evaluate Jev against Praxis's classification sites"
status: Proposed
feature: FX-BF-043
updated: 2026-09-21
tasks: [TASK-370, TASK-371, TASK-372, TASK-439]
dependencies: []
validation: [npm run check-types --workspace=@praxis/core]
---

# FX-BE-136: Research spike: evaluate Jev against Praxis's classification sites

## User or operational impact

Maintainers get a go / no-go answer, backed by measurements on Praxis's own data,
on whether a hosted structured-decision model is worth adding. **This is research
only — no product code, no settings, no UI, and no data sent to TypeSafe from the
app.** Deferred; not scheduled.

## Sources to start from

- Launch post: https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Console / API: https://console.typesafe.ai
- Vendor: https://typesafe.ai
- Background and constraints: `FX-BF-043` `feature.md`.

## Scope

- Read the console/API documentation and record the real request/response shape,
  auth, rate limits, data retention, training-on-customer-data terms, licence, and
  whether any self-hosted option exists.
- Build an **offline** evaluation harness (a script in the scratchpad or a
  non-shipped test) that runs real Praxis inputs through Jev and through the current
  rules, and compares them.
- Use **"should a failed stage be retried?"** as the primary target: it is where a
  correct answer saves human time. Evidence design and the go bar are in `TASK-439`.
- Produce a short written report with a recommendation.

## Out of scope

- Any change under `packages/core`, `apps/praxis-desktop/main` or `renderer`.
- Adding a provider, a setting, a dependency, or a key to the app.
- Sending secrets, tokens, or private repository content to the vendor. Use
  scrubbed or synthetic inputs and say so in the report.

## Acceptance criteria

- The report records the verified API shape and terms, and flags every claim from
  the launch post that was checked (latency, price, cardinality, "no hallucination").
- For each candidate site, accuracy of Jev vs the current rules is reported on at
  least the existing fixtures, plus the confidence threshold at which Jev's answers
  are trustworthy and the share of inputs above it.
- For the retry decision: unsafe-retry rate (with upper bound), recoverable recall
  over the current rules, and estimated human interventions removed per 100 failed
  stages, judged against the bar fixed in `TASK-439` before the run.
- Measured p50/p95 latency and cost per 1,000 decisions, from real calls.
- A clear recommendation: go (with the first target and threshold), no-go, or wait.

## Task list

- `TASK-439` — Define the retry-decision value case, baseline and evidence bar (do first).
- `TASK-370` — Read the docs; record API shape, auth, limits, data and licence terms.
- `TASK-371` — Assemble scrubbed fixtures and an offline comparison harness.
- `TASK-372` — Run the comparison, verify vendor claims, and write the report.

## Validation

- No app code changes, so `git diff` outside `docs/` should be empty.

## Close when

The report is attached to `FX-BF-043` and the feature carries a go / no-go decision.

## Description

### Primary target: should a failed workflow stage be retried?

Today a failed stage either fails and spends an attempt, or (when
`classifyCheckEnvironmentFailure` fires on a narrow set of registry/network
signatures) pauses for a person. `maxAttempts` defaults to 1, so in practice **a
person reads the log and decides whether to retry.** Jev is only worth adopting if it
removes a meaningful share of those interventions without ever retrying a real
failure.

### Approach

One Jev call per failed stage, against a scrubbed state (command, exit code, log
tail, stage kind, attempt number), asking atomic questions and combining them in code:

- `code-error` (Noul) — **veto**: any high value means never retry.
- `environment`, `transient` (Noul) — retry gates.
- `provider-limit` (Noul) — back off rather than retry immediately.
- `category` (Choice: transient / environment / provider-limit / real-failure) — routing, display, and a confidence gate.

`retry = !veto && max(environment, transient) >= T_retry && category.confidence >= T_conf && budget left`.
Deterministic classifiers run first; any error, timeout or low confidence falls back
to today's behaviour.

### How the value is evidenced

- Corpus of **>=150 labelled failures** from real run history (>=30 per class, with hard negatives); synthetic cases clearly marked.
- Labels from **outcomes first** (same stage, same commit, later passed with no code change), then blind human labels; thresholds tuned on one split, reported on a held-out split. Neither the rules nor Jev produce labels.
- Compare A) current rules, B) rules then Jev, C) optional small-model control.
- **Bar for go (fixed before the run):** unsafe-retry rate <=1% of real failures (with 95% upper bound); recovers >=40% of what the rules miss and >=10 absolute cases; >=90% precision on automatic retries; calibration holds on the test split.
- Report the result as **estimated human interventions removed per 100 failed stages**, not only as accuracy. Accurate but small is a no-go.

Full design, metrics table and honest limits: `TASK-439`.

## Dependencies


## Comments

**2026-10-10 — evidence design added.** Verified in code that retry is mostly a human
decision today (`workflowCheckRunner.ts` pauses only on the narrow
`classifyCheckEnvironmentFailure` signatures; `workflowRecovery.ts` defaults
`maxAttempts` to 1), so the spike's primary target is the retry decision and its
value is judged in human time saved. Thresholds in `TASK-439` are proposals by the
author of this note; a maintainer should confirm or change them **before** the run,
and any change is recorded here. Not yet checked: how much real failed-run history
exists to build the corpus from — if it is thin, the report must say that limits what
the spike can prove. `PLAN_MAP.md` has not been regenerated for `TASK-439`.
