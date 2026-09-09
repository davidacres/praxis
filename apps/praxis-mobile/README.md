# Praxis Mobile

Planning and development home for the Praxis mobile companion. This scaffold contains plans and documentation; no mobile runtime is implemented yet.

Continue and execute existing desktop work from a phone using the same agents, workflows, sessions and project context. Execution stays on a running desktop host.

## Layout

| Path | Ownership |
| --- | --- |
| main/ | Future native/platform shell, secure storage, discovery, QR, identity and lifecycle adapters; not Electron |
| renderer/ | Future React-based feature UI and client state, subject to the packaging feasibility decision |
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
