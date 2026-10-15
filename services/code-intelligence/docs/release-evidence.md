# Release evidence and remaining gates

Updated 15 October 2026. M3 implementation is in progress; this document is not a release approval.

| Check | Evidence | Result |
|---|---|---|
| C# suite | SDK10.0.402, real MiniLM bundle and explicit SDK capture fixture; latest run | 63 passed,0 failed,0 skipped |
| Source/context | Raw UTF16 hashes, path policy, passive no-execution, SDK capture, generated support and stale/deleted inputs | Covered by targeted tests |
| Durable jobs | Coalescing, backoff, heartbeat, expired owner recovery, wrong-token publication, pause and atomic refresh enqueue | Covered by targeted tests |
| Automatic embeddings | Runtime registration/index, queued activation, real inference, edit, empty stale vector results, background refresh | Covered by native model fixture |
| Git policy | Ignored invalid-encoding source skipped before reads; configured fsmonitor cannot execute | Test passed |
| MCP/settings | SDK initialize/list/call, scoped denial/cancellation, provider handover filter, settings regressions | 46 focused Node tests passed |
| JSON Schema | 80 actual responses across11tools, including metadata/unresolved evidence, graph expansion and trimmed status/summary/pages/source | Passed with JSON Schema2020-12 |
| Full application build | Includes service, renderer import guard, Vite, copied renderer and trusted IPC guard | Passed after restoring complete SettingsPage source; exact remote blob checked |
| Linux native package | Self-contained publish, native CLI help, SQLite initialization and native ONNX model check | Passed on Linux x64; Windows/macOS and native owner IPC remain outstanding |
| UI e2e/screenshots | Prior environment denied UI launch sockets; user requested implementation proceed | Deferred, not passed |
| Native owner process/platform matrix | Unit framing/grants/lease tests are not a process-boundary proof | Outstanding |
| Live provider invocation | No paid/live adapter runs authorized or performed | Outstanding |
| Performance/quality corpus | 50k-symbol latency/update/RSS and120-query relevance protocol | Outstanding; no benchmark claims |

## Platform and provider claims

| Target | Configured | Executed evidence |
|---|---|---|
| Linux x64 | Yes | C# tests, native ONNX and self-contained CLI/SQLite/model checks |
| Windows x64 | Yes | None in this environment |
| macOS arm64 | Yes | None in this environment |
| Linux arm64/macOS x64 | Additional build targets | None in this environment |
| Claude Code/Codex/Copilot/Antigravity | Existing MCP routing plus explicit destination grants | Generic SDK mock only; no actual adapter tool invocation claim |

## Semantic graph checkpoint — 15 October

44 C# tests passed, 0 failed, 0 skipped, including provisioned ONNX and explicit SDK capture. 86 captured responses across all 11 tool schemas passed JSON Schema 2020-12 validation. New fixtures cover semantic/syntax top-level entries, context roots, initializer/lambda ownership, type relationships, optional virtual/interface candidates and static base calls. No UI changes in this checkpoint.

## Independent baseline checkpoint — 15 October

46 C# tests passed, 0 failed, 0 skipped. Golden reference checks detected and fixed special-token splitting. Tokenizer profile v2 changes the fingerprint; provision/install/activate it to replace v1. Model/vocabulary bytes remain pinned and unchanged. See reconstruction-progress.md for exact reference versions and fixture checksum. Metadata references now share immutable image data across contexts under one 512 MiB analysis bound.

## Query completeness checkpoint — 15 October

51 C# tests passed, 0 failed, 0 skipped; 64 fresh responses across all 11 schemas validated. New coverage includes reduced-page continuation without skips/duplicates, UTF-16/surrogate-safe source trimming, graph endpoint/evidence consistency, metadata-only evidence and cross-project implicit constructor identities. Method override relations are distinct from call edges. Full application build, two focused MCP tests and Linux self-contained CLI/SQLite/ONNX checks also pass. UI/platform/performance/quality gates remain outstanding.

## Representation checkpoint — 15 October

52 C# tests passed, 0 failed, 0 skipped. Representation v2 includes bounded, hash-verified source excerpts and persists exact UTF-16/token chunk bounds, source mappings, hashes and truncation. Independent token/span golden coverage expanded to 10 cases; all four full vector comparisons pass. Tokenizer v3 and representation v2 produce fingerprint `sha256:cee9c5b0d7765f298742c8c40da17095de5338a4b46e4f310cedcc4eb23dffba`; upgrade by provisioning/installing/activating this profile. Prior profile vectors remain isolated. Exact-representation reuse across structural republishing is implemented (see following checkpoint); scale performance remains unmeasured.

## Source-handle checkpoint — 15 October

54 C# tests passed, 0 failed, 0 skipped on Linux x64. Source handles are validated before/after reads, Unix traversal uses platform-specific no-follow flags and FIFO inputs are nonblocking/rejected. Windows/macOS code compiles; native platform execution remains a release gate. No UI changes.

## Recovery operations checkpoint — 15 October

57 C# tests passed, 0 failed, 0 skipped on Linux x64. Forced rebuild, alias retention, stable-ID relocation with old-fact/grant revocation, exclusion preservation, duplicate-root rejection and actual watcher rebinding are covered. Root/nonce-bound consent is rechecked before returning provider responses; legacy grants require reapproval. Desktop recovery controls and platform/provider/UI execution remain unfinished.

## Desktop recovery checkpoint — 15 October

Full application build passes with typed trusted rebuild/relocate IPC and desktop controls, themed relocation prompt, consent-config cleanup, search continuation, truncation feedback and polled generation. Two functional specs were added and attempted. Electron startup failed before UI interaction (missing X display/native node-pty); these tests and visual inspection remain blocked, not passed. Application workspace typechecking passes; an ad-hoc standalone e2e tsc invocation also exposes existing launchTestApp declaration errors.

## Retrieval completeness checkpoint — 15 October

60 C# tests passed, 0 failed, 0 skipped; 71 fresh responses across all 11 schemas validated. Status/summary budgets, unresolved source evidence and bounded one-hop search expansion now have regression coverage. Expansion preserves filters/evidence and keeps graph-only neighbors below direct matches. Graph/alias relevance and scale benchmarks remain unmeasured.

## Vector reuse/equivalence checkpoint — 15 October

63 C# tests passed, 0 failed, 0 skipped. Complete current-profile vectors reuse exact representations atomically under updated revisions/source mappings, with a 128 MiB capture bound and no detached cache. Changed/corrupt sets re-infer; exclusion changes purge vectors. An edited-vs-clean compiler fixture matches all structural domain projections. Normative pagination/trace defaults, empty filter behavior, normalization and duplicate rejection pass. The query-enabled run validated 80 responses across all 11 schemas. Targeted invalidation, representative performance/RSS and relevance remain release work.

## Relationship/performance checkpoint — 15 October

67 C# tests passed, 0 failed, 0 skipped with pinned-model inference. Compiler adapter v2 publishes member/type references, supported field/property reads/writes and declared type/return dependencies with source occurrence evidence. Adapter version changes invalidate prior context hashes. Existing call-only behavior remains filtered; unfiltered graphs include the additional facts. No desktop UI files changed.

Reconstructed benchmark and transaction-local prepared-command publication are saved. The checked-in direct-API 5k-symbol measurements **fail** the body-edit threshold (prepared run: 5422.148 ms); lexical p95 was 62.9009 ms and peak RSS 452349952 bytes. These reports predate adapter v2. Baseline overlapped compilation; no causal speedup is claimed. A single edit sample excludes debounce and cannot establish normative p95. Hybrid, native owner/MCP, real-repository relevance, other platforms and post-v2 performance remain unmeasured.

## Member/event/throw checkpoint (15 October)

Adapter `roslyn-5.9/v3` normalizes reduced extension methods to their source definitions; shared field declarations retain separate member-owned type dependencies with distinct occurrence identities. Null-coalescing assignment is classified as read/write. Compiler-resolved interface member implementations and property/indexer/event overrides now have relationship evidence. Direct source handler subscriptions produce HANDLES_EVENT from handler to event; unsubscription does not create that relationship. Direct and conditional event invocation produce EMITS_EVENT from enclosing callable to event. Unknown handler flow emits EVENT_HANDLER_UNRESOLVED rather than inventing a handler edge. Explicit throw statements/expressions identify their statically known named exception type; bare rethrow is not given an invented type. These facts do not prove handler execution, event ordering, runtime receivers or exhaustive exception behavior.

Unsupported implicitly declared source delegate methods remain unresolved source endpoints instead of being mislabelled external metadata. Adapter-version hashes trigger reconciliation after upgrades. **75 C# tests passed, 0 failed, 0 skipped**, including real pinned-model inference and a query test separating event/throw relationships from call queries. No desktop UI files changed. General delegate points-to flow, project/module dependency relationships, targeted invalidation and release performance/quality/platform gates remain open.

## Reconciliation/storage checkpoint (15 October)

SQLite schema 2 adds twelve missing foreign-key lookup indexes through migration002.sql. Migration001.sql is unchanged. Initialization validates all applied migration checksums and atomically upgrades a version-1 database; tests verify fact preservation, idempotence and indexed occurrence-edge lookup. Newer schema versions remain rejected without downgrade. Older binaries cannot open schema 2.

Validated unchanged snapshots now bypass Roslyn analysis while preserving structural generation/query epoch. Snapshot keys include adapter version, source bytes/path/role, repository configuration and captured manifest inputs; project/reference validation and fresh source checks still run. Legacy context metadata is backfilled after full analysis; force rebuild bypasses reuse. Byte changes with unchanged file length/time and changed captured metadata are regression tested. This is not targeted body-edit/API-stamp invalidation.

Model activation skips derivative rewrites only for complete validated current sets whose regenerated source metadata matches exactly. A trigger-based regression proves unchanged sets are untouched; corrupted mapping metadata is repaired. Empty search filters now also preserve eligible/vector coverage counts. **80 C# tests passed, 0 failed, 0 skipped** with real pinned-model inference. Post-change performance remains to be measured; earlier hybrid/body-edit failures are retained as evidence rather than recast as passes.

## Verified backup/scoring/CI checkpoint (15 October)

Schema upgrades now preserve a private verified pre-upgrade `.praxis.db` backup beside the database before migration writes. Preflight version/history validation runs in a consistent read transaction; concurrent initializers are covered. The upgrade test verifies the retained backup still has schema 1, the original repository fact and a successful integrity check. Backup failure prevents migration. **81 C# tests passed, 0 failed, 0 skipped**, including the pinned real model.

Vector scoring now reuses one byte buffer and validates normalization/finiteness while computing the dot product in one pass. It preserves scalar score precision, avoids per-chunk float arrays/LINQ passes and checks cancellation during scanning. The real-model fixture compares all candidate scores with an independent byte-decoded dot product and verifies cancellation. No post-change latency improvement is claimed without measurement.

The checked-in schema-2/adapter-v3 benchmark recorded 5000 source symbols plus one external type: lexical p95 52.4869 ms, hybrid p95 531.2665 ms, one body edit 9179.6436 ms, vector refresh 2342.056 ms, no-op reconciliation 939.6106 ms and peak RSS 1198485504 bytes. Hybrid and body-edit thresholds failed. Refresh alone satisfies the normative ten-second semantic threshold after structural publication; the older harness compared the stricter combined edit-plus-refresh duration instead. Threshold-definition version 2 corrects future reports and separately records combined duration. The report predates buffered scoring; initial vector construction overlapped a focused database-fixture build/run. This is not a controlled comparison or 50k capacity evidence.

A scoped GitHub workflow now defines Linux, Windows and macOS locked restores, independent golden/native model tests, captured-response schema validation, and self-contained CLI/SQLite/ONNX smoke packaging. It runs on relevant PRs or manual dispatch; the real-model Linux benchmark is opt-in. YAML structure was validated locally. No remote platform CI result or UI visual pass is claimed.

## Remaining code and acceptance work

1. Execute the independent golden tokenizer/vector fixture on Windows/macOS; execute representation source-span fixtures on those platforms. Exact persisted chunk spans and selected source excerpts are implemented. Linux x64 passes the checked-in Python-reference fixture (10 token/span cases, 4 full vectors, absolute tolerance 1e-5/cosine >= 0.99999).
2. Complete remaining dependency relationships and general delegate points-to analysis. Local callable, synthetic project-root/top-level ownership, type inheritance/implementation and optional bounded virtual/interface candidates now have regression coverage. Candidates are possible structural targets, not runtime proof.
3. Verify remaining irreducible-item budget/freshness errors against A01–A40. Status/summary collection trimming and full coverage counts now have targeted regression coverage. Paged collections, source text and graphs now trim with evidence/range/cursor invariants covered by regression tests. A single irreducible item can still return an explicit budget error.
4. Execute Windows/macOS source-handle race fixtures, including junctions, case/Unicode paths and concurrent swaps. Platform-specific handle-path verification is implemented and compiles; only Linux execution is evidenced. Linux rename/replacement and nonblocking FIFO regressions pass.
5. Execute desktop recovery/search functional e2e, final visual walkthrough and provider cancellation/error transcripts. Recovery controls and cursor/truncation feedback are implemented; the two new UI specs are blocked before panel interaction by missing X display/native node-pty.
6. Measure scale/quality gates. Conservative full-context publication is intentional until equivalence/performance evidence supports more targeted invalidation.

Native IPC, corruption/full-disk recovery, crash takeover, package dependencies and offline operation require execution on required platforms before release. Review the full normative acceptance list rather than treating the test count as coverage of every gate. M4 TypeScript/JavaScript, M5 local LLM enrichment and M6 scale/federation remain future milestones.

## Preservation

Work is on `codex/code-intelligence-recovery`, not main. Remote checkpoints are verified against Git blob SHA values. Large file contents are transferred in bounded chunks; textual tool-output truncation must never be accepted as source. The prior SettingsPage checkpoint corruption was repaired from main with the small integration reapplied and its exact remote blob verified.
