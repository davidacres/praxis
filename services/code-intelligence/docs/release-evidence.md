# Release evidence and remaining gates

Updated 16 October 2026. M3 implementation is in progress; this document is not a release approval.

| Check | Evidence | Result |
|---|---|---|
| C# suite | SDK10.0.402, real MiniLM bundle and explicit SDK capture fixture; latest run | 97 local and on each native CI host passed,0 failed,0 skipped |
| Source/context | Raw UTF16 hashes, path policy, passive no-execution, SDK capture, generated support and stale/deleted inputs | Covered by targeted tests |
| Durable jobs | Coalescing, backoff, heartbeat, expired owner recovery, wrong-token publication, pause and atomic refresh enqueue | Covered by targeted tests |
| Automatic embeddings | Runtime registration/index, queued activation, real inference, edit, empty stale vector results, background refresh | Covered by native model fixture |
| Git policy | Ignored invalid-encoding source skipped before reads; configured fsmonitor cannot execute | Test passed |
| MCP/settings | SDK initialize/list/call, scoped denial/cancellation, provider handover filter, settings regressions | 46 focused Node tests passed |
| JSON Schema | 109 actual responses across11tools, including metadata/unresolved evidence, graph expansion and trimmed status/summary/pages/source | Passed with JSON Schema2020-12 |
| Full application build | Includes service, renderer import guard, Vite, copied renderer and trusted IPC guard | Passed after restoring complete SettingsPage source; exact remote blob checked |
| Linux native package | Self-contained publish, native CLI help, SQLite initialization and native ONNX model check | Passed on Linux x64, Windows x64 and macOS arm64 in native CI |
| UI e2e/screenshots | macOS: two mocked recovery/search regressions and one real packaged-service desktop flow; source/dialog captures inspected | Focused checks pass; full theme/accessibility/platform qualification remains open |
| Native owner process/platform matrix | Packaged macOS arm64 startup, lock, concurrent queries, grants, backup, restart and crash takeover | Linux x64, Windows x64 and macOS arm64 passed native CI |
| Live provider invocation | No paid/live adapter runs authorized or performed | Outstanding |
| Performance/quality corpus | Local macOS 5k comparison in docs/benchmarks; 50k-symbol and120-query relevance protocol | Local body edit 1532.0555 ms, hybrid p95 129.0305 ms; normative scale/quality gates outstanding |

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

Native IPC, corruption/full-disk recovery, crash takeover, package dependencies and offline operation require execution on required platforms before release. Review the full normative acceptance list rather than treating the test count as coverage of every gate. M4 TypeScript/JavaScript, M5 local LLM enrichment and M6 scale/federation remain future milestones.

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
