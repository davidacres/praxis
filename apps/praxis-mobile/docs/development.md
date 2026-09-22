# Mobile development and future extraction

## Current state (2026-09-22)

`@praxis/mobile` is an **Expo SDK 57 app that builds and runs** — verified with
`npx expo start --ios` in the iOS Simulator (bundles in under a second, no
errors) and screenshotted rendering Connect → Work list → Work detail
(Chat/Progress/Changes tabs) → Attention. It is driven by the tested
`renderer/` reducers (`mobileShellState`, `mobileNavigation`, `mobileFollowUp`,
`mobileAttention`), which still compile and test independently via
`npm run test:mobile` (`tsc -p tsconfig.test.json && node --test`), run in the
root `test` chain and `check-types`.

**What's real vs. deferred**, precisely:
- Real: Noise-authenticated TCP, protected device identity and last-host
  storage, UDP identity discovery, QR/paste pairing, explicit desktop
  confirmation and project/capability grants, live session snapshots,
  create/continue/cancel, workflow start/cancel/retry/approve, and exact
  permission allow/deny commands.
- Fixture only: `demoData.ts` and the loopback host remain deterministic test
  inputs; the production store no longer loads them on connect.
- Deferred: GenericSystem/Roleover identity, Azure relay and internet push.
  Physical-device release evidence is also still required before closing the
  local milestone.

## Resume here (2026-09-22)

Build a native development client (`expo run:ios` / `expo run:android`; Expo Go
does not contain the TCP/UDP native modules), then execute TASK-241's physical
device matrix. Retain iOS and Android evidence for pair/confirm, streamed turns,
workflow and permission actions, background/foreground, network loss, host
sleep, revocation and host-key rotation. Fix only failures observed in that
journey; cloud relay remains a separate deferred feature.

## Conventions inherited from desktop

Feature ownership stays in feature folders. Main owns native/platform adapters; renderer owns UI. Reuse token-based themes, icons, in-app dialogs and visible focus. Core's CommonJS Node dependencies cannot be imported as runtime values into the renderer. Contract/UI reuse requires a browser-safe versioned boundary. No desktop-source relative imports in mobile runtime code.

Plans use docs/plans/features/fx-bf-NNN-slug/feature.md, stories/fx-be-NNN-slug/story.md and tasks/task-NNN-slug.md. Every item has explicit type, unique id, H1, status, Dependencies, acceptance and verification. Keep frontmatter and prose dependencies aligned. Issues are mirrors outside the parsed plans tree. IDs 028–033 / 074–085 / 201–236 are allocated from the existing repository sequence, not reset for this project.

## Plan validation

Run the repository's read-only parsePlanFolder over the unchanged root plan tree and this mobile plan tree. Expect mobile: 6 features, 13 Story children and 36 Task children, with stable explicit IDs and no 9000+ fallback allocation. Compare root counts before/after, validate links and dependency graph, and ensure parent metadata resolves. Do not invoke FolderService against source plans because it can write template upgrades. Use temporary copies for any application journey.

## Implementation verification

Use scripted host/agent/identity/relay fixtures by default; paid agents and real Azure are explicit opt-ins. Run focused contract, desktop parity and mobile integration checks. UI changes need fresh inspected captures and accessibility checks. Physical iOS/Android journeys are required for platform-dependent discovery, pairing, backgrounding and internet milestones; screenshots alone do not prove these capabilities.

## Repository extraction

Move this folder intact when authorised: README, main, renderer, docs, board.praxis.json and project.praxis.md. Keep plan IDs stable and internal links relative. Consume published/pinned protocol and UI assets rather than root filesystem paths. Host/API/service implementation stays with its owner; record source repos and contract versions. Add independent mobile version/release/CI configuration during implementation. Prove a temporary standalone build in TASK-235; this plan does not perform the move.

## Local-first priority (2026-09-09)

GenericSystem and Roleover are not running. Deliver account-free LAN pairing, mobile continuation, workflow execution, decisions and a usable local release before cloud integration. No local completion gate requires these services or Azure. Keep internet features unavailable until the real integration is verified; use fixtures only for development. FX-BF-030 is deferred, including optional notifications moved to FX-BE-086. See the mobile master plan for the revised order.
