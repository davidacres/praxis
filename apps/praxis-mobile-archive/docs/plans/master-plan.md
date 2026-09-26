# Praxis Mobile Master Plan

**Status:** Planned
**Type:** Master Plan
**Priority:** High

## Delivery order

1. Host execution contracts and local access policy: FX-BE-074/075.
2. Account-free LAN pairing and connectivity: FX-BE-076/077.
3. Mobile shell and same-session continuation: FX-BE-080/081. Shell work can start after FX-BE-074 using fixtures.
4. Start work, run existing workflows, review changes and resolve approvals locally: FX-BE-082/083.
5. Local lifecycle, device testing and release: FX-BE-084/085.
6. Deferred: GenericSystem/Roleover integration and Azure internet access, FX-BE-078/079; optional cloud notifications FX-BE-086 follows local release and relay readiness.

## Local release acceptance

With GenericSystem, Roleover and Azure unavailable, pair a phone, start/continue work, use existing agents/workflows, approve exact requests, retry/cancel and inspect results. Lock/reopen the phone and return to desktop with the same session/run. Enforce local device trust and project/action scope. No accounts, VPN, production mock authentication or cloud deployment are needed.

## Deferred internet acceptance

The identity services are not running today. Their availability must not block mobile development or local release. Keep cloud controls disabled until real authentication, authorisation and relay integration pass FX-BE-078/079. Internet access still requires signed-in desktop/mobile and current permissions; desktop sign-out disconnects remote clients without stopping local work. TASK-218 owns the full internet journey; TASK-232 owns later optional push.

## Dependency semantics

See [Plan Map](../PLAN_MAP.md) for all 55 items: 6 features, 13 stories, 36 tasks. Canonical Dependencies sections define hard prerequisites; parents roll up their children. No local release item depends transitively on the deferred cloud items. TASK-232 keeps its ID but moves from local reliability to FX-BE-086. Priority order does not invent additional dependency edges.

## First implementation task

TASK-201: audit execution ownership and freeze protocol v1. Use deterministic protocol/host fixtures to develop mobile UI before real platform/service integration. All implementation remains planned or backlog; plans are not completion evidence.
