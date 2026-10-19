# Shared vector scan: accuracy preservation and latency

Build qualification: the timings below use Debug service assemblies. See the subsequent [Release timing and language comparison](release-timing-20261019.md) for packaging-configuration measurements and the user's half-second tolerance assessment. The recorded Debug results are retained unchanged.

## Result

The semantic query variants now share one validated database scan. The model, representation format (5), stored vectors, query variants, per-view top-100 selection and reciprocal-rank fusion weights remain unchanged. This optimization reduces repeated SQL joins, revision/completeness/eligibility checks and vector-byte reads. The existing similarity scorer still runs for each query view; this is not a claim that all vector arithmetic or norm checks execute only once.

| Warm semantic request latency | Before optimization | Shared scan |
| --- | ---: | ---: |
| Median | 715.6 ms | 434.5 ms |
| 95th percentile | 1381.2 ms | 609.5 ms |
| Mean | 902.7 ms | 475.3 ms |

Median latency falls **39.3%**; p95 falls **55.9%**. This recovers part of the earlier slowdown. It does not restore the original pre-feature latency: the earlier original-engine measurement was approximately 104 ms median and 120 ms p95. Those historical measurements are a separate run, not a third arm of this timing experiment. This result does not establish release readiness or a better overall default.

## Timing method and profile

Used the unchanged `latency-plan.praxis.json`: 24 desktop natural-language questions across 12 domains, three repetitions, 72 requests per arm. Counterbalanced sequential requests, two resident idle engines, warmup excluded, required pagination included through the first ten results. Both arms used the same frozen generation-79/epoch-193 database and the same helper source; only the service assembly differs. Retrieval evaluations and native tests finished before timing. No concurrent evaluation or model provisioning ran during timing. Every timed request had full vector coverage, stable snapshot identity and identical top-ten results between arms; rankings were stable across repetitions.

A separate direct profile calls production `QueryEmbedding` and `Candidates`, after timing. It measures embedding separately from opening the read connection/transaction and retrieving/scoring candidates; response assembly is excluded. Two passes over the same 24 questions with reversed arm order; summarize the warm second pass:

| Median component | Before | Shared scan |
| --- | ---: | ---: |
| Query embedding | 12.58 ms | 12.64 ms |
| Candidate retrieval and scoring | 690.61 ms | 381.61 ms |

These component medians are not additive estimates of the median end-to-end request. They identify candidate retrieval/scoring as the dominant cost, but do not separately attribute SQL, vector arithmetic and dictionary overhead. SIMD scoring already interprets little-endian bytes without allocating a decoded float array; no extra decode-cache speedup is claimed.

## Accuracy and correctness

**1,108 comparisons preserve the scored top-ten result lists and relevance metrics:**

| Replay | Comparisons | Result |
| --- | ---: | --- |
| Desktop, 168 queries in three modes | 504 | Same top ten and metrics; all integrity checks pass |
| Desktop acceptance | 40 | Same complete lists/ranks; 35/40, 87.5%, MRR 0.54215 |
| Maze C# | 360 | Complete lists and metrics identical |
| Broader Praxis TypeScript | 144 | Complete lists and metrics identical |
| markdown-it JavaScript | 60 | Complete lists and metrics identical |

The desktop historical archive contains one ordering difference outside the scored range: `F28-e`, vector ranks 17/18. It predates this optimization and used the older format-4 snapshot. A direct replay through the current unoptimized and optimized engines on the identical format-5 database matches all 20 results **including scores**. The other 503 historical full lists match. Raw diagnostic responses and the discrepancy are retained rather than silently ignored.

Original natural-language retrieval remains 46/64 (71.875%); all-development remains 67/96 (69.8%, below 70%). The existing JavaScript hybrid regression remains 5/20, versus 6/20 before the semantic feature. No labels or questions changed. This is an accuracy-preserving optimization, not new independent evidence of retrieval quality. The partial TypeScript/JavaScript compiler contexts and AI-authored labels retain the limits in the [extended report](extended-validation-20261019.md). Independent human review and controlled agent-answer comparisons remain pending.

The service suite passes **200/200, none skipped**, including added separate-versus-shared fusion checks, exact scores, kind/context/project/language filters, cancellation and capacity enforcement. The initial full run passed 199/200; the legacy-owner host probe failed its running-status assertion, then passed alone and in a complete rerun. All three TRX files are preserved. The actual shared-source build passes with zero warnings/errors. No UI changed, so no UI visual verification was performed.

## Patch and evidence

Only `Embeddings/ModelStore.cs` and `SemanticViewsTests.cs` were changed for this optimization. They were built/tested in `/private/tmp/pci-shared-scan-code`, then applied to the shared service with exact before/after hash guards. Existing source WIP was preserved. The actual service was built to `/private/tmp/pci-shared-scan-workspace-verified`. The running app and its live index were not updated.

Evidence under `.praxis/session-artifacts/code-intelligence-benchmark/`:

- `shared-scan-latency/latency.praxis.json` and raw timing responses.
- `shared-scan-profile/`: direct profiling source/results, immutable two-file patch, before/after promotion hashes, TRX files, comparisons and the historical ordering diagnostic/current control.
- `shared-scan-all-modes/`, `shared-scan-acceptance/`, `shared-scan-maze/`, `shared-scan-typescript/`, `shared-scan-javascript/`: raw retrieval responses and scored reports.

The timing helper remains `compare_semantic_latency.py`. `shared-scan-profile/measure.py` records the exact orchestration and private fixture paths. The original fixture/model evidence remains in the earlier archives. No model, dependency, database migration or index rebuild was introduced. Additional work is required to reduce the remaining latency; no release or deployment is authorized by this report.
