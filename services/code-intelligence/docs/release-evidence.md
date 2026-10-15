# Release evidence and remaining gates

Updated 15 October 2026. M3 implementation is in progress; this document is not a release approval.

| Check | Evidence | Result |
|---|---|---|
| C# suite | SDK10.0.402, real MiniLM bundle and explicit SDK capture fixture; latest run | 57 passed,0 failed,0 skipped |
| Source/context | Raw UTF16 hashes, path policy, passive no-execution, SDK capture, generated support and stale/deleted inputs | Covered by targeted tests |
| Durable jobs | Coalescing, backoff, heartbeat, expired owner recovery, wrong-token publication, pause and atomic refresh enqueue | Covered by targeted tests |
| Automatic embeddings | Runtime registration/index, queued activation, real inference, edit, empty stale vector results, background refresh | Covered by native model fixture |
| Git policy | Ignored invalid-encoding source skipped before reads; configured fsmonitor cannot execute | Test passed |
| MCP/settings | SDK initialize/list/call, scoped denial/cancellation, provider handover filter, settings regressions | 46 focused Node tests passed |
| JSON Schema | 64 fresh actual responses across11tools, including metadata evidence and budget-trimmed pages/graphs/source | Passed with JSON Schema2020-12 |
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

52 C# tests passed, 0 failed, 0 skipped. Representation v2 includes bounded, hash-verified source excerpts and persists exact UTF-16/token chunk bounds, source mappings, hashes and truncation. Independent token/span golden coverage expanded to 10 cases; all four full vector comparisons pass. Tokenizer v3 and representation v2 produce fingerprint `sha256:cee9c5b0d7765f298742c8c40da17095de5338a4b46e4f310cedcc4eb23dffba`; upgrade by provisioning/installing/activating this profile. Prior profile vectors remain isolated. Reuse across full structural republishing and scale performance remain unfinished.

## Source-handle checkpoint — 15 October

54 C# tests passed, 0 failed, 0 skipped on Linux x64. Source handles are validated before/after reads, Unix traversal uses platform-specific no-follow flags and FIFO inputs are nonblocking/rejected. Windows/macOS code compiles; native platform execution remains a release gate. No UI changes.

## Recovery operations checkpoint — 15 October

57 C# tests passed, 0 failed, 0 skipped on Linux x64. Forced rebuild, alias retention, stable-ID relocation with old-fact/grant revocation, exclusion preservation, duplicate-root rejection and actual watcher rebinding are covered. Root/nonce-bound consent is rechecked before returning provider responses; legacy grants require reapproval. Desktop recovery controls and platform/provider/UI execution remain unfinished.

## Desktop recovery checkpoint — 15 October

Full application build passes with typed trusted rebuild/relocate IPC and desktop controls, themed relocation prompt, consent-config cleanup, search continuation, truncation feedback and polled generation. Two functional specs were added and attempted. Electron startup failed before UI interaction (missing X display/native node-pty); these tests and visual inspection remain blocked, not passed. Application workspace typechecking passes; an ad-hoc standalone e2e tsc invocation also exposes existing launchTestApp declaration errors.

## Remaining code and acceptance work

1. Execute the independent golden tokenizer/vector fixture on Windows/macOS; execute representation source-span fixtures on those platforms. Exact persisted chunk spans and selected source excerpts are implemented. Linux x64 passes the checked-in Python-reference fixture (10 token/span cases, 4 full vectors, absolute tolerance 1e-5/cosine >= 0.99999).
2. Extend member/type/reference relationships and delegate points-to analysis. Local callable, synthetic project-root/top-level ownership, type inheritance/implementation and optional bounded virtual/interface candidates now have regression coverage. Candidates are possible structural targets, not runtime proof.
3. Verify remaining status/summary/irreducible-item budget boundaries and freshness errors against A01–A40. Paged collections, source text and graphs now trim with evidence/range/cursor invariants covered by regression tests. A single irreducible item can still return an explicit budget error.
4. Execute Windows/macOS source-handle race fixtures, including junctions, case/Unicode paths and concurrent swaps. Platform-specific handle-path verification is implemented and compiles; only Linux execution is evidenced. Linux rename/replacement and nonblocking FIFO regressions pass.
5. Execute desktop recovery/search functional e2e, final visual walkthrough and provider cancellation/error transcripts. Recovery controls and cursor/truncation feedback are implemented; the two new UI specs are blocked before panel interaction by missing X display/native node-pty.
6. Measure scale/quality gates. Conservative full-context publication is intentional until equivalence/performance evidence supports more targeted invalidation.

Native IPC, corruption/full-disk recovery, crash takeover, package dependencies and offline operation require execution on required platforms before release. Review the full normative acceptance list rather than treating the test count as coverage of every gate. M4 TypeScript/JavaScript, M5 local LLM enrichment and M6 scale/federation remain future milestones.

## Preservation

Work is on `codex/code-intelligence-recovery`, not main. Remote checkpoints are verified against Git blob SHA values. Large file contents are transferred in bounded chunks; textual tool-output truncation must never be accepted as source. The prior SettingsPage checkpoint corruption was repaired from main with the small integration reapplied and its exact remote blob verified.
