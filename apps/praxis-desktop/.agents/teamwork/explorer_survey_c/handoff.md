# Handoff Report: Workstream C (FX-BE-198) — AI MCP/ACP Runtime, Durable Team Chat, and Gadgets in `crates/praxis-ai`

## 1. Observation

### 1.1 Scope and Existing Repository State
- **Story Context**: Located at `apps/praxis-desktop/docs/plans/features/fx-bf-114-rust-and-tauri-migration/stories/fx-be-198-ai-runtime-mcp-acp-and-team-chat/story.md`.
  - `TASK-524` (Sequential Step 1): LLM streaming wire adapters (Anthropic, Gemini, OpenAI/Custom) & usage ledger — **Status: Implemented**.
  - `TASK-525` (Parallel Step 2A): MCP server registry, stdio/HTTP tool transports, built-in MCP servers, and ACP stdio bridge — **Status: Missing**.
  - `TASK-526` (Parallel Step 2B): Durable team chat message persistence and gadget validation/repair — **Status: Missing**.
- **Current `crates/praxis-ai` implementation**:
  - `crates/praxis-ai/src/lib.rs` exports only `WireProtocolFamily`, `pub mod providers;`, and `pub mod usage_stats;`.
  - `crates/praxis-ai/src/providers/`: contains Anthropic wire adapter (`anthropic_wire.rs`), Gemini wire adapter (`gemini_wire.rs`), OpenAI/generic wire adapter (`wire.rs`), custom providers (`custom_providers.rs`), pricing table (`model_pricing.rs`), preflight checks (`provider_preflight.rs`), rate limit error detection (`provider_limit_error.rs`), reasoning effort support (`reasoning_support.rs`), and local runtime detection (`local_runtime_detection.rs`).
  - `crates/praxis-ai/src/usage_stats.rs`: contains the usage ledger tracking requests, input/output tokens, and costs.
  - Test baseline: Running `cargo test -p praxis-ai` executes 105 tests, all currently passing in ~0.01s.
- **Reference Implementations in TypeScript**:
  - **MCP Transports and Client Pool**: `packages/core/src/ai/mcp/mcpToolBridge.ts` (lines 1–279) and `packages/core/src/ai/mcp/mcpServerConfig.ts`.
  - **Built-in MCP Servers**:
    - `packages/core/src/ai/readOnlyFilesMcp.ts` (lines 1–41)
    - `packages/core/src/ai/trackerMcpServer.ts` (lines 1–280)
    - `packages/core/src/ai/browserMcpServer.ts` (lines 1–159)
    - `packages/core/src/ai/coordination/coordinationMcpServer.ts` (lines 1–214)
  - **ACP Agent Host & Client**:
    - `packages/core/src/ai/acp/acpClient.ts` (lines 1–823)
    - `packages/core/src/ai/acp/acpAgentHost.ts` (lines 1–1509)
  - **Durable Team Chat**:
    - Types: `packages/core/src/ai/assistant/assistantTypes.ts` (lines 1–313)
    - State Transitions: `packages/core/src/ai/assistant/teamChatTransitions.ts` (lines 1–213)
    - Store: `packages/core/src/ai/assistant/teamChatStore.ts` (lines 1–122)
    - File Repository: `apps/praxis-desktop/main/src/main/adapters/teamChatRepository.ts` (lines 1–222)
  - **Interactive Chat Gadgets**:
    - Contracts: `packages/core/src/ai/gadgets/contracts.ts` (lines 1–475)
    - Limits: `packages/core/src/ai/gadgets/limits.ts` (lines 1–32)
    - Redaction: `packages/core/src/ai/gadgets/redaction.ts` (lines 1–83)
    - Lenient JSON Repair: `packages/core/src/ai/gadgets/jsonRepair.ts` (lines 1–84)
    - Block Parser: `packages/core/src/ai/gadgets/blockParser.ts` (lines 1–186)
    - Validation Engine: `packages/core/src/ai/gadgets/validation.ts` (lines 1–875)
- **Rust Contracts & Crates Already Available**:
  - `praxis-contracts`: `ConnectionType`, `ToolDescriptor`, `IssueSummary`, `SaveArtifactDetails`.
  - `praxis-core`: `McpServerConfig`, `McpTransport`, `sanitize_mcp_servers`, `mcp_server_slug` in `crates/praxis-core/src/config/mcp_servers.rs`.
  - Workspace dependencies available: `serde`, `serde_json`, `tokio`, `tokio-util`, `reqwest`, `regex`, `chrono`, `sha2`, `sha1`, `uuid`, `url`.

---

## 2. Logic Chain

1. **Separation of Concerns**:
   - `praxis-ai` is designed to be the complete AI runtime in Rust. TASK-524 provided LLM streaming wire adapters and usage accounting.
   - To complete FX-BE-198, two distinct sub-domains must be added to `crates/praxis-ai`:
     - **TASK-525**: Tooling & Agent Interop (`mcp` and `acp`).
     - **TASK-526**: Virtual Team Chat & User Decision Surfaces (`team_chat` and `gadgets`).
2. **MCP Architecture (TASK-525)**:
   - **Protocol**: Model Context Protocol uses JSON-RPC 2.0 messages (`initialize`, `tools/list`, `tools/call`).
   - **Transports**:
     - `StdioTransport`: Runs a child process (`command`, `args`, `env`), communicates over piped stdin/stdout via line-delimited JSON-RPC, pipes stderr for server logging.
     - `HttpTransport`: Speaks Streamable HTTP / SSE over `reqwest::Client` with authorization headers.
   - **Client Pool (`McpClientPool`)**:
     - Caches active connections keyed by `(server_id, config_signature)`. If a server configuration is updated, the stale client is closed and replaced.
     - Implements connection timeouts (20s) and call timeouts (120s).
     - Flattens content blocks (`text`, `resource`, `structuredContent`) to plaintext, bounding output to `MAX_RESULT_CHARS` (60,000 chars) with truncation notice.
   - **Tool Namespacing**:
     - Emits tool names formatted as `mcp__<server_slug>__<safe_tool_name>`, clamped to 64 chars. If longer, hashes with SHA-1 6-hex suffix (`<prefix>_<hash>`).
     - Replaces invalid characters with `_`.
     - Handles name collisions across multiple servers with `_2`, `_3` suffixes.
   - **Built-in Servers**:
     - `ReadOnlyFilesMcp`: Exposes sandboxed `read_file` (with offset pagination) and `list_dir`.
     - `TrackerMcp`: Exposes ticket read tools (`tracker_get_ticket`, `tracker_list_transitions`) and write tools (`tracker_add_comment`, `tracker_update_ticket`, `tracker_transition_ticket`) gated by `tool_mode`.
     - `CoordinationMcp`: Exposes cooperative file claims and cross-agent communication (`coordination_status`, `coordination_claim`, `coordination_wait`, `coordination_release`, etc.).
   - **Registry (`McpServerRegistry`)**:
     - Central registry holding configured servers (`McpServerConfig`) and built-in server providers.
3. **ACP Architecture (TASK-525)**:
   - **Supervisor**: `AcpClient` supervises agent CLI processes (e.g. Claude Code, Codex, Cursor).
   - **Protocol Handshake**:
     - `initialize` -> receives `agentCapabilities` and `authMethods`.
     - Optional `authenticate` with `authMethod`.
     - `session/new` -> receives `sessionId` and `configOptions`.
     - `session/set_config_option` -> sets model and reasoning effort.
     - `session/prompt` -> streams `session/update` delta notifications (text, thoughts, tool calls, usage).
   - **Agent Tool Requests & Permission Gate**:
     - Handles `session/request_permission`.
     - Evaluates against `AgentToolMode`:
       - `ReadOnly`: Blocks mutations (`edit`, `delete`, `move`, `execute`, `unknown`), permits safe operations (`read`, `search`, `think`, `fetch`).
       - `ProjectOnly`: Blocks external or disk-modifying tools.
       - `Full`: Respects auto-approval or prompts user.
     - Handles `fs/read_text_file` and `fs/write_text_file` within sandboxed `working_directory`.
   - **Cancellation**: Sends `session/cancel` and gracefully terminates process group on Unix.
4. **Durable Team Chat Architecture (TASK-526)**:
   - **Domain Model**:
     - 5 virtual engineering personas (`lead`, `dev`, `qa`, `security`, `product`).
     - Explicit multi-turn conversation state with immutable sequence numbering.
     - Turn state machine: `Queued` -> `Running` -> `Completed` (or `Interrupted` / `OutcomeUnknown` / `Cancelled`).
     - Attempt state machine: `Prepared` -> `Dispatching` -> `Running` -> `AwaitingApproval` -> `Completed`.
   - **Deterministic Transitions (`transitions.rs`)**:
     - Canonical JSON payload digest (`SHA-256` over recursively sorted keys, strict numbers).
     - Atomic command submission (`submit_conversation_turn`) providing idempotency: duplicate command IDs with identical payload digest return the current state unchanged; conflicting digests return `CommandPayloadConflict`.
     - Epoch management (`begin_conversation_epoch`): on coordinator crash or restart, transitions active attempts to `OutcomeUnknown` (if dispatched) or `Interrupted`, preserving originating epoch for recovery.
   - **Atomic Durability (`FileTeamChatRepository`)**:
     - File path: `assistant-team-chats.json`.
     - Commit sequence: write to `<file>.<uuid>.tmp` (mode `0o600`) -> `file.sync()` -> atomic `rename` -> parent directory `sync()`.
     - Detects and flags durability uncertainty if directory sync fails after rename (`CommitUncertainError`).
     - Strict in-memory schema validation on every read and transaction to guarantee transcript integrity.
5. **Gadget Validation & Repair Architecture (TASK-526)**:
   - **Contracts**: Version 1 schema supporting 12 gadget kinds (`choice`, `confirmation`, `form`, `table`, `chart`, `progress`, `diff`, `artifact`, `image`, `handoff`, `conflict`, `approval`).
   - **Hard Limits**: Envelope size <= 128 KB, string lengths <= 20,000 chars, table rows <= 200 (trimmed with `truncated: true`), chart points <= 500, actions <= 8.
   - **Secret Redaction**: Masks private keys, GitHub tokens/PATs, OpenAI/Anthropic keys, AWS keys, Slack tokens, Google API keys, Bearer tokens, JWTs, and keyed secrets with `[redacted]`.
   - **Lenient JSON Repair & Block Parser**:
     - Models emit unescaped quotes (`"a "quoted" word"`) and unescaped newlines in markdown code fences (````praxis-gadget ... ````).
     - `repair_json_strings` escapes inner quotes and raw newlines without guessing at object structure.
     - Stamps host-authoritative `scope` and `issued_at`, preventing untrusted scope injection.
     - Derives readable `fallbackText` when omitted by producer.
   - **Action Validation**:
     - Validates submitted action values against gadget definitions (e.g. choice selected option must exist).

---

## 3. Caveats

1. **Read-Only Exploration**:
   - No source code in `crates/praxis-ai` or `Cargo.toml` was edited during this exploration phase.
2. **Electron IPC Registration Boundaries**:
   - Workstream C focuses strictly on the Rust crate implementation in `crates/praxis-ai` and verifying it via `cargo test -p praxis-ai`.
   - Electron IPC routing (`RustHostBridge.handleOrFallback` in Electron main) is governed under Workstream B for `folder:*`/`plans:*`/`settings:*`, while full cutover of `assistant:*` and `mcp:*` into `praxis-host` will consume these completed `praxis-ai` modules.
3. **External Dependencies in `Cargo.toml`**:
   - `sha2`, `sha1`, `uuid`, and `url` exist in workspace dependencies (`Cargo.toml` root) and must be added to `crates/praxis-ai/Cargo.toml` as `sha2.workspace = true`, `sha1.workspace = true`, `uuid.workspace = true`, `url.workspace = true`.
4. **Platform Process Group Handling**:
   - On Unix (macOS/Linux), subprocess management in `acp` and `mcp` uses POSIX process groups (`libc::setpgid` / `nix::sys::signal::killpg`) for clean process tree termination; on Windows, job objects or standard child process kill is used.

---

## 4. Conclusion & Concrete Implementation Plan

### 4.1 Target Module Layout in `crates/praxis-ai`
```
crates/praxis-ai/
├── Cargo.toml                   # Add sha2, sha1, uuid, url from workspace
└── src/
    ├── lib.rs                   # Re-export mcp, acp, team_chat, gadgets modules
    ├── providers/               # (Existing TASK-524 wire adapters)
    ├── usage_stats.rs           # (Existing TASK-524 usage ledger)
    ├── mcp/                     # TASK-525: Model Context Protocol
    │   ├── mod.rs               # Module exports
    │   ├── types.rs             # JSON-RPC 2.0 messages & MCP tool descriptors
    │   ├── transport.rs         # StdioTransport and HttpTransport
    │   ├── tool_bridge.rs       # McpClientPool, tool namespacing, output truncation
    │   ├── registry.rs          # McpServerRegistry
    │   └── builtin/             # Built-in MCP servers
    │       ├── mod.rs
    │       ├── read_only_files.rs
    │       ├── tracker.rs
    │       ├── browser.rs
    │       └── coordination.rs
    ├── acp/                     # TASK-525: Agent Client Protocol
    │   ├── mod.rs               # Module exports
    │   ├── protocol.rs          # ACP JSON-RPC message schemas & notifications
    │   ├── client.rs            # Stdio child process lifecycle & streaming
    │   └── host.rs              # Session supervisor & tool mode permission gating
    ├── team_chat/               # TASK-526: Durable Team Chat
    │   ├── mod.rs               # Module exports
    │   ├── types.rs             # AssistantRole, DurableConversation, ConversationTurn, etc.
    │   ├── transitions.rs       # Canonical SHA-256 digest & atomic state machine transitions
    │   ├── store.rs             # FileTeamChatRepository (temp+fsync+rename durability)
    │   └── personas.rs          # Default personas & system prompts
    └── gadgets/                 # TASK-526: Interactive Gadgets
        ├── mod.rs               # Module exports
        ├── contracts.rs         # Versioned gadget envelope, 12 kinds, scopes, action values
        ├── limits.rs            # Envelope & payload bounds
        ├── redaction.rs         # Secret pattern regex masking ([redacted])
        ├── json_repair.rs       # Unescaped quote & newline string repair
        ├── block_parser.rs      # ```praxis-gadget block parser & scope stamping
        ├── fallback.rs          # Automatic text fallback derivation
        └── validation.rs        # Schema validation & array trimming (truncated = true)
```

### 4.2 Step-by-Step Implementation Plan for Worker

#### Step 1: Update `crates/praxis-ai/Cargo.toml`
Add workspace dependencies needed for hashing, UUID generation, and URL parsing:
```toml
sha2.workspace = true
sha1.workspace = true
uuid.workspace = true
url.workspace = true
```

#### Step 2: Implement TASK-525 (`mcp` and `acp`)
1. **`src/mcp/types.rs`**:
   - `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcError`.
   - `McpToolInfo` (`name`, `description`, `input_schema`).
   - `McpContentBlock` (`Text { text }`, `Resource { resource }`).
   - `CallToolResult` (`ok: bool`, `content: String`).
2. **`src/mcp/transport.rs`**:
   - Trait `McpTransportConnection: Send + Sync`: `async fn call_tool(...)`, `async fn list_tools(...)`, `async fn close(...)`.
   - `StdioTransport`: uses `tokio::process::Command`, piped stdin/stdout, JSON-RPC line reader/writer.
   - `HttpTransport`: uses `reqwest::Client` for POSTing JSON-RPC requests.
3. **`src/mcp/tool_bridge.rs`**:
   - `McpClientPool`: connection cache keyed by `(id, signature)`.
   - `mcp_tool_name(server_name, tool_name)`: `mcp__<slug>__<tool>`, 64-char clamp with SHA-1 suffix.
   - Output truncation logic: 60,000 characters maximum with truncation notice.
   - Approval gate: prompts or checks approval when `require_approval == true`.
4. **`src/mcp/builtin/`**:
   - `read_only_files.rs`: `read_file` with offset pagination (48,000 chars per page), `list_dir`.
   - `tracker.rs`: ticket read/write tools mapped to tracker contracts.
   - `coordination.rs`: claim/wait/release coordination tools.
5. **`src/mcp/registry.rs`**:
   - `McpServerRegistry`: registers user configs and built-ins.
6. **`src/acp/protocol.rs` & `src/acp/client.rs` & `src/acp/host.rs`**:
   - `AcpClient`: stdio process supervisor with newline JSON-RPC.
   - Handles `initialize`, `session/new`, `session/prompt`, `session/update`.
   - `AcpAgentHost`: evaluates `session/request_permission` against `AgentToolMode`:
     - In `ReadOnly` mode: denies mutations, permits safe operations (`read`, `search`, `think`, `fetch`).
     - In `ProjectOnly` mode: denies mutations and external tools.
     - In `Full` mode: honors auto-approval or prompts.
   - Handles sandboxed `fs/read_text_file` and `fs/write_text_file`.

#### Step 3: Implement TASK-526 (`team_chat` and `gadgets`)
1. **`src/team_chat/types.rs`**:
   - `AssistantRole`, `AssistantSpeaker`, `PageAssistantContext`, `AssistantMessage`.
   - `ConversationParticipant`, `ConversationTurn`, `ConversationTurnState`.
   - `ConversationAttempt`, `ConversationAttemptState`, `ConversationContextReceipt`.
   - `ConversationMessage`, `ConversationBinding`, `ConversationSummary`.
   - `ConversationCommandReceipt`, `ConversationRecoveryEvidence`, `ConversationPendingApproval`.
   - `DurableConversation`, `TeamChatSnapshot`, `TeamChatRecord`.
2. **`src/team_chat/transitions.rs`**:
   - `conversation_payload_digest`: canonical deterministic JSON serialization (lexicographically sorted keys) + `sha2::Sha256`.
   - `submit_conversation_turn`: atomic turn submission with idempotency check against `command_receipts`.
   - `start_conversation_turn`: starts next queued turn.
   - `reserve_conversation_attempt`: assigns next participant attempt in plan.
   - `advance_conversation_attempt`: prepared -> dispatching -> running -> awaiting_approval.
   - `record_attempt_approval` & `resolve_attempt_approval`.
   - `complete_conversation_attempt`: stores final reply, updates completed participants, completes turn when all finish.
   - `begin_conversation_epoch`: fences in-flight attempts to `OutcomeUnknown`, `Cancelled`, or `Interrupted`.
3. **`src/team_chat/store.rs`**:
   - `FileTeamChatRepository`: atomic durability via `.tmp` file + `fsync` + atomic `rename` + directory `fsync`.
   - Throws `TeamChatStorageError` and `TeamChatCommitUncertainError`.
   - Strict `decode` schema validation on read and write transactions.
4. **`src/gadgets/contracts.rs` & `limits.rs`**:
   - `GADGET_CONTRACT_VERSION = 1`.
   - 12 `GadgetKind` enums & payloads: `Choice`, `Confirmation`, `Form`, `Table`, `Chart`, `Progress`, `Diff`, `Artifact`, `Image`, `Handoff`, `Conflict`, `Approval`.
   - `GadgetScope`, `GadgetActionDescriptor`, `GadgetActionValue`, `GadgetAction`, `GadgetEnvelope`, `ChatBlock`.
   - Hard limits: 128 KB envelope bytes, 20,000 string length, table row ceiling (200), etc.
5. **`src/gadgets/redaction.rs`**:
   - Regex patterns for private keys, GitHub tokens/PATs, OpenAI/Anthropic keys, AWS keys, Slack tokens, Google keys, Bearer tokens, JWTs, and keyed secrets.
   - Deep redaction function: replaces detected tokens with `[redacted]`.
6. **`src/gadgets/json_repair.rs` & `block_parser.rs` & `fallback.rs`**:
   - `repair_json_strings`: fixes unescaped inner quotes and raw newlines inside string literals.
   - `parse_chat_blocks`: extracts ````praxis-gadget ... ```` blocks, parses lenient JSON, stamps host scope.
   - `gadget_fallback_text`: generates human-readable fallback for each gadget kind.
7. **`src/gadgets/validation.rs`**:
   - `validate_gadget_envelope`: validates version, kind, envelope byte ceiling, kind-specific schema rules.
   - Truncates oversized collections (e.g. table rows clamped to 200) and sets `truncated = true`.
   - Runs secret redaction pass and sets `redacted = true` when credentials are masked.
   - `validate_gadget_action_value`: ensures submitted action value matches gadget kind and choices.

#### Step 4: Write Comprehensive Unit Tests in `crates/praxis-ai`
- Add parity unit tests covering:
  - MCP tool naming, tool execution, client pooling, approval requests, and output truncation.
  - Read-only files MCP server sandboxing and chunked reads.
  - ACP agent host permission gating across `ReadOnly`, `ProjectOnly`, and `Full` tool modes.
  - Team chat transition invariants: idempotency, conflict detection, attempt fencing, and epoch changes.
  - File repository atomic persistence, directory fsync error handling, and transaction serialization.
  - Gadget envelope validation, table truncation, secret redaction, lenient JSON repair, and action validation.

---

## 5. Verification Method

To independently verify the completeness and correctness of the implementation:

1. **Unit Test Suite**:
   ```bash
   cargo test -p praxis-ai
   ```
   **Expected Result**: All existing 105 tests plus newly added unit tests for `mcp`, `acp`, `team_chat`, and `gadgets` pass cleanly with zero compiler warnings or test failures.

2. **Full Workspace Typecheck**:
   ```bash
   cargo check --workspace
   ```
   **Expected Result**: Exits with code 0.

3. **Desktop Smoke Tests**:
   ```bash
   npm run test:desktop:smoke
   ```
   **Expected Result**: All smoke spec tests pass with no regressions.
