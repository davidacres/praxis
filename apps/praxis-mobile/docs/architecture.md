# Mobile companion architecture

Status: planned, 2026-09-09. Baseline: davidacres/praxis main at 592c59b9c83e02863680779ae7221ad4b8812530. Requirements below reflect agreed product decisions; proposed technologies still require their named feasibility gates.

## Product boundary

A mobile companion for continuing and executing work on an existing running Praxis desktop host. Reuse configured agents, workflows, project context and durable sessions/runs. Start from an existing work item or free-form task; read results, send follow-ups, make permitted decisions, retry and cancel. Work/Attention/Activity navigation; Chat/Progress/Changes within work. Preserve the Praxis theme system and composer context in a phone-specific layout.

Excluded: board/workflow/agent administration, workflow authoring, on-phone agents or repository execution, source editor, broad shell access, always-on executor service, automatic production deployment and any VPN/Tailscale prerequisite. Existing workflows may execute their configured actions under existing policy; mobile adds no generic deployment privilege.

## Access modes

| Desktop mode | Account requirement | Connectivity |
| --- | --- | --- |
| Off (default) | None | No mobile listener or relay |
| Local-only (default on first enable) | None; locally confirmed device pairing | Allowed local interfaces/subnets only; no cloud prerequisite |
| Local + internet relay | Desktop and remote mobile sign-in required for internet | Prefer authenticated LAN; allow Azure relay with current authorisation |

Desktop normal work never needs an account. A cloud login does not automatically enable remote access or replace local pairing. Signing out closes existing relay sessions, invalidates remote grants and prevents renewal; jobs continue locally and independently permitted LAN pairings survive. Account/token expiry closes remote access when its bounded lease expires; specify and test the maximum revocation window. Roleover/identity outage never permits unbounded stale remote grants. Local-only must work with internet blocked, including pairing.

Network restrictions are host-enforced on new and established connections. Bind approved interfaces; validate peer and destination scope, IPv4/IPv6 and network changes. Do not infer locality from RFC1918 addresses, discovery or forwarded headers alone. No VPN/tunnel route is a supported requirement. Local-only disables relay registration/traffic and cloud notification dependencies.

## Ownership and reuse

| Owner | Existing entry points / proposed boundary |
| --- | --- |
| Desktop host | apps/praxis-desktop/main/src/main/aiIpc.ts, workflowIpc.ts, workflowAgentStage.ts; extract application services and keep IPC as adapter |
| Core execution | packages/core/src/ai/aiSessionManager.ts; workflows/workflowOrchestrator.ts, workflowRun.ts, workflowRecovery.ts |
| Shared contracts | packages/core/src/host/ipcContracts.ts informs a narrow versioned browser-safe protocol; do not expose all IPC |
| Mobile platform/UI | main/ and renderer/ within this project; no runtime relative imports into desktop |
| GenericSystem | Authentication candidate; inspect actual repository, issuer/token/public-client capabilities before integration |
| Roleover | Host/project/action authorisation candidate; inspect actual resource/tenant model before integration |
| Praxis connection API | Proposed small ASP.NET Core service for host registry, paired-device association, authorised host list, grant issuance and minimal notification routing |
| Azure Relay | Proposed outbound-only Hybrid Connections transport; feasibility/cost gate before implementation commitment |

These service names describe intended reuse, not verified API contracts. Host registration is not a generic identity responsibility; keep it in the connection service. Connection API source/deployment ownership is decided during the audit; do not create a second authentication/RBAC implementation. Root host/core changes are tracked once by the mobile initiative and implemented in their owning directories.

## Protocol and execution authority

Use host/project/session/run/request IDs instead of bare issue keys for remote identity. Include protocol version, commandId, payload digest, expected state version, event sequence/cursor and authenticated caller. Validate an explicit operation allowlist and project scope. Persist command intent/outcome, reconcile uncertain side effects, reject ID reuse with different payloads and replay bounded events with snapshot fallback. Do not promise universal exactly-once external side effects; record unknown/interrupted state and reconcile rather than blindly retry.

Snapshot the chosen workflow definition; keep agent/provider/worktree facts on the host. The host arbitrates desktop and mobile through the same service/orchestrator. Device disconnection is not job cancellation. Agent continuation and workflow-stage retry are distinct and capability-gated. Offline drafts remain drafts; commands are never silently queued for future execution.

Current permissions resolve a FIFO request through a session key; replace this with request-specific IDs/version checks before exposing mobile approvals. Workflow approvals likewise identify the exact stage. Derive audit actor from verified identity; never accept arbitrary actor text as authority. View, execute, approve and administer-access are separate scoped rights. Workflow rules still apply; execute does not imply approve or gate bypass. Persistent allow and bypass are excluded from MVP.

## Pairing and internet route

Desktop generates a single-use expiring QR token and host identity; mobile registers a device key with explicit desktop confirmation. Discovery/address hints never establish trust. Keys use protected OS storage and a vetted authenticated exchange; host identity persists across IP changes. Support device revocation, host-key change, manual endpoint entry and discovery-disabled networks.

Internet mode: GenericSystem sign-in → Roleover-authorised host registry → short-lived per-host relay grant → authenticated paired-device channel. Desktop listener and mobile sender use outbound connections; no router port forwarding. Namespace management keys remain server-side. Application payloads need endpoint-to-endpoint authenticated encryption through the relay, not merely separate TLS legs. Use established cryptographic protocols/libraries; document replay/key rotation and identity binding. Relay still observes routing/timing/volume metadata. The API carries registration/authorisation, not transcripts or provider secrets.

## Availability and notifications

A running, awake desktop is required. Desktop sleep, quit or network outage is shown as host offline; host process interruption uses existing recovery and may require an explicit retry. This initiative does not implement an always-on daemon or wake-on-LAN. Phone lock/termination must not stop the host job.

Cloud push is later and opt-in; use opaque references and fetch current state after authentication. No execution/approval from notification payload alone. Local-only foreground reconnection remains useful without cloud push; document background notification limitations honestly.

## Decisions to resolve before shipping

- FX-BE-078: actual GenericSystem/Roleover capabilities and required changes, tenant model, revocation lease and public-client login support.
- FX-BE-079: Azure Relay compatibility, pricing model, limits, encrypted transport choice and real-device feasibility; provision environments only during implementation.
- FX-BE-080: mobile packaging choice, iOS/Android discovery/secure-storage/browser-login support and reusable asset boundary.
- FX-BE-085: supported OS releases, distribution/signing, operational ownership, budget and extraction readiness.

## Relationship to existing work

FX-BE-073 in the desktop roadmap evaluates a future shared executor. Reuse compatible trust/capability concepts, but it is not a hard dependency: this initiative controls an already-running desktop and does not depend on completing the deployment/debugging roadmap. Avoid duplicating the executor implementation or changing its backlog status.

Source reference: [Praxis baseline](https://github.com/davidacres/praxis/tree/592c59b9c83e02863680779ae7221ad4b8812530). Technical Azure assumptions must be rechecked during the spike against [Azure Relay documentation](https://learn.microsoft.com/en-us/azure/azure-relay/relay-what-is-it).

## Local-first priority (2026-09-09)

GenericSystem and Roleover are not running. Deliver account-free LAN pairing, mobile continuation, workflow execution, decisions and a usable local release before cloud integration. No local completion gate requires these services or Azure. Keep internet features unavailable until the real integration is verified; use fixtures only for development. FX-BF-030 is deferred, including optional notifications moved to FX-BE-086. See the mobile master plan for the revised order.


## ADR: mobile packaging and build boundary

Decision: use the Expo React Native application in `apps/praxis-mobile` with thin native platform adapters for TCP transport, QR scanning, local discovery, secure storage, browser sign-in, app lifecycle, and push notifications. Native connection/key ownership remains outside screen components; tested renderer helpers remain platform-neutral where useful. Mobile imports only versioned browser-safe contracts and never Electron or Node desktop modules. Expo Go may support UI prototyping, but any feature requiring native adapters is built and verified through iOS/Android development or release builds.

The current monorepo layout is an interim arrangement. The mobile folder is intentionally portable so it can move to its own repository without changing the protocol boundary. iOS/Android distribution and signing remain a later feasibility spike. Local LAN continuation and execution do not require GenericSystem, Roleover, Azure, or internet access.

## Host surface revisions 2–3 (2026-09-23)

Protocol v1 is unchanged on the wire; revision 2 adds operations and frames,
revision 3 adds `sessions.configure`.
A phone reads `host.info` first and treats a missing operation (an older
desktop) as *unsupported*, never as an error.

| Where | Addition |
| --- | --- |
| `packages/core/src/host/mobileProtocol.ts` | `MOBILE_HOST_SURFACE_REVISION = 2`; reads `host.info` (revision, operations, `latestSequence`, `hostEpoch`), `providers.list`, `models.list` (`params.provider`, `params.refresh`), `sessions.usage`, `access.get`; `MobileCreateSessionPayload` (`provider`, `model`, `mode`). All reads need only `view`. |
| `packages/mobile-protocol/src/wire.ts` | Frames inside the Noise channel, a `status` frame and its codes (`ready`, `pairing-required`, `pairing-pending`, `pairing-rejected`, `invitation-expired/invalid/used`, `device-revoked`, `host-key-reset`, `access-disabled/denied`, `host-shutdown`), a `pair` request carrying the invitation `tokenId`, reply error codes, and `MobileConnectionError` classification of failures the host cannot explain (unreachable, handshake rejected, connection lost, timed out). |
| `packages/mobile-protocol/src/client.ts` | `MobileSecureClient`: the one phone-side implementation of handshake, pairing, request correlation and failure reasons, over any byte socket. The iOS app and the desktop integration tests both use it. |
| `packages/mobile-protocol/src/sessionMirror.ts` | Merge-by-sequence for session snapshots and an event cursor. |

**Provider/model selection.** `providers.list` is built from the desktop's own
provider statuses (`listAiProviderStatuses`) and exposes only id, label, kind,
availability with a readable reason, and default model — never keys, key
source, base URLs or CLI paths. `models.list` reuses the desktop model catalog
(`listApiModelOptions` / `listCliModelOptions`). `sessions.create` re-validates
provider, model and mode on the desktop (`resolveMobileSessionLaunch`) and
rejects an unavailable provider, an unknown model or an unavailable mode with a
message a person can act on; an unknown provider is never silently replaced.
**Existing sessions (revision 3).** `sessions.configure` changes an existing
session between turns using the desktop's own functions (`updateSessionModel`,
`handoverSession`, `switchSessionMode` in `aiIpc.ts`, shared with the desktop
IPC channels): a model on the same provider switches in place; a different
provider is a handover — the desktop builds its handover brief and starts a
turn on the new provider, so the phone asks for confirmation first; a mode
switch applies to the next turn (Analysis and Review make the session's tools
read-only, Chat restores full tools). All are refused mid-turn with a reason.
The mobile projection shows handover and model changes as one-line notices and
never sends the handover brief (it contains workspace paths) to the phone.

**Session modes.** Chat uses the project's tool mode. Analysis and Review use
the desktop's shared read-only task contract (`sessionModeTask.ts`, also used
by `ai:delegate`) and always run with read-only tools; Analysis needs the
desktop's analysis prompt. `providers.list.sessionModes` reports which modes can
start in the project, with reasons. Tool access and working folder remain
desktop project settings and are not editable from the phone.

**Usage.** Running totals from the session record (`tokenUsage`,
`contextTokens`/`contextLimit`, `cost`) arrive with every streamed snapshot and
on demand via `sessions.usage`. Cost is shown only when the provider reports it
(`costStatus: 'not-reported'` otherwise); Praxis does not estimate it on the phone.

**Pairing.** An unknown key receives `pairing-required` and must present the
current invitation's `tokenId`; knowing the host key is not enough. The
desktop answers `pairing-pending` and holds the socket until someone confirms
(then `ready`) or denies (`pairing-rejected`). Tokens are single-use: confirming
one request voids others made with the same token (`invitation-used`), and a new
invitation voids the old one. Revocation, host-key reset, policy changes and
listener shutdown send their reason before closing. A wrong pinned key cannot
be told anything (no shared key exists), so the phone reports a handshake
rejection and asks for a new invitation.

**Replay and reconnect.** A newly authorised peer receives only events appended
after it connected. The phone pins `host.info.latestSequence`, re-reads
sessions (each snapshot stamped with that sequence), then replays after it;
snapshots merge by sequence, so replay never duplicates a message or rolls back
a streamed reply. The event log keeps the last 5000 events, and a replay from
before that window reports `truncated`. A changed `hostEpoch` (desktop restart)
resets the phone's cursor. The phone reconnects with backoff (1s → 30s) after
retryable losses, checks liveness when it returns to the foreground, and keeps
the session UI in a read-only *reconnecting* state meanwhile.
