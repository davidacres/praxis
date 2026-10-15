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
