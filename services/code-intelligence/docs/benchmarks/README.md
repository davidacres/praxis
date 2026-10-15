# Service performance measurements

Run the Release benchmark directly after compilation/tests finish; avoid competing build processes. The harness creates and deletes an isolated synthetic source/data directory, uses the real compiler/SQLite/query implementations, and saves a `.praxis.json` report. Exit 2 means at least one measured threshold failed; null gates were not measured. Outputs include runtime, model fingerprint, source/reference hashes, symbol counts, reader concurrency and peak process RSS.

```sh
dotnet restore services/code-intelligence/Praxis.CodeIntelligence.slnx --locked-mode
dotnet build services/code-intelligence/benchmarks/Praxis.CodeIntelligence.Benchmarks -c Release --no-restore
dotnet services/code-intelligence/benchmarks/Praxis.CodeIntelligence.Benchmarks/bin/Release/net10.0/Praxis.CodeIntelligence.Benchmarks.dll --symbols 5000 --queries 100 --output benchmark.praxis.json
```

Add `--model /absolute/path/to/provisioned/bundle` for actual hybrid queries, initial embedding and edit-to-vector refresh. Provision with `scripts/prepare-model.py`; no remote inference occurs. Query latency uses 20 warmups and four concurrent readers, with nearest-rank p50/p95 over all query samples. Body edit is a single direct index invocation; it does **not** establish the normative edit p95 including watcher debounce. Exact-name synthetic queries do not establish held-out relevance. Native IPC, MCP/provider overhead, platform behavior and real-repository quality remain separate gates.

## Recorded Linux x64 runs, 15 October 2026

Both checked-in reports predate relationship adapter v2. Baseline overlapped compilation and is retained as unsuccessful evidence, not a controlled comparison. The prepared-command run started after builds/tests completed. Its lexical p95 was 62.9009 ms, body edit 5422.148 ms and peak RSS 452349952 bytes. The body-edit threshold failed. Neither report measures hybrid retrieval. Prepared transaction-local commands passed the complete 63-test C# suite; no performance success is claimed for body edits. Later semantic functionality must be remeasured rather than inheriting these results.

The additional `linux-x64-5000-v1-hybrid.praxis.json` report loaded the earlier Release artifact while the v3 build was pending; it is explicitly **not v3 evidence**. Initial indexing overlapped compilation. It used the real pinned model and measured hybrid p95 686.3245 ms, one body edit 11505.5783 ms, vector refresh 11119.251 ms and peak RSS 1155346432 bytes. Hybrid/body-edit/refresh thresholds failed. Keep this record separate from measurements of schema 2 and adapter v3.

## Schema 2 / adapter v3 measurement

`linux-x64-5000-schema2-v3-hybrid.praxis.json` records 5000 source symbols and one external type. Lexical p95 was 52.4869 ms; hybrid p95 531.2665 ms; body edit 9179.6436 ms; semantic refresh 2342.056 ms; no-op 939.6106 ms; peak RSS 1198485504 bytes. Hybrid/body-edit thresholds failed. It predates buffered vector scoring and automatic migration backups. Initial vector construction overlapped a focused database-fixture build/run, so do not treat it as a controlled causal comparison.

The recorded threshold-definition version 1 compared **combined edit plus refresh** with ten seconds. Normative specification §19 instead allows ten seconds **after structural publication** for the semantic refresh. Refresh alone in this report meets that threshold; the separate structural threshold still fails. Version-2 reports use `fiveThousandSymbolSemanticRefreshAtMost10Seconds` and retain total `EditToVectorsMs` as a separate observation. Query timings at 5k do not prove the required 50k capacity, and retrieval-only latency remains unmeasured. The native CI workflow offers an opt-in real-model run; no remote execution is claimed.

## Buffered scorer / corrected harness smoke

The 100-source-symbol real-model run records threshold-definition version 2, vector-scorer version 2, schema 2 and adapter v3. It exercised all phases with complete real vector coverage and 40 samples per query mode. Hybrid p95 was 83.9372 ms, lexical p95 117.4202 ms, body edit 668.1955 ms and refresh 1625.8922 ms. The lexical threshold comparison failed; this remains an unsuccessful small-fixture measurement, not 5k/50k capacity or relevance evidence. All raw observations, including peak RSS, are preserved in `linux-x64-100-schema2-scorer2-hybrid.praxis.json`.

## macOS arm64 analysis/batch checkpoint

Same-machine Release runs after the native source-handle prerequisite fix compare the same 5,000-source-symbol corpus, SDK/runtime/reference assembly and pinned model. Builds/tests completed before each run. Baseline hybrid body-edit publication was 3352.3529 ms; analysis-local semantic-model/diagnostic/identity reuse and child-first relationship deletion reduced it to 2691.3054 ms. It still fails the two-second direct structural comparison, which also excludes watcher debounce. Hybrid p95 was 107.8961 ms before and 111.7799 ms after; no hybrid latency improvement is established by this pair. Candidate symbol rows are fetched in a single bounded query while retaining vector rank order.

The macOS runtime reports PeakWorkingSet64 as zero. Baseline reports retain that raw zero and their resulting RSS gate must not be treated as valid evidence. The harness now records unavailable RSS as null and an unmeasured gate. Independent `/usr/bin/time -l` measured maximum RSS 877920256 bytes for the analysis/batch run. This is 5k synthetic direct-service evidence, not the normative 50k query capacity or representative relevance gate.

## Retained parent/vector publication checkpoint

The same corpus with retained structural parent rows and validated vector blobs measured a body edit at 2530.7532 ms, versus baseline 3352.3529 ms (24.5% lower). Hybrid p95 was 113.1703 ms and semantic refresh 384.8981 ms. The direct structural threshold still fails; this is not acceptance completion. Independent `/usr/bin/time -l` measured maximum RSS 1005813760 bytes. `macos-arm64-5000-retained-hybrid.praxis.json` preserves the raw report.

## Retained declaration/relationship checkpoint

The final Release run, after builds and all 87 tests completed, measured body-edit publication at **1532.0555 ms** versus the same-machine native baseline **3352.3529 ms** (54.3% lower). Structural keys and context/file memberships must match before retaining contributions. Persisted declarations and occurrences/edges are compared with fresh complete compiler output; changed bindings are replaced even when the caller source is unchanged.

Lexical p95 was 21.362 ms; hybrid p95 129.0305 ms over 400 samples with four readers; semantic refresh was 420.4457 ms. Hybrid remains below the 500 ms comparison, but is higher than the baseline 107.8961 ms: this series establishes no hybrid speedup. Independent `/usr/bin/time -l` measured maximum RSS 874692608 bytes. The runtime RSS field remains null. The complete raw report is `macos-arm64-5000-contributions-hybrid.praxis.json`.

This is one direct body-edit observation, not structural p95 including 500 ms watcher debounce. It does not establish the normative 50k-symbol query gate, Windows/Linux behavior, representative repository relevance, native IPC/MCP overhead or desktop UI acceptance. The full feature remains in progress.

## First 50k-symbol native measurement (15 October)

`macos-arm64-50000-v5-hybrid.praxis.json` records a single Release run with adapter v5, schema 2, scorer 2, 49,999 source symbols and one metadata symbol. Both latency targets **fail**: lexical p95 204.2217 ms (target 100 ms), hybrid p95 1732.5997 ms (target 500 ms), each over 400 timed queries/four readers after 20 warmups. Independently measured maximum resident size was 1,308,540,928 bytes (below 2 GiB); the runtime RSS field correctly remains null. Body edit 17105.3281 ms and semantic refresh 2073.6256 ms are 50k observations, not applications of the 5k edit/refresh thresholds. Initial index took 18007.3026 ms; initial vectors took 524779.3442 ms.

The synthetic corpus, fixed query schedule, pinned model/reference and environment are recorded in the raw report. Initial vector construction overlapped focused MCP compilation/tests; the measured query/edit phases ran after those completed. This is one direct-service run, not the full five-run/category/concurrent-edit protocol or held-out relevance proof. It excludes owner/MCP transport and does not report retrieval-only latency. Preserve the failure rather than treating 5k improvements as 50k acceptance.

## Snapshot counts and candidate-first lexical plan (15 October)

Search-count cache version 1 retains at most 128 scalar entries keyed by repository, structural generation, query epoch, context, filters and model profile. Policy/configuration revocation changes the epoch even before a new generation; vector refresh also changes it. No connection, source snapshot or compiler model is retained. Regression checks cover filters, concurrent reads, policy clearing, body edits and vector refresh.

The first 50k lexical-only run with cached counts still **failed** at p95 100.806 ms. The materialized FTS join could still scan every repository symbol. Search-plan version 2 pins the ranked-candidate side first with SQLite CROSS JOIN, retaining exact predicates and rank ordering. The subsequent same-machine/corpus/SDK/reference/scorer/cache lexical-only run measured p95 **3.9272 ms** (p50 3.1888 ms; maximum 5.2061 ms) over 400 queries/four readers. Both raw reports are retained. Independent maximum resident size was 920256512 bytes before the plan change and 889749504 bytes afterward. Neither run installed/activated a model; no hybrid or model-inclusive memory improvement is claimed from this pair.

Both fixtures have corpus hash `sha256:f14bc8736fbc2bbcf4c984a76c488edf6c55324d0cadd3b0a0f2581ba2a99993`. Builds/tests finished before the measurements. The shared structural edit observations (~9.3 seconds) are for 50k with no active model and are not comparable with the model-enabled edit/refresh run or the normative 5k update threshold. These are single synthetic exact-name query runs; full category/five-run/held-out-relevance and hybrid acceptance remain open.

## Model-inclusive count-cache/search-plan rerun

`macos-arm64-50000-count-plan-hybrid.praxis.json` uses the same 50k corpus and pinned model with cache version 1, search plan 2 and scorer 2. Lexical p95 is 3.8807 ms; hybrid p95 is 1117.9363 ms (still **fails** 500 ms, versus the earlier 1732.5997 ms). Independent `/usr/bin/time -l` maximum RSS is 1350893568 bytes, below 2 GiB; runtime RSS remains null. Initial index 17481.4988 ms, vectors 525098.4112 ms, body edit 16057.7432 ms and vector refresh 2130.1119 ms are preserved. Query/edit phases had no concurrent builds or tests; lightweight repository inspection and evaluator editing occurred during the run. This remains one exact-name synthetic four-reader run, not five-run/category or real-repository relevance acceptance.

## Exact scorer version 3 — 16 October

`macos-arm64-50000-scorer3-hybrid.praxis.json` preserves the same corpus/model/reference fixture with hardware-accelerated exact scoring. Lexical p95 is 3.6989 ms and hybrid p95 is 1026.5347 ms: hybrid still **fails** 500 ms. Independent maximum RSS is 1783087104 bytes (below 2 GiB); runtime RSS remains null. Initial index 17409.7693 ms, initial vectors 532400.1504 ms, body edit 16202.3371 ms and vector refresh 2157.7971 ms are raw observations. This precedes bounded SQLite reader mapping. Cold vectors overlapped focused local test builds and Maze tuning preparation; timed search/edit phases were quiet. This one synthetic run does not establish five-run/category/watcher-inclusive/real-repository acceptance.
