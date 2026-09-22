# Praxis Mobile

React Native companion for controlling sessions and workflows that execute on a running Praxis desktop host. The phone renders live transcripts and sends scoped commands; provider credentials, tools, repositories, and agent processes remain on the desktop.

## Run the app

This app uses native TCP, UDP discovery, camera, and secure-storage modules, so it requires an iOS/Android development or release build rather than Expo Go.

1. In Praxis desktop, open Settings → Mobile access, choose Local network, and create a pairing code.
2. Start a native mobile build with `npm run ios --workspace=@praxis/mobile` or `npm run android --workspace=@praxis/mobile`.
3. Scan the desktop QR code or paste its invitation. The phone opens an authenticated Noise channel and appears in desktop Settings for explicit confirmation.
4. Grant one or more projects and the required view/execute/approval capabilities. Reconnect on the phone after confirmation.

The phone keeps its device key and last confirmed host configuration in OS-protected storage. LAN discovery carries identity hints only and never establishes trust.

Continue and execute existing desktop work from a phone using the same agents, workflows, sessions and project context. Execution stays on a running desktop host.

## Layout

| Path | Ownership |
| --- | --- |
| app/ | Native transport, secure storage, discovery, shared state, navigation, and themed primitives |
| screens/ | React Native connection, session, attention, and activity screens |
| main/ | Deterministic host fixture and end-to-end protocol journey; not Electron |
| renderer/ | Browser-safe reducers and contracts shared by tests and the native UI |
| docs/plans/features/ | Canonical Feature → stories → tasks implementation plans |
| docs/issues/features/ | Navigational issue mirrors, matching the desktop documentation convention |
| docs/PLAN_MAP.md | Complete ordered dependency index |
| docs/architecture.md | Scope, access modes, service boundaries and open decisions |
| docs/plans/master-plan.md | Milestones and execution order |
| board.praxis.json | Independent PRAXISMOBILE board identity and workflow |
| project.praxis.md | Portable project purpose |

The desktop's docs currently live at repository root. This project mirrors that docs/plans/issues layout inside its own folder so it can move intact to a separate repository. Main and renderer preserve the desktop's division of platform and UI responsibilities without introducing an Electron dependency.

## Start here

Read [master plan](docs/plans/master-plan.md), [architecture](docs/architecture.md), [plan map](docs/PLAN_MAP.md) and [development guidance](docs/development.md).

Open this folder as a separate folder-backed Praxis project (key PRAXISMOBILE); its docs/plans is the canonical board source. The root PRAXIS board remains unchanged. The root plan map links here; it does not duplicate these items. No machine-specific workspace paths are committed.

## Access contract

Desktop sign-in is optional. LAN mobile access uses account-free pairing. Internet access requires desktop and mobile sign-in, GenericSystem authentication, Roleover authorisation and the proposed Azure Relay path. No VPN or Tailscale dependency. Signing out closes remote access, not local work.

## Local-first priority (2026-09-09)

GenericSystem and Roleover are not running. Deliver account-free LAN pairing, mobile continuation, workflow execution, decisions and a usable local release before cloud integration. No local completion gate requires these services or Azure. Keep internet features unavailable until the real integration is verified; use fixtures only for development. FX-BF-030 is deferred, including optional notifications moved to FX-BE-086. See the mobile master plan for the revised order.


## Phase 1 boundary

Phase 1 is local-first. Platform-specific implementations are supplied through `renderer/mobilePlatformAdapters.ts`; desktop execution stays behind the host IPC bridge. GenericSystem, Roleover, Azure Relay, remote sign-in, and internet notifications are Phase 2 and are not required for local delivery.
