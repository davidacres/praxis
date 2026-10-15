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

Current checkpoint verification: **40 C# tests passed, 0 failed, 0 skipped**, including real pinned-model inference and explicit SDK capture. No UI files changed in this checkpoint.

Regression coverage includes nested lambda containment, resolved local-function targets, distinct delegate identities, body/offset edits, syntax-only prefixes and initializer ownership. Synthetic project-root/top-level entries and possible virtual dispatch remain separate unfinished work.

## Verification evidence

15 October: C#38 passed,0 failed,0 skipped with provisioned pinned model assets. Includes real ONNX inference, offline model installation/activation, durable automatic vector refresh after source publication, coalescing/backoff, expiry recovery, stale-token publication rejection, heartbeat and pause, Git-ignore privacy and no fsmonitor execution. Explicit SDK capture, stale/deleted inputs, generated support non-disclosure and alias preservation also pass.
14 October: full desktop build passed including renderer core-import and trusted-IPC guards;2 MCP SDK/provider-isolation tests passed;24 responses across all11 tools validated with JSON Schema2020-12.
Full application build including the service passed; Linux self-contained publish/CLI/SQLite/native-model checks passed after context capture.30fresh responses across all11tools validate against the normative schemas.46focused MCP/settings tests passed. Parser counts moved53/160/345/18to54/164/366/18(features/stories/tasks/bugs). Do not treat historical results as verification of later changes.

## Remaining implementation/release work

- Independent golden tokenizer/vector fixture and representation chunk spans/source excerpts.
- Semantic API-stamp/affected-context optimization, possible dispatch/type relationships, synthetic project-root/top-level ownership.
- Complete line-budget truncation/pagination behavior and hardened source-handle checks on Windows/macOS.
- Native IPC process/platform matrix, UI e2e/visual walkthrough, live provider adapter invocation, scale/quality acceptance gates A01–A40.

Current indexing intentionally uses conservative full-context republishing; it does not claim incremental performance or release readiness. M4–M6 remain future scope. Environment-dependent checks may be deferred at the user's instruction; record them rather than silently claiming success.

## Preservation policy

Meaningful code/tests/docs must be committed remotely before ending a turn and at intermediate checkpoints. Verify exact remote file contents. A local Git commit is insufficient. Command-line HTTPS push was unavailable; the connected GitHub API has successfully preserved checkpoints. Use the actual remote commit SHA in reports. Recovery-record.md retains the deleted implementation inventory; it is not current passing code.
