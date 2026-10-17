# Release evidence and remaining gates

Updated 17 October 2026. M3 implementation is in progress; this document is not a release approval. Current local performance state with the bge-small model (search plan 7): the 50k full run, the 25-edit concurrent run and the 40-process query matrix all pass, on a 12-core Mac only. With one shared inference session, the committed build's concurrent run peaks at 1.65 GB, about 470 MiB under the 2 GiB limit (a prototype run: 1.83 GB).

| Check | Current evidence | Remaining qualification |
|---|---|---|
| C# compiler/storage/model suite | 120 passed, zero failures/skips with SDK/model fixtures (schema 6, vector plan 6, search plan 6, mapping v7, disk-full, memory-pressure, start-up reclaim and reconciliation) | Run [38959603040](https://github.com/davidacres/praxis/actions/runs/38959603040) at `e54a8a40` passes on Windows/macOS/Linux |
| Source/context and dependency graph | Source identity/evidence, cross-project source uses, captured project/assembly references and configuration withdrawal tested | General runtime delegate flow is explicitly unresolved; no NuGet-name inference |
| Durable work and edit updates | Real 5k watcher: 25 edits, structural p95 1.676 s, semantic upper-bound p95 0.620 s, no errors | This measurement predates adapter v8; five-run/concurrent-edit protocol remains open |
| MCP | Four local SDK/stdio tests pass, including native grants/errors and controlled in-flight child cancellation | Actual live provider adapter/inference cancellation qualification remains open |
| Disk full | Actual full-volume qualification on macOS (64 MiB APFS image filled to ENOSPC): retryable `DISK_FULL`, reads keep serving the committed index, `doctor` reports paused writes with zero integrity findings, automatic recovery about 31 s after space returns; `SQLITE_FULL` fault test on every platform | Windows/Linux actual-volume runs; owner-start-on-already-full volume relies on the nearly-full heuristic |
| Crash recovery | 20 SIGKILLs at seeded random points 0–2.5 s after an edit (2,000 symbols with vectors): integrity clean after every restart, every edit published, full vector coverage; recovery p50 0.8 s, max 2.1 s | macOS only (SIGKILL); a first run failed (60 s lease waits; stale index reported current) and is retained |
| JSON Schema | Fresh final-code batch: 132 responses across all 11 tools validate | Repeat for future wire changes |
| Application/native packaging | Full application build and current native owner/SQLite/ONNX/IPC packaging smoke pass locally | Latest release-wide platform/UI matrix remains open |
| Desktop recovery/search | Four focused tests pass, including real native service, light/dark keyboard focus containment and Escape handling; captures inspected | Full functional run: 543 passed, 15 failed, 3 skipped; all four code-intelligence checks pass. 14 failures reproduce with previous dialog; one passes on rerun |
| Fixed-corpus quality | Search-plan-5 fixed 120-query corpus passed applicable gates, Recall@10 0.893939 equals lexical | Adapter-v8/exact-streaming recheck passed; no semantic recall gain or new blind study claimed |
| 50k exact-query latency and memory | Plan-6/schema-5 full process: lexical p95 6.467 ms, hybrid p95 211.053 ms, retrieval-only p95 191.841 ms, independent peak RSS 2020671488 bytes; all measured gates pass (previous plan-5 run: hybrid 434.591, retrieval 414.348 failing) | 50k body edit 17034 ms vs 14263 ms before (no 50k gate). Repeat/concurrent-edit/reference-machine protocol open |
| 50k with bge-small (search plan 7) | Full process: lexical p95 7.651 ms, hybrid 134.027 ms, retrieval-only 121.149 ms, peak RSS 1,266,171,904 bytes. 25-edit concurrent run: zero errors, hybrid p95 310.9 ms, peak RSS 2,120,105,984 bytes before the shared-session fix, **1,654,276,096 bytes (about 470 MiB under 2 GiB) with the committed fix** (prototype run 1,832,779,776). Query matrix 40/40 pass; four-reader retrieval-only p95 max 186.3 ms | Initial 50k vector build 1,008–1,014 s (MiniLM 520 s). 12-core Mac only; two post-fix runs vary by about 180 MB |
| 50k concurrent edits | With §31.3 pressure admission: 25 edits, 14,121 lexical + 14,121 hybrid queries, zero errors, lexical p95 10.98 ms, hybrid p95 286.9 ms, independent peak RSS 1,908,703,232 bytes (about 227 MiB under 2 GiB; pressure engaged in 11 of 1,362 one-second samples) | One run on a 12-core Mac; reference machine and repeated runs open |
| Query matrix (plan 6) | Five runs × exact/terminology/behaviour/negative × one/four readers × 200 queries: 39/40 processes pass every gate; hybrid p95 max 322.743 ms; lexical p95 max 82.942 ms; zero errors | **Fails:** behaviour four-reader run 1 retrieval-only p95 301.9 ms; other four-reader terminology/behaviour runs 236–247 ms (thin margin). Concurrent edits, cross-project, owner/wire, full-process RSS, reference machine unmeasured |
| Query matrix (mapping v7) | Same protocol after the memory fix: complete, zero errors, all lexical/hybrid p95 pass; 36/40 processes pass every gate | **Fails:** four-reader retrieval-only behaviour runs 1–3 (261.2/261.2/270.4 ms) and terminology run 4 (250.2 ms); the memory fix costs about 5–25 ms on broad four-reader retrieval |
| Query matrix (vector plan 5, native scan) | Five runs × four categories × one/four readers × 200 queries: **40/40 processes pass every gate**, zero errors; four-reader retrieval-only p95 max 172.0 ms, hybrid p95 max 182.8 ms, lexical p95 max 85.1 ms | 12-core Mac only; reference 8-core/16 GiB machine, cross-project and owner/wire latency unmeasured |
| Query matrix (schema 6, vector plan 6) | Same protocol on the retained fixture migrated to schema 6: **40/40 pass**, zero errors; four-reader retrieval-only p95 max 177.0 ms, hybrid max 189.8 ms, lexical max 82.9 ms | 12-core Mac only |
| Owner protocol queries | 50k via the native owner's socket protocol (connect, token handshake, admission, dispatch, framing): zero errors; hybrid p95 82.8/152.1 ms (exact, 1/4 clients), 125.0/193.0 ms (terminology); owner sampled peak RSS 1.51 GB through its own indexing, vectors and queries | Single run; Windows named pipes and MCP stdio framing not timed; exact 4-client hybrid p99 410 ms |
| Broader terminology performance (history) | (Superseded for the vector path by the ranked-validation checkpoint below: one-reader hybrid p95 228.496 ms, four-reader 365.737 ms, single pilot.) Two independent 50k processes, matched 200-query sets/mode: one reader lexical/hybrid p95 74.371/353.665 ms; four readers 98.664/507.817 ms; no errors | Four-reader hybrid fails 500 ms and retrieval-only fails 250 ms. Five repeats, other categories and concurrent edits remain open |
| Native CI | Run 38897870350 passed Windows/macOS/Linux; follow-up 38900116034 found harness/fixture issues now fixed locally | Final mapping-v6 run 38904504214 passes Windows/macOS/Linux (112 tests per host, schemas, native packaging, retained/matrix safeguards and watcher smoke) |

## Platform and provider claims

| Target | Configured | Executed evidence |
|---|---|---|
| Linux x64 | Yes | 97 C# tests, 109 schema responses, native ONNX, self-contained package and owner-process IPC |
| Windows x64 | Yes | 97 C# tests, 109 schema responses, native ONNX, self-contained package and owner-process IPC |
| macOS arm64 | Yes | 97 C# tests, 109 schema responses, golden/native ONNX, self-contained package and owner-process IPC |
| Linux arm64/macOS x64 | Additional build targets | None in this environment |
| Claude Code/Codex/Copilot/Antigravity | Existing MCP routing plus explicit destination grants | Real native stdio MCP SDK invocation passes on macOS; actual agent adapters remain unqualified |

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

## Native macOS performance and owner-process checkpoint (15 October)

The latest macOS arm64 compiler/model suite passes 87 tests with zero failures/skips, and 87 captured responses validate against all 11 schemas. The controlled 5k-symbol comparison reduced a single direct body edit from 3352.3529 to 1532.0555 ms (54.3%); hybrid p95 is 129.0305 ms, with no hybrid speedup claimed. These are local synthetic measurements, not watcher-inclusive p95, 50k capacity or relevance acceptance. Full-context compiler analysis remains; matching structural and derivative facts are retained during publication. See `docs/benchmarks` for reports and limits.

Self-contained macOS arm64 packaging now executes actual local IPC: automatic owner startup from a normal CLI command, duplicate-owner rejection, indexing, four concurrent lexical searches, provider grant/revocation, SQLite backup creation, clean doctor checks, persisted search/generation after restart, and forced-crash takeover with the old rendezvous/socket left in place. The new owner rotates its authentication token; revoked provider access remains denied after recovery. The rendezvous includes an informational process ID so the fixture can stop only its own automatically launched owner. Endpoint validation and token authentication remain unchanged. Native ONNX inference also passes during packaging.

Windows/Linux execution of this IPC fixture, desktop visual/e2e proof, live provider adapters, normative scale/quality gates, targeted invalidation and remaining relationship coverage are still open. Automatic startup/crash takeover is now evidenced on macOS; it must not be treated as proof of the other platform results.

## Compiler import checkpoint (15 October)

Adapter `roslyn-5.9/v4` records compiler-bound namespace, alias and static imports with exact source occurrences. Merged namespace imports resolve each constituent to its defining project/assembly rather than inventing a caller-owned namespace. Unbound imports emit no invented target; compiler diagnostics remain visible. Syntax-only analysis emits no semantic import edges. Graph queries expose imports separately from calls, and removing directives removes the published edges. Adapter-version hashing reconciles existing indexes on upgrade.

**90 C# tests passed, zero failures/skips; 91 captured responses validated across all 11 tool schemas.** Tests cover global/namespace-scoped imports, alias/static targets, cross-project merged namespaces, partial contexts, publication/removal and query evidence. Project/package dependency completeness and general delegate flow remain open.

## Observed project dependency checkpoint (15 October)

Adapter `roslyn-5.9/v5` lifts compiler-bound cross-project source references into `depends_on` edges between their synthetic context roots. Each edge retains the actual source occurrence, hash, range and resolution; duplicate evidence for the same occurrence/project pair is collapsed. Possible bindings remain possible, and partial target contexts cannot become resolved project dependencies. Metadata-only targets and unused configuration-only project references do not receive invented source evidence.

**92 C# tests passed, zero failures/skips; 94 actual responses validated across all 11 schemas; full application build passed.** Analyzer and query fixtures verify defining roots, source evidence, graph publication and edge withdrawal after edits. Configuration-only project references/package dependencies remain separate work.

## Native desktop recovery/search checkpoint (15 October)

The full application build and both existing desktop recovery/search regressions pass on macOS arm64. A new opt-in native desktop fixture passes against the freshly published self-contained service without replacing its IPC handler: register a disposable repository, index/search, read hash-verified source, force rebuild, pause/resume, relocate to distinct source, search the relocated symbol and unregister. The fixture owns its service process and temporary data. The source view and themed relocation dialog screenshots were inspected on this same build; text, controls, focus ring and dialog layout were legible. This is one light-theme native walkthrough, not a complete theme/accessibility/platform or live-provider qualification.

The Playwright catalog now includes the new fixture, and `npm run test:praxis-contracts` passes (614 catalogued tests). The native test visibly skips unless `PRAXIS_CODE_INTELLIGENCE_EXE` identifies a host package. No paid provider call or project evaluation is used.

## Native stdio MCP checkpoint (15 October)

The opt-in core fixture now launches the compiled stdio bridge through the real MCP SDK client and talks to the self-contained native service. It lists all 11 tools, denies ungranted reads, proves a different provider's grant is insufficient, grants the selected provider, searches indexed source, retrieves a hash-verified source fragment, rejects a different repository and denies reads immediately after revocation. The bridge, service and owner transport are real; no inference provider is contacted. Three focused MCP/provider tests pass with zero skips, and core compilation passes.

This closes the local native stdio protocol gap on macOS arm64. It does not claim paid/live Claude Code, Codex, Copilot or Antigravity adapter qualification, nor Windows/Linux execution. The fixture uses temporary data and stops its owner/bridge processes.

## Native owner authentication checkpoint (15 October)

The packaged IPC smoke now sends actual length-prefixed frames directly to the owner socket/pipe. A forged token is rejected without returning the fixture path, and the previous owner's token is rejected after crash takeover rotates the token. Normal queries still succeed afterward. The expanded fixture passes on macOS arm64. These are same-user authentication checks; they do not substitute for cross-user ACL/platform verification.

## 50k capacity checkpoint (15 October)

The first real-model macOS arm64 50k synthetic direct-service run fails lexical/hybrid latency: p95 204.2217/1732.5997 ms against 100/500 ms. Independently measured maximum resident size is 1308540928 bytes, below 2 GiB. Full raw observations and protocol limits are in `docs/benchmarks/macos-arm64-50000-v5-hybrid.praxis.json` and the benchmark README. This failure leaves scale acceptance open; the prior passing 5k observations do not establish 50k behavior.

## Search-count and lexical-plan checkpoint (15 October)

Search counts are bounded scalar-only snapshot entries keyed by repository/generation/epoch/context/filters/profile. They invalidate for immediate policy clearing and vector refresh as well as structural edits. Candidate-first FTS joining removes a repository-wide symbol scan while preserving predicates and rank ordering.

**94 C# tests passed, zero failures/skips; 109 actual responses validate across all 11 schemas.** The same 50k lexical-only fixture measured p95 100.806 ms with count reuse alone and **3.9272 ms** after the join-plan fix. Both raw reports and the failed intermediate run are retained in `docs/benchmarks`. This establishes a local single-run lexical improvement; model-enabled hybrid, full protocol and relevance acceptance remain open.

## Remaining code and acceptance work

1. Execute the independent golden tokenizer/vector and representation source-span fixtures on Windows; macOS arm64 now passes these fixtures. Exact persisted chunk spans and selected source excerpts are implemented. Linux x64 passes the checked-in Python-reference fixture (10 token/span cases, 4 full vectors, absolute tolerance 1e-5/cosine >= 0.99999).
2. Complete remaining dependency relationships and general delegate points-to analysis. Local callable, synthetic project-root/top-level ownership, type inheritance/implementation and optional bounded virtual/interface candidates now have regression coverage. Candidates are possible structural targets, not runtime proof.
3. Verify remaining irreducible-item budget/freshness errors against A01–A40. Status/summary collection trimming and full coverage counts now have targeted regression coverage. Paged collections, source text and graphs now trim with evidence/range/cursor invariants covered by regression tests. A single irreducible item can still return an explicit budget error.
4. Execute Windows/macOS source-handle race fixtures, including junctions, case/Unicode paths and concurrent swaps. Platform-specific handle-path verification is implemented and compiles; Linux and macOS arm64 execution is evidenced. Native macOS fixes cover the Darwin arm64 fcntl ABI and canonical alias parents; Windows execution remains open. Linux/macOS rename/replacement and nonblocking FIFO regressions pass.
5. Complete theme/accessibility/platform qualification and provider cancellation/error transcripts. On macOS the two recovery/search specs and a new real packaged-service desktop flow pass, with source/dialog captures inspected. Earlier Linux attempts remain blocked evidence, not a current macOS blocker.
6. Measure scale/quality gates. Conservative full-context publication is intentional until equivalence/performance evidence supports more targeted invalidation.

Native IPC, corruption/full-disk recovery, crash takeover, package dependencies and offline operation require execution on required platforms before release. Review the full normative acceptance list rather than treating the test count as coverage of every gate. M4 TypeScript/JavaScript (CI-019 / TASK-459) is implemented and verified across 132 tests; M5 local LLM enrichment and M6 scale/federation remain future milestones.

## Preservation

Work is on `codex/code-intelligence-recovery`, not main. Remote checkpoints are verified against Git blob SHA values. Large file contents are transferred in bounded chunks; textual tool-output truncation must never be accepted as source. The prior SettingsPage checkpoint corruption was repaired from main with the small integration reapplied and its exact remote blob verified.

## Three-host native verification and relevance evaluator — 15 October

[CI run 38817326799](https://github.com/davidacres/praxis/actions/runs/38817326799) at `faf6408bd9943e1c94e8b5115402741d8111fbf5` passed all three native hosts. Each executed 94 C# tests without skips, validated 109 responses across 11 schemas, packaged the self-contained service and passed startup/owner lock, forged/stale token rejection, concurrent searches, consent, backup, restart and crash takeover. This does not qualify full desktop themes/accessibility or actual provider adapters.

The local relevance evaluator has seven metric/report safeguard tests plus one real packaged-owner fixture. The native fixture confirms label resolution, source evidence, report output and honest rejection of a small unreviewed lexical-fallback corpus. Maze was supplied as the representative repository: `https://github.com/davidacres/maze`, snapshot `61d4510a8ef6946407fa310038ae0add1fffdf24`. The 120 reviewed labels and manual explanation/abstention checks remain open; evaluator availability does not pass those gates.

The model-inclusive 50k count-cache/search-plan rerun measured lexical p95 **3.8807 ms**, hybrid p95 **1117.9363 ms**, body edit 16057.7432 ms and vector refresh 2130.1119 ms. Independently measured maximum RSS was **1350893568 bytes**. Hybrid still fails 500 ms; this is one synthetic direct-service run, not the full acceptance protocol.

## Exact scorer acceleration checkpoint

Scorer version 3 uses hardware vector operations on little-endian supported hosts and a portable little-endian scalar path elsewhere. Products retain the former float rounding before double accumulation; no approximate candidate pruning or vector caching is introduced. Independent seeded comparisons cover 1,000 normalized vector/query pairs on both paths to 12 decimal places. Invalid lengths, nonfinite components and nonnormalized vectors are rejected. The full local suite passes **96 tests, zero failures/skips**, including real-model ranking against independently decoded scalar products. Post-change 50k performance and fresh cross-platform execution must be measured before claiming a latency improvement.

The Maze tuning draft now contains 40 queries and its source-only report contains 80 actual searches with stable generation/epoch, no tool errors and valid evidence for returned relevant labels. All review declarations remain false and no held-out metrics are inferred. The first scorer-3 CI run passed Linux but the macOS handshake regression hit its fixture-only three-second deadline under concurrent native tests; the client already allows 15 seconds for startup/re-discovery. The regression now uses that same bounded 15-second wait and a 30-second fixture lifetime, retaining stale-token rejection and eventual success assertions. The local full 96-test suite passes after this fixture change. Fresh native CI is still required.

## Native scorer validation and bounded reader mapping — 16 October

[CI run 38820512973](https://github.com/davidacres/praxis/actions/runs/38820512973) at `b5c10d9e788a488f9764e70483a48e9329b7baef` is green on Windows x64, Linux x64 and macOS arm64. Every host ran 96 C# tests without skips, validated 109 responses, passed native golden/model/package/owner lifecycle checks and ran all 10 evaluator tests with the real packaged owner. This supersedes the fixture timeout failure; it does not qualify later changes automatically.

The scorer-3 50k run recorded lexical p95 **3.6989 ms**, hybrid p95 **1026.5347 ms**, body edit 16202.3371 ms and semantic refresh 2157.7971 ms. Independent maximum RSS was **1783087104 bytes**. Hybrid still fails 500 ms; the observed change from 1117.9363 ms is not five-run acceptance or proof of a general speedup. Cold vector construction overlapped focused local tests and Maze corpus preparation; timed query/edit phases had no concurrent builds/tests. Raw report: `benchmarks/macos-arm64-50000-scorer3-hybrid.praxis.json`.

Read-mapping version 1 requests at most **128 MiB** of file-backed SQLite mapping per read connection. Unsupported hosts fall back to the pager; SQLite retains its WAL snapshot/locking behavior. It retains no detached source/compiler/vector cache. A concurrent-publication regression proves an existing reader sees its original BLOB while a fresh read sees the committed replacement; the actual mapping size is bounded. All **97 local C# tests** and **109 response schemas** pass. Performance and native CI for this mapping change are pending measurement.

## Native mapping validation and Maze model run — 16 October

[CI run 38821489666](https://github.com/davidacres/praxis/actions/runs/38821489666) at `d788beb7` passed Windows x64, Linux x64 and macOS arm64 with 97 C# tests, 109 schema responses, native package/owner lifecycle and the 10 evaluator checks on each host. The mapping change is natively verified; the 50k latency rerun is still pending.

The actual Maze local-model run has complete current vector coverage for 14,298 source symbols and a stable snapshot across 80 searches. The 35 positive tuning queries have macro Recall@10 0.80 hybrid versus 0.4571428571 lexical; five negative cases are excluded from recall. All labels remain unreviewed tuning data, the compiler context is syntax-only, and no held-out or cross-project acceptance is claimed. See `evaluations/maze-model-tuning-results.praxis.json` for the actual per-case results and failed declared gates.

## Final bounded-mapping measurement and handover — 16 October

`benchmarks/macos-arm64-50000-mmap1-hybrid.praxis.json` records the final same-corpus/model/reference 50k run: lexical p95 **3.7177 ms**, hybrid p95 **681.9115 ms**, direct body edit **14931.5108 ms**, semantic refresh **1898.8956 ms**. Independent maximum RSS is **1623851008 bytes**, below 2 GiB; runtime RSS remains null. Hybrid still **fails** 500 ms. Observed p95 was 1117.9363 ms before scorer/mapping changes, 1026.5347 ms with scorer 3, and 681.9115 ms with bounded mapping; these individual observations do not establish a repeated-run causal estimate or full protocol acceptance.

Cold vector construction overlapped the separate Maze model run and was explicitly paused until Maze finished. Therefore initial vector/build elapsed times are preserved as raw observations but are **not controlled cold-start comparisons**. Capacity warmups and timed query/edit phases ran after Maze and other local builds/tests had finished. No production process remains paused; the benchmark and temporary Maze owner exited.

All implementation changes are pushed to `codex/code-intelligence-recovery`. Last implementation commit `d788beb7` has green three-host CI (97 C# tests, 109 responses and 10 evaluator checks per host); later commits preserve documentation/corpus evidence. M3 is **not complete**. Immediate work remains: close the 500 ms hybrid target under the full repeated/category protocol; independently prepare/freeze 80 held-out Maze queries and review all labels/split leakage; obtain complete trusted compiler contexts and exercise cross-project/stale scenarios; perform abstention and 30 explanation reviews. Targeted API/dependency invalidation, configuration-only project/package dependencies, full UI/platform/accessibility and actual provider-adapter qualification remain broader release gates described above.

## Retained capacity fixtures and actual Maze compiler preparation

The benchmark can now retain its own generated post-edit snapshot and requery it without indexing, inference activation or source mutation. Source membership/hashes, root, generation/epoch, profile and complete hybrid coverage are verified; changed fixtures fail without producing a measurement. Native CI [38862234657](https://github.com/davidacres/praxis/actions/runs/38862234657) at `774434ef` passed all three hosts, including the real-model reuse/change/refusal/restoration smoke.

The pinned Maze SDK restore/build and captured generator outputs yield four complete contexts for the explicitly selected SearchCore/UserService/Common/ModuleContracts subset. There are 76 observed resolved cross-project calls and 11 separate possible calls; source files are unchanged. See the actual compiler preparation/status artifacts under `evaluations`. This closes preparation for compiler-backed relevance work on that subset, not the held-out/manual review gates. Evaluator completeness now uses the authoritative repository-wide freshness signal when only diagnostics are truncated, with positive and hidden-partial regression cases. All 97 local C# tests, 109 schemas and 11 evaluator checks pass.

## Exhaustive vector filter plan

Vector query-plan version 2 avoids looking up the context row for every eligible vector when no project filter is present. Symbol context foreign keys still enforce identity, explicit context/kind predicates remain on symbols, and project-filtered queries retain the context join. Exhaustive scoring, completeness/revision/representation predicates and ranking are unchanged. A real-model two-project fixture checks all candidates and their relative ranks/scores under context, kind, project, combined, mismatched, missing and empty filters. Local validation: **98 C# tests**, **109 schemas**, plus the real-model retained benchmark smoke. Post-change capacity measurement and fresh native CI are pending.

Retained query reports also include a separately labelled one-sample warmed embedding/candidate-scan diagnostic after timed queries. It is not a latency percentile or a substitute for the component protocol. The query-only baseline is the retained post-edit snapshot, not the earlier initial-query phase.

## Vector blob boundary validation

Query-plan version 3 checks `length(values_blob)=1536` in SQLite and performs one bounded managed/native copy per eligible chunk, replacing the separate managed length probe. Finiteness/norm checks, exact scoring and completeness/revision predicates remain. The two-project real-model regression now also simulates short and oversized on-disk vector blobs: neither may produce a candidate (including an oversized blob with a valid normalized prefix), and restored data passes integrity checks. All 98 local C# tests, 109 schemas and the retained real-model smoke pass. Post-change capacity/native CI are pending.

The fixed-snapshot plan-1/plan-2 measurements are preserved in `benchmarks`: hybrid p95 632.9483/624.8069 ms, both failing. Linux, Windows and macOS CI [38863600869](https://github.com/davidacres/praxis/actions/runs/38863600869) passed plan 2 at `60aa7057`; this does not qualify later plan changes automatically.

## SQLite read page-cache experiment

Read page-cache version 1 requests 16 MiB per read connection, retaining the 128 MiB file-mapping request and normal connection disposal. Snapshot/WAL, filter and malformed-vector fixtures pass in the full 98-test local C# suite; all 109 response schemas validate. The fixed-snapshot result is hybrid p95 579.3655 ms versus plan 3's 636.7387 ms, with query-only maximum RSS 964886528 bytes. It still fails 500 ms and does not qualify cold/full-process RAM or repeated/category acceptance. Raw observations are under `benchmarks`.

Read page-cache version 2 requests 64 MiB per read connection. The same 98-test suite and 109 schemas pass. Its fixed-snapshot hybrid p95 is 544.4594 ms with query-only maximum RSS 1153794048 bytes, still above the latency target. No whole-process memory qualification is inferred from that query-only value.

## Selected mapping pilot

Read mapping version 3 requests at most 640 MiB of file-backed mapping per read connection, with a 64 MiB SQLite page-cache request. The same-snapshot exact-query pilot measured **415.1196 ms hybrid p95**, **4.5717 ms lexical p95**, and query-only maximum RSS **1906245632 bytes**. A 1 GiB mapping pilot was faster (362.8384 ms) but had query-only RSS 2119991296 bytes; the smaller window leaves more headroom. Full-process/RSS, repeated/category/concurrent-edit and native CI qualification of this selected policy remain pending. All 98 local C# tests, 109 schemas and the retained real-model smoke pass.

Review policy clarification: specification §32 asks for reviewed labels and recommends a second human sample where practical. Source review by Codex must be identified as AI review; it is not human approval. Existing draft artifacts remain unreviewed until actual review records are attached. This does not relax the numerical, evidence, abstention or explanation criteria.

## Repeated-query evidence support

The retained benchmark supports one/four readers and up to five warm runs, preserving each run, p99, p95 min/max and all failed sample timings. Any timed/warmup error fails its gate. Workload hash/schedule/count are explicit; repeated runs use a declared deterministic schedule version 2. Real-model smoke verifies repeatability plus an injected 40-request/20-warmup failure case with no omitted samples. This is evaluation support, not a completed category/concurrent-edit performance protocol. The fresh full-process 50k selected-policy run remains in flight in an immutable copy of the prior benchmark build.

## Fresh selected-policy 50k process and compiler-backed tuning pilot

The fresh full-process Mac run passes the individual exact-query comparisons: hybrid p95 **478.7044 ms**, lexical p95 **4.4348 ms**, and independent peak RSS **2015674368 bytes** (below 2 GiB, compiler/native/model included). The full raw report and overlap/measurement limitations are recorded under `benchmarks`; this is not the complete repeated/category/concurrent-edit or cross-platform capacity gate.

Native CI [38867071673](https://github.com/davidacres/praxis/actions/runs/38867071673) at `5dbc7135` passed all three supported hosts with the selected policy, 98 C# tests, schemas, evaluator and retained-fixture smoke. Later benchmark-only repetition changes do not change the service binary; their expanded smoke passes locally and requires fresh CI.

The real four-context Maze model pilot has complete compiler/vector coverage and a stable snapshot, but positive tuning Recall@10 is **0.7714285714 hybrid**, **0.5142857143 lexical**. It is not held-out evidence and does not establish the 0.80 quality gate. Both the corpus and all misses are preserved under `evaluations`; no reviews are claimed by merely setting flags.

## Filtered retrieval and query-bound correction — 16 October

Search now applies language, kind and project filters before the lexical, exact and alias candidate limits. Alias rows are deduplicated before ranking. A 350-decoy regression verifies that a valid selected project/type cannot disappear behind the unfiltered lexical cap. Queries support up to 64 literal terms; longer requests return `INVALID_ARGUMENT` before model inference rather than silently discarding terms after 32. The full provisioned-model/SDK suite passed 105 tests with zero failures/skips. The earlier 50k performance reports predate this change; fresh timing is required.

## Model activation disk reserve — 16 October

Model activation now checks available space on the SQLite database volume before inference/publication, requiring the larger of 1 GiB or twice a conservative projected four-chunk profile (float32 payload plus span/index overhead). This is a preflight rather than a reservation; transactional publication still protects against later write failure. A real-model fault fixture injects zero available bytes without filling the host disk and verifies the previous vector results and query epoch remain unchanged. All 106 service tests passed with the pinned model and SDK enabled. Actual operating-system disk exhaustion remains a separate recovery scenario.

## Vector capacity fallback — 16 October

The exact vector scan retains its 200,000-chunk default bound. Exceeding it now returns lexical candidates with an explicit capacity warning in hybrid mode and `VECTOR_CAPACITY_EXCEEDED` in vector-only mode, rather than escaping as an unhandled operation failure. An actual-model fixture lowers the scan bound to exercise both paths without constructing a huge database; it verifies no partial vector channel or coverage claim survives fallback. Search plan version 3 identifies the filtered/exact-ranking implementation. All 107 service tests passed with no skips.

## Full corpus and current capacity checkpoint — 16 October

The source-reviewed Maze corpus is frozen at 120 cases (40 tuning/80 held-out, 20 in each category), including two explicit overload cases and 20 actual identifier rename/file-move transitions in a private four-project overlay. AI review is identified explicitly; no independent human review is claimed. The baseline report preserves all 240 searches and all transition proofs. It passed exact/overload lookup, compiler completeness, stable snapshots, full semantic coverage and error/duplicate checks, but **failed quality**: held-out hybrid Recall@10 0.7576 versus lexical 0.8939, driven by cross-project regression. One overload case initially retained its original expected evidence path after its file moved; this setup metadata was corrected without changing query text, split or relevant symbols. Negative result review is recorded separately from recall. Generated LLM explanations are M5, so an explicit M3 corpus excludes that conditional review gate rather than claiming 30 generated reviews.

The tuning artifact collects complete candidate channel ranks only for the 40 tuning cases. A preregistered grid of lexical weights 1, 1.25, 1.5, 2, 3 and 4 (vector/alias weight 1) selects maximum tuning Recall@10, then MRR, then lower lexical weight. Weight 4 wins with tuning Recall@10 0.9706. It is not yet applied or accepted by the held-out gate at this checkpoint; the failed baseline remains preserved.

The fresh search-plan-3/adapter-v6 full 50k run measured lexical p95 5.7069 ms and hybrid p95 442.528 ms, with no timed or warmup errors. Independent full-process maximum RSS was **2181988352 bytes**, exceeding the 2 GiB gate. Raw latency and independent process measurements are both preserved. Reader mapping version 4 reduces the request from 640 to 512 MiB; correctness tests pass, but its latency/RSS still require measurement. No memory pass is claimed.

## Tuning-selected fusion implementation checkpoint

Search plan 4 applies profile `rrf-k60-lexical4-vector1-alias1-v2`: lexical contribution 4/(60+rank), vector and alias contribution 1/(60+rank), with the independent exact bucket unchanged. The recorded 40-case tuning grid selected this weight before the updated profile was applied; no query text, split or relevant symbol selector changed. All 107 service tests pass. New benchmark reports identify the ranking profile and lexical weight explicitly. `scripts/tune-retrieval.py` preserves the candidate-collection/grid procedure, including waiting for startup reconciliation and rejecting mixed epochs/duplicate pages. Updated held-out and memory acceptance are still pending at this checkpoint.

## Updated held-out profile result — preserved before usage limit

The packaged search-plan-4 profile was queried against the same frozen 120-case corpus after the owned service's startup reconciliation settled. All 20 old identities remained withdrawn and all 20 new source hashes were revalidated against the original controlled transition proofs. Held-out hybrid Recall@10 increased from 0.7576 to **0.8333**, versus lexical **0.8939**. Unique exact lookup, ambiguous overload coverage, source evidence, complete compiler contexts, full semantic coverage, stable snapshots and zero errors/duplicates pass. The category-regression gate **still fails**: behaviour 0.8667 versus lexical 0.9333; cross-project 0.7692 versus 0.9231; terminology 0.5385 versus 0.6154. The feature remains incomplete. Query wording, split and relevant symbol labels stayed fixed; only the disclosed evidence-path setup correction and scope/review metadata changed.

All 107 service tests and all 13 evaluator tests (including the packaged owner) pass. The current native package passes CLI, SQLite, ONNX and owned-process startup/authentication/crash/restart smoke checks on macOS. Reader mapping 512 MiB has not yet received a fresh full-process memory qualification. No timed jobs remain running locally. Next work must address category regression using tuning evidence, re-run the fixed acceptance corpus transparently, measure the smaller mapping, and complete the remaining performance scenarios including watcher-inclusive 5k edit timing. Previous acceptance reports are retained as failures rather than replaced by a success claim.

## Expanded tuning range — 16 October

The first grid winner was its upper bound, so the same recorded 40 tuning cases were replayed over weights through 128, using the original Recall/MRR/lower-weight tie-break. No held-out query or relevance label participates in selection. Weight 64 is the lowest weight tied for the optimum: tuning macro Recall@10 1.0 and MRR@10 0.8366. `maze-fusion-expanded-tuning.praxis.json` records every trial and hashes the original complete-candidate artifact. Search plan 5 applies `rrf-k60-lexical64-vector1-alias0.5-v3`; alias weight 0.5 corrects the specification default (the tuning fixture has no aliases). This is a strongly lexical-weighted profile, not evidence of semantic recall gains. The prior weight-4 acceptance report is retained separately. All 107 service tests pass with the provisioned model and SDK. New acceptance and capacity measurements follow separately; the reused fixed acceptance set must not be described as a new blind hold-out experiment.

## Fixed-corpus retrieval acceptance — search plan 5

The current packaged profile passes every applicable gate on the fixed 120-case Maze corpus: 80 acceptance queries, 66 positively labelled acceptance cases, macro Recall@10 **0.893939**, MRR@10 **0.672042**, 100% unique exact top-1 and complete overloaded-name top-ten coverage. Each category equals its lexical baseline; there are no tool errors, duplicate matches, missing expected evidence, mixed snapshots or incomplete compiler/vector coverage. All 20 retired identities and replacement source hashes were revalidated. The baseline and weight-4 failures remain checked in. Query texts, relevance selectors and split stayed fixed through the tuning-only expansion; this is repeated evaluation of the published acceptance set, not a newly unseen blind study. AI source/negative review is identified; independent human review is not claimed. No generated LLM review or semantic recall improvement is claimed: recall and MRR match lexical-only retrieval for this corpus.

A fresh full-process 50k benchmark of the exact current search-plan-5 / mapping-version-4 binary is running from an immutable binary copy. This measurement is still pending and does not close the full performance protocol, watcher-inclusive edit timing or remaining platform/UI qualification.

## FTS revision-only publication optimization

Schema 4 guards the external-content FTS update trigger: changing only input revision does not delete/reinsert the same token stream. Text or row-ID changes still remove the old indexed content and insert the new content atomically. The regression checks that revision-only updates cause exactly one document-row change, that old tokens disappear after actual text changes, that new tokens retrieve the original symbol/evidence, and that FTS external-content integrity holds. Upgrade fixtures now cover schemas 1, 2 and 3 with backups and preserved facts. All 109 provisioned-model/SDK service tests pass. Conservative whole-context invalidation/revision semantics are unchanged.

The actual-watcher benchmark passed its five-edit 100-symbol native smoke; a 25-edit 5k baseline is running against the pre-optimization package. The current schema-3 full-process 50k run with mapping 512 MiB passed RSS (1827373056 bytes) but failed hybrid latency (526.8845 ms p95). Lexical p95 was 6.2885 ms and there were no query errors. These raw results remain failures, not a release pass.

## Reader mapping pilot and Windows benchmark cleanup — 16 October

Mapping version 5 selects 576 MiB. A retained post-edit 50k snapshot on schema 4 measured 400 queries per mode with four readers: lexical p95 6.0273 ms, hybrid p95 493.2797 ms, zero query/warmup errors. Independent `/usr/bin/time -l` reported 1610809344 bytes maximum RSS for this query-only process. This passes the measured query-only limits, not the full initial-index/enrichment process RSS or repeated/category/concurrent-edit protocol. The raw report is `macos-arm64-50000-profile5-map576-retained.praxis.json`; full-process measurement follows.

The pre-optimization native 5k actual-watcher baseline completed all 25 edits without error: structural p95 2981.2815 ms fails 2 seconds; semantic-refresh upper-bound p95 689.8446 ms passes 10 seconds. Its raw report is retained. Schema-4 comparison remains pending.

CI 38896614816 passed macOS/Linux. Windows completed every watcher sample, then failed benchmark shutdown because a signal-terminated child retains null `exitCode`. Cleanup now checks both exit and signal status, subscribes before signalling and bounds escalation waits so failure evidence can still be saved. This is a benchmark cleanup fix, not a Windows watcher failure. A fresh three-host run is required.

## Watcher scheduling and in-flight MCP verification

The schema-4 FTS optimization completed 25 actual-watcher edits on 5k symbols without errors. Structural p95 fell from 2981.2815 ms to 2127.0310 ms, still failing 2 seconds; semantic refresh p95 was 634.9363 ms. Raw `macos-arm64-5000-watcher-fts-guard.praxis.json` preserves that failure. The owner now checks maintenance every 100 ms instead of 500 ms and watcher debounce is 350 ms (within the specification’s 300–750 ms interval), retaining the 2-second maximum coalescing window and 60-second reconciliation. Timed qualification follows separately.

All 109 provisioned-model/SDK service tests pass; 131 captured responses validate across all 11 schemas. Core compilation and all four MCP fixtures pass with zero skips. The real native stdio fixture now verifies invalid arguments and successful subsequent queries. A separate real stdio/SDK fixture waits for an RPC child to start, cancels the in-flight request through MCP, verifies process termination and checks that error/list requests still work. Its child service is deliberately controlled, so this proves bridge cancellation, not paid/live provider or native inference cancellation under load.

## Watcher-inclusive 5k update targets pass

The current 100 ms maintenance / 350 ms debounce package completed 25 actual-watcher body edits with zero errors. Structural p95 was 1675.5366 ms and semantic-refresh conservative upper-bound p95 was 620.3558 ms, passing 2 seconds and 10 seconds respectively. All samples, the cold-first-edit outlier and measurement bounds are retained in `macos-arm64-5000-watcher-cadence.praxis.json`. This is one native process on this Mac, not the five-run reference-machine/concurrent-query protocol.

## Full-process mapping-576 result

The fresh immutable search-plan-5/schema-4 binary completed initial 50k indexing, real local inference, 400 queries per mode, edit publication and refresh. Independent peak RSS was 1915731968 bytes (passes 2 GiB); lexical p95 was 6.6607 ms; hybrid p95 was 506.9080 ms (**fails** 500 ms). There were no query or warmup errors. Initial structural indexing took 19.738 s and initial vectors 531.257 s. The pilot pass does not override this full-run failure. Raw and independent-process records are retained as `macos-arm64-50000-profile5-map576-full.praxis.json` and `macos-arm64-50000-profile5-map576-process.praxis.json`. This binary predates adapter-v7 assembly dependency edges and the optional phase observer; no exact-current-head release claim is made.

CI [38897870350](https://github.com/davidacres/praxis/actions/runs/38897870350) passed Windows, macOS and Linux, including actual watcher smoke and the Windows signal-cleanup fix.

## Observed assembly dependencies and repeatable query diagnostics

Adapter `roslyn-5.9/v7` adds one compiler-observed external assembly dependency per context/assembly. Identity includes the actual assembly version/culture/public-key identity; the external module has no invented local declaration or inferred NuGet package name. Its dependency edge retains a deterministic original source occurrence/hash/range. Partial contexts remain possible; syntax-only contexts emit no assembly dependencies. Existing source-to-source dependencies remain source-backed and withdraw on edits. General delegate flow and unused configuration-only graph edges remain unsupported.

All 111 C# tests pass with model/SDK fixtures, including assembly identity/source evidence, degraded contexts, graph publication/removal and optional measurement wire-equivalence/cancellation. The cumulative captured 261 responses validate across all 11 tools. Core/application compilation also passes.

The internal opt-in query observer records model query including lock wait, retrieval, vector-scan subcomponent and response preparation without adding wire fields, text logging or persistent telemetry. Benchmarks exclude warmups from phase distributions. The query matrix starts independent processes, matches one/four-reader stride-17 workloads, preserves raw failures, validates sample counts/snapshots and refuses output within the retained fixture or overwrites. Its process/failed-result/containment safeguards pass. Exact, terminology, behaviour and negative categories are synthetic performance workloads; real cross-project and concurrent-edit performance remain distinct outstanding scenarios. The runner is implemented, not a completed five-run qualification.

## Exact streaming candidate selection

Vector scorer version 4 retains only the exact top 100 symbol maxima during exhaustive scanning. The threshold is monotonic, equal scores retain ordinal-ID tie breaking, later chunks may re-enter and improve a previously discarded symbol, and every vector is still validated/scored. IDs below the competitive threshold need not be decoded. This bounds ranking state without ANN, cached candidate subsets, altered cosine precision or reduced scan coverage. A fixed-seed regression compares ten shuffled 4,000-chunk workloads with exhaustive grouped maxima, including negative scores, ties and later chunks. All 112 provisioned service tests passed at the selector checkpoint before subsequent configured-reference graph work. Capacity latency/RSS improvement remains unmeasured until the desktop regression run finishes.

The new independent matrix executed eight real 100-symbol benchmark processes (four synthetic categories, one/four readers, 200 timed queries per mode) with matched query hashes, complete coverage, complete phase samples and no failed measured smoke gates. This is harness validation at 100 symbols, not 50k performance qualification.

## Captured configuration dependencies

Adapter `roslyn-5.9/v8` closes the unused-reference graph gap. Validated captured project references and compiler-bound metadata assembly references publish `depends_on` edges with no occurrence/file ID; their evidence is explicitly metadata, containing context/reference hashes and actual project/assembly identity. No local source range, usage occurrence or NuGet name is invented. Compiler project references persist target full-context hashes in `context_dependencies`; this is conservative whole-context dependency stamping, not semantic API-only optimization. Publication replaces configured edges atomically; removal of the captured reference withdraws both edge and dependency stamp. Syntax-only contexts emit none, and partial contexts remain possible.

All 112 C# tests pass with zero skips using SDK/model fixtures. Source-use proofs and configured-reference proofs remain distinct in graph tests. Tests cover an unused project reference, metadata hash/version identity, graph/schema evidence, source rename/move/deletion with a still-configured assembly, and final withdrawal after configuration removal. Current schema captures validate separately. General delegate points-to inference remains unsupported as allowed by the explicit unresolved-runtime boundary.

## Follow-up CI harness corrections

CI 38900116034 preserved two failures: macOS/Linux retained-smoke compared hashes from 40 four-reader queries against 10 single-reader queries after the hash began describing the actual timed workload; Windows fixture Git setup left its process alive on a cold-start timeout, masking the assertion with a directory-lock cleanup error. The smoke now uses 40 queries for both reader counts and verifies exact phase sample counts. Fixture-only Git setup allows 15 seconds, kills/drains owned work on timeout and still fails the timeout explicitly; production ignore-policy deadlines are unchanged. All 112 provisioned C# tests pass locally, and the real retained smoke passes including source/membership/epoch tampering, repeated matched-reader schedules, failure retention and restoration. Fresh native CI is still required.

## Adapter-v8/exact-streaming fixed-corpus recheck

The current native package revalidated all 20 controlled transitions and reran the fixed 120-query corpus after startup reconciliation settled. Every declared gate passes: acceptance Recall@10 0.893939 and MRR@10 0.672042 equal lexical, with no errors/duplicates, missing evidence, mixed epochs or incomplete compiler/vector coverage. The new report `maze-release-configured-dependencies-results.praxis.json` preserves all samples and explicitly records adapter v8 and scorer v4. This is a repeat of the published corpus, not a new blind study or evidence of semantic recall gains. Desktop tests ran concurrently, so these CLI timings are quality-run diagnostics, not capacity latency qualification.

## Desktop keyboard fix and full functional run

The real keyboard regression exposed Escape bubbling out of the relocation prompt and closing Settings. Shared dialogs now consume Escape/accepted input Enter, focus their input or Cancel control, contain Tab/Shift-Tab and restore the opener when it remains enabled. Enter on a Cancel button keeps its native cancellation behaviour. The focused light/dark regression at enlarged control scale verifies focus rings, tab containment, Escape, Enter-on-Cancel, unchanged repository root and no panel overflow; an additional exact-build rerun passes. Four focused tests, including native source navigation/recovery, pass and screenshots were visually inspected. The test catalogue has 615 linked entries and its contract check passes.

The required full functional desktop run completed **543 passed, 15 failed, 3 skipped (12.3 minutes)**. Every code-intelligence fixture passed. Wider failures concern AI transcript/usage/review, provider recovery, connections, EasyMode and issue creation. These must not be declared pre-existing solely by inspection: a rerun of all failures using a separately built previous-dialog renderer is underway, with the fixed renderer backed up and restored afterward. No unrelated feature repair or screenshot baseline update is claimed.

## Wider desktop baseline comparison and fresh native CI

The 15 failed desktop cases were rerun using a separately built renderer with only `dialogs.tsx` reverted to c1e5ef94. Fourteen failed again; the demo-board Subtask case passed on rerun. Renderer-index hashes, exact failed cases and verified restoration of the fixed renderer are recorded in `desktop-dialog-baseline-comparison.praxis.json`. This establishes that those 14 failures do not require the dialog change; it does not fix them or establish the cause of the intermittent fifteenth case. All four code-intelligence tests passed in the full run, and the focused keyboard test also passes Enter-on-Cancel.

[Native CI 38901354276](https://github.com/davidacres/praxis/actions/runs/38901354276) passes all three hosts with 112 C# tests each, schema validation, retained and matrix runner safeguards, packaging/ONNX/IPC and actual watcher smoke. No native test skip, actual provider-adapter proof or full desktop pass is inferred from this result.

## Isolated scorer-v4 capacity query result

The current exact streaming scorer completed 400 timed exact queries per mode with four readers and 20 warmups on the verified retained post-edit 50k snapshot. Lexical p95 was **11.1386 ms**, hybrid **387.2155 ms**, with zero warmup/query errors. Independent query-process peak RSS was **1865580544 bytes**, below 2 GiB. The main 100/500 ms limits pass; retrieval-only p95 **370.6477 ms fails the 250 ms target**, so `PassedMeasuredGates` remains false. Vector scan p95 was 336.1311 ms; model query including lock wait 8.6380 ms; response preparation 15.4993 ms. These phase percentiles are not additive. Raw and independent-process reports preserve the failed target. The retained data predates adapter-v8 configured edges, and schedule 2 differs from the earlier four-reader pilot; no identical-workload speedup percentage or full-process/repeated-category qualification is claimed. Fresh full-process indexing/inference/RSS follows separately.

## Saved-files UI scope notice

The code-intelligence panel now explicitly says saved files are searched and unsaved editor changes are not indexed, as required by §26.2. All four recovery/search/light-dark-keyboard/native-service tests pass on the rebuilt renderer; a separate capture rerun verifies the visible notice and its layout. The updated 615-entry catalogue contract passes. This text-only follow-up does not turn the earlier full desktop run into a green suite; its wider baseline-reproduced failures remain open.

## Full adapter-v8/scorer-v4 result — RSS failure preserved

The immutable current-build full run completed indexing, real inference, 400 queries per mode and edit/refresh with zero query errors. Lexical p95 **5.8004 ms** and hybrid **405.6300 ms** pass the main latency limits. Retrieval-only p95 **383.2350 ms** still fails 250 ms. Independent peak RSS **2235957248 bytes** fails 2 GiB, despite the separate query-only process passing it. Both raw and independent-process records, including binary hashes, are preserved. Reader mapping is being reduced to 512 MiB (version 6); its latency and full-process memory must be measured afresh. No current release pass is claimed.

## Reader mapping v6 and current graph/scorer watcher result

Reader mapping v6 selects 512 MiB. All 112 provisioned C# tests pass, with zero skips. Its isolated adapter-v8 retained-snapshot pilot measured 200 exact queries per mode with four readers: lexical p95 **6.2081 ms**, hybrid **420.2002 ms**, zero query/warmup errors and independent query-process peak RSS **1289863168 bytes**. The main latency/RSS pilot limits pass; retrieval-only still fails 250 ms and full-process memory remains pending. Raw and independent-process reports are preserved.

The adapter-v8/scorer-v4 native package (before this mapping-only change) completed all 25 actual-watcher 5k edits with zero errors: structural p95 **1675.3390 ms**, semantic-refresh conservative upper-bound p95 **609.0794 ms**. Both update gates pass. The new source/configuration graph and streaming selector therefore retain update performance in this run; repeated/concurrent-load qualification remains open.

## Final mapping-v6 native verification

[CI 38904504214](https://github.com/davidacres/praxis/actions/runs/38904504214) passes Windows/macOS/Linux for the selected 512 MiB mapping and streaming scorer v4. Each host passes 112 C# tests, schemas, retained/matrix safeguards, native packaging/ONNX/IPC and watcher smoke. The final local native package also passes all four MCP and 13 evaluator fixtures. Full local capacity RSS measurement is still pending; this CI result does not replace performance or live-provider qualification.

## Selected configuration — full main latency/RSS limits pass

The immutable selected adapter-v8/scorer-v4/mapping-v6 binary completed the fresh full process: initial 50k indexing, real local inference, 400 exact queries per mode, body-edit publication and refresh. Lexical p95 **5.8947 ms**, hybrid **434.5913 ms**, zero warmup/query errors and independent maximum RSS **2004254720 bytes (1.867 GiB)** pass the main 100/500 ms and 2 GiB limits together. Raw and independent-process records include binary hashes and the implementation commit. These are exact-query, one-run measurements on this Mac, not the complete reference-machine performance protocol. Retrieval-only p95 **414.3476 ms** still fails 250 ms; the raw `PassedMeasuredGates` therefore remains false. Previous failed configurations remain preserved.

## Final broader terminology pilot and remaining work

The selected mapping-v6/scorer-v4 binary completed independent one-reader and four-reader processes on the verified current 50k retained snapshot, each with 20 warmups and 200 timed queries per mode. Query hashes match across reader counts; all phase samples are present and errors are zero. Single-reader lexical/hybrid p95 **74.3707/353.6647 ms** pass main latency limits. Four-reader lexical **98.6638 ms** passes, but hybrid **507.8171 ms fails** 500 ms. Retrieval-only also fails 250 ms. Both raw reports and the complete matrix summary are checked in; relative artifact paths were relocated without changing measurements. This is one terminology run, not the five-run/full-category protocol.

Implemented coding gaps closed in this continuation: guarded FTS publication and watcher scheduling, exact bounded top-k ranking, source-observed and captured configuration project/assembly dependencies with distinct evidence, in-flight MCP/error tests, shared recovery-dialog keyboard handling and saved-file UI scope. The latest service suite is 112/0/0, final native CI is green on all three hosts, four focused desktop tests pass, and fixed-corpus quality passes without a semantic-recall-gain claim.

**M3 remains incomplete.** Remaining work is performance improvement for broad four-reader queries and the 250 ms retrieval-only target; full repeated/category/concurrent-edit/reference-machine qualification; live provider-adapter/platform/accessibility qualification; and the wider desktop failures recorded in the baseline comparison. No later language or generated-explanation milestone is required for this C# scope. All completed changes and failed/successful evidence are committed; no local timed service/benchmark is intentionally left running.

## Ranked-validation vector search checkpoint — 16 October

`ModelStore.Candidates` now scores ready vectors with no symbol/target joins, keeps a ranked window of 1024 symbols, and validates candidates in rank order (symbol revision, representation target, set completeness, context/kind/project filters) with a prepared point query until 100 validate. If fewer than 100 validate and the window was saturated, if the chunk capacity is exceeded, or if the database holds more than one repository, the previous exhaustive validated scan (`ExhaustiveCandidates`, unchanged) decides. Results are therefore identical to the exhaustive scan for any window size; a new real-model test compares both paths across filters, windows (100/128/1024) and with the 30 and 100 best-ranked symbols made ineligible (forcing fallback). 113 C# tests pass, zero skipped, with SDK and model.

Motivation (private immutable copy, sqlite3): the symbols/representation_targets point lookups, not scoring or blob reads, dominated the old scan (~310 ms of the join vs ~39 ms for vector blobs alone). Covering indexes on those tables gave only ~25 ms and were not adopted; no schema change.

Single terminology pilot, same retained 50k fixture and query set hash as the earlier pilot (`benchmarks/macos-arm64-50000-ranked-validation-terminology-pilot*`), zero errors:

| Readers | Hybrid p95 before → after | Retrieval p95 (after) | Vector scan p95 (after) |
|---|---|---|---|
| 1 | 353.665 → 228.496 ms | 221.922 ms (passes 250) | 126.157 ms |
| 4 | 507.817 → 365.737 ms | 345.232 ms (**fails 250**) | 225.112 ms |

One run, terminology only: not the five-run/all-category/concurrent-edit protocol, and not yet re-measured on the full-process memory run. Four-reader retrieval-only still fails; the lexical arm (74–98 ms p95) is now the next largest component.

Query-only peak RSS of the four-reader benchmark process (`/usr/bin/time -l`, 50 queries per reader, one run each; not the full compiler/model process): exact 1,266,696,192 bytes, terminology 1,335,672,832 bytes. The 2 GiB full-process gate has not been re-measured with this change.

Investigated and not adopted:
- Covering indexes on `symbols` / `representation_targets` (~25 ms in a private copy; planner ignores them without `INDEXED BY`).
- Removing the 512 MiB read mapping (four-reader hybrid p95 397.9 vs 377.0 ms, no scaling benefit).
- A resident vector matrix keyed by `query_epoch` would cut the 126–225 ms scan to roughly scoring time (about 8 ms measured) but retains a detached vector cache, which this design deliberately does not have, and would stop detecting out-of-band vector corruption between epoch bumps (an existing regression test relies on that). Not implemented; needs an explicit decision.
- Phase timing of the new score pass (single reader): about 90 ms SQLite row/blob delivery, about 8 ms scoring. The lexical arm (about 75 ms) is dominated by FTS5 `bm25` over about 49k broad matches (about 60 ms) plus symbol lookups (about 45 ms); only the lookups are avoidable.

Still failing/open: four-reader retrieval-only p95 345.232 ms (> 250), full five-run/all-category/concurrent-edit protocol, full-process memory re-measure, reference hardware, provider/platform/accessibility, recovery/stress/disk-full, five native runtime identifiers, and the non-green broad desktop suite (unchanged; no desktop files touched).

## Dense vector-scan table checkpoint (schema 5) — 16 October

Schema 5 (`migration005.sql`) adds `vector_scan`: a dense copy of each chunk's set ID, chunk index, symbol, model fingerprint, ready flag, dimensions and vector bytes. The migration backfills it, and triggers on `vectors` (insert/update/delete, including FK cascades) and `embedding_sets` (set/symbol/model/state updates) keep it in the writing transaction. Vector query plan 4 scores this table, then validates candidates in rank order as before. It also rescores each accepted set from `vectors` and hands the query to the exhaustive scan if the two disagree. `IndexDatabase.Check()` now reports any row-level difference between the copy and `vectors` joined to `embedding_sets`. (The previous ranked-validation commit did not bump `VectorQueryPlanVersion`; its pilot reports say plan 3.)

The window test now also covers: a schema-4 database migrated by backfill, an edit plus republish/reactivation, and a drifted copy. The drifted copy must fail `Check()` and still return exhaustive results. With the rescoring guard disabled, that case fails, so the guard is what keeps results exact. Existing lifecycle tests already run `Check()` after indexing, reuse, refresh, relocation and unregister, so they now also prove the copy stays in step. 113 C# tests pass, zero skipped. Limitation: a row *missing* from the copy (only possible through out-of-band writes that bypass the triggers) is caught by `Check()`, not at query time.

The retained 50k fixture was migrated in place with the service's explicit `init`. Root, generation, epoch and sources are unchanged; the service kept its own schema-4 backup beside the database, and a separate byte copy was kept privately. Migration took about 3 s and grew the database from 808,898,560 to 918,982,656 bytes.

Terminology pilot, same query-set hash, zero errors (`benchmarks/macos-arm64-50000-vector-scan-terminology-pilot*`):

| Readers | Hybrid p95 | Retrieval p95 | Vector scan p95 | Lexical p95 |
|---|---|---|---|---|
| 1 | 173.3 ms | 167.4 ms (passes 250) | 69.4 ms (was 126.2) | 74.2 ms |
| 4 | 280.9 ms | 260.2 ms (**fails 250**) | 140.8 ms (was 225.1) | 98.8 ms |

Single run, one category. Edit-publication cost (vector bytes are now written twice) has not been re-measured.

## Lexical candidate window checkpoint (search plan 6) — 16 October

The lexical arm no longer joins every FTS match to `symbols` just to take 100. It reads exact-name rows first through the indexed `symbols(repository_id,name)` lookup, which is skipped when no symbol has that name. Next it reads the best 1024 matches by (`bm25`, symbol ID) and joins only those, applying the context, kind, project and language filters and excluding exact-name rows. If that yields fewer than 100 rows and the window was full, the previous full ranked join decides. The order is identical to the old `(name=query) DESC, score, symbol_id`. Vector-only searches no longer compute the lexical arm they discarded. A new test compares full responses for five queries × three kind filters × windows 1/7/150/1024 against the full join. It fails under each of three injected ordering/fallback/exclusion bugs. 114 C# tests pass, zero skipped.

Terminology pilot (schema-5 fixture, same query-set hash, zero errors; `benchmarks/macos-arm64-50000-lexical-window-terminology-pilot*`):

| Readers | Lexical p95 | Hybrid p95 | Retrieval p95 | Vector scan p95 |
|---|---|---|---|---|
| 1 | 47.2 ms (was 74.2) | 148.2 ms | 143.0 ms | 70.8 ms |
| 4 | 78.1 ms (was 98.8) | 258.9 ms | **237.4 ms (passes 250)** | 146.9 ms |

This is the first measurement where four-reader retrieval-only passes. The margin is about 13 ms, from a single run in one category, so it is not qualification.

## Full query matrix, plan 6 — 16 October

`benchmarks/macos-arm64-50000-plan6-query-matrix*` contains 40 independent processes on the schema-5 retained fixture. That is five runs of each category (exact, terminology, behaviour, negative) at one and four readers, 200 timed queries per mode and 20 warmups, with matched query-set hashes per group. The matrix is complete with zero query errors and no runner failures. **The matrix fails:** one of 40 processes misses the retrieval-only target.

| Category | Readers | Lexical p95 range | Hybrid p95 range | Retrieval-only p95 range |
|---|---|---|---|---|
| exact | 1 | 1.54–1.68 ms | 104.1–106.2 ms | 98.4–100.8 ms |
| exact | 4 | 6.73–7.32 ms | 192.6–205.1 ms | 172.2–181.8 ms |
| terminology | 1 | 46.2–47.9 ms | 147.5–148.5 ms | 142.2–143.2 ms |
| terminology | 4 | 74.5–77.1 ms | 261.4–268.3 ms | 239.1–246.7 ms |
| behaviour | 1 | 46.7–47.9 ms | 148.9–150.3 ms | 143.5–145.1 ms |
| behaviour | 4 | 76.4–82.9 ms | 256.3–322.7 ms | 236.4–**301.9** ms |
| negative | 1 | 1.59–1.67 ms | 108.0–110.3 ms | 102.3–104.4 ms |
| negative | 4 | 6.61–6.82 ms | 199.1–206.7 ms | 178.9–185.7 ms |

Lexical (≤100 ms) and hybrid (≤500 ms) pass in every process. Retrieval-only (≤250 ms) fails once: behaviour four-reader run 1, at 301.9 ms with a 206.4 ms vector-scan p95. The other four runs in that group measured 236–241 ms. The cause is not established; it looks like a first-run or host effect rather than a deterministic regression, but that is not proven. Broad four-reader workloads otherwise sit within 3–14 ms of the target on this 12-core Mac, so the reference 8-core machine may well fail.

Native CI [38918489261](https://github.com/davidacres/praxis/actions/runs/38918489261) at `d8487df1` passed on Windows, Linux and macOS with the schema-5/plan-6 code.

Still open:
- The four-reader retrieval margin.
- Concurrent-edit, cross-project and owner/wire measurements.
- Full-process RSS with schema 5.
- Edit-publication cost of the duplicated vector writes.
- Reference hardware.
- Provider, platform and accessibility checks.
- Recovery, stress and disk-full qualification.
- The two runtime identifiers with no execution evidence (Linux arm64, macOS x64).
- The broader desktop suite.

## Schema-5 edit-publication cost — 16 October

The packaged native owner, using the actual watcher, ran 25 edits on the same 5k corpus hash as `macos-arm64-5000-watcher-v8-scorer4` (earlier today, same Mac), with zero errors. The packaging step's native IPC smoke passed. Result: `benchmarks/macos-arm64-5000-watcher-schema5.praxis.json`.

| Upper bound | v8/scorer-4 p95 | Schema 5 p95 |
|---|---|---|
| Structural detection (gate ≤2 s) | 1675.3 ms | 1763.3 ms (passes) |
| Semantic refresh (gate ≤10 s) | 609.1 ms | 642.8 ms (passes) |
| Edit to vectors | 2059.1 ms | 2215.3 ms |

The duplicated vector writes cost roughly 5–8% at p95 in this single comparison; run-to-run noise was not measured. The structural margin to the 2 s gate falls from about 325 ms to about 237 ms.

## Full-process 50k run, plan 6 / schema 5 — 16 October

This is the same protocol as `scorer4-map512-full`: cold indexing of 49,999 source symbols (50,001 published), real local inference, 400 exact queries per mode, then body-edit publication and refresh, all under `/usr/bin/time -l`. Zero query or warmup errors. Raw files: `benchmarks/macos-arm64-50000-plan6-schema5-full.praxis.json` and `-process.praxis.json`.

| Measure | Plan 5 / schema 4 | Plan 6 / schema 5 |
|---|---|---|
| Lexical p95 | 5.895 ms | 6.467 ms |
| Hybrid p95 (≤500) | 434.591 ms | **211.053 ms** |
| Retrieval-only p95 (≤250) | 414.348 ms (fails) | **191.841 ms (passes)** |
| Vector scan p95 | 382.205 ms | 152.449 ms |
| Peak RSS (≤2 GiB) | 2,004,254,720 | 2,020,671,488 (passes; about 127 MiB headroom) |
| Initial index / vectors | 17,990 / 522,709 ms | 17,611 / 520,185 ms |
| 50k body edit | 14,263 ms | 17,034 ms (+19%) |
| Vector refresh | 1,685 ms | 1,777 ms |

All measured gates pass in this run. That covers this process only: the four-reader broad-category matrix still has one retrieval failure and thin margins. The 50k body-edit regression is consistent with writing vector bytes twice plus trigger work, but its cause was not isolated. There is no 50k edit gate; the 5k watcher gate still passes.

## 50k concurrent-edit workload — 16 October

The fresh-fixture benchmark gained an opt-in `--concurrent-edits N` phase (`f945c529`). After the normal measurements, one writer makes N real body edits, each followed by publication and vector refresh. Meanwhile four readers alternate lexical and hybrid exact-name queries until the writer finishes. Any query error, lost vector channel or unpublished edit fails the phase. Coverage is allowed to dip and is reported. The run used 49,999 source symbols, real local inference and 25 edits, under `/usr/bin/time -l`. Raw files: `benchmarks/macos-arm64-50000-plan6-concurrent-edits-full.praxis.json` and `-process.praxis.json`.

| Measure | Result |
|---|---|
| Idle phase (same process) | lexical p95 6.671 ms, hybrid p95 204.586 ms, retrieval-only p95 183.431 ms, body edit 16,326 ms, refresh 1,846 ms |
| Concurrent queries | 11,870 lexical + 11,870 hybrid, **zero errors** |
| Concurrent lexical p95 / p99 / max | 12.118 / 163.363 / 2,267 ms (passes 100 ms p95) |
| Concurrent hybrid p95 / p99 / max | 417.431 / 855.682 / 4,734 ms (passes 500 ms p95) |
| Concurrent retrieval phase p95 (lexical and hybrid combined) | 360.286 ms; not comparable to the hybrid-only 250 ms target, and a hybrid-only retrieval figure would be higher |
| Minimum vector coverage seen | 49,997 of 49,999 |
| Edit publish p50 / max under load | 31,423 / 40,437 ms |
| Refresh p50 / max under load | 3,645 / 13,291 ms |
| **Independent peak RSS** | **2,594,717,696 bytes: fails the 2 GiB budget** |

The benchmark's own summary reports `PassedMeasuredGates: true` only because its in-process RSS gate is unavailable on macOS (`null`). The independent measurement is authoritative, and it fails. The idle full run peaked at 2,020,671,488 bytes, so the extra roughly 545 MiB comes from overlapping compilation/publication with four readers' mapped and cached pages. This is not yet attributed between the writer, the reader mappings and the page caches. Specification §31.3 requires memory-pressure admission (stop background inference, evict caches, reduce concurrency at 80% of the budget); that admission control is not implemented. Tail latency under edits (hybrid p99 856 ms, max 4.7 s) and publication slowing to about 2× are also recorded.

## Disk-full handling and actual full-volume qualification — 16 October

The first actual full-volume run (`scripts/qualify-disk-full.mjs`: a private 64 MiB APFS sparse image holds only the index data and is filled until the OS returns ENOSPC) **failed** every behavioural gate. Two causes:
- **Every connection failed, reads included.** The owner opened a fresh, unpooled connection per operation. When the last one closed, SQLite deleted `index.db-wal` and `index.db-shm`, and a full volume could not recreate them. Every open, including reads and `doctor`, then failed with `SQLITE_CANTOPEN` (14).
- **Failures were silent and permanent.** `SqliteException` was caught by neither `Dispatch` nor the owner's request handler, so clients saw "Unable to read beyond the end of the stream" instead of an error. The same exception faulted the background maintenance task, so indexing never resumed after space was freed until the owner restarted.

Fixes (specification §31.3):
- **Keep-alive connection.** The owner holds one idle connection open for its lifetime, so the WAL and shared-memory files persist. Reads keep working on a full volume, and writes fail inside SQLite with `SQLITE_FULL`, which rolls the transaction back.
- **Classification.** `StorageFailures.IsDiskFull` recognises `SQLITE_FULL`, ENOSPC and the Windows disk-full codes, including wrapped exceptions. It also counts SQLite CANTOPEN/IOERR or other I/O failures when the index volume has under 16 MiB free (`NearlyFullBytes`); that is a heuristic for an owner started on an already-full volume.
- **Errors.** `Dispatch` returns retryable `DISK_FULL`; other SQLite failures return `OPERATION_FAILED` instead of escaping. The owner replies `INTERNAL_ERROR` to any unexpected exception rather than dropping the client.
- **Pausing and recovery.** Background writes pause on a 30 s retry delay. `doctor` reports `storage: {writesPaused, code, sinceUtc, retryUtc}`. A `DISK_FULL` job returns to pending without using an attempt or a backoff slot, and the first maintenance pass after the pause reconciles every unpaused repository. Other storage exceptions back off instead of ending the maintenance loop. The job-level handler now also records `SqliteException` failures.

Result after the fixes (`evaluations/macos-arm64-actual-disk-full.praxis.json`), all five gates pass:
- The volume was genuinely full (63,307,776 filler bytes).
- `index` returned retryable `DISK_FULL`.
- `doctor` reported `writesPaused: true` with code `DISK_FULL` and zero integrity findings.
- Search results and generation were unchanged.
- After the filler was deleted, the new file became searchable after about 31 s without a restart, and the pause cleared.

`DiskFullTests` adds classification checks and a cross-platform `SQLITE_FULL` scenario: a page cap set through the internal test hook makes SQLite fail exactly as it does on a full volume. That scenario covers a direct action, background maintenance, the preserved committed state and recovery. Mutation checks: disabling the no-backoff `DISK_FULL` rule fails it. Disabling the outer maintenance catch does not fail the unit test, because the page cap cannot deterministically fail small scheduling writes; the actual-volume run is what covers that path.

Verification: 116 C# tests, zero skipped; 13 evaluator tests through the packaged owner; 4 MCP SDK/stdio tests, zero skipped; native IPC packaging smoke. The actual-volume script is macOS-only (it uses `hdiutil`). Windows and Linux actual-volume runs remain open.

## Native CI for disk-full handling — 16 October

Run [38930087096](https://github.com/davidacres/praxis/actions/runs/38930087096) at `10aae5b2` **failed on Windows**: `HostTests.PersistedRepositoryClientGrantsAreExplicitAndRevocable` could not delete its temporary `index.db`. The test never disposed its two `ServiceRuntime` instances, and the new keep-alive connection holds the database open for a runtime's lifetime (production disposes it via `using`). After the test fix (`71f10163`), run [38930496865](https://github.com/davidacres/praxis/actions/runs/38930496865) passed on Windows, Linux and macOS.

## Concurrent-edit memory attribution — 16 October

A repeat 50k concurrent run with 10 edits (`benchmarks/macos-arm64-50000-concurrent-rss-attribution/`: report, phase starts, RSS sampled once a second) again failed the budget: `/usr/bin/time` peak 2,623,160,320 bytes. Resident memory by phase:

| Phase | Peak RSS sampled | RSS at phase end |
|---|---|---|
| Index 50k | 0.77 GiB | 0.77 GiB |
| Model install and vectors | 0.79 GiB | 0.73 GiB |
| Four-reader hybrid queries | 1.81 GiB | 0.74 GiB |
| Single body edit | 1.62 GiB | 1.25 GiB |
| Queries during 10 edits | 2.29 GiB (1 s sampling misses the 2.44 GiB peak) | 1.16 GiB |

Concurrent readers add about 1.07 GiB, and the writer adds up to about 0.9 GiB, part of which stays resident after publication. The two overlap during concurrent edits.

Query-only reader-policy frontier on the retained schema-5 fixture: four readers, 100 queries each, one run per cell, `/usr/bin/time` RSS. Raw reports are in `benchmarks/macos-arm64-50000-reader-memory-frontier-runs/`.

| Read map / page cache | Terminology RSS · hybrid p95 · retrieval p95 | Exact RSS · hybrid p95 |
|---|---|---|
| 512 MiB / 64 MiB (current, mapping v6) | 1.19 GiB · 257.8 · 238.0 ms | 1.13 GiB · 193.2 ms |
| 256 MiB / 16 MiB | 0.98 GiB · 240.6 · 229.2 ms | 0.92 GiB · 179.8 ms |
| 128 MiB / 16 MiB | 0.85 GiB · 249.6 · 238.2 ms | 0.80 GiB · 190.4 ms |
| 128 MiB / 8 MiB | 0.90 GiB · 252.9 · 243.2 ms | 0.76 GiB · 190.7 ms |
| 64 MiB / 16 MiB | 0.71 GiB · 281.8 · 270.1 ms | 0.63 GiB · 213.1 ms |

With the dense `vector_scan` table, a 128 MiB map and 16 MiB cache saves about 0.33 GiB of query RSS with no measurable latency cost (single runs). That alone does not close a roughly 0.45 GiB overrun, so writer-side retention is being measured next. No policy has been adopted yet.

## Reader policy for concurrent edits (mapping v7, page cache v3) — 16 October

Two fresh 50k runs with 10 concurrent edits used the query-only frontier's 128 MiB map and 16 MiB cache (`benchmarks/macos-arm64-50000-concurrent-reader-policy/`; the experiment build differs from the adopted code only in the version constants and a comment):

| Run | `/usr/bin/time` peak RSS | Idle hybrid / retrieval p95 | Concurrent lexical / hybrid p95 | Concurrent errors | Publish p50 under load |
|---|---|---|---|---|---|
| 512/64 MiB (attribution run above) | 2,623,160,320 (**fails**) | n/a | n/a | 0 | n/a |
| 128/16 MiB | **1,926,168,576 (passes 2 GiB)** | 209 / 198 ms | 12.3 / 380 ms | 0 | 26.8 s |
| 128/16 MiB + `DOTNET_GCConserveMemory=7` | 1,905,836,032 | 209 / 198 ms | 11.5 / 420 ms | 0 | 28.5 s |

The reader policy cuts the concurrent peak by about 0.70 GB, more than the 0.33 GiB it saves in query-only runs. Concurrent readers no longer stack large file mappings on top of the writer. The GC setting adds only about 20 MB and is slower, so it is not adopted. `IndexDatabase` now uses mapping version 7 (128 MiB) and page-cache version 3 (16 MiB). 116 C# tests pass, zero skipped. Headroom to 2 GiB is about 211 MiB in one run on a 12-core Mac. The policy still needs the full query matrix, the 25-edit concurrent protocol and the reference machine.

## Mapping v7 qualification — 16 October

**Native CI:** [38937746342](https://github.com/davidacres/praxis/actions/runs/38937746342) at `605eb881` passed on Windows, Linux and macOS.

**Full query matrix** (`benchmarks/macos-arm64-50000-map7-query-matrix*`): five runs × four categories × one/four readers × 200 queries. It is complete, with zero errors and no runner failures. **It fails** with 36 of 40 processes passing every gate, against 39 of 40 under mapping v6. Every lexical (≤100 ms) and hybrid (≤500 ms) p95 passes. Retrieval-only p95 at four readers, five runs each:
- Behaviour: 236.1–270.4 ms; runs 1–3 fail.
- Terminology: 245.9–250.2 ms; run 4 fails by 0.2 ms.
- Exact: 179.6–189.8 ms, all pass.
- Negative: 177.0–184.8 ms, all pass.

The single-run frontier did not show this cost. Over five runs the smaller reader settings add roughly 5–25 ms to broad four-reader retrieval, which had almost no margin.

**25-edit concurrent 50k run** (`benchmarks/macos-arm64-50000-map7-concurrent-edits/`), under `/usr/bin/time -l`:
- Peak RSS **1,966,702,592 bytes; passes 2 GiB** (mapping v6: 2,594,717,696).
- Idle: lexical p95 6.38 ms, hybrid 198.2 ms, retrieval-only 186.7 ms, body edit 16,706 ms, refresh 1,889 ms.
- Concurrent: zero errors across 10,714 + 10,714 queries; lexical p95 11.667 ms, hybrid p95 408.155 ms (p99 794.6, max 1,953.5); minimum vector coverage 49,997 of 49,999.
- Edits under load: publish p50/max 27.7/34.0 s, refresh p50/max 3.5/9.9 s.

**Trade-off as it stands:** mapping v7 fixes the memory failure and introduces four marginal retrieval-only failures in broad four-reader workloads. Making broad retrieval itself cheaper is the next step, rather than trading memory for latency.

## Native score pass (vector query plan 5) — 16 October

Instrumenting the score pass on the retained fixture (terminology queries) showed the cost was ADO.NET, not scoring:

| Readers | `Read()` step | `GetBytes` copy | Scoring | Total |
|---|---|---|---|---|
| 1 | 29.6 ms | 32.2 ms | 7.8 ms | 71.6 ms |
| 4 | 62.9 ms | 54.8 ms | 12.3 ms | 134.5 ms |

The score pass now prepares and steps its statement through SQLitePCL on the connection's own handle, inside the caller's read transaction. It scores directly from SQLite's row buffer (`sqlite3_column_blob`) and reads the symbol ID string only for rows that can enter the window. It uses the same SQL filters, the same bytes and the same scorer, so scores are identical. Capacity overflow still hands the query to the exhaustive scan, and SQLite errors surface as `SqliteException`. SQLitePCLRaw was already a locked transitive dependency; no package changed. 116 C# tests pass, zero skipped, including window equivalence, drift, malformed-blob and cancellation cases.

Single-run pilot, terminology and behaviour categories (`benchmarks/macos-arm64-50000-native-scan-pilot*`), zero errors:

| Run | Hybrid p95 | Retrieval p95 | Vector scan p95 | Lexical p95 |
|---|---|---|---|---|
| terminology, 1 reader | 120.0 ms | 116.5 ms | 39.5 ms | 53.9 ms |
| terminology, 4 readers | 178.1 ms | **166.8 ms** | 67.4 ms | 80.7 ms |
| behaviour, 1 reader | 122.1 ms | 118.3 ms | 40.3 ms | 47.8 ms |
| behaviour, 4 readers | 185.9 ms | **175.5 ms** | 71.6 ms | 77.6 ms |

Under mapping v7, four-reader retrieval had measured 245.9–270.4 ms. The full matrix and concurrent-edit run follow.

## Vector plan 5 qualification — 16 October

**Native CI:** [38943640382](https://github.com/davidacres/praxis/actions/runs/38943640382) at `00318731` passed on Windows, Linux and macOS.

**Full query matrix** (`benchmarks/macos-arm64-50000-plan5-native-query-matrix*`): five runs × exact/terminology/behaviour/negative × one/four readers × 200 queries, 20 warmups and matched query sets. It is complete with zero errors, and **all 40 processes pass every gate**, the first fully passing matrix. Ranges across five runs:

| Category | Readers | Lexical p95 | Hybrid p95 | Retrieval-only p95 |
|---|---|---|---|---|
| exact | 1 | 1.6–1.7 | 79.5–81.2 | 76.0–77.3 |
| exact | 4 | 6.9–7.2 | 121.5–126.1 | 110.7–114.4 |
| terminology | 1 | 46.4–46.9 | 119.1–121.0 | 115.4–117.2 |
| terminology | 4 | 73.5–78.9 | 178.9–182.8 | 168.7–172.0 |
| behaviour | 1 | 47.3–48.5 | 120.4–121.8 | 116.8–117.5 |
| behaviour | 4 | 79.6–85.1 | 179.9–182.4 | 168.0–172.0 |
| negative | 1 | 1.5–1.7 | 81.5–86.1 | 77.9–82.6 |
| negative | 4 | 6.7–8.0 | 124.3–131.3 | 113.8–121.8 |

(milliseconds; targets: lexical 100, hybrid 500, retrieval-only 250)

**25-edit concurrent 50k run** (`benchmarks/macos-arm64-50000-plan5-native-concurrent-edits/`):
- Peak RSS 2,112,667,648 bytes: **passes 2 GiB by about 33 MiB**. The plan-4 run peaked at 1,966,702,592.
- Idle: lexical p95 6.45 ms, hybrid 127.4 ms, retrieval-only 116.4 ms, body edit 16,677 ms, refresh 1,839 ms.
- Concurrent: zero errors across 15,570 + 15,570 queries; lexical p95 10.86 ms (p99 119.6); hybrid p95 275.8 ms (p99 643.4, max 3,062); minimum coverage 49,997 of 49,999.
- Edits under load: publish p50/max 24.8/33.5 s, refresh p50/max 3.5/9.2 s.

Faster queries meant about 45% more queries ran during the edits, overlapping more reader and writer work. The memory result is a pass on one run with headroom too small to rely on. Specification §31.3 calls for pressure-based admission (at 80% of the budget, stop background inference, evict caches, reduce concurrency), which would make the budget hold by design rather than by margin. That is the next memory step.

## Memory-pressure admission (specification §31.3) — 16 October

`MemoryPressure` treats 80% of the 2 GiB process budget (1.6 GiB resident, from `Environment.WorkingSet`) as the soft limit. At or above it:
- Newly opened read connections use no file mapping and a 2 MiB page cache instead of 128/16 MiB. Connections are per-query, so reader memory falls within moments.
- `RepositoryIndexer.Index` and `ModelStore.Activate` end with one blocking, compacting, aggressive collection to return retained managed memory.

`doctor` reports `memory: {residentBytes, softLimitBytes, budgetBytes, pressure}`. Results are unchanged; only caching changes. `MemoryPressureTests` runs in a non-parallel collection and forces the signal on both sides of the limit. It checks the connection settings, identical search output, the doctor report, and a publication under pressure with clean integrity checks. 117 C# tests pass, zero skipped. CI [38948504180](https://github.com/davidacres/praxis/actions/runs/38948504180) at `dc32a2fe` passed on Windows, Linux and macOS, so resident memory is observable on all three.

**25-edit concurrent 50k run** (`benchmarks/macos-arm64-50000-memory-pressure-concurrent-edits/`):
- Peak RSS **1,908,703,232 bytes**, about 227 MiB of headroom (the plan-5 run without admission had about 33 MiB). Pressure engaged in 11 of 1,362 one-second samples.
- Idle: lexical p95 6.44 ms, hybrid 135.7 ms, retrieval-only 125.3 ms.
- Concurrent: zero errors across 14,121 + 14,121 queries; lexical p95 10.98 ms; hybrid p95 286.9 ms (p99 670.6, max 3,808); minimum coverage 49,997 of 49,999.
- Edits under load: publish p50/max 25.6/33.3 s, refresh p50/max 3.6/11.1 s.

Query-only workloads peak around 0.85 GiB and never reach the soft limit, so the 40/40 plan-5 query matrix is unaffected. Admission does not cap Roslyn analysis itself; §31.3 allows large projects to exceed the reference profile with reported degraded capacity. That reporting, and stopping background inference at the soft limit, are not implemented.

Background inference deferral (§31.3): at or above the memory soft limit the scheduler leases only non-embedding jobs, so queued model activation and vector refresh stay pending (repository model `building`) until resident memory falls; indexing continues. `MemoryPressureTests.PressureDefersBackgroundInferenceUntilMemoryFalls` uses the real model and fails if the gate is removed. 118 C# tests pass, zero skipped.

## Owner-protocol query latency — 16 October

`scripts/benchmark-owner-queries.mjs` starts a real native owner. The owner indexes a 49,999-symbol synthetic corpus with its own durable jobs (untimed: 18.8 s analysis, 523 s vectors) and is driven over its Unix-socket protocol from a persistent Node client: one connection per request, as the native client does, including connect, token handshake, per-repository admission (four query slots), dispatch and JSON framing. There are 200 timed queries per cell after 20 warmups. Raw: `benchmarks/macos-arm64-50000-owner-protocol-queries.praxis.json`.

| Category | Clients | Lexical p50 / p95 / p99 | Hybrid p50 / p95 / p99 |
|---|---|---|---|
| exact | 1 | 1.0 / 1.3 / 1.7 | 79.8 / 82.8 / 86.2 |
| exact | 4 | 6.2 / 7.8 / 8.5 | 123.6 / 152.1 / 410.3 |
| terminology | 1 | 45.6 / 47.5 / 48.4 | 121.3 / 125.0 / 132.9 |
| terminology | 4 | 66.0 / 84.2 / 90.8 | 180.3 / 193.0 / 194.1 |

Zero errors; all lexical (≤100 ms) and hybrid (≤500 ms) gates pass. Compared with the direct-API plan-5 matrix, the owner path adds about 1–15 ms at p95 and up to about 26 ms for four-client exact hybrid. One tail outlier, four-client exact hybrid p99 410 ms, is recorded. The owner process's resident memory, sampled once per second, peaked at 1,505,558,528 bytes across its own indexing, vector build and queries. Retrieval-only phases cannot be separated on this path because the owner reports no timings. Windows named-pipe transport and MCP stdio framing are not timed by this runner.

## Cross-project 50k run (8 projects) — 16 October

`--projects 8` split 49,999 source symbols across eight referencing projects with real cross-project calls (`benchmarks/macos-arm64-50000-8-projects-full.praxis.json`; `/usr/bin/time` peak RSS 1,546,551,296 bytes). Unfiltered: lexical p95 6.35 ms, hybrid 126.5 ms, retrieval-only 115.6 ms, body edit 16,101 ms, refresh 1,873 ms. Zero errors.

**Fails:** four-reader hybrid queries filtered to one project (6,301 of 49,999 symbols): p50 127.5 ms, p95 383.8 ms, p99 393.1 ms; **retrieval-only p95 378.7 ms (> 250)**; vector phase p95 340.6 ms. The score pass ignores filters, so about 1 in 8 window candidates matches. When fewer than 100 validate, the query falls back to the exhaustive join, which explains the bimodal latency. The fix is to apply context, kind and project filters inside the score pass.

## Filtered score pass (schema 6, vector plan 6) — 16 October

`migration006.sql` rebuilds `vector_scan` with each symbol's `context_id` and `kind`, backfilled. Its triggers fill them, and a guarded trigger on `symbols` (fires only when context or kind actually change) keeps them current. `Check()` compares them against `symbols`. The score pass applies the same context, kind and project predicates as validation, so the ranked window holds only candidates that can pass. Validation against the source tables, rescoring from `vectors` and the exhaustive fallback are unchanged. The window test adds a direct kind change, which must keep `Check()` clean and results equal to the exhaustive scan; making the `symbols` trigger a no-op makes `Check()` fail. CI [38956534617](https://github.com/davidacres/praxis/actions/runs/38956534617) at `e2c1ac5d` passed on Windows, Linux and macOS.

Eight-project 50k rerun (`benchmarks/macos-arm64-50000-8-projects-plan6-full.praxis.json`; peak RSS 1,669,152,768 bytes), zero errors:
- Project-filtered hybrid: p50 115.3 ms, **p95 119.3 ms** (was 383.8), retrieval-only p95 **108.3 ms (passes 250; was 378.7)**, vector p95 66.0 ms.
- Unfiltered: hybrid p95 126.9 ms, retrieval-only 116.1 ms.

## Crash-recovery stress — 16 October

`scripts/qualify-crash-recovery.mjs` builds a 2,000-symbol corpus with real vectors, then 20 times: edit a file, wait a seeded random 0–2.5 s, SIGKILL the owner, and restart it through the normal client. Each iteration requires clean integrity checks after restart and after recovery, a settled index with full vector coverage, and the edited content published.

The first run (`evaluations/macos-arm64-crash-recovery-before-fixes.praxis.json`) **failed**:
- Integrity was clean after all 20 kills, and every iteration settled.
- **11 of 20 recoveries took about 60 s.** A job leased by the killed owner was reclaimed only when its 60-second lease expired.
- **3 of 20 (kills 113–475 ms after the edit) reported settled within about 0.3 s without the edit.** The restarted owner reported "current" with no pending jobs during its watcher debounce, before it had looked at the sources. A client asking then was told a stale index was current.

Fixes:
- At start-up, while holding the exclusive owner lock, the owner reclaims every job leased by another owner (`ReclaimAbandonedLeases`; attempts kept, so a job that repeatedly kills its owner still reaches the retry limit).
- Before publishing its endpoint, the owner queues reconciliation for every unpaused repository (`ScheduleStartupReconciliation`), so status shows pending work from the first request.

New `SchedulerTests` and `HostTests` cases cover both. 120 C# tests pass, zero skipped. The stress rerun against the fixed package follows.

Stress rerun against the fixed package (`evaluations/macos-arm64-crash-recovery.praxis.json`, same seed and protocol): **all four gates pass**. All 20 kills hit a live owner; integrity was clean after every restart and recovery; every edit was published, including short-delay kills; and recovery took p50 821 ms, p95 2,090 ms, max 2,092 ms (before: 11 of 20 about 60 s, 3 of 20 stale).

## Schema-6 query matrix — 16 October

The retained 50k fixture was migrated from schema 5 to 6 with the service's explicit `init`; root, generation, epoch and sources are unchanged. The service kept `index.db.schema5.*.praxis.db` beside the schema-4 backup, and the backfill populated context and kind for all 51,499 rows. The full matrix (`benchmarks/macos-arm64-50000-plan6-filtered-query-matrix*`) is complete with zero errors and **all 40 processes pass every gate**. Ranges over five runs (ms):

| Category | Readers | Lexical p95 | Hybrid p95 | Retrieval-only p95 |
|---|---|---|---|---|
| exact | 1 | 1.6–1.7 | 79.5–83.7 | 75.7–80.0 |
| exact | 4 | 7.0–8.1 | 124.1–131.8 | 113.9–119.3 |
| terminology | 1 | 46.8–48.9 | 121.1–121.6 | 117.5–118.0 |
| terminology | 4 | 75.8–80.9 | 183.1–185.8 | 171.8–174.1 |
| behaviour | 1 | 47.4–50.1 | 122.3–124.0 | 118.6–120.2 |
| behaviour | 4 | 77.7–82.9 | 184.7–189.8 | 172.7–177.0 |
| negative | 1 | 1.6–1.7 | 79.9–83.2 | 76.4–79.1 |
| negative | 4 | 6.8–7.0 | 125.2–129.8 | 115.0–118.4 |

The filter predicates in the score pass cost about 2–5 ms on unfiltered queries compared with plan 5, while project-filtered retrieval improved from 378.7 to 108.3 ms. CI [38959603040](https://github.com/davidacres/praxis/actions/runs/38959603040) at `e54a8a40` passed on Windows, Linux and macOS.

## Usability trial on a real repository (Maze) — 16 October

A scratch copy of the Maze repository (433 C# files, 13 SDK-style projects, restore output present, `.git` and `bin/` excluded) was registered through the packaged CLI with **no captured manifest**, as a user would from the desktop panel.

**Before automatic project inference:** indexing was syntax-only. Search was lexical only ("search index documents" returned test classes named `Index…`), and callers and callees were empty. Capture, the only route to semantics, needed a CLI step the desktop does not offer and the `global.json`-pinned SDK, and failed on every project using `Microsoft.NET.Test.Sdk` (fixed in `db5209bc`). Two failures hid their real cause and now report it (`a91c1187`): an over-long data directory for the owner socket, and SDK resolution errors without an MSBuild error code.

**With execution-free inference (`645ad62b`, transitive references below):** registration to an indexed repository took about 26 s. **9 of 13 projects compile with zero errors; the other 4 have 6 errors in total**, all from source generators that inference deliberately never runs (`[GeneratedRegex]`, Razor components, .NET 10's generated `public partial class Program`). The index held 25,157 call edges, 77,375 references and 2,102 implements edges (syntax-only: none). `find_related` on `IRoleoverPermissionClient` returned its implementation, the services and handler that depend on it, and the test stubs; `get_callers` returned compiler-resolved callers with evidence. Model activation covered all 13,314 eligible symbols in about 190 s.

**Search-quality finding:** hybrid results were identical to lexical for all four natural-language queries tried, because the ranking profile `rrf-k60-lexical64-vector1-alias0.5-v3` weights lexical matches 64 to 1. Vector-only search found the right answer where lexical did not: "permission check for roles" → `MazePermissionAuthorizationHandler.HandleRequirementAsync` / `GetPermissionsAsync`, while hybrid ranked test stubs first. The semantic channel works but is effectively unused by hybrid ranking. Changing that affects the fixed-corpus quality gates and needs re-evaluation, so it is not changed here.

Transitive project references: the SDK flows `ProjectReference` transitively unless `DisableTransitiveProjectReferences` is set; inference initially used direct references only, which left the test projects unable to see `Maze.Common`/`MazeHub.Shared` types. Inference now uses the transitive closure and honours the opt-out (new test). 126 C# tests pass, zero skipped.

## Desktop and agent walkthrough on Maze — 16 October

**Ranking.** Not retuned: on the reviewed corpus every more-semantic profile regressed held-out quality. Equal weights scored all-category recall 0.76 against 0.89, with cross-project recall 0.31 against 0.92; lexical ×4 scored 0.83, with cross-project recall 0.77. The lexical-weighted hybrid default stays. The desktop panel now offers **Hybrid / Keyword / Semantic**, and agents can already request `mode: "vector"`.

**Real-app walkthrough.** A temporary local Playwright spec, not committed because it depends on the user's repository and the downloaded model, drove the real desktop app with the packaged service against the Maze copy. Registration to indexed took 26.5 s. Model install and activation from the panel reached 13,314/13,314 vectors in 191 s. Keyword and Semantic searches ran; Semantic ranked `MazePermissionAuthorizationHandler.HandleRequirementAsync` first for "permission check for roles"; Callers opened; provider consent completed. The MCP server written to settings was then started exactly as an agent host would start it, listed 11 tools and answered `search_code`.

**Defects found and fixed during the walkthrough:**
1. **Repository ID (`b85ed2c4`).** The MCP bridge advertised `repositoryId` as required while nothing told the agent its opaque value, so every agent call failed with `ACCESS_DENIED`. The bridge now hides it from the advertised schemas and fills it in; a different ID is still refused.
2. **Overflow.** Long qualified names and signatures from a real repository widened the settings panel. A new e2e assertion fails without the wrapping fix and passes with it.
3. **Project summary.** Fourteen anonymous context lines became "Projects: 9 complete · 4 partial · 1 syntax-only", with details on demand.
4. **Wording.** Panel and relocation copy describe automatic project detection.

All five desktop code-intelligence specs pass, the packaged-service one included; there are 4 MCP tests (zero skipped) and 126 C# tests. CI [38969353019](https://github.com/davidacres/praxis/actions/runs/38969353019) passed on Windows, Linux and macOS after one rerun. The first Windows attempt hit a transient `EPERM` on a just-exited owner's DLL during package cleanup, now retried (`8cb9a40d`).

## TypeScript and JavaScript language adapter (M4 / CI-019 / TASK-459) — 16–17 October

The M4 TypeScript and JavaScript language adapter (`ts-sidecar.mjs`, `TypeScriptAnalyzer.cs`) was implemented and integrated into the Code Intelligence service on `feat/code-intelligence-typescript`.

1. **Deterministic Node sidecar (`ts-sidecar.mjs`):** Runs TypeScript 7.0.2 programmatic compiler API over NDJSON stdio. Strictly relies on Praxis's internal runtime dependency (`package.json`), never executing untrusted project scripts, plugins or repo `node_modules` (§26.1).
2. **Contexts and project ownership:** Scans `tsconfig.json` and `jsconfig.json` trees and project references. Multi-project containment assigns each source file to its deepest containing project directory, preventing symbol duplicates across projects.
3. **AST & semantic coverage:**
   - Overloads, interface merging, namespace merging, parameter properties, function ordinals.
   - Relationships: `calls`, `may_call` (virtual/interface dynamic dispatch), `implements`, `inherits`, and `overrides`.
   - Syntax-only fallback: On process timeout or sidecar error, the service falls back to syntax-only extraction and emits diagnostic `TYPESCRIPT_SIDECAR_FAILED`.
4. **Polyglot indexing and search:**
   - Multi-language search (`csharp`, `typescript`, `javascript`) in lexical, exact, vector, and hybrid modes with language filters.
   - Preserves byte-identical snapshot hashes for C#-only repositories.
   - Watches `.ts`, `.tsx`, `.js`, `.jsx`, and config files in `RepositoryMonitor`.
   - Bundles `ts-sidecar.mjs` and `node_modules/typescript` into self-contained service packages (`build-service.mjs`).
5. **Test evidence:**
   - 132 tests pass (0 failures, 0 skipped) under `PRAXIS_DOTNET` and `PRAXIS_MODEL_BUNDLE` via `npm run test:code-intelligence`.
   - Verified overloads, merging, parameter properties, call hierarchies, multi-project references, polyglot vector/hybrid searches, untrusted script rejection, and fallback.

## Optional local LLM enrichment (M5 / CI-020 / TASK-460) — 17 October

The M5 optional local LLM enrichment (`Praxis.CodeIntelligence.Enrichment`) was implemented and integrated on `feat/code-intelligence-local-llm`:

1. **Loopback security guard (§17):**
   - Strictly permits only verified loopback host addresses (`127.0.0.1`, `::1`, `localhost`).
   - Rejects remote/external endpoints with `SecurityException`.
   - Configures `SocketsHttpHandler` with `AllowAutoRedirect = false` and `UseProxy = false`.
2. **OpenAI-compatible local LLM client (§2, §11):**
   - Directs chat completions to `/v1/chat/completions` with temperature `0.0`, `max_tokens: 1024`, and an 8-second bounded timeout.
   - Caps response bodies at 64 KiB.
3. **Structured schema enforcement & evidence grounding (§11):**
   - Requires JSON structure with `intent`, `inputs`, `outputs`, `sideEffects`, `uncertainties`, and `evidenceIds`.
   - Strictly validates `evidenceIds` against the compiler-verified evidence set, throwing `GroundingException` on fabricated citations.
   - Generates summary text labeled with `provenance: "generated"`.
4. **Durable caching & targeted invalidation:**
   - Stores cached symbol and project summaries in SQLite `descriptions` and `description_dependencies` tables.
   - Clears stale entries when a symbol or dependency is modified.
   - Employs dedicated writable SQLite connection for enrichment persistence while `QueryService` executes queries in read-only mode.
5. **Aggregate project summaries (§29.3):**
   - Generates aggregate project descriptions across child components in `summarize_project`, bounded at 50 child components.
6. **Test evidence:**
   - 137 tests pass (0 failures, 0 skipped) under `PRAXIS_DOTNET` and `PRAXIS_MODEL_BUNDLE` via `npm run test:code-intelligence`.
   - All 5 dedicated enrichment tests in `EnrichmentTests.cs` pass covering loopback validation, schema grounding rejection, cached `explain_symbol` responses, aggregate `summarize_project` descriptions, and invalidation upon dependency edits.

## ANN scaling, federation, and interoperability evaluation (M6 / CI-021 / TASK-461) — 17 October

The M6 evaluation, architecture, and interop integration were completed on `feat/code-intelligence-m6-ann-interop`:

1. **Scale gates analysis & decision record:**
   - Published `docs/evaluations/ann-scaling-and-interoperability-decision-record.md`.
   - Analyzed exact SIMD vector scoring vs HNSW/IVF-PQ across small (5k), medium (50k), and large (200k+) symbol scales.
   - Retained SIMD-accelerated dense scan as default: guarantees 100% recall, zero graph update overhead on incremental edits, and operates well within the 2 GiB memory ceiling (~850–1,350 MiB at 50k symbols).
   - Established threshold for activating approximate index partitioning at 200,000 chunks or if hybrid query p95 exceeds 500 ms SLA.
2. **Pluggable vector backend architecture (`IVectorBackend`):**
   - Decoupled `ModelStore` vector candidate retrieval through `IVectorBackend` and `VectorSearchFilter`.
   - Provided `ExactVectorBackend` (default SIMD hardware-accelerated scanner).
   - Provided `AnnEvaluationBackend` (supporting simulated cluster pruning, candidate evaluation metrics, and empirical recall calculation).
3. **Federation & cryptographic pin mapping (`InterRepositoryMapping`):**
   - Implemented `InterRepositoryMapping` and `InterRepositoryMappingRegistry` for explicit cross-repository symbol mapping.
   - Enforces cryptographic target commit hash pinning (`TargetCommitHash`), preventing stale/divergent resolution or unauthorized ambient access across repository boundaries (§17, §35).
4. **SCIP protocol interoperability (`ScipInterop`):**
   - Implemented Source Code Intelligence Protocol v0.4+ encoder and decoder.
   - Supports round-trip translation between internal Praxis symbol identities and SCIP descriptor grammar (`/`, `#`, `.`, `().`, `()`, `[]`).
5. **Test evidence:**
   - 141 tests pass (0 failures, 0 skipped) under `PRAXIS_DOTNET` and `PRAXIS_MODEL_BUNDLE` via `npm run test:code-intelligence`.
   - `AnnAndInteropTests.cs` covers backend switching, ANN evaluation pruning metrics, SCIP symbol formatting/parsing round-trip, and commit-hash verified inter-repository mapping.

## Baseline model change and fusion retune — search plan 7 — 17 October

**Model.** `BAAI/bge-small-en-v1.5` replaces `all-MiniLM-L6-v2` as the single pinned profile: revision `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`, model SHA-256 `828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35`, the same `vocab.txt` bytes, CLS pooling, query instruction `Represent this sentence for searching relevant passages: `, MIT. `LocalModel` accepts only this manifest; an installed MiniLM profile fails to load, which degrades hybrid to lexical with `MODEL_UNAVAILABLE` rather than failing queries. Profile fingerprint `sha256:dc9986ab75caeae2895119a413d6eb31d400ce05e36d6d86225d1e77c801c29c`. The golden fixture `bge-small-golden.json` was generated by the independent Python stack, now driven by the manifest's pooling and query prefix; regenerating the MiniLM fixture with the changed generator reproduced every token and every vector within 1.4e-7. The fixture test was proven against both a mean-pooling and a missing-prefix runtime: each fails it.

**Selection evidence.** On the fixed 120-case corpus at plan 6 (lexical 64), every mode except vector was identical across models; vector-only held-out Recall@10/MRR@10 was MiniLM 0.515/0.326, bge-small 0.697/0.487, bge-small with the instruction 0.758/0.537 (`maze-release-model-*-results`).

**Retune.** The tuning grid was fixed before collection and extended below 1 (0.25, 0.5, 0.75 added to the original 1–128) so the selection could favour vectors; the selection rule is unchanged (tuning macro Recall@10, then MRR, then lower lexical weight) and reads only the 40 tuning cases. Every weight ≥ 1 reaches tuning recall 1.0; weight 16 has the highest MRR (0.8395 versus 0.8371 at 64). `maze-bge-small-fusion-tuning.praxis.json` records every trial and hashes the complete candidate artifact. Search plan 7 applies `rrf-k60-lexical16-vector1-alias0.5-v4`.

Collecting candidates exposed a response-budget defect: a namespace declared in many files produced a single `search_code` match (~20 KB of declaration evidence) larger than the whole 8,000-token budget, and the page failed with `INPUT_TOO_LARGE`, so callers could not page past it. Such an item now has its declaration list halved until it fits (at least one kept), with evidence kept complete for every declaration still referenced, `truncated: true` and a `RESPONSE_TRUNCATED` warning. `QueryTests.OneMatchLargerThanTheBudgetShortensItsDeclarationsInsteadOfFailingThePage` fails without the change. `tune-retrieval.py` also had its command-line arguments shadowed by the paging loop and could not write its output; fixed.

**Acceptance.** The plan-7 binary reran the fixed corpus on a fresh fixture (`maze-release-bge-small-lexical16-results.praxis.json`). Every declared gate passes. Held-out hybrid Recall@10 0.894 (unchanged) and MRR@10 **0.672 → 0.687**: 8 queries rank their answer higher, none lower; behaviour MRR 0.700 → 0.734, cross-project 0.378 → 0.410, no category regresses against lexical. This is the first configuration in which hybrid beats lexical-only on this corpus; the gain is modest. Terminology hybrid recall stays at lexical's 0.615 although vector-only reaches 0.846, so further gains need a richer fusion than a single weight. Query texts, labels and split are unchanged; this is repeated evaluation of the published acceptance set, not a new blind study. Hybrid p95 102 ms in the sequential CLI evaluation. All 140 service tests pass with the bge bundle (2 SDK-capture tests skipped without their opt-in).

## 50k performance and memory with bge-small (search plan 7) — 17 October

This reruns the 50k gates after the model change and fusion retune above. The binary was built at `b8289a3d` (`Praxis.CodeIntelligence.dll` `sha256:9721e46d…`) and used the pinned bge-small bundle. The three runs ran one after another on the same 12-core Mac, with nothing else running.

**Full process** (`benchmarks/macos-arm64-50000-plan7-bge-full.praxis.json`, `-process`, `-time.txt`):
- All measured gates pass: lexical p95 7.651 ms, hybrid 134.027 ms, retrieval-only 121.149 ms.
- Independent peak RSS 1,266,171,904 bytes.
- Initial index 25.1 s. Initial vectors **1,014 s against 520 s with MiniLM**. bge-small has twice MiniLM's layers at the same width, so a first full build of a large repository takes about twice as long. Later edits re-embed only the affected symbols.
- Body edit 19.3 s; vector refresh 2.0 s (plan 6 with MiniLM: 17.0 s and 1.8 s).

**25-edit concurrent run** (`benchmarks/macos-arm64-50000-plan7-bge-concurrent-edits/`):
- Zero errors across 16,554 lexical and 16,554 hybrid queries.
- Lexical p95 12.65 ms. Hybrid p95 310.9 ms (p99 643.9, max 5,074).
- Minimum coverage was 49,997 of 49,999.
- Edits under load: publish p50/max 26.9/36.4 s; refresh p50/max 4.0/15.3 s (MiniLM 3.6/11.1 s).
- Idle hybrid p95 was 135.7 ms, identical to the MiniLM run.
- **Peak RSS 2,120,105,984 bytes. This passes, but with only about 26 MiB of headroom (MiniLM: about 227 MiB).** The one-second sampler saw resident memory at or above the 1.6 GiB soft limit in 3 of 1,942 samples, so the peak is a short spike rather than a sustained level. The likely cause is the larger ONNX session's working set during vector refresh while Roslyn analysis is also running. That is not yet attributed. Treat it as open before release. (Resolved by the shared inference session below.)

**Query matrix** (`benchmarks/macos-arm64-50000-plan7-bge-query-matrix*`, retained fixture from the full run): complete, zero errors, **all 40 processes pass every gate**. Ranges over five runs (ms):

| Category | Readers | Lexical p95 | Hybrid p95 | Retrieval-only p95 |
|---|---|---|---|---|
| exact | 1 | 1.7–1.9 | 82.7–84.2 | 77.1–78.5 |
| exact | 4 | 8.2–8.6 | 132.9–136.7 | 119.4–125.7 |
| terminology | 1 | 46.5–48.3 | 123.5–126.2 | 118.3–120.9 |
| terminology | 4 | 76.6–81.6 | 179.2–185.4 | 166.5–171.3 |
| behaviour | 1 | 47.7–54.8 | 125.2–133.9 | 119.5–128.1 |
| behaviour | 4 | 78.6–82.9 | 180.9–201.0 | 168.1–186.3 |
| negative | 1 | 1.7–1.8 | 84.6–87.1 | 78.8–80.9 |
| negative | 4 | 8.0–8.5 | 133.4–140.5 | 120.6–123.1 |

Query latency is effectively unchanged from the schema-6 MiniLM matrix. Both models produce 384-dimensional vectors, so the exact scan costs the same; the extra encoder depth adds only about 8–16 ms to query embedding. The lower hybrid p95 compared with the plan-6/schema-5 full-process row (211 ms) comes from the vector-plan-5/6 score pass, not from the model. Only one run was made, on a 12-core Mac; the reference machine remains unmeasured.

## Shared inference session — 17 October

**Cause of the concurrent peak.** The peak in the bge-small run above came at model install, about 17 s in, not during the edits (1 s samples: 721 MiB to 2,021 MiB for one sample, then 836 MiB). Install and the first activation built three inference sessions from managed copies of the model: the candidate, a verification of the staged copy, and the activation's own. `ReadBounded` grew a `MemoryStream` by doubling, so the 133 MB file briefly held a 256 MiB buffer plus a 133 MB copy, and the arrays stayed until a gen-2 collection. Every later `Activate` (one per edit refresh) built another session next to the cached query session. A standalone probe of the same load sequence (ONNX Runtime 1.31.0, three sessions) peaked at 914 MiB for MiniLM and 1,160 MiB for bge-small. bge-small's larger file crosses the 128 MiB doubling step, which made the difference worse than the size ratio.

**Change.**
- `ReadBounded` reads into an exactly sized array and fails if the file grows during the read.
- `LocalModel.VerifyFingerprint` checks the manifest and asset hashes without creating a session. Install uses it for the staged and the already-installed copy.
- `ModelStore` keeps one session per profile, shared by query embedding and activation. A replaced session is disposed once no activation holds it.

The integrity checks are unchanged: the session is still created from the bytes that were hashed.

**Tests.**
- `QueriesAndVectorRefreshesShareOneInferenceSession`: install, activate, query, edit, refresh and query again create exactly one session. With caching disabled it fails with 4.
- `ProfileVerificationChecksAssetHashesWithoutASession`: a one-byte change to `model.onnx` is rejected.
- 142 C# tests pass, 2 SDK-capture tests skipped without their opt-in.

**Measurement.**
- 3,000-symbol, 5-edit runs (two each): peak RSS 1.00/1.10 GB before, 0.83/0.83 GB after; refresh 0.43–0.45 s before, 0.22 s after.
- 50k 25-edit concurrent run (`benchmarks/macos-arm64-50000-plan7-bge-shared-session-concurrent-edits/`), prototype build `Praxis.CodeIntelligence.dll` `sha256:06618a20…`, which differs from the committed code only by the test-visible session counter:
  - **Peak RSS 1,832,779,776 bytes**, about 299 MiB under 2 GiB. Before the fix it was 2,120,105,984; MiniLM's run was 1,908,703,232.
  - Zero errors across 15,751 + 15,751 queries.
  - Concurrent lexical p95 12.69 ms; hybrid p95 305.3 ms (p99 614.3, max 2,689; before the fix max 5,074).
  - Idle hybrid / retrieval-only p95 135.8 / 122.6 ms.
  - Refresh under load p50/max 3.1/8.6 s (before 4.0/15.3 s); publish p50/max 25.9/39.3 s.
  - The RSS sampler was attached to the `time` wrapper until the edit phase, so `rss-samples-kib-from-edits.txt` covers the edits only (peak sampled 1.45 GiB); `/usr/bin/time` covers the whole process.

**Committed build** (`3464cfe4`, `Praxis.CodeIntelligence.dll` `sha256:1afa413a…`). Both runs were on the same Mac, one after the other. A 3 s unit-test run and a TypeScript build overlapped the start of the concurrent run's vector build, which has no gate.

- **Full process** (`benchmarks/macos-arm64-50000-plan7-bge-shared-session-full/`): all gates pass.
  - Lexical p95 7.992 ms, hybrid 134.784 ms, retrieval-only 121.556 ms.
  - Peak RSS 1,318,748,160 bytes.
  - Initial vectors 1,008 s; body edit 17.2 s; vector refresh 1.7 s.
- **25-edit concurrent** (`benchmarks/macos-arm64-50000-plan7-bge-shared-session-committed-concurrent-edits/`):
  - **Peak RSS 1,654,276,096 bytes, about 470 MiB under 2 GiB.** The highest one-second sample was 1.51 GiB.
  - Zero errors across 16,074 + 16,074 queries; coverage was 49,997 of 49,999.
  - Concurrent lexical p95 12.67 ms; hybrid p95 306.0 ms (p99 616.0, max 2,707).
  - Refresh under load p50/max 3.2/4.1 s; publish p50/max 26.7/37.0 s.

The two post-fix concurrent peaks (1.83 and 1.65 GB) bracket run-to-run variation. Both are below MiniLM's 1.91 GB.

## One MCP server for every granted repository — 17 October

**Bridge mode.** The MCP bridge's repository argument may be `*`. The bridge then serves every repository granted to its client:
- It adds `list_repositories`, and gives every tool an optional `repository` name. The name is the root folder's name, given in any case, with a short ID suffix when two names collide; the full ID is also accepted.
- New grants are found without a restart. The grant list is cached for 10 s, and a miss refreshes it.
- The owner still checks the grant on every query, so a revoke takes effect immediately.
- Failures name what was requested (or `*`), because the envelope's `repositoryId` must be a non-empty string. A mock test caught the first version sending `null`, which the MCP client rejects against the contract.
- Desktop sessions still use one bridge per repository and provider.

**Service.** A new `grants --client <name>` action lists a client's valid grants: same root and nonce, the same test a query applies.

**`connect` helper.** `npm run connect:code-intelligence -- <folder>`:
- registers the folder, grants `claude-cli` and waits for the index;
- activates the semantic model when a bundle is available;
- adds one user-scope `code-intelligence` MCP server to Claude Code the first time.

`--list` and `--disconnect` are included.

**Owner admission fix.** Trying `connect` on Maze exposed a pre-existing stall. Background jobs hold the owner's writer for a whole index or vector build, and every non-query action queued behind it. During Maze's vector build, `grants` waited out the 2-minute deadline and the client saw "Unable to read beyond the end of the stream". The desktop's `list` calls had the same wait.
- `list`, `grants`, `grant` and `revoke` are now admitted beside the writer, like queries. None of them writes the index.
- A grant written during a relocation fails closed, because queries re-check its root.
- After the change, `--list` answered in 0.36–0.46 s while the owner built Maze's vectors at about 410% CPU.

**Tests.**
- Service: 144 passed, 2 SDK-capture tests skipped without their opt-in. New tests cover the grant listing (clients, revoke, relocation) and the admission classification.
- MCP bridge: 7 of 7 pass. The new tests are a mock for multi-repository naming, ambiguity, refusal, live grant/revoke and the schema-valid failures, and a native owner run against the packaged service.
- Core: 1,550 passed, 2 skipped. `check-types` is clean.
- Native packaging smoke passes.

Real Claude Code CLI use through this server has not yet been exercised.
