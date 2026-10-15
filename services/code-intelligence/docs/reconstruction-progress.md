# Code intelligence implementation progress

Updated 15 October 2026. Branch: codex/code-intelligence-recovery. Feature remains in progress; no PR or main merge.

## Implemented

- .NET 10.0.402 solution, locked dependencies and executable specification migration.
- SQLite WAL, foreign keys, migration compatibility/checksums, integrity checks and verified backups.
- Raw-byte hashes, UTF8/UTF16 coordinates, bounded source reads, root/path policy and Linux descriptor-relative source opening.
- C# passive Roslyn analysis, syntax fallback, overload/partial identities, cross-project call targets and atomic repository publication.
- Eleven schema-defined read-only queries, lexical/hybrid/vector search, static graphs, evidence/source checks, cursors and response limits.
- Per-user authenticated owner/CLI, repository/provider grants and revocation, scoped MCP SDK bridge, provider isolation during handover.
- Desktop registration, exclusions, status, search/source/navigation, model install/activation and provider consent controls.
- Pinned local MiniLM ONNX/WordPiece provider, complete atomic vector sets, query/profile checks and lexical fallback.
- Durable index/embedding jobs with coalescing, lease tokens, heartbeat, expiry recovery, bounded retry and wrong-lease publication rejection.
- Structural publication atomically enqueues current model refresh work. Model activation queues durable work rather than holding a UI request open for inference.
- Watcher hints with debounce, overflow handling, retry cooldown and periodic reconciliation. Pause/unregister obsoletes work.
- Git ignore evaluation filters paths before decoding, disables fsmonitor execution and bounds subprocess time/output.

- Explicit capture and semantic-support roles pass the SDK/source-role fixtures. Operational instructions, integration/capability matrix and26parser-verified plan records are present.
- Self-contained Linux package passes CLI help, SQLite initialization and actual native ONNX inference.
- Argument-hashed cursors remain within wire limits even for large valid filters.

## Callable ownership checkpoint (15 October)

Lambdas and anonymous delegates now have source-backed function symbols. Nested calls belong to the immediate callable; field/property initializer calls belong to the containing type. Local function and lambda descriptors use enclosing identity, syntax kind and preorder ordinal rather than character offsets. These identities remain explicitly local-edit-sensitive: inserting or removing a sibling callable may renumber later siblings.

Current checkpoint verification: **44 C# tests passed, 0 failed, 0 skipped**, including real pinned-model inference and explicit SDK capture. 86 captured responses across all 11 tools passed normative schema validation. No UI files changed in this checkpoint.

Regression coverage includes nested lambda containment, resolved local-function targets, distinct delegate identities, body/offset edits, syntax-only prefixes and initializer ownership. Synthetic project roots and source-level top-level entries are now labelled explicitly. Inheritance/interface type relationships carry occurrence evidence. Virtual/interface dispatch adds bounded source candidates as `may_call`/`possible`, opt-in for call queries; direct base calls remain static. Candidate sets cap at 64 with a diagnostic when truncated. Delegate points-to/runtime receiver analysis remains unsupported.

## Independent model checkpoint (15 October)

The checked-in golden fixture was generated independently with Python tokenizers 0.21.4, ONNX Runtime 1.23.2, NumPy 2.5.4 and CPU inference against the pinned asset hashes. Eight tokenizer cases cover empty input, source code, accents, multilingual/emoji, control characters, literal special tokens and four-chunk truncation. Four full 384-dimensional query vectors use absolute tolerance 1e-5 and minimum cosine 0.99999. Fixture SHA256: `67700b62e4bdeb733d4baced69041397051f6f87bd68ce3f70ae987d49f25a0b`.

The fixture exposed incorrect splitting of BERT special tokens. Corrected behavior uses tokenizer profile `bert-uncased-wordpiece-v2`, changing the model fingerprint. Existing v1 installations must provision/install/activate the new profile; weights and vocabulary hashes are unchanged. Old profile vectors cannot participate in the new profile. C# suite: **46 passed, 0 failed, 0 skipped** on Linux x64. Cross-platform numerical verification remains required.

Metadata images are now shared across project contexts within an analysis, preserving per-reference aliases/options. The 512 MiB unique-metadata bound applies to the repository analysis instead of separately to each project.

## Query completeness checkpoint (15 October)

Paged search/lookup/caller/callee/related responses reduce their collections to fit the byte budget and resume at the retained count, with evidence pruned only when unreferenced. Regression pagination visits 20 results without skips or duplicates. Source trimming preserves UTF-16 range/text agreement and surrogate pairs; source line/budget truncation is explicit without a pagination cursor. Graph budget trimming retains the root, valid edge endpoints and referenced evidence, with a boundary and truncation warning. Single irreducible items may still return an explicit budget error.

Method override relationships are separate from call edges. External symbols now expose metadata evidence for explanations without invented local declarations. Implicit source constructors resolve to the defining type/context, carry no fabricated declaration location and remain non-external, including cross-project calls.

Latest C# run: **51 passed, 0 failed, 0 skipped**. 64 fresh responses across all 11 tools pass normative schemas. Full application build and two scoped MCP tests pass; Linux self-contained CLI/SQLite/ONNX package passes with tokenizer-v2 fingerprint `sha256:567dd29d161c0beb8dd0474774adbd41924c6c274faa92b065925b63de2c1705`. No UI files changed; platform/UI/quality gates remain unexecuted.

## Representation checkpoint (15 October)

Selected source excerpts are now part of representation v2 after identity/signature/documentation/description fields. Excerpts cap at 4096 UTF-16 units, total representations at 16384. Partial declarations choose a deterministic path/offset location. Source hashes are verified before inference and rechecked before atomic publication. Stored chunk metadata includes exact original-input UTF-16 bounds, payload token ranges, representation hashes, truncation and intersecting source path/hash/offset mappings. No fabricated spans or split surrogate pairs are stored.

Tokenizer v3 corrects Unicode cleanup/case/CJK handling while mapping normalized tokens back to original UTF-16 coordinates. The independent fixture now covers **10 cases** including combining marks, Turkish casing, replacement characters, supplementary CJK and emoji; exact chunk spans and token IDs pass alongside four 384-dimensional query vectors. Current fixture SHA256: `3a1da71af763aa127e61e6f6d846d5598e81b03c302741c3243cd5a0cf7178cd`.

Current profile: tokenizer `bert-uncased-wordpiece-v3`, representation version 2, fingerprint `sha256:cee9c5b0d7765f298742c8c40da17095de5338a4b46e4f310cedcc4eb23dffba`. Reprovision/install/activate to upgrade; previous profile vectors remain isolated. **52 C# tests passed, 0 failed, 0 skipped**, including persisted source spans, representation priority/caps and changed-source rejection. Earlier checkpoint hashes/results above are historical evidence.

## Source-handle checkpoint (15 October)

Unix source opening now uses platform-specific descriptor-relative no-follow traversal on Linux and macOS. Windows validates the opened handle with GetFinalPathNameByHandleW; macOS uses fcntl(F_GETPATH). The actual handle path is checked again after reading, in addition to pathname policy checks, so replacing the pathname does not validate an already-renamed handle. Unix source handles open nonblocking and non-seekable inputs are rejected, preventing FIFO inputs from waiting indefinitely for a writer.

**54 C# tests passed, 0 failed, 0 skipped** on Linux x64. Deterministic rename/replacement and FIFO timeout regressions pass. Windows/macOS branches compile but require native execution, including links/junctions, case/Unicode paths and concurrent swaps; this is not a cross-platform pass claim.

## Recovery operations checkpoint (15 October)

Service/CLI rebuild queues a forced republish under the durable lease protocol; unchanged inputs advance generation and surviving manual aliases persist. Relocation keeps repository identity/exclusions, clears old facts, revokes root-bound provider grants and drops old captured manifests unless explicitly replaced. Indexing is queued for the new root; paused repositories remain paused. Duplicate destination registrations are rejected. Watchers rebind on root changes and are recreated after root loss/errors.

Provider consent includes canonical root and an issuance nonce. Queries recheck the exact grant after execution before returning data, so revoked/reissued or old-root consent cannot authorize a result. Legacy grants require explicit reapproval.

**57 C# tests passed, 0 failed, 0 skipped** on Linux x64. New runtime tests cover forced rebuild/alias retention, relocation/fact revocation/provider reapproval/duplicate-root rejection and real watcher rebinding. Desktop controls are now wired (see following checkpoint); native IPC/platform/UI execution and release gates remain outstanding.

## Desktop recovery checkpoint (15 October)

Typed trusted IPC now exposes rebuild/relocate. The Tools panel uses an in-app relocation prompt, removes obsolete generated MCP configurations after moving, offers cursor-based search continuation, labels truncated responses and shows generation from polled status. Full application build passes, including renderer core-import and trusted-IPC guards.

Two functional UI specs were added for recovery/status/dialog behavior and paginated search. Execution was attempted: startup failed before panel interaction because the environment has no X display and lacks the native node-pty module; no screenshots or passing UI assertions are claimed. Standalone ad-hoc e2e typechecking also reports existing launchTestApp.ts Window/Page declaration errors; application workspace typechecking/build passes. User instruction is to proceed with implementation rather than block on GUI environment repair.

## Retrieval completeness checkpoint (15 October)

Status/summary collections now reduce detail to the byte budget, preserve full project coverage totals, prioritize active model/error diagnostics and flag both fixed-cap and budget truncation. Unresolved trace occurrences include source evidence; graph trimming removes occurrences from omitted nodes and batches node removal to bound repeated serialization.

Optional search graph expansion adds at most 100 one-hop neighbors from the top 20 direct seeds, respects structural filters, preserves seed/edge evidence, and ranks graph-only results below direct matches. The wire contract has no graph-rank field, so graph support appears in reasons/channels and score without inventing a schema field.

**60 C# tests passed, 0 failed, 0 skipped**; **71 fresh responses across all 11 tools** passed normative schemas. UI execution remains blocked as documented; no new UI changes in this checkpoint.

## Vector reuse and equivalence checkpoint (15 October)

Complete current-profile vectors are captured within the structural write transaction (128 MiB bound), validated for dimensions/norm/chunk completeness/spans, and reused only for the same symbol/profile/exact representation hash. New revisions and source mappings are published atomically. There is no detached cache: exclusions, relocation and unregister purge derivatives normally. Fully reused active-profile coverage avoids redundant refresh jobs; partial refresh skips inference for already-current sets. Corrupt normalized-vector data is rejected and re-inferred. Real body edits still invalidate changed representations and refresh through durable work.

A clean-index equivalence fixture compares normalized symbols, projects/contexts, files/locations, occurrences, edges, search documents and diagnostics after source edits, additions, deletion, partial-type/context changes and cross-project lambda calls. Random storage IDs/generation counters are intentionally excluded; semantic identities share the same repository ID. Edited and clean publications match.

Normative defaults are now search/lookup/related limit 10, callers/callees limit 50 and trace maxEdges 2000. Empty relation/kind filters use defaults; filter case/whitespace normalization and duplicate rejection are tested.

**63 C# tests passed, 0 failed, 0 skipped**. 80 actual tool responses across all 11 schemas passed validation in the preceding query-enabled run. Full-context Roslyn/SQLite republishing remains conservative; no 5k/50k latency or 2 GiB RSS claim is made.

## Verification evidence

15 October: C#38 passed,0 failed,0 skipped with provisioned pinned model assets. Includes real ONNX inference, offline model installation/activation, durable automatic vector refresh after source publication, coalescing/backoff, expiry recovery, stale-token publication rejection, heartbeat and pause, Git-ignore privacy and no fsmonitor execution. Explicit SDK capture, stale/deleted inputs, generated support non-disclosure and alias preservation also pass.
14 October: full desktop build passed including renderer core-import and trusted-IPC guards;2 MCP SDK/provider-isolation tests passed;24 responses across all11 tools validated with JSON Schema2020-12.
Full application build including the service passed; Linux self-contained publish/CLI/SQLite/native-model checks passed after context capture.30fresh responses across all11tools validate against the normative schemas.46focused MCP/settings tests passed. Parser counts moved53/160/345/18to54/164/366/18(features/stories/tasks/bugs). Do not treat historical results as verification of later changes.

## Relationship and benchmark checkpoint (15 October)

Compiler adapter `roslyn-5.9/v2` adds source-backed REFERENCES, supported field/property READS/WRITES, declared USES_TYPE dependencies and named method/delegate RETURNS_TYPE edges. Simple/compound assignment, increment, ref/out arguments and nameof have explicit classification tests. Local variables/parameters are not promoted to member symbols; unsupported source endpoints are omitted. Syntax fallback emits no new semantic facts. All relationship occurrences carry exact source hash/range, context and compiler resolution; they publish atomically alongside calls. The adapter version participates in context hashes so reconciliation upgrades existing v1 indexes rather than accepting a false no-op. Unfiltered graphs/search expansion may now include type dependencies; call-filtered queries remain isolated.

Transaction-local prepared commands are reused during structural/vector publication; there is no shared mutable command cache or schema migration. **67 C# tests passed, 0 failed, 0 skipped** with the pinned real model. Four new relationship tests cover classifications, syntax fallback, type facts, foreign keys and no-op publication. Updated graph tests retain direct-result ordering and evidence checks.

A reproducible Release benchmark now generates isolated sources and measures four concurrent readers, indexing and optional local model refresh. Checked-in Linux reports are explicitly unsuccessful: the prepared-command run measured lexical p95 62.9009 ms, one body edit 5422.148 ms and peak RSS 452349952 bytes. It predates adapter v2 and excludes debounce/native owner/MCP; it establishes no normative edit p95 or release readiness. The earlier baseline overlapped compilation and is not a controlled comparison. See `benchmarks/README.md`; rerun after semantic changes.

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

## Native macOS prerequisite checkpoint (15 October)

The first native macOS arm64 run exposed an incorrect variadic `fcntl(F_GETPATH)` call: Darwin arm64 requires the buffer argument on the stack. The architecture-specific declaration now supplies that ABI layout; the existing x64 declaration remains isolated to non-arm64 macOS. Source-root canonicalization also resolves aliased parents inside a symlink target, including macOS `/var` to `/private/var`. A new nested-alias regression checks canonical identity and actual reads, and the opened-file rename fixture now supplies the canonical expected path.

**82 C# tests passed, 0 failed, 0 skipped** on macOS arm64 with SDK 10.0.402, explicit SDK capture and the pinned real model. This includes source aliases, replaced handles, nonblocking FIFO rejection, the independent tokenizer/vector golden fixture and durable vector refresh. The initial unmodified native run hung and was terminated; it is not passing evidence. This checkpoint enables local performance measurements; no performance improvement is claimed yet. Windows, Linux revalidation and desktop UI remain separate checks.

## Analysis and publication batching checkpoint (15 October)

Compiler passes share semantic models, diagnostics and non-local symbol identities within one analysis only. No cache survives source snapshots. Relationship deletion happens before symbol cascades; a two-repository regression proves rebuild/unregister preserve the other repository's facts. Vector candidate rows load in one bounded query and an independent rank-order assertion covers query publication. **83 C# tests pass with no failures/skips** on macOS arm64, with native model and SDK fixtures enabled.

The controlled local 5k synthetic comparison reduces model-enabled body edits from 3352.3529 to 2691.3054 ms, still above target. Hybrid p95 is 111.7799 ms versus 107.8961 ms before, so no hybrid improvement is claimed. Benchmark RSS unavailability is now explicit; independent system measurement shows 877920256 bytes peak RSS. Reports and limitations are in `docs/benchmarks`.

## Retained publication checkpoint (15 October)

When repository files, contexts and symbol keys are unchanged, structural publication retains parent rows and updates their current facts atomically. Complete validated active-profile vectors retain their blobs when the exact representation matches; changed source mappings are regenerated, changed representations are revoked, and durable refresh is queued. Additions/removals and forced rebuilds retain full replacement. Complete compiler analysis still runs; this is not API-stamp invalidation.

**86 C# tests passed, 0 failed, 0 skipped; 87 responses validate across all 11 schemas.** Added checks compare retained publication with clean indexing across project contexts, prove failed writes roll back facts/generation, and prevent deletion/rewriting of an unchanged vector while verifying changed representations disappear until refresh. The 5k body-edit measurement is 2530.7532 ms (baseline 3352.3529 ms), still failing the two-second threshold. Hybrid p95 is 113.1703 ms, refresh 384.8981 ms, and independent peak RSS 1005813760 bytes. Desktop/native IPC and 50k/quality gates remain open.

## Retained declaration/relationship checkpoint (15 October)

Stable-key publications now retain declaration locations and occurrence/edge rows only when their complete stored facts match the newly computed analysis. Context/file membership changes fall back to full replacement. Changed or missing facts are replaced in the same transaction; cancellation remains checked during comparison. A cross-project overload-accessibility regression proves an unchanged caller is rebound to the new target, unchanged caller locations survive, and resulting facts match forced clean publication.

**87 C# tests passed, 0 failed, 0 skipped; 87 responses validate against all 11 tool schemas; Release build passed with zero warnings/errors.** The macOS arm64 5k real-model benchmark measured body edit **1532.0555 ms**, down from native baseline **3352.3529 ms** (54.3%). Lexical p95 is 21.362 ms, hybrid p95 129.0305 ms, semantic refresh 420.4457 ms and independently measured peak RSS 874692608 bytes. Hybrid passes the local comparison but no speedup is established. This is a single direct body edit, not watcher-inclusive p95; 50k/platform/quality/UI acceptance remains open.

## Native macOS package smoke checkpoint (15 October)

At source commit `3e1da0cf9f3536cac6e19c9e79428fe27c9f354b`, the standard `scripts/build-service.mjs --package` workflow successfully published the self-contained `osx-arm64` package using SDK 10.0.402. The packaged executable passed `help`, initialized a fresh SQLite index, and ran `model-check` against the pinned real MiniLM bundle. Model output reported 384 dimensions, normalized vectors, and fingerprint `sha256:cee9c5b0d7765f298742c8c40da17095de5338a4b46e4f310cedcc4eb23dffba`. All commands exited successfully.

This verifies local native packaging, CLI startup, database initialization and ONNX inference. Signing/notarization, owner-process IPC, desktop integration and other platform packages remain separate acceptance work. Generated binaries are excluded from Git.

## Packaged owner-process IPC checkpoint (15 October)

The host packaging workflow now runs a disposable native IPC fixture against the published executable. On macOS arm64 it passed registration and indexing, four concurrent lexical searches, provider access denial before grant and after revocation, granted provider search, backup creation with a SQLite header, database doctor checks, persisted generation/search and revoked access after owner restart, and unregister. The standalone fixture and complete packaging workflow both passed with SDK 10.0.402; the complete workflow also passed real-model inference.

The fixture explicitly starts/stops its own owner process and uses temporary sources/data. It does not establish automatic owner startup, stale-rendezvous recovery, semantic project capture, desktop/MCP adapters or Windows/Linux execution. The existing platform CI packaging step will execute it on each host; those remote results are not claimed here.

## Automatic owner startup/crash takeover checkpoint (15 October)

The packaged IPC fixture now starts the owner through a normal CLI command, rejects a concurrent second owner, and recovers after a forced owner crash without removing the stale rendezvous/socket. Persisted generation, search and provider revocation survive; the recovered owner has a fresh authentication token. The private rendezvous adds an informational process ID for fixture cleanup; authentication still uses its existing endpoint/version/token checks. Complete self-contained macOS arm64 packaging and real-model checks pass. Windows/Linux execution remains open.

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

## Remaining implementation/release work

- Cross-platform golden numerical verification and representative scale/quality performance verification.
- Semantic API-stamp/affected-context optimization, remaining dependency relationships and general delegate points-to analysis.
- Irreducible single-item budget behavior and execution of Windows/macOS source-handle fixtures.
- Native IPC process/platform matrix, UI e2e/visual walkthrough, live provider adapter invocation, scale/quality acceptance gates A01–A40.

Current indexing performs full-context compiler analysis and atomically updates or replaces structural facts. It does not yet implement targeted API-stamp invalidation or establish complete performance/release acceptance. M4–M6 remain future scope. Environment-dependent checks may be deferred at the user's instruction; record them rather than silently claiming success.

## Preservation policy

Meaningful code/tests/docs must be committed remotely before ending a turn and at intermediate checkpoints. Verify exact remote file contents. A local Git commit is insufficient. Command-line HTTPS push was unavailable; the connected GitHub API has successfully preserved checkpoints. Use the actual remote commit SHA in reports. Recovery-record.md retains the deleted implementation inventory; it is not current passing code.
