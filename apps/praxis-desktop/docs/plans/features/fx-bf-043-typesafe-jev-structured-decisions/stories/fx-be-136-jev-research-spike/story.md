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
tasks: [TASK-370, TASK-371, TASK-372]
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
- Measured p50/p95 latency and cost per 1,000 decisions, from real calls.
- A clear recommendation: go (with the first target and threshold), no-go, or wait.

## Task list

- `TASK-370` — Read the docs; record API shape, auth, limits, data and licence terms.
- `TASK-371` — Assemble scrubbed fixtures and an offline comparison harness.
- `TASK-372` — Run the comparison, verify vendor claims, and write the report.

## Validation

- No app code changes, so `git diff` outside `docs/` should be empty.

## Close when

The report is attached to `FX-BF-043` and the feature carries a go / no-go decision.

## Description


## Dependencies


## Comments
