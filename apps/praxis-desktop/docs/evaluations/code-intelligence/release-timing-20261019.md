# Release timing and TypeScript/JavaScript accuracy

## Decision context

The user considers a search taking about half a second acceptable. These measurements concern the time to return the first ten results, including required response-budget pagination. They do not measure agent explanation generation, whole-session task completion, indexing or UI rendering.

The earlier 104 ms original-engine, 766 ms semantic-candidate and 435 ms shared-scan measurements used **Debug service assemblies**. They remain valid comparisons of those development builds, but were not qualified as packaged-app timings. `scripts/build-service.mjs` builds the development service with the default configuration and explicitly publishes packaged service assets with `--configuration Release`. This distinction should have been stated earlier.

This pass tests the current shared-scan source in both Debug and Release. It does **not** compare an original pre-feature Release engine with a current Release engine, so it does not establish the relative packaged-build cost of the original semantic feature.

## Remaining cost and rejected experiment

Private diagnostic instrumentation measured median Debug times across the frozen 24-question desktop plan: reading/checking database rows approximately **213 ms**, scoring/aggregation approximately **168 ms**, final ranking approximately **1.6 ms**, scanning 49,494 chunks. Stopwatch instrumentation is diagnostic overhead; it was not shipped or used in the main timing builds.

An SQL prototype materialized eligible embedding sets so completeness checks could run once per set. On the identical database it returned the same 49,494 rows, but warm Python/SQLite scan medians were approximately **167 ms before versus 184 ms after**, around 10% slower. The first cold observation was retained separately and excluded from that warm comparison. **The SQL prototype was rejected. No additional service-code or production configuration change was applied in this pass.**

Before making another speculative source optimization, the existing packaging configuration was qualified. The Release clone matches all 50 current service source files; its manifest and assembly hashes are preserved. The service model, vectors, query views and ranking rules are unchanged.

## Sequential warm timings

Each arm used identical frozen databases, source and model assets. Compared the current Debug and Release service builds through the same helper source, with only one active request at a time. All native tests and retrieval evaluations completed before timing. Per-language plans use three repetitions, counterbalanced arm/query order with recorded seeds. Both search modes were warmed before measurement. Desktop uses the existing 24-question plan; broader TypeScript uses all 30 positive natural-language questions; JavaScript uses all 20 natural-language questions. This is not a claim that those numbers describe all repositories of either language.

| Fixture | Mode | Calls per arm | Debug median / p95 (ms) | Release median / p95 (ms) |
| --- | --- | ---: | ---: | ---: |
| Desktop TypeScript | vector | 72 | 425.2 / 607.4 | 269.1 / 307.6 |
| Broader Praxis TypeScript | vector | 90 | 447.0 / 636.0 | 294.1 / 333.6 |
| Broader Praxis TypeScript | hybrid | 90 | 378.9 / 400.2 | 297.3 / 313.8 |
| markdown-it JavaScript | vector | 60 | 33.4 / 41.2 | 28.5 / 33.6 |
| markdown-it JavaScript | hybrid | 60 | 16.8 / 20.0 | 15.0 / 19.7 |

**All 372 measured warm Release requests completed within 500 ms**, including both semantic and hybrid searches. Each timed pair returned the same top ten; rankings remained stable across repetitions. Full vector coverage and snapshot stability checks passed. The desktop, broader TypeScript and JavaScript fixtures contain 21,583, 28,262 and 271 symbols respectively; the JavaScript fixture is small.

First requests in the fresh Release helpers took **646 ms desktop**, **695 ms broader TypeScript**, and **260 ms JavaScript**, including model initialization. These are individual warmup observations, not a cold-start distribution; process launch and full app startup were not timed, and OS caches were not deliberately cleared. The half-second observation applies to measured warm requests, not every possible first search or larger index.

## Accuracy

Release preserves **all 1,108 complete result lists and scored relevance metrics** from the shared-scan Debug replay: 504 desktop three-mode comparisons, 40 acceptance questions, 360 Maze C# comparisons, 144 broader TypeScript comparisons and 60 JavaScript comparisons. There are no new ranking changes from this pass.

Semantic Hit@10 means the expected answer appears in the first ten results; it does not measure the correctness of an agent's final explanation.

| Natural-language set | Original semantic | Current semantic |
| --- | ---: | ---: |
| Desktop fresh acceptance, 40 questions | 23/40 (57.5%) | 35/40 (87.5%) |
| Original desktop comparison, 64 questions | 40/64 (62.5%) | 46/64 (71.9%) |
| Broader Praxis TypeScript, 30 questions | 26/30 (86.7%) | 29/30 (96.7%) |
| markdown-it JavaScript, 20 questions | 11/20 (55%) | 11/20 (55%) |

JavaScript is **not an overall accuracy improvement**: semantic Hit@10 is unchanged in aggregate, with three previously missed questions rescued and three previous successes lost. Semantic MRR improves from 0.2546 to 0.2972, but hybrid loses one question: **6/20 (30%) to 5/20 (25%)**, and hybrid MRR declines from 0.1450 to 0.0788. This is the previously recorded regression, not a Release or shared-scan regression. Its fast timing does not resolve it.

Broader TypeScript hybrid Hit@10 improves from 24/30 to 27/30, while its MRR changes slightly downward (0.6750 to 0.6722). The claims of better accuracy refer to answer availability in the top ten, not improvement on every ranking metric or every question.

The acceptance and timing question sets differ and their denominators are not pooled. All-development semantic Hit@10 remains 67/96 (69.8%). Maze C# remains unchanged. Human independent relevance review, agent-answer comparisons and full compiler context for the copied broader TypeScript/JavaScript fixtures remain outstanding; see [extended validation](extended-validation-20261019.md).

## Conclusion and verification

Under the user's stated tolerance, the current TypeScript candidate's measured warm search cost (roughly 0.27–0.30 seconds) is acceptable on these fixtures while retaining its measured retrieval gains. Extra speed experiments are not currently the priority. JavaScript hybrid accuracy needs separate resolution before calling this a general improvement across both languages. No overall-agent-time benefit or whole-product release acceptance is claimed.

The Release service build and **200/200 Release service tests pass, with no skips**. The built clone's 50 service source files match the workspace, and all evaluation databases remain unchanged. No UI change or visual verification occurred. The running app, owner service and live index remain unchanged; no app reload, deployment, commit or publication was performed.

## Evidence

Under `.praxis/session-artifacts/code-intelligence-benchmark/`:

- `remaining-cost-profile/`: private diagnostic source and timings, rejected SQL prototype and raw results, per-language frozen plans, timing helper and orchestration, 50-file source manifest, Release TRX and comparison summary.
- `release-all-modes/`, `release-acceptance/`, `release-maze/`, `release-typescript/`, `release-javascript/`: full raw responses and metrics.
- `release-latency-desktop/`, `release-latency-typescript/`, `release-latency-javascript/`: paired timings, plans, metadata/hashes and raw responses, including warmups.

The Release harness is framework dependent under the installed .NET runtime, not the complete self-contained packaged app. These are service timings with the packaging build configuration, without owner transport/UI overhead; packaged end-to-end timing and release-scale capacity remain separate checks.
