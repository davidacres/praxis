# Semantic code intelligence recovery record

Recorded 14 October 2026. Branch: codex/code-intelligence-recovery.
Baseline main: f8ef840269ec871aa87ae4d2a50c26950e14b875.
Status: reconstruction required; this is historical implementation evidence, not current passing code.

## Incident and preservation rule

Automated scratch workspace maintenance removed the previous checkout. The local branch codex/code-intelligence and local commit e1e5806 were not pushed. Accessible filesystem searches found no service source, tests, compiled assemblies, Git object store, patch or bundle. GitHub could not resolve that commit or branch. Internal platform backups cannot be inspected by this agent.

Before ending any work turn, preserve meaningful code, tests and documentation remotely. Push coherent changes and intermediate checkpoints at least every 15–20 minutes. Verify remote branch SHA and committed file content. If Git push fails, connector file commits can preserve text; otherwise create and verify a durable recovery bundle. Never claim local-only work is protected. No PR or main merge without the user's instruction.

## Authoritative requirements

Reviewed specification v1.2 survives in ChatGPT Library as Praxis-Semantic-Code-Intelligence-Specification-v1.2.md, library_file_id libfile_c2a46c2667188191b9b11ff21270aaab, version 2, 149539 bytes. Preserve it verbatim in services/code-intelligence/docs/specification-v1.2.md before implementation.

C# release is M3; TypeScript/JavaScript M4 is implemented (CI-019 / TASK-459); optional local LLM M5, scale/federation M6 remain future. Passive indexing never implicitly builds, restores or runs generators. Explicit capture warns it can execute project code. Local-only indexing; provider tool-output egress requires explicit repository/provider grant. Native IPC only: private Unix socket or current-user Windows pipe, random-token rendezvous and kernel-held stable lock. No TCP substitute.

Roslyn facts, SQLite+FTS5, local ONNX MiniLM384. Raw-byte SHA256 source hashes, UTF16 coordinates, context-scoped canonical identities, distinct pci:syntactic fallback IDs. Atomic publication/queryEpoch; HMAC snapshot-safe cursors; bounded queries and evidence with no dangling graph endpoints.

## Historical runtime and dependencies

.NET SDK10.0.402; net10.0 strict nullable, warnings as errors, deterministic lockfile restores. App: Microsoft.Data.Sqlite10.0.13, Microsoft.CodeAnalysis.CSharp5.9.0, Microsoft.ML.OnnxRuntime1.31.0. Tests: Microsoft.NET.Test.Sdk18.11.0, xunit2.9.3, runner4.0.1. These were previously restored/tested, but must be freshly verified.

RIDs linux-x64/linux-arm64/osx-x64/osx-arm64/win-x64. Native dependency execution must be tested on Windows x64, Linux x64 and macOS arm64. Linux self-contained publish historically passed.

## Lost service inventory and behavior

Root services/code-intelligence: global.json, Directory.Build.props, Praxis.CodeIntelligence.slnx, app/tests csproj and packages.lock.json; contracts.json embedded and copied to output/publish; model manifest; model-provisioning, contract-validation and packaging scripts.

Storage/IndexDatabase.cs: connection per operation, WAL, foreign keys, executable embedded migration001.sql, migration checksum validation, reject newer schemas; quick_check/FK doctor and verified atomic backup. Storage/Sql.cs: parameterized command/execute/scalar helpers. Schema included23tables, FTS5 and immutable-ready-vector triggers from normative specification.

Indexing/SourceFiles.cs: physical canonical root resolution; reject absolute/traversal/symlink source paths; bounded2MiB source reads, UTF8/UTF16 BOM strict decoding, rejectUTF32. Scan caps25kfiles/200kentries/256MiB, excludes .git/bin/obj/node_modules/vendor/dist/coverage/.idea/.vs and generated .g.cs. Enumeration failures abort publication rather than mass-delete. GitFilePolicy used trusted git check-ignore --no-index -z --stdin with fsmonitor disabled,5sec timeout,4MiB bounds; needs tests.

ProjectContext.cs: explicit passive version1 projects manifest, hashed imports/project inputs and metadata references including aliases,512MiB aggregate reference cache; dependency DAG, cycle rejection, multiple target slots; generated support sources excluded from returned authored source. Compilation fingerprints own source/context+dependent API stamps; reusable compilation cache.
ContextCapture.cs: explicit dotnet msbuild ResolveReferences/getItem/getProperty, timeout2min, bounded output, optional --restore only, recursive project refs, hashed imported inputs, atomic *.praxis.json output.
ApiSurface.cs: API descriptors include signatures, attributes, constants/defaults, bases/internal friend concerns, exclude bodies.
SymbolIdentity.cs: fixed canonical JSON arrays for source/external, kind/docID/methodkind/arity/parameter types/refkinds/interface descriptors; direct hash canonical bytes; fallback identity separate.
SyntaxPublisher.cs: namespace/type/method/property/event/field declarations, FTS camel splitting and deterministic descriptions;50ksymbol cap. Operators/indexers/local functions incomplete.
SemanticPublisher.cs: compiler declarations, partial locations/revisions, cross-project source mapping, resolved invocations/object creation call edges, unresolved occurrences. Only changed contexts republished, symbols upserted, obsolete context contributions removed, unchanged vectors/aliases retained; dependency API hashes persisted. Possible-dispatch expansion/type relationships/local function ownership incomplete.
RepositoryIndexer.cs: idempotent registration, preserve optional config, pause/resume/unregister/manual aliases; immediate exclusion derivative revocation; hash reconciliation, root unavailable=>unknown freshness retaining facts; no-op generation stable; epoch CAS atomic publish, changed context incremental path; fallback uncovered source. Needs clean-index equivalence/invalidation tests.

Queries: all11 normative read-only tools via JsonContract/QueryService/GraphQuery. Input schema validation and independent output AJV2020-12 samples. Scoped grants; read snapshot; query embedding before read transaction with active-profile recheck. Exact/name lookup, external scope, overload disambiguation; hash-checked source selectors and UTF16 fragments; structural explain/summarize; real diagnostic/job/model status.
Search lexical weighted BM25(name10/signature3/docs2/description1), exact first, top100; manual aliases, vector cosine and RRF; max300 union. Active profile/input revision/representation filters. Hybrid model-missing lexical warning, vector explicit error. Partial vector gap warning incomplete.
Graph static callers/callees/related/BFS, resolved-only default, cycle prevention,100nodes/200edges/depth3 defaults/depth10max, callsite evidence. Calls only; graph-kind filtering after LIMIT and boundary count require review.
CursorCodec canonical args+random HMAC256 owner secret,5min expiry; epoch/restart invalidate. ResponseBudget drops whole items and unreferenced evidence, clears nextCursor on omitted budget; source line trimming incomplete. Response cap min60000,budgetTokens*3; MCP duplication stays under128KiB.

## Embeddings reconstruction

Upstream sentence-transformers/all-MiniLM-L6-v2 revision1110a243fdf4706b3f48f1d95db1a4f5529b4d41, Apache2.0.
Model90405214bytes SHA2566fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452.
Vocab231508bytes SHA25607eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3.
No runtime downloads or placeholder checksums. Explicit provision/install validates assets/license/profile and golden inference.
WordPieceTokenizer uncasedBERT basic+greedy, accents/punct/chinese/specials;1–4 chunks256tokens.
LocalModel ONNX CPU input_ids/attention_mask/token_type_ids, masked mean pooling, finite L2 normalization384dims, cancellation via RunOptions.Terminate.
ModelStore verified staged install, canonical manifest fingerprint, cached query model, repo epoch CAS profile activation, atomic complete vector sets and float32littleendian blobs. Representations name/signature/docs/deterministic description max16k; source excerpts/golden fixture manifest incomplete. Recent matching representation vector reuse requires norm-check tests.

## Owner and scheduler reconstruction

HostPaths default WinLocalAppData/Praxis/code-intelligence; mac~/Library/Application Support/Praxis/code-intelligence; Linux absoluteXDG_DATA_HOME else ~/.local/share/Praxis/code-intelligence; matching TypeScript function.
Framing4byteLE:1MiB requests/128KiB responses.
ServiceRuntime private0700data directory, indexer/query/model/scheduler, persisted repo/client grant JSON; revoke/unregister remove grants. Local CLI queries repo authorized; MCP needs grant.
JobScheduler durable coalesced jobs, random lease token, recover expired leased jobs,3 retries/backoff; index then queued embedding refresh if active profile. Long-job heartbeat and wrong-lease publication acceptance need completion.
RepositoryMonitor native watcher+60sec full hash, overflow dirty,500ms debounce/max2sec; interest cs/csproj/props/targets/praxis.json/gitignore/editorconfig. Failed watcher retry currently risks resetting debounce forever; fix cooldown.
OwnerService FileShare.None stable lock,256bit token rendezvous private atomic, CurrentUserOnly pipe or absolute private owner.sock(path<=100UTF8bytes). Max16 clients/queries, serial writer, disconnected client cancellation,2min requests, idle5min shutdown. Perrepo4queries/queue32 and bounded5sec shutdown drain incomplete.
CLI help/init/parse/capture/serve/register/list/index/watch/pause/resume/unregister/grant/revoke/status/search/query/rpc/model-install/model-activate/alias/doctor/backup. Help needs update; rebuild/relocate/exitcode policy incomplete.

## Desktop / MCP reconstruction

Core codeIntelligence/mcpBridge.ts: actual MCP SDK server11 schemas/input+output and read-only annotations; fixed repo binding, source args stdinJSON shellfalse, bounded process output/timeouts/cancel, structuredContent plus compatibility text; schema1.2 error envelopes. Native executable assembly-or- sentinel. runtimePaths.ts shared storage defaults.
AI mcpServerConfig provider filter: generated MCP config PRAXIS_CODE_INTELLIGENCE_PROVIDER must equal actual provider; missing generated marker fail closed. Generic MCP unaffected. userMcp and aiIpc pass provider for initial/continued ACP+gateway.
Core ipcContracts new CodeIntelligenceRequest action union and AiIpc method; trusted main IPC+preload (never raw ipcMain). Service execFile dev DLL or packaged native binary; PRAXIS_DOTNET/DLL/EXE overrides; isolated fixture settings/data.
main/codeIntelligenceIpc.ts explicit repository/provider grant before config, Electron node-mode bridge, requireApproval true, revoke.
Renderer SettingsPage Tools tab CodeIntelligencePanel: registration/root/manifest/excludes, repo selector, refresh/index/pause/resume/status/unregister dialog, lexical/hybrid search/source/callers/callees/trace/copy symbol, local model install/activate, explicit provider egress dialog, warnings/diagnostics/coverage/source hashes and clickable evidence range reads. Theme CSS, ChipSelect ariaLabel, useDialogs; type-only core imports. Capture/rebuild/progress polling UI incomplete.
Packaging scripts/build-service.mjs build or self-contained stage; desktop predist extraResources code-intelligence. Root normal build did not yet include C#.

## Historical tests, not reconstructed verification

Last lost checkout C#40/40 passed, no skips, real model and SDK capture enabled. Suites DatabaseTests, SyntaxIndexerTests, SourceEvidenceTests, RepositoryTests, SemanticTests, HostTests, SchedulerTests, ModelTests, CaptureTests, ContractSamples.
Cover migration/backup, hashes/UTF16/root aliases/excludes/no implicit execution, edit/delete/root loss, grants, partial declarations/cross-project calls/multi-target/external scope, framing, durable job recovery, tokenizer/cursors/real ONNX activation, actual SDK capture. Independent29samples across11tools validated against AJV schemas.
Full npm build historically passed before newest changes. Core1536 tests:1534passed,2 existing backgroundprocess-group localTools failures repeated isolated. New MCP SDK mock initialize/list/call/provider binding2tests passed. Real provider invocation not verified.
Desktop e2e attempted; node-pty repaired; native Xvfb and owner Unix listening socket creation denied. Browser component fixture actual Panel/DialogHost/Vite build passed, launch blocked absent headlessshell and official CDN SiteUnavailable. No screenshot or visual QA passed.
Do not report these results as current branch validation.

## Plan inventory to recreate and validate

Feature FX-BF-109; stories FX-BE-169(local index),170(retrieval/MCP),171(desktop/release),172(future languages/scale); tasks441–461 mappingCI001–021. All deleted. Historical parser before53features160stories345tasks18bugs, after54features164stories366tasks18bugs. CI001 historicalDone, restM3 InProgress,019–021Backlog. Re-read current IDs and plan skill before creating; do not assume availability. integration-map.md, release-evidence.md and operational README were still incomplete.

## Remaining gates and reconstruction order

1 Restore specification verbatim and source/test project; locks/migration and source policy.
2 Passive Roslyn context/declarations/canonical identity and call graph, tested clean-index equivalence.
3 API invalidation/incremental publish/leases/epochs/exclusion CAS; alias/vector preservation.
4 All11 query contracts/hash evidence/budgets/cursors and actual schema output validation.
5 Verified local model/tokenizer/golden fixtures/chunks/representation reuse; queued refresh.
6 Native owner admission/security/recovery/cancellation and MCP SDK/provider round trips.
7 Desktop workflows/packaging with actual e2e/screenshots/platform verification.
8 Operational docs/integration map/capability matrix/plan parser.
A01–A40 gates must be evidenced. Performance50ksymbols: warm lexicalp95<=100ms4readers, hybrid<=500ms,5kproject body edit<=2sec, async fixture vectors<=10sec,RSS<=2GiB. Quality120queries40tuning80heldout6categories recall>=.80,no category>5point regression;30manual explanation reviews. These benchmarks were never completed. No paid/live provider runs were authorized.
