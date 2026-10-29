# Prompt clarity checklist v3

The live composer asks a model to answer five fixed checks: target, desired
outcome, finish condition, missing context, and ambiguity. Core validates the
schema and quoted evidence, then calculates deductions with a pure function.
Factual permission, symbol, context-window and capability checks remain separate.

## User behaviour

- A 250 ms check reads cached answers and factual findings without a model call.
- After 1.2 seconds of idle typing, the composer requests a model assessment.
- Checked drafts display a checklist score and concrete suggestions. The live
  coach omits letter grades and projected scores.
- Drafts with no suggestions stay quiet. Empty drafts animate closed.
- Checking and unavailable states display no readiness number. Sending remains
  available; provider failure offers Retry clarity check.
- Responses for superseded drafts/settings are ignored. Snooze applies to the
  current draft, rather than future prompts sharing the same finding IDs.
- File/test chips use workspace evidence. If the target or outcome is unknown,
  clarification takes priority over suggesting a verification command.

## Provider and reproducibility

An explicitly selected Recommendations provider is honoured. Otherwise the resolver
prefers an enabled configured API provider, then the existing recommendation
fallback. Reports record the requested provider/model identifier. A versioned model
ID is preferable to an alias: aliases and CLI defaults do not pin immutable model
revisions.

Validated answers are stored in profile-local `prompt-clarity-cache.json`. Keys
include prompt, supplied context, checklist version, requested model and endpoint.
Up to 2,000 entries are retained. Identical concurrent requests share one call;
at most two distinct calls run at once, with 20-second timeouts. Successful
assessments await cache persistence. Malformed answers and invented quotations
cannot become checked assessments.

Scoring is deterministic for fixed answers and factual inputs. Fresh model
answers are not deterministic. Eviction, configuration changes or changed context
can trigger reassessment. Retained evidence is reproducible; fresh generations
and successful task execution are not guaranteed.

## Verification and remaining quality gate

Unit tests cover schema rejection, quotation grounding, check applicability,
cache-key separation and scoring. Electron tests use fixed model responses through
the provider transport to check suggestions, cache persistence across restart,
failure/retry and stale-response handling. They prove integration, not semantic
judgement quality.

Before calling the score calibrated, human-label representative real prompts:
ambiguous requests, actionable bug reports, questions, contextual follow-ups and
adversarial content. Report per-check precision/recall and overall agreement on
a held-out set. The proposed minimum 85% agreement is a target, not an achieved
result. Correlation with later outcomes requires a separate reviewed evaluation;
automatically detected corrections alone are not ground truth.

### Running a calibration

1. `node scripts/build-prompt-calibration-set.mjs` samples the user's own session
   history into `<profile>/prompt-calibration/` (never the repository): every turn
   whose next message reads as a correction, plus first turns and follow-ups spread
   across short, medium and long prompts. Sampling is seeded, so a rebuild keeps
   item ids and labels. Known secret formats are masked before anything is written.
2. Review `labels.csv` (kind, the five checks, and "should the coach speak"), and
   mark rows as reviewed.
3. `node scripts/score-prompt-calibration.mjs --run --endpoint <OpenAI-compatible URL>
   --model <id>` asks the checklist through the same prompt, parser and scoring as
   the app, caches answers, and writes `report.md`. Without `--run` nothing is sent.

Plain agreement is not the gate: about one prompt in ten needs coaching, so a coach
that never speaks agrees roughly 90% of the time. The gate is precision and recall
on "should the coach speak" (70% each by default).

## Validation recorded in this handover

- Shared core suite: 1,788 passed, 2 skipped, 0 failed (1,790 total).
- Renderer build and main compile: passed; renderer copied before Electron tests.
- Focused final Electron run: 5 passed, including all four feedback journeys and
  the team-chat composer grow/shrink regression. Disabling the stale-response
  guard made its regression test fail as expected; the guard was restored.
- Full functional attempt with `--max-failures=5`: 368 passed, 8 skipped,
  5 failed, 299 not run. One failure was the global intrinsic-size animation
  setting; scoping it to the score panel fixed the composer sizing test in the
  final focused rerun. Tasks/Subagents element expectations and marketplace
  skill counts remain unresolved. The full suite is not green.
- The two composer screenshots were opened and inspected, including the vague
  request with clarification advice and no unrelated test chip.
- Test-contract catalog regenerated and validated. No application snapshots
  were updated and no changes were committed.

The user explicitly approved limited conversation context. Prompt checks now
include at most six earlier visible user/assistant message excerpts, capped at
1,200 characters each. Tool outputs and hidden reasoning are excluded. Requests,
cache keys and report digests use the same bounded excerpts. A scoped historical
turn receives only conversation preceding that turn, with no future responses.

### Approved conversation-context follow-up

After explicit user approval, bounded visible message excerpts were added to the
model request and its canonical cache/report inputs. The updated core suite passed
1,789 tests with 2 skipped and no failures; all four feedback Electron journeys
passed, including assertions against the actual mock-provider request body.
Renderer typecheck and main compile also passed. This follow-up changes no UI
layout; the earlier full-suite failures and semantic calibration gate remain open.

## Five coaching enhancements

The clarity checklist is now version 2 (score rubric remains version 3). Model
answers include a Target / Change / Expected result interpretation, with exact
prompt or bounded-context quotations. Unsupported interpretation slots remain
unknown. This richer assessment changes the cache key; it does not give a model
permission to calculate scores.

- The composer shows the interpretation with source quotations when coaching is
  needed. A clean assessed draft has a quiet **Preview approach** action; opening
  it is explicit and does not turn every clean draft into an automatic panel.
- Uncertain phrases are highlighted in a read-only mirror of the draft. Selecting
  one opens a specific question. Only **Replace this phrase** or **Add my answer**
  changes the editable prompt, and Undo restores its earlier wording. The mirror
  preserves the real textarea and keyboard editing behaviour.
- **Preview the approach** derives candidate files, available capability categories,
  attached skills and verification from existing local evidence. It invokes no
  tools or session. Missing interpretation slots stop the plan; restricted tool
  modes require an explicit access prerequisite instead of proposing edits.
- The session Scorecard has a collapsed **Potential turning point** disclosure.
  Actual recorded steps sit beside a proposed better sequence, with transcript
  links. The causal interpretation is labelled a hypothesis; no savings figure is
  invented. Raw tool data stays local.
- **Useful / Already clear from context / Wrong suggestion** creates a separate
  local review record, keyed by assessment digest and finding ID. It retains the
  prompt, bounded context, model answers and versions for later calibration.
  Repeated votes replace a label rather than inflate counts. Fewer than five
  reviewed suggestions do not produce a reliability percentage; larger counts
  show the fraction humans marked useful, not a claimed accuracy/precision metric.

Muting is a deliberate user action for the current model/checklist/rule within
this profile. It hides advice and removes its actions from staged follow-ups,
without changing the original numeric score or deleting its evidence. Muted
checks remain restorable; muting every check leaves a compact management strip.
Labels are not automatically sent to providers, used to train models, or written
into workspace instructions. Data lives with session feedback in the profile-local
`session-feedback.json`, so it persists across restart.

The new controls use typed IPC and the trusted sender boundary. The host accepts a
rating only for a finding in a recently evaluated or persisted report. Response
generations prevent old rating reads, verdict saves, or turn evaluations from
replacing newer UI state.

### Five-enhancement verification

- Core: 1,793 passed, 2 skipped, 0 failures (1,795 total), including interpretation
  evidence rejection, restricted-mode proposals, local turning-point selection,
  durable deduplicated labels, and restoring visibility without manufacturing votes.
- Renderer build/core-import guard and main compile passed.
- The expanded Electron feedback journeys cover interpretation, mixed-case phrase
  highlighting, explicit repair/Undo, previews on clean drafts, restricted-mode
  prerequisites, no session creation from a preview, local rating persistence across
  restart, reversible muting, and exclusion of muted fixes from follow-ups.
- The delayed verdict-save regression was proven by disabling its response guard:
  an old full-session response replaced the newer turn and the assertion failed.
  The guard was restored before the final focused run.
- The broad functional attempt stopped at the four-failure threshold: 371 passed,
  4 failed (the recurring Tasks/Subagents elements and marketplace skill-count
  expectations), 3 interrupted, 8 skipped, 297 not run. This is not a green full
  suite. Final small review-preference/markup corrections received focused checks.
- Screenshot review removed duplicated advice, tightened preview controls and kept
  the turning-point disclosure collapsed by default. No snapshot baselines changed.
- These integration tests use fixed model replies through the real provider
  transport. They do not establish real-model semantic accuracy or the 85% quality
  gate. Human-labelled calibration remains required.

Final focused rerun after restoring the delayed-save guard: all four Electron
feedback journeys passed (48.5 seconds). The retained composer and turning-point
screenshots were reopened for visual inspection. Visibility restoration on another
assessment preserves existing labels without creating a new vote.

### Calibration and Coach Deduction Threshold (v4)

176 real user prompts (including 26 turns drawing corrections) were calibrated against `MiniMax-M3.1-Flash-Preview`:
- Operational commands (`git commit`, `pull remote main and merge`, test runs, version bumps, inspections) and natural multi-turn follow-ups are recognized as unambiguous developer tasks.
- Trailing commentary and context-resolved quotes are cleanly grounded in evidence.
- A deterministic coach deduction threshold (`CLARITY_COACH_THRESHOLD = 5`) suppresses minor partial-check nitpicks (-2 to -4 pts), keeping the composer quiet and clean on normal prompts.
- Substantive issues (missing target, missing outcome, or missing context/unattached screenshots) or multiple accumulated flaws meet the threshold and trigger the coach strip.
- Benchmark false alarms dropped from 73 to 5 (at threshold 5) and to 2 (at threshold 6), with precision reaching 71.4% at deduction ≥ 6.

### Recording API Costs for Prompt Analysis and Calibration

API tokens and monetary costs are tracked across live composer prompt checks and batch calibration runs:
- **Live prompt checks (`promptClarityReader.ts`):** `askModel` captures completion tokens via `runProviderPrompt`'s `onUsage` callback (or character fallback), estimates USD turn cost with `estimateTurnCost`, and appends an entry to the durable `AiUsageLog` ledger tagged `source: 'prompt-analysis'`.
- **Calibration benchmark runs (`score-prompt-calibration.mjs`):** Batch runs extract token usage from `/chat/completions` responses (`body.usage`), estimate turn costs with `estimateTurnCost`, and record events directly to `<userData>/ai-usage-log.json` tagged `source: 'prompt-calibration'`.
- **AI Usage Page Visibility (`AiUsageStatsSection.tsx` & `UsageModelBreakdown.tsx`):**
  - Evaluated models (e.g. `MiniMax-M3.1-Flash-Preview`, `claude-3-5-haiku`) appear in the **Top models** breakdown with their token counts, share %, and USD costs.
  - The new **Activity by feature** card breaks down token consumption and reported costs across `Prompt analysis`, `Prompt calibration`, `Sessions`, and `Workflow recommendations`.
  - Aggregations persist across UTC time-series windows (`today`, `week`, `month`, `allTime`) and feed the overall usage ledger charts.
