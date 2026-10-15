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

## Verification evidence

15 October: C#38 passed,0 failed,0 skipped with provisioned pinned model assets. Includes real ONNX inference, offline model installation/activation, durable automatic vector refresh after source publication, coalescing/backoff, expiry recovery, stale-token publication rejection, heartbeat and pause, Git-ignore privacy and no fsmonitor execution. Explicit SDK capture, stale/deleted inputs, generated support non-disclosure and alias preservation also pass.
14 October: full desktop build passed including renderer core-import and trusted-IPC guards;2 MCP SDK/provider-isolation tests passed;24 responses across all11 tools validated with JSON Schema2020-12.
Full application build including the service passed; Linux self-contained publish/CLI/SQLite/native-model checks passed after context capture.30fresh responses across all11tools validate against the normative schemas.46focused MCP/settings tests passed. Parser counts moved53/160/345/18to54/164/366/18(features/stories/tasks/bugs). Do not treat historical results as verification of later changes.

## Remaining implementation/release work

- Cross-platform golden numerical verification and vector representation reuse/performance verification.
- Semantic API-stamp/affected-context optimization, richer member/type/reference relationships and delegate points-to analysis.
- Remaining status/summary/irreducible-item budget boundaries and execution of Windows/macOS source-handle fixtures.
- Native IPC process/platform matrix, UI e2e/visual walkthrough, live provider adapter invocation, scale/quality acceptance gates A01–A40.

Current indexing intentionally uses conservative full-context republishing; it does not claim incremental performance or release readiness. M4–M6 remain future scope. Environment-dependent checks may be deferred at the user's instruction; record them rather than silently claiming success.

## Preservation policy

Meaningful code/tests/docs must be committed remotely before ending a turn and at intermediate checkpoints. Verify exact remote file contents. A local Git commit is insufficient. Command-line HTTPS push was unavailable; the connected GitHub API has successfully preserved checkpoints. Use the actual remote commit SHA in reports. Recovery-record.md retains the deleted implementation inventory; it is not current passing code.
