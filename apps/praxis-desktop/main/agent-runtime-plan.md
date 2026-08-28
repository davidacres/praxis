# Unified Agent Runtime With Automatic Discovery and Skill Loading

**Status:** Implemented — discovery, skill indexing, IPC, host loading, capability negotiation, and session skill activation
**Owner:** Praxis desktop app
**Scope:** `packages/core`, `apps/praxis-desktop/main`, and the shared renderer settings UI
**Priority:** P1
**Risk:** High

## Purpose

Create one desktop agent runtime that automatically discovers and loads:

- Claude Agent Host
- Copilot Agent Host
- Codex Agent Host
- Future compatible agent hosts
- Shared and per-agent skills

The intended experience mirrors VS Code's configuration-driven discovery: a user installs or configures an agent host, Praxis discovers its manifest, negotiates its capabilities, and makes compatible skills available without adding provider-specific orchestration to the Electron shell.

## Desired Outcomes

1. Adding a conforming agent host does not require changing the runtime manager.
2. Existing ACP-based Claude and Codex hosts, the Copilot SDK host, and API/gateway providers continue to work.
3. Skills use one canonical on-disk format and are loaded progressively.
4. Agent processes, tools, resources, and secrets remain behind explicit desktop trust and permission boundaries.
5. Sessions retain a stable agent identity and capability snapshot so they can be resumed safely.

## Current Implementation Status

The first runtime slice is now live in the desktop main process:

- `packages/core/src/ai/agentRuntime` validates manifests, discovers agents, indexes skill metadata, and fingerprints `SKILL.md` files.
- `AgentRuntimeManager` exposes refresh/list/start/dispose lifecycle operations and normalized capability snapshots.
- Trusted HTTP hosts negotiate `GET /capabilities`; trusted subprocess hosts launch without a shell and are disposed on app shutdown.
- Electron IPC exposes `agentRuntime.list()`, `agentRuntime.refresh()`, and `agentRuntime.start(agentId)`.
- Startup-activation hosts are started after discovery; on-demand hosts remain lazy.

The existing ACP/Copilot implementations remain the native provider adapters for their established session protocols. Explicitly selected runtime skills can now be injected into those sessions through `AiDelegateInput.agentId` and `skillNames`, while generic discovered hosts use the runtime loader.

## Non-Goals

1. Vercel AI Gateway will not discover, launch, or manage agents or skills.
2. The first release will not download or install agent hosts automatically.
3. Discovery will not make an untrusted manifest executable without user approval.
4. The runtime will not assume that every host supports tools, memory, resume, or skills.
5. Skills will not bypass the existing `read-only`, `project-only`, or `full` tool modes.

## High-Level Architecture

Project-level configuration may use this layout:

```text
<project>/
  .praxis/
    agents/
      claude/
        agent.json
      copilot/
        agent.json
      codex/
        agent.json
    skills/
      search/
        SKILL.md
        resources/
        scripts/
      calendar/
        SKILL.md
      filesystem/
        SKILL.md
    agent-runtime.json
```

User-level agents, skills, and overrides live beneath Electron's `app.getPath('userData')`. Project configuration takes precedence only for that trusted project; user configuration provides defaults shared across projects.

The implementation should follow the current monorepo boundaries:

```text
packages/core/src/ai/agentRuntime/
  discovery.ts
  manifest.ts
  hostLoader.ts
  capabilityRegistry.ts
  skillRegistry.ts
  agentManager.ts
  adapters/
    acpHostAdapter.ts
    copilotHostAdapter.ts
    gatewayHostAdapter.ts
    skillCompatibilityAdapter.ts

apps/praxis-desktop/main/src/main/
  agentRuntimeInstance.ts
  agentRuntimeIpc.ts
```

`packages/core` owns discovery, validation, negotiation, routing, and host-neutral types. The Electron main process owns filesystem access, child-process lifecycle, secret resolution, trust prompts, and IPC. The renderer receives serializable status snapshots and user actions only.

## Runtime Responsibilities

1. Discover configured agent manifests.
2. Validate manifests before resolving or launching an entry point.
3. Start or connect to hosts through a transport adapter.
4. Negotiate and cache host capabilities.
5. Discover, validate, and index skills.
6. Register or adapt skills for compatible hosts.
7. Route new and resumed sessions to an eligible host.
8. Enforce permissions, trust, lifecycle, logging, and failure isolation.

## 1. Agent Discovery

### Goal

Detect installed and project-configured agent hosts without hard-coding provider names in the Electron application.

### Discovery Sources

Scan in deterministic order:

1. Built-in host descriptors shipped with Praxis.
2. User-level `agents` directory beneath Electron `userData`.
3. Trusted project-level `.praxis/agents` directory.
4. Explicit paths from the merged runtime configuration.

Agent IDs must be unique after merging. A higher-precedence source may override a lower-precedence manifest only when the user has explicitly enabled overrides.

### Example `agent.json`

```json
{
  "schemaVersion": 1,
  "id": "claude",
  "name": "Claude",
  "type": "acp",
  "entry": {
    "command": "claude-agent-acp",
    "args": []
  },
  "skills": ["../../skills"],
  "config": "./config.json",
  "activation": "onDemand"
}
```

Required fields are `schemaVersion`, `id`, `name`, `type`, and `entry`. The manifest schema must reject unknown executable forms, path traversal outside approved roots, duplicate IDs, invalid environment declarations, and unsupported schema versions.

### Discovery Result

Discovery returns descriptors only; it does not immediately launch every process. Each descriptor records:

- Manifest source and resolved path
- Trust state
- Host type and transport adapter
- Activation policy
- Configuration and skill roots
- Validation errors or warnings

Hosts using `onDemand` activation start when first selected or probed. An optional `startup` policy may be used for explicitly trusted hosts that need eager initialization.

## 2. Host Loading and Lifecycle

The loader resolves a validated descriptor to a host adapter. Initial adapters map onto the runtime already present in the repository:

- ACP adapter for Claude and Codex-compatible CLI hosts, reusing `AcpAgentHost` and `AcpClientWrapper`.
- Copilot adapter, reusing `CopilotAgentHost`.
- Gateway adapter, reusing `VercelAgentService` for direct model calls.

The loader must:

1. Resolve the executable without invoking a shell.
2. Spawn with an explicit argument array, minimal environment, working directory, and cancellation signal.
3. Establish the adapter-specific handshake within a timeout.
4. Capture a normalized capability snapshot.
5. Track process health and active sessions.
6. Dispose child processes during app shutdown or configuration reload.
7. Apply bounded restart/backoff for unexpected exits without creating a restart loop.

A broken host must be isolated. Its failure is surfaced in Settings and logs, while other hosts remain available.

## 3. Capability Negotiation

All adapters expose a host-neutral capability contract even when their wire protocols differ.

```ts
interface AgentCapabilities {
  skills: 'native' | 'context' | 'tools' | 'unsupported';
  tools: boolean;
  memory: boolean;
  resume: boolean;
  models: boolean;
  streaming: boolean;
  permissions: boolean;
  version?: string;
  defaultModel?: string;
}
```

HTTP-based future hosts may expose:

```http
GET /capabilities
```

```json
{
  "supportsSkills": true,
  "supportsTools": true,
  "supportsMemory": true,
  "supportsResume": true,
  "model": "example-model",
  "version": "1.0.0"
}
```

ACP and SDK hosts use their native initialization/session negotiation instead of requiring an HTTP endpoint. The adapter translates native data to `AgentCapabilities`.

The capability registry stores the snapshot with the agent ID, manifest fingerprint, negotiated timestamp, and adapter version. It is invalidated when the manifest, executable version, configuration, or app version changes.

The agent manager uses capabilities to decide:

- Whether and how a skill can be exposed
- Which tool contracts can be registered
- Whether a prior session can be resumed
- Whether model selection is available
- Whether permission requests can be enforced interactively
- Which hosts are eligible for a request

## 4. Unified Skill Registry

### Canonical Skill Format

Each skill is a folder containing:

```text
skill-name/
  SKILL.md
  resources/     # optional
  scripts/       # optional
```

`SKILL.md` contains YAML front matter followed by instructions:

```markdown
---
name: search
description: Search project content when a request needs repository evidence.
version: 1.0.0
triggers:
  - search
  - find in project
---

# Search

Instructions loaded only after activation.
```

At discovery time, the registry reads only bounded metadata. It validates:

- Stable name and supported metadata version
- Unique identity after source precedence is applied
- Description and trigger size limits
- Resource and script paths contained within the skill root
- Optional agent allow/deny constraints
- Trust requirements for scripts or executable resources

The registry records skill source, fingerprint, trust state, metadata, and compatibility. Full instructions and resources are not loaded until activation.

### Skill Sources and Precedence

1. Built-in Praxis skills
2. User-level skills
3. Trusted project-level `.praxis/skills`
4. Per-agent skill paths from an `agent.json` manifest
5. Explicit configuration paths

Duplicate skill names are reported. Silent shadowing is not allowed unless an explicit override identifies both the replacing and replaced skill.

## 5. Automatic Skill Activation

Progressive disclosure occurs in three stages:

1. **Index:** Load name, description, triggers, compatibility, and trust state.
2. **Activate:** When the request and host capabilities match, load `SKILL.md` instructions.
3. **Use:** Resolve individual resources or scripts only when the active skill requires them and the session's permission mode allows access.

Relevance uses metadata plus request/session context. The runtime provides the eligible skill catalog to the selected agent; the agent may request activation, or the runtime may activate a deterministic required skill configured for the workflow. Activation decisions are logged on the session.

Skills never widen authority. A project-only session cannot access resources outside its approved project, and a read-only session cannot run a skill script that mutates state.

## 6. Host Compatibility

The registry chooses one of four delivery modes from negotiated capabilities:

- `native`: register the canonical skill through the host's native skill mechanism.
- `context`: inject the activated instructions into the host's session context.
- `tools`: translate explicitly declared skill operations into host tool schemas.
- `unsupported`: keep the skill unavailable and explain why in status/UI.

The compatibility adapter must be capability-driven rather than based only on an agent brand. For Codex or any other host that cannot consume the canonical skill folder directly through the selected protocol, it will:

1. Parse and validate `SKILL.md` metadata.
2. Add activated instructions through the adapter's supported context mechanism.
3. Convert only explicitly declared operations to tool schemas.
4. Map resource reads to host-mediated, permission-checked tool calls.
5. Preserve the original skill identity in logs and session metadata.

Arbitrary prose must not be inferred into executable tool schemas. A skill needs a structured operation declaration before the compatibility layer exposes it as a tool.

## 7. Configuration

Example `.praxis/agent-runtime.json`:

```json
{
  "schemaVersion": 1,
  "agentsPath": "./agents",
  "skillsPath": "./skills",
  "defaultAgent": "claude",
  "logging": true,
  "allowProjectAgents": false,
  "allowProjectSkillScripts": false
}
```

Configuration is merged in this order:

1. Safe application defaults
2. User-level configuration
3. Trusted project configuration
4. Supported environment-variable overrides

Only a documented allowlist may be overridden through environment variables. Secrets remain in the existing secret store and must never be written to manifests, normal settings JSON, capability caches, renderer IPC payloads, or logs.

Configuration changes trigger a debounced rescan. Active sessions keep their pinned host descriptor and capabilities until they finish; new sessions use the new registry. Removing a host with active sessions requires an explicit stop or deferred removal.

## 8. Agent Manager and Request Routing

The manager replaces provider-specific branching at desktop call sites with one normalized interface:

```ts
interface AgentManager {
  listAgents(): AgentStatus[];
  startSession(request: AgentSessionRequest): Promise<AgentSessionHandle>;
  resumeSession(sessionId: string, input: string): Promise<void>;
  abortSession(sessionId: string): Promise<void>;
  respondToPermission(sessionId: string, decision: PermissionDecision): void;
  dispose(): Promise<void>;
}
```

Routing order:

1. Use the explicitly selected agent when it is healthy and compatible.
2. Use the session's pinned agent for resume.
3. Use the configured default agent for new sessions.
4. Use a fallback only when fallback is enabled and its capabilities meet all requirements.
5. Fail with an actionable reason when no compatible host exists.

Fallback must not silently change trust level, tool mode, model class, cost boundary, or provider. The session record stores agent ID, adapter type, model, manifest fingerprint, capability snapshot, active skill IDs, and fallback reason.

## 9. Vercel AI Gateway Integration

The gateway is used only for:

- Routing supported model API calls
- Usage monitoring
- Provider fallback within the configured gateway policy

It does not discover agents, launch processes, load skills, or grant tools.

```text
Praxis UI
        |
        v
Unified Agent Runtime
        |
        +--> Local ACP / SDK Agent Host
        |
        +--> Vercel AI Gateway --> Model Provider
```

The gateway is one host adapter target, not the runtime itself.

## 10. Desktop UI and IPC

Settings should show:

- Discovered agents and their source
- Trust, health, executable, version, and activation status
- Negotiated capabilities and available models
- Discovered skills, source, compatibility, and trust state
- Validation failures with the manifest or skill path
- Rescan, enable/disable, trust/revoke, and test-connection actions

IPC contracts expose serializable summaries and explicit commands. The renderer must never receive executable environment variables, API keys, raw child-process handles, or unrestricted filesystem paths.

The session creation UI should default to the configured agent, show only compatible skills, and make fallback behavior visible before execution.

## 11. Security and Reliability Requirements

1. Project-level agents and executable skill scripts are disabled until the project is trusted and the user approves them.
2. Resolve and canonicalize all paths before containment checks; reject traversal and symlink escapes from approved roots.
3. Spawn commands directly with argument arrays and `shell: false`.
4. Filter inherited environment variables and inject secrets only for the intended host process.
5. Apply handshake, idle, and shutdown timeouts plus output-size limits.
6. Preserve existing host-enforced tool modes and interactive permission decisions.
7. Redact secrets, tokens, authorization headers, and configured sensitive values from logs.
8. Version and size-limit manifests, capability responses, skill metadata, instructions, and resources.
9. Fail closed when validation, capability negotiation, trust, or permission checks are incomplete.
10. Dispose watchers and processes on project switch, rescan, logout, and application shutdown.

## 12. Delivery Phases

### Phase 1: Contracts and Read-Only Discovery

- Define versioned manifest, capability, skill metadata, and status types in `packages/core`.
- Add schema validation and deterministic user/project discovery.
- Surface discovered descriptors and errors through Electron IPC and Settings.
- Do not launch third-party hosts in this phase.

### Phase 2: Unified Host Adapters

- Wrap the existing ACP, Copilot SDK, and gateway implementations behind a common adapter.
- Add lazy activation, handshake timeouts, health state, disposal, and normalized events.
- Migrate desktop session start/resume/abort/permission flows to `AgentManager`.
- Preserve current provider settings and session migration compatibility.

### Phase 3: Skill Registry and Progressive Loading

- Discover built-in, user, project, and per-agent skills.
- Parse metadata separately from full instructions.
- Implement trust, compatibility, activation, resource loading, and audit events.
- Add native/context/tools compatibility modes.

### Phase 4: Routing, Fallback, and UX

- Add compatibility-aware routing and explicit fallback policy.
- Add agent and skill management UI, rescan, health tests, and clear diagnostics.
- Pin agent/capability/skill snapshots to session records.
- Add configuration reload behavior without disrupting active sessions.

### Phase 5: Hardening and Extensibility

- Publish JSON schemas and an agent-host adapter contract.
- Add fixture hosts for ACP, SDK, HTTP, invalid, slow, and crashing cases.
- Validate packaging, upgrades, Windows/macOS path behavior, shutdown, and recovery.
- Document how a future host or skill can be added without core routing changes.

## 13. Verification Strategy

### Unit Tests

- Manifest and configuration schema validation
- Source precedence, duplicate detection, and deterministic ordering
- Canonical path containment and symlink-escape rejection
- Capability normalization and cache invalidation
- Skill metadata parsing, size limits, compatibility, and progressive loading
- Routing, pinning, fallback constraints, and unavailable-host errors
- Secret redaction and environment filtering

### Integration Tests

- Discover built-in and temporary user/project agent roots
- Negotiate ACP, Copilot, gateway, and mock HTTP host capabilities
- Start, resume, abort, and dispose sessions through `AgentManager`
- Activate a metadata-matched skill without eagerly loading unrelated resources
- Enforce read-only and project-only modes through every adapter
- Reload configuration while an existing session remains pinned
- Recover cleanly from timeout, malformed response, crash, and restart exhaustion

### Electron End-to-End Tests

- View discovered agents and skills in Settings
- Trust and enable a project host, then revoke it
- Select Claude, Copilot, or Codex and complete a fixture session
- Show an incompatible skill as unavailable with a useful explanation
- Verify no secrets or host internals cross renderer IPC
- Quit the app and confirm all fixture host processes terminate

Run at minimum:

```bash
npm run check-types
npm test
npm --workspace @praxis/desktop-main run test:e2e
```

## 14. Acceptance Criteria

1. A valid manifest added to an approved discovery root appears in the desktop app after rescan without a code change.
2. Invalid or untrusted manifests never launch and produce actionable diagnostics.
3. Claude/ACP, Codex/ACP, Copilot SDK, and gateway-backed sessions use the unified manager without losing existing session, permission, model-selection, or cancellation behavior.
4. Capabilities are negotiated through the host's native protocol and normalized consistently.
5. Skills are indexed from metadata, activated by relevance, and load resources only on demand.
6. Skill delivery adapts to host capabilities and cannot bypass session permissions.
7. New sessions use explicit/default routing; resumed sessions remain pinned; fallback is visible and policy-constrained.
8. Vercel AI Gateway remains limited to model routing, usage monitoring, and provider fallback.
9. Configuration merges predictably across application, user, project, and environment sources without leaking secrets.
10. Tests cover discovery, negotiation, lifecycle, skills, routing, trust, permissions, failure isolation, IPC, and shutdown.

## Final Workflow

1. The user launches Praxis.
2. The runtime merges configuration and scans approved agent roots.
3. It validates manifests and displays discovered hosts without eagerly launching on-demand processes.
4. It scans skill roots and indexes validated metadata.
5. The user starts a request with an explicit or default agent.
6. The loader starts or connects to that host and negotiates capabilities.
7. The manager filters eligible skills and progressively activates relevant ones.
8. The request is routed through the selected adapter with the existing tool and permission boundaries.
9. The session persists its agent, capability, model, skill, and fallback metadata.
10. The runtime monitors health and disposes hosts cleanly when no longer needed or when the app exits.
