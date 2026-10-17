# Praxis Code Intelligence

A local C# repository index shared by the desktop, CLI and read-only MCP bridge. The implementation is in progress against [specification v1.2](docs/specification-v1.2.md); [release evidence](docs/release-evidence.md) distinguishes working code from outstanding acceptance gates.

## Build and verify

Install the SDK pinned in `global.json` (10.0.402), plus the Node/npm prerequisites for the main Praxis application. From the repository root:

```sh
npm ci
npm run build:code-intelligence
npm run test:code-intelligence
npm run build
```

Set `PRAXIS_DOTNET` to an absolute SDK executable if `dotnet` is not on PATH. `npm run build` now includes the service. Normal compilation uses locked restores. Tests use temporary repositories, never the working tree as a source-write fixture. Native model tests require `PRAXIS_MODEL_BUNDLE`; SDK capture integration requires `PRAXIS_DOTNET`. Without those explicit fixtures, their tests are visibly skipped.

`node scripts/build-service.mjs --package` publishes a self-contained host package and checks CLI startup, SQLite initialization, and local model inference when `PRAXIS_MODEL_BUNDLE` is set. For the host runtime it also runs real owner-process IPC checks: automatic startup, duplicate-owner rejection, indexing, four concurrent searches, provider grant/revocation, backup creation, persisted search after restart, crash takeover with stale rendezvous/socket files, and unregister. The fixture owns and stops its service processes and removes its temporary source/data directories. To rerun just IPC against an existing package, use `node services/code-intelligence/scripts/smoke-native-ipc.mjs /absolute/path/to/Praxis.CodeIntelligence` (add `.exe` on Windows).

To run the real desktop integration fixture after the full application build and host packaging, set `PRAXIS_CODE_INTELLIGENCE_EXE` to the packaged executable and run `npx playwright test codeIntelligenceNative.spec.ts --project=functional --workers=1` from `apps/praxis-desktop/main`. It uses a disposable repository and isolated app profile; it performs no project evaluation or paid provider invocation.

With the same `PRAXIS_CODE_INTELLIGENCE_EXE` setting and a built core, `node --test packages/core/out/codeIntelligence/mcpBridge.test.js` from the root also runs the real stdio MCP fixture. It exercises provider-specific grant/revocation and source reads locally, without contacting an inference provider.

## Index a repository

The development executable is `services/code-intelligence/src/Praxis.CodeIntelligence/bin/Debug/net10.0/Praxis.CodeIntelligence.dll`. Run it through `dotnet`; a packaged self-contained executable needs no separately installed runtime.

```sh
dotnet path/to/Praxis.CodeIntelligence.dll register /absolute/repository
dotnet path/to/Praxis.CodeIntelligence.dll list
dotnet path/to/Praxis.CodeIntelligence.dll index REPOSITORY_ID
dotnet path/to/Praxis.CodeIntelligence.dll status REPOSITORY_ID
dotnet path/to/Praxis.CodeIntelligence.dll search REPOSITORY_ID 'authentication token'
```

Registration queues initial reconciliation. File watcher hints are debounced; periodic reconciliation recovers missed events. Indexing never evaluates a project, builds, restores packages, runs generators, or downloads a model. Without a captured manifest it infers compiler context from SDK-style `.csproj` files, the nearest `Directory.Build.props`, existing `obj/project.assets.json` restore output, installed reference packs and any SDK-generated global-usings file: project references (transitively, unless `DisableTransitiveProjectReferences`), package and framework references, language/nullable settings, defines and implicit usings. Projects that cannot be inferred, files outside every project, and anything only source generators produce stay syntax-only with diagnostics. A repository that has never been restored resolves packages only after one normal restore or build. Overloads retain distinct IDs. Source hashes cover original bytes; ranges are zero-based UTF-16 with exclusive ends.

`--exclude 'private;secrets'` supplies repository-relative folder prefixes. Git-ignore policy and standard generated/dependency folder exclusions also apply. This implementation does not interpret the explicit folder-prefix list as glob patterns. Updating exclusions revokes existing derivatives immediately; ordinary body edits preserve aliases for surviving identities. Paths cannot traverse outside the registered root or follow source symlinks. Linux uses descriptor-relative opening; Windows/macOS handle-race hardening remains a release gate.

Root loss or unreadable scans retain the last committed index and mark coverage unknown. Queries can require current coverage; exact source reads always check the indexed hash. An index is an observed snapshot, not proof the filesystem has remained unchanged afterward.

## Capture compiler context explicitly

This command **evaluates MSBuild projects and targets and can execute project code**. It is never invoked automatically by registration, indexing, MCP, or watchers. Run it only for a project whose execution you authorize:

```sh
dotnet path/to/Praxis.CodeIntelligence.dll capture /absolute/repository src/App/App.csproj --output context.praxis.json --configuration Debug --framework net10.0
```

Add `--restore` only when you explicitly want NuGet restore and access to configured feeds. Without it, missing assets/references fail capture. Multi-target projects need an explicit target framework. Referenced C# projects must remain within the selected root.

Register using `--manifest context.praxis.json`. The manifest records project/import and reference hashes, source membership, compiler options and project dependencies. Generated compile files can supply semantic context through `supportSources`; their source is not returned as authored code. Explicit user exclusions still win. Missing/stale captured inputs degrade to syntax-only analysis with diagnostics. Re-capture after SDK/package/import or project source-membership changes. Source body edits do not require capture.

## Local embeddings

Provisioning is a separate, explicit network operation:

```sh
python3 services/code-intelligence/scripts/prepare-model.py /absolute/model-bundle
dotnet path/to/Praxis.CodeIntelligence.dll model-check /absolute/model-bundle
dotnet path/to/Praxis.CodeIntelligence.dll model-install /absolute/model-bundle
dotnet path/to/Praxis.CodeIntelligence.dll model-activate REPOSITORY_ID sha256:FINGERPRINT
```

Use the fingerprint returned by installation. An offline bundle contains `manifest.json`, `model.onnx` and `vocab.txt`. The model is `BAAI/bge-small-en-v1.5` (MIT; CLS pooling; queries take the instruction `Represent this sentence for searching relevant passages: `, documents take none). Its revision and SHA-256 values are pinned in `models/bge-small-manifest.json` and `LocalModel`; installation verifies checksums and actual local inference. It replaced `all-MiniLM-L6-v2` on 2026-10-17 after the retrieval evaluation in `docs/evaluations/README.md`; an installed MiniLM profile no longer loads, so hybrid falls back to lexical until the new model is installed and activated. See the repository's `LICENSING.md` for the model licence policy. No repository source is uploaded for embeddings. Independent cross-platform golden-vector validation is still outstanding.

Activation queues durable work. Index publication atomically queues vector refresh for active/building profiles. Only complete, normalized, current-revision vector sets participate in retrieval. Hybrid search falls back to lexical results with an explicit warning if a model is missing; vector mode returns `MODEL_UNAVAILABLE`. Current implementation uses exact cosine search and conservative full-context publication; it makes no incremental performance claim.

## Desktop and providers

Open Settings → AI → Tools → Code intelligence. Register/index a root, inspect coverage/diagnostics, search, read source evidence, navigate callers/callees/static traces, and install/activate a local model. Background status polls show queued/running jobs and vector coverage. UI e2e and visual verification remain outstanding.

Provider access is separate from local indexing. The consent dialog names the destination; only that provider receives the generated MCP server. Handover does not transfer another provider's grant. Revoke removes both the repository/client grant and its desktop MCP configuration. Existing provider navigation continues to work independently. Real adapter invocation is not yet claimed; the MCP SDK mock initialize/list/call and provider isolation checks pass.

All eleven tools are read-only and described by `contracts.json`: `search_code`, `find_symbol`, `get_symbol`, `get_source`, `explain_symbol`, `get_callers`, `get_callees`, `trace_flow`, `find_related`, `summarize_project`, `get_index_status`. Static call edges are not execution guarantees. Compiler-bound type/member relationships, bounded possible dispatch, namespace imports, events, explicit throws and observed cross-project dependencies are supported. Captured project and assembly references also have configuration-backed dependency edges with metadata evidence, including unused references. General delegate points-to flow and NuGet package-name inference remain unsupported; static facts do not establish runtime execution.

## Ownership, operations and recovery

Desktop and CLI attach to one per-user owner using a private Unix socket or current-user Windows pipe, a kernel-held stable lock and a random rendezvous token. No TCP fallback exists. Storage defaults are LocalAppData/Praxis/code-intelligence on Windows, `~/Library/Application Support/Praxis/code-intelligence` on macOS, and XDG_DATA_HOME/Praxis/code-intelligence (or `~/.local/share/Praxis/code-intelligence`) on Linux. `--data` selects another private directory. Desktop test profiles isolate their data when `PRAXIS_SETTINGS_PATH` is set.

```sh
dotnet path/to/Praxis.CodeIntelligence.dll pause REPOSITORY_ID
dotnet path/to/Praxis.CodeIntelligence.dll resume REPOSITORY_ID
dotnet path/to/Praxis.CodeIntelligence.dll doctor
dotnet path/to/Praxis.CodeIntelligence.dll backup /absolute/new-backup.db
dotnet path/to/Praxis.CodeIntelligence.dll alias REPOSITORY_ID SYMBOL_ID 'domain phrase'
dotnet path/to/Praxis.CodeIntelligence.dll unregister REPOSITORY_ID
```

Backups use SQLite backup and validate before publication; an existing destination is refused. Do not copy a live database without its WAL. Newer schema versions and mismatched migration checksums are rejected. For corruption, stop the owner, preserve the entire data directory, and restore a verified backup using the matching binary or build a fresh index in a new data directory. Source files must not be deleted for recovery. Use the rebuild/relocation workflow below to recover an index without changing source.

Jobs have 60-second leases and 20-second heartbeats. Retries use 1,5,30,120,300-second delays and terminate after six attempts; expired leases are recovered. Old tokens cannot publish. Pause/unregister obsolete queued work. Owner startup/process boundary and crash recovery still require platform-level verification.

## Packaging

`npm run package:code-intelligence` stages a self-contained service under `artifacts/package`; desktop distribution hooks include it outside the application archive. `--rid` supports linux-x64, linux-arm64, osx-x64, osx-arm64 and win-x64. Model weights are provisioned separately. Cross-target build configuration is not execution evidence. Windows ia32 packaging is explicitly unsupported for this feature.

See [integration map](docs/integration-map.md), [release evidence](docs/release-evidence.md), [current progress](docs/reconstruction-progress.md), and the feature plan under `apps/praxis-desktop/docs/plans/features/fx-bf-109-code-intelligence`.

### Tokenizer profile v3 / representation v2 and independent baseline verification

The tokenizer now preserves BERT special tokens consistently with the independent Python reference. This changes the profile fingerprint (`bert-uncased-wordpiece-v3`, representation version 2); rerun provisioning, installation and activation for an existing v1 setup. Weight/vocabulary hashes do not change. Existing v1/v2 profile vectors are never reused under this profile.

`tests/Praxis.CodeIntelligence.Tests/Fixtures/bge-small-golden.json` records ten tokenizer cases, exact UTF-16/token chunk spans and four full query vectors (instruction-prefixed, CLS-pooled, as the service embeds a query). The model-enabled C# suite checks exact token IDs, absolute vector error <= 1e-5 and cosine >= 0.99999. `scripts/generate-model-golden.py` documents the pinned independent Python reference stack; regenerate only for a deliberate reviewed baseline change. Linux x64 passes; Windows/macOS numerical checks remain release gates.

Representations now prioritize qualified name/signature, documentation and baseline description, then append a selected source declaration excerpt (up to 4096 UTF-16 units; total representation cap 16384). Each stored chunk records its exact UTF-16/token bounds, representation hash, truncation, and intersecting original-source spans/hashes. Source is verified before inference and rechecked before atomic publication. Partial declarations select the first location by path/offset deterministically. Current profile fingerprint: `sha256:dc9986ab75caeae2895119a413d6eb31d400ce05e36d6d86225d1e77c801c29c`. Reprovision, install and activate this profile to upgrade.

### Rebuild and relocation recovery

`rebuild <repository>` queues a forced structural republish even for unchanged inputs. It preserves surviving manual aliases, refreshes active-model vectors through durable work and leaves source files untouched. Paused repositories must be resumed first.

`relocate <repository> <new-root> [--manifest newly-captured.praxis.json]` preserves the repository ID and exclusion policy while clearing old derived facts and revoking provider grants. It schedules indexing at the new canonical root and rebinds watchers. A destination already registered under another ID is rejected. Old captures may contain absolute paths, so the old manifest is dropped unless a newly captured manifest is explicitly supplied. Reapprove provider access after reviewing the relocated root. Paused repositories remain paused.

Provider grants now bind to the canonical root and a unique issuance nonce, checked again before a query response is returned. Legacy grants without these fields fail closed; disable/re-enable provider access to reissue consent.

Desktop recovery is available in **Settings → AI Provider → Tools → Code intelligence**. Select a repository, then use **Rebuild index** or **Relocate repository**. Relocation uses an in-app prompt explaining grant revocation and manifest recapture; generated MCP entries for the old consent are removed. Search responses expose **More search results** when a continuation cursor exists, and shortened source/graph results are labelled. Generation displays use the polled status snapshot.

Unchanged representations reuse complete, normalized current-profile vector sets during atomic structural publication. Reuse updates symbol revisions and source-span hashes without retaining an orphaned cache. Capture is bounded to 128 MiB per publication; uncaptured/changed/invalid sets use durable inference work. Exclusion changes, relocation and unregistration purge old derived vectors. Model refresh also skips inference for already-current complete sets. Structural analysis still republishes full contexts; this is not a claim of affected-file/API-stamp incremental performance.

### Storage upgrade and reconciliation

The service initializes SQLite schema 4. Migration 1 is unchanged; migrations 2–4 add cascading-publication lookup indexes, exact-search indexes and guarded FTS updates. Existing schemas 1–3 upgrade atomically after their migration history/checksum is validated. Incompatible/newer schemas and changed history are refused. A verified private backup is preserved before upgrade writes; backup failure prevents migration. Older binaries refuse newer schemas. Revision-only search-document updates retain the token stream, while actual text changes update FTS atomically.

Unchanged reconciliation validates source bytes, support roles, captured manifest/project inputs and metadata before using an adapter-versioned snapshot in context metadata. It preserves structural generation and query epoch when facts are unchanged. Missing legacy snapshots are backfilled after full analysis. Force rebuild bypasses this optimization. This does not implement semantic API stamps or targeted body-edit invalidation.

Model activation retains complete current vector sets only after value validation and exact regenerated source metadata agreement. Mismatched/corrupt sets or mappings are repaired; input/source/lease checks remain mandatory before committing.

Native CI in `.github/workflows/code-intelligence.yml` executes Linux/Windows/macOS fixtures, schema validation, packaging and actual watcher smoke checks, with an optional Linux real-model benchmark. See the dated release evidence for exact runs and failures; hosted CI smoke is separate from performance and desktop/provider qualification.

### Repeated query performance

The retained benchmark verifies every source/manifest hash, index generation, epoch and complete active vector coverage before measuring. It refuses changed fixtures; migrate a private retained database explicitly with the matching service before reusing it. Query-only measurements never reindex or install models.

`benchmark-query-matrix.mjs` starts a separate benchmark process per category/reader/run, performs 20 warmups and defaults to 200 timed queries per mode, five runs, with both one and four readers. It uses the same stride-17 query set for both reader counts, preserves every raw report and failure, and reports min/max p95. Categories are synthetic exact, terminology, behaviour and negative workloads; they do not establish relevance or cross-project performance. Phase timings separate model query (including its lock wait), retrieval (including SQL/vector/ranking/evidence), vector scan and response preparation. Vector scan is a retrieval subcomponent, not an additional duration. Direct API measurements exclude owner admission and wire serialization.

```sh
node services/code-intelligence/scripts/benchmark-query-matrix.mjs \
  --dotnet /absolute/dotnet --benchmark /absolute/Praxis.CodeIntelligence.Benchmarks.dll \
  --fixture /absolute/retained-fixture --output /existing/output/query-matrix.praxis.json
```

The output parent must exist and be outside the retained fixture. Existing output or raw-run directories are refused. Use `--runs 1 --categories exact` for a pilot; this does not satisfy the five-run protocol. Actual watcher edit timing has a separate `benchmark-watcher.mjs` runner; neither runner implies concurrent-edit or reference-machine qualification.

### Configuration dependency evidence

A `depends_on` edge may describe an observed source use or a compiler reference from validated captured inputs. Source-use edges retain the exact occurrence/hash/range. Configuration edges instead return metadata evidence containing context/reference hashes and the defining project or actual assembly identity; they have no fabricated file, range or source-use claim. Unused references remain configuration dependencies until the captured reference is removed. Assembly identity includes version/culture/public-key identity and does not infer a NuGet package name. Compiler project references also persist the target's conservative full-context dependency stamp, published atomically with the graph. Syntax-only contexts do not emit configured compiler dependencies; partial contexts label them possible.
