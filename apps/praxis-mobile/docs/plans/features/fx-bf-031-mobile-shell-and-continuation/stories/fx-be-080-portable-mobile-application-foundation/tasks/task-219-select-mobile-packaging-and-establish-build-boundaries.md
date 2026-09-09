---
type: Task
id: TASK-219
title: "Select mobile packaging and establish build boundaries"
status: complete
story: FX-BE-080
updated: 2026-09-09
dependencies: [FX-BE-074]
---

# TASK-219: Select mobile packaging and establish build boundaries

**Priority:** High
**Created:** 2026-09-09

## Goal

Evaluate a React DOM mobile shell with native platform integration for QR, local discovery, secure storage, system-browser sign-in and push. Record framework choice after iOS/Android feasibility proof. Keep main for native/platform ownership and renderer for feature UI; do not copy Electron main.

## Implementation entry points

apps/praxis-mobile/main and renderer; independently versioned protocol and UI assets. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- ADR records real platform constraints and distribution implications. Mobile consumes versioned contracts/assets without imports into desktop source or Node core; a separate-repository checkout design is documented.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- FX-BE-074

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Recorded the mobile packaging and build-boundary ADR in apps/praxis-mobile/docs/architecture.md.

- React DOM renderer with thin native adapters is selected for QR, discovery, secure storage, browser sign-in, and push.
- Mobile consumes versioned browser-safe contracts only; Electron/Node desktop modules are excluded.
- Monorepo placement is explicitly portable to a future standalone repository.
- Cloud identity and relay remain deferred and do not block local delivery.

Parent completion requires verified child outcomes.

## Local-first delivery gate

Complete this item with GenericSystem, Roleover and Azure unavailable. Implement and verify local behaviours now. Any cloud sign-in, Roleover, relay, remote revocation or cloud operational scenarios above describe later compatibility requirements and are verified in FX-BE-078/079, not prerequisites to close this item. Keep internet controls disabled with an explicit unavailable explanation until that integration ships. Protocol/identity fixtures may exercise future interfaces; no production mock-auth path is permitted. Local pairing, device scopes and request-specific approvals remain enforced.
