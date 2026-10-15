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

## Index a repository

The development executable is `services/code-intelligence/src/Praxis.CodeIntelligence/bin/Debug/net10.0/Praxis.CodeIntelligence.dll`. Run it through `dotnet`; a packaged self-contained executable needs no separately installed runtime.

```sh
dotnet path/to/Praxis.CodeIntelligence.dll register /absolute/repository
dotnet path/to/Praxis.CodeIntelligence.dll list
dotnet path/to/Praxis.CodeIntelligence.dll index REPOSITORY_ID
dotnet path/to/Praxis.CodeIntelligence.dll status REPOSITORY_ID
dotnet path/to/Praxis.CodeIntelligence.dll search REPOSITORY_ID 'authentication token'
```

Registration queues initial reconciliation. File watcher hints are debounced; periodic reconciliation recovers missed events. Indexing defaults to syntax-only C# and never evaluates a project, builds, restores packages, runs generators, or downloads a model. Overloads retain distinct IDs. Source hashes cover original bytes; ranges are zero-based UTF-16 with exclusive ends.

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

Use the fingerprint returned by installation. An offline bundle contains `manifest.json`, `model.onnx` and `vocab.txt`. The model/tokenizer revision and SHA-256 values are pinned in `models/minilm-manifest.json`; installation verifies checksums and actual local inference. No repository source is uploaded for embeddings. Independent cross-platform golden-vector validation is still outstanding.

Activation queues durable work. Index publication atomically queues vector refresh for active/building profiles. Only complete, normalized, current-revision vector sets participate in retrieval. Hybrid search falls back to lexical results with an explicit warning if a model is missing; vector mode returns `MODEL_UNAVAILABLE`. Current implementation uses exact cosine search and conservative full-context publication; it makes no incremental performance claim.

## Desktop and providers

Open Settings → AI → Tools → Code intelligence. Register/index a root, inspect coverage/diagnostics, search, read source evidence, navigate callers/callees/static traces, and install/activate a local model. Background status polls show queued/running jobs and vector coverage. UI e2e and visual verification remain outstanding.

Provider access is separate from local indexing. The consent dialog names the destination; only that provider receives the generated MCP server. Handover does not transfer another provider's grant. Revoke removes both the repository/client grant and its desktop MCP configuration. Existing provider navigation continues to work independently. Real adapter invocation is not yet claimed; the MCP SDK mock initialize/list/call and provider isolation checks pass.

All eleven tools are read-only and described by `contracts.json`: `search_code`, `find_symbol`, `get_symbol`, `get_source`, `explain_symbol`, `get_callers`, `get_callees`, `trace_flow`, `find_related`, `summarize_project`, `get_index_status`. Static call edges are not execution guarantees. Possible-dispatch expansion and additional type relationships remain incomplete.

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

Backups use SQLite backup and validate before publication; an existing destination is refused. Do not copy a live database without its WAL. Newer schema versions and mismatched migration checksums are rejected. For corruption, stop the owner, preserve the entire data directory, and restore a verified backup using the matching binary or build a fresh index in a new data directory. Source files must not be deleted for recovery. A dedicated rebuild/relocation workflow is not yet implemented.

Jobs have 60-second leases and 20-second heartbeats. Retries use 1,5,30,120,300-second delays and terminate after six attempts; expired leases are recovered. Old tokens cannot publish. Pause/unregister obsolete queued work. Owner startup/process boundary and crash recovery still require platform-level verification.

## Packaging

`npm run package:code-intelligence` stages a self-contained service under `artifacts/package`; desktop distribution hooks include it outside the application archive. `--rid` supports linux-x64, linux-arm64, osx-x64, osx-arm64 and win-x64. Model weights are provisioned separately. Cross-target build configuration is not execution evidence. Windows ia32 packaging is explicitly unsupported for this feature.

See [integration map](docs/integration-map.md), [release evidence](docs/release-evidence.md), [current progress](docs/reconstruction-progress.md), and the feature plan under `apps/praxis-desktop/docs/plans/features/fx-bf-109-code-intelligence`.
