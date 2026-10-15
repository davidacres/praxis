# Code intelligence integration map

| Concern | Implementation | Integration decision |
|---|---|---|
| Storage/schema | `Storage/IndexDatabase.cs`, `migration001.sql` | Own local database; no source writes; checksum migrations |
| Source policy | `Indexing/SourceFiles.cs`, `SafeSourceHandle.cs`, `SourceScanner.cs`, `GitFilePolicy.cs` | Canonical roots, raw hashes, explicit excludes and Git policy |
| Passive semantics | `Indexing/PassiveManifest.cs`, `RoslynAnalyzer.cs`, `RepositoryIndexer.cs` | Roslyn compilation from captured inputs; no implicit project evaluation |
| Explicit evaluation | `Indexing/ContextCapture.cs`, CLI `capture` | Separate authorized MSBuild execution; bounded output/time; optional restore |
| Jobs/freshness | `Host/DurableScheduler.cs`, `RepositoryMonitor.cs` | One owner, coalesced durable work, lease CAS, watcher hints plus periodic scans |
| Queries/contracts | `Queries/QueryService.cs`, `JsonContract.cs`, `CursorCodec.cs`, `contracts.json` | Eleven bounded, scoped read-only tools; normative schema generation |
| Embeddings | `Embeddings/LocalModel.cs`, `ModelStore.cs`, `WordPieceTokenizer.cs` | Pinned offline CPU inference and atomic complete vector sets |
| Owner/CLI | `Host/OwnerService.cs`, `Framing.cs`, `HostPaths.cs`, `Program.cs` | Authenticated local IPC; shared lifecycle; no TCP listener |
| Shared desktop paths | `packages/core/src/codeIntelligence/runtimePaths.ts` | Match service data defaults; explicit test/profile overrides |
| MCP | `packages/core/src/codeIntelligence/mcpBridge.ts` | Reuse installed MCP SDK; bounded child RPC; fixed repository/client scope |
| Provider launch | `main/src/main/userMcp.ts`, `aiIpc.ts`; core `ai/mcp/mcpServerConfig.ts` | Reuse existing ACP/gateway MCP plumbing and enforce destination filter |
| Privileged IPC | `main/src/main/codeIntelligenceIpc.ts`, `index.ts`, preload | Reuse trusted sender wrapper; validate actions/tools; shell-free execution |
| Renderer types | `packages/core/src/host/ipcContracts.ts` | Extend existing AI IPC slice; type-only renderer imports |
| Desktop surface | `renderer/src/settings/CodeIntelligencePanel.tsx`, `SettingsPage.tsx` | Existing AI Tools tab, ChipSelect, themed dialogs/tokens; no new top-level route |
| Packaging | `scripts/build-service.mjs`, root/main package scripts | Locked service build, staged self-contained native bundle, extraResources |
| Verification | C# tests, core `mcpBridge.test.ts`, `scripts/verify-contracts.py` | Isolated fixtures; mock MCP proof separated from actual provider evidence |

Paths in the first column's service rows are relative to `services/code-intelligence/src/Praxis.CodeIntelligence`; desktop `main`/`renderer` paths are relative to `apps/praxis-desktop`. No new settings backend, credentials store, or AI runtime is introduced. Repository/provider egress grants are owned by the service and the generated MCP configuration carries the destination marker.

Build dependency order is core → service → mobile protocol/relay → renderer → renderer copy → desktop. Service assets are installed explicitly; runtime search never contacts model hosts or package feeds. General application build/package operations may restore this repository's locked dependencies. This is separate from indexing a user's repository.
