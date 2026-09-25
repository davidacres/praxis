---
**Status:** 📋 To Do
**Created:** 2026-09-21T09:00:00.000Z
**Type:** Feature
**Priority:** Low
id: FX-BF-043
slug: typesafe-jev-structured-decisions
title: TypeSafe Jev structured-decision model (deferred evaluation)
status: Proposed
owner: Electron desktop app
updated: 2026-09-21
stories: [FX-BE-136]
---

# FX-BF-043: TypeSafe Jev structured-decision model (deferred evaluation)

## Outcome

Praxis has a recorded, evidence-backed answer to whether TypeSafe AI's **Jev** — a
hosted "System One" model that returns schema-typed values with calibrated
confidence instead of generated text — should back the small classification
decisions Praxis currently makes with regexes and synonym tables. **This feature
is parked. Nothing here is built until a pick-up decision is made** (see "Pick-up
criteria"). It exists so the research, the links and the design constraints are not
lost.

## Background: what Jev is

Details below were gathered on 2026-09-21 from the launch post, via a
summarising fetch — **treat them as vendor claims, unverified**, and re-read the
source before relying on any number.

- **Source:** https://typesafe.ai/blog/introducing-system-one-models-and-jev
- **Console / API access:** https://console.typesafe.ai (referenced by the post)
- **Vendor site:** https://typesafe.ai
- **What it is:** the first public "System One Model" — a model class built for
  *automation inside software*, not chat. Early access as of September 2026.
- **Behaviour:** takes unstructured input and returns type-safe structured values
  with calibrated confidence scores. Outputs are generated **in parallel**, not
  token by token, and always conform to a predefined schema (the vendor says it
  "can't hallucinate" and never produces type errors — this means the *shape* is
  guaranteed, **not** that the chosen value is correct).
- **Claimed performance:** 70 ms–500 ms end to end (stated as 40x–200x faster than
  frontier models); input $0.042 per million tokens; output "free".
- **Access:** hosted API through the console; a "System One LLM wrapper" for Python
  is mentioned. **No local/self-hosted option and no licence terms were stated.**
- **Stated limits:** optimised for structured decisions only ("gives up string
  generation"); **maximum cardinality of 255** for a choice; **no image input**;
  early access with acknowledged gaps in real-world testing.

## Why it might be useful here

Praxis makes several small "which of N things is this?" decisions with
hand-maintained rules. Candidate sites (verify each still exists before starting):

| Candidate | Where | Today | Risk if wrong |
| --- | --- | --- | --- |
| Freeform plan status → workflow stage | `resolveStatus` (`projects/projectWorkflow.ts`), last tier | Falls to the first stage — a silent wrong answer | Low: a mis-filed card |
| Stage failure triage (real failure vs environment vs provider limit) | `classifyCheckEnvironmentFailure` (core), `isProviderLimitError` | Deliberately narrow signatures | **High**: a false "environment" pauses and hides a real failure |
| Choosing a workflow edge (success / failure / always) | workflow orchestrator | Deterministic | Medium |

The first is the recommended trial: cheapest to test, lowest blast radius.

## Design constraints for any future integration

These come from `AGENTS.md` and from the reasons the idea was parked; they are the
conditions under which it is acceptable to proceed.

- **Opt-in, off by default.** Follow the AI-provider pattern in Settings → AI
  Provider (`AI_PROVIDERS`, `isProviderUsable`, key in the secret store, an `enabled`
  switch where *unset means off* for this one — a new third party must not be called
  by existing setups). Add any settings field to `settingsDefaults.ts` too.
- **Deterministic rules run first.** The model sees only what the rules cannot
  decide; a confident deterministic match never goes to it.
- **Low confidence is "unknown", never a guess.** Below threshold, fall back to
  today's behaviour — for failure triage that means *a real failure*, not a pause.
- **The renderer must not value-import core** (`npm run check-core-imports`); the
  client belongs in `packages/core` and is called from main.
- **Data leaves the machine.** Plan text and build logs would go to a third party.
  Needs a clear disclosure in Settings and must never include secrets or tokens.
- **Tests without the network.** Mock the client; add fixtures of real Praxis inputs
  and a negative case per rule, as `checkEnvironmentFailure.test.ts` does.

## Risks or open questions

- API shape, auth, rate limits, data retention and training-use terms are
  **undocumented in the post** — read the console docs first.
- The confidence scores are uncalibrated for *our* inputs until measured.
- Early-access product from a small vendor: pricing, availability and the API can
  change or vanish. Keep the integration behind one small interface.
- Cardinality limit (255) is ample for stages/edges but rules out free-form output.
- Modest upside: Praxis's slow, expensive steps are agent runs, not classification.

## Pick-up criteria

Start implementation only if **all** hold: FX-BE-136's report shows the model beats
the current rules on real Praxis fixtures at a usable confidence threshold; the
vendor's terms allow sending this data; and a maintainer has chosen a first target.
Otherwise close this feature as "won't do" with the report attached.

## Story map

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-136 | Research spike: evaluate Jev against Praxis's classification sites | Proposed | — |

## Dependencies

- None. Related context: `FX-BF-019` (workflow as data / `resolveStatus`),
  `FX-BF-021` (failure diagnosis), `FX-BF-013` (workflow orchestration runtime).

## Close when

The research story is done and a written go / no-go decision is recorded here. No
production code ships under this feature until a go decision exists.

## Description

---
**Status:** 📋 To Do
**Created:** 2026-09-21T09:00:00.000Z
**Type:** Feature
**Priority:** Low
id: FX-BF-043
slug: typesafe-jev-structured-decisions
title: TypeSafe Jev structured-decision model (deferred evaluation)
status: Proposed
owner: Electron desktop app
updated: 2026-09-21
stories: [FX-BE-136]
---

# FX-BF-043: TypeSafe Jev structured-decision model (deferred evaluation)

## Outcome

Praxis has a recorded, evidence-backed answer to whether TypeSafe AI's **Jev** — a
hosted "System One" model that returns schema-typed values with calibrated
confidence instead of generated text — should back the small classification
decisions Praxis currently makes with regexes and synonym tables. **This feature
is parked. Nothing here is built until a pick-up decision is made** (see "Pick-up
criteria"). It exists so the research, the links and the design constraints are not
lost.

## Background: what Jev is

Details below were gathered on 2026-09-21 from the launch post, via a
summarising fetch — **treat them as vendor claims, unverified**, and re-read the
source before relying on any number.

- **Source:** https://typesafe.ai/blog/introducing-system-one-models-and-jev
- **Console / API access:** https://console.typesafe.ai (referenced by the post)
- **Vendor site:** https://typesafe.ai
- **What it is:** the first public "System One Model" — a model class built for
  *automation inside software*, not chat. Early access as of September 2026.
- **Behaviour:** takes unstructured input and returns type-safe structured values
  with calibrated confidence scores. Outputs are generated **in parallel**, not
  token by token, and always conform to a predefined schema (the vendor says it
  "can't hallucinate" and never produces type errors — this means the *shape* is
  guaranteed, **not** that the chosen value is correct).
- **Claimed performance:** 70 ms–500 ms end to end (stated as 40x–200x faster than
  frontier models); input $0.042 per million tokens; output "free".
- **Access:** hosted API through the console; a "System One LLM wrapper" for Python
  is mentioned. **No local/self-hosted option and no licence terms were stated.**
- **Stated limits:** optimised for structured decisions only ("gives up string
  generation"); **maximum cardinality of 255** for a choice; **no image input**;
  early access with acknowledged gaps in real-world testing.

## Why it might be useful here

Praxis makes several small "which of N things is this?" decisions with
hand-maintained rules. Candidate sites (verify each still exists before starting):

| Candidate | Where | Today | Risk if wrong |
| --- | --- | --- | --- |
| Freeform plan status → workflow stage | `resolveStatus` (`projects/projectWorkflow.ts`), last tier | Falls to the first stage — a silent wrong answer | Low: a mis-filed card |
| Stage failure triage (real failure vs environment vs provider limit) | `classifyCheckEnvironmentFailure` (core), `isProviderLimitError` | Deliberately narrow signatures | **High**: a false "environment" pauses and hides a real failure |
| Choosing a workflow edge (success / failure / always) | workflow orchestrator | Deterministic | Medium |

The first is the recommended trial: cheapest to test, lowest blast radius.

## Design constraints for any future integration

These come from `AGENTS.md` and from the reasons the idea was parked; they are the
conditions under which it is acceptable to proceed.

- **Opt-in, off by default.** Follow the AI-provider pattern in Settings → AI
  Provider (`AI_PROVIDERS`, `isProviderUsable`, key in the secret store, an `enabled`
  switch where *unset means off* for this one — a new third party must not be called
  by existing setups). Add any settings field to `settingsDefaults.ts` too.
- **Deterministic rules run first.** The model sees only what the rules cannot
  decide; a confident deterministic match never goes to it.
- **Low confidence is "unknown", never a guess.** Below threshold, fall back to
  today's behaviour — for failure triage that means *a real failure*, not a pause.
- **The renderer must not value-import core** (`npm run check-core-imports`); the
  client belongs in `packages/core` and is called from main.
- **Data leaves the machine.** Plan text and build logs would go to a third party.
  Needs a clear disclosure in Settings and must never include secrets or tokens.
- **Tests without the network.** Mock the client; add fixtures of real Praxis inputs
  and a negative case per rule, as `checkEnvironmentFailure.test.ts` does.

## Risks or open questions

- API shape, auth, rate limits, data retention and training-use terms are
  **undocumented in the post** — read the console docs first.
- The confidence scores are uncalibrated for *our* inputs until measured.
- Early-access product from a small vendor: pricing, availability and the API can
  change or vanish. Keep the integration behind one small interface.
- Cardinality limit (255) is ample for stages/edges but rules out free-form output.
- Modest upside: Praxis's slow, expensive steps are agent runs, not classification.

## Pick-up criteria

Start implementation only if **all** hold: FX-BE-136's report shows the model beats
the current rules on real Praxis fixtures at a usable confidence threshold; the
vendor's terms allow sending this data; and a maintainer has chosen a first target.
Otherwise close this feature as "won't do" with the report attached.

## Story map

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-136 | Research spike: evaluate Jev against Praxis's classification sites | Proposed | — |

## Dependencies

- None. Related context: `FX-BF-019` (workflow as data / `resolveStatus`),
  `FX-BF-021` (failure diagnosis), `FX-BF-013` (workflow orchestration runtime).

## Close when

The research story is done and a written go / no-go decision is recorded here. No
production code ships under this feature until a go decision exists.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments
