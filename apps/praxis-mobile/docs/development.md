# Mobile development and future extraction

## Current state (2026-09-12)

`@praxis/mobile` is an **Expo SDK 57 app that builds and runs** — verified with
`npx expo start --ios` in the iOS Simulator (bundles in under a second, no
errors) and screenshotted rendering Connect → Work list → Work detail
(Chat/Progress/Changes tabs) → Attention. It is driven by the tested
`renderer/` reducers (`mobileShellState`, `mobileNavigation`, `mobileFollowUp`,
`mobileAttention`), which still compile and test independently via
`npm run test:mobile` (`tsc -p tsconfig.test.json && node --test`), run in the
root `test` chain and `check-types`.

**What's real vs. demo**, precisely:
- Real: the app itself (Expo config, navigation shell, screens), the pure
  reducers, `@praxis/mobile-protocol`'s Noise `IK` channel, the desktop's real
  LAN listener (`mobileLanServer.ts`) and host composition.
- Demo only: the app's data. `app/demoData.ts` fills the store with canned
  projects/work/attention shaped like the host's real `MobileHostReads`; the
  app does not yet open a socket. `App.tsx`'s `connect()` in `app/store.tsx` is
  the seam — replacing its body with a real `SecureChannel` connection is the
  next task, not a redesign.
- Not started: native platform adapters (camera, keychain, discovery) and
  Azure deployment.

## Resume here (2026-09-12)

In order, each independently shippable:

1. **Wire the app to a real host.** `app/store.tsx`'s `connect()` currently
   fakes a delay and loads `demoData`. Replace it with `SecureChannel.initiator`
   (`@praxis/mobile-protocol`) over a socket to the desktop's `mobileLanServer.ts`
   (`apps/praxis-desktop/main/src/main/mobileLanServer.ts`), reusing the framing
   `mobileLoopbackServer.ts` (`apps/praxis-mobile/main/`) already proves against
   the real host contracts. Needs a real socket, which Expo Go cannot provide —
   see next.
2. **A dev client.** `expo start` alone only runs in Expo Go, which has no
   third-party native modules. Add `react-native-tcp-socket`
   (`npx expo install`) and build a dev client (`npx expo run:ios`) once, then
   `expo start --dev-client` for iteration. This is the same simulator, no
   device required.
3. **mDNS discovery** (FX-BE-077's remaining half) — advertise the desktop's
   host/port from `mobileLanServer.ts`, browse from the app
   (`renderer/mobileHostDiscovery.ts` already has the pure resolution logic;
   it needs a real `MobileDiscovery` adapter).
4. **QR pairing + keychain** (FX-BE-076) — `expo-camera` for
   `MobileQrScanner`, `expo-secure-store` for `MobileSecureStore`
   (`renderer/mobilePlatformAdapters.ts` names both interfaces already); the
   desktop side of the handshake (`consumeMobilePairing`,
   `InMemoryMobilePairingStore`) is implemented and tested in
   `@praxis/core`'s `host/mobilePairingHandshake.ts`.
5. **FX-BE-081 permission rework**, then un-defer `sessions.continue` /
   `permissions.respond` in `apps/praxis-desktop/main/src/main/mobileHostComposition.ts`
   (currently explicit `MobileHostPendingError`).

None of the above needs a redesign — every seam it plugs into already exists
and is named above.

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
