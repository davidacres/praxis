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
