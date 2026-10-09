# Praxis Flutter — status

_Last updated 2026-09-25._ A Flutter port of the Expo app (now removed),
built to replace it. Everything below was checked on the iPhone 15 Pro
simulator against `tool/stage_host.cjs` (the desktop's own LAN listener and
host services over sample data), with the same steps run in a fresh Release
build of the Expo app where the Expo app could be driven.

## Tests

`flutter test` — 53 pass:

- Noise IK/NK/XX byte-exact against the `snow` vectors `@praxis/mobile-protocol` uses.
- The Dart client pairing with the desktop's real `MobileLanServer`
  (`pairing-required` → `pairing-pending` → `ready`), reads, replay, and the
  handshake-rejected / unreachable failures.
- Ports of the Expo renderer tests (markdown, usage, theme and motif, workflow
  runs, gadgets, pairing invitation, session options).
- The error card replacing a widget that fails to build.

## Screens — compared with the Expo app, same data

| Screen | Result |
| --- | --- |
| Sidebar, markdown chat, streaming chat, meta chips, usage panel | match (label widths measured pixel-equal) |
| Run awaiting approval, details strip, stage bar, steps sheet | match |
| Attention, Activity | match |
| Settings: Desktop connection, Permissions, App settings | pixel-equal |
| Provider picker, model picker, session options, new-chat draft | match |
| Handover result, Progress view | match |

Flutter only (checked against the Expo source, not an Expo screenshot): all 11
gadget kinds, Changes view with diff, dark theme, Reconnecting state, Large
display size, connect/pairing screens.

## Actions — each confirmed by the desktop's state afterwards

| Action | Flutter | Expo |
| --- | --- | --- |
| Pair with an invitation | ✓ | ✓ |
| Send first message (creates a session, reply streams) | ✓ | — |
| Answer a choice / confirmation / form / conflict / approval question | ✓ (Face ID where the answer changes something) | ✗ **app crashes** (fatal JS error, 3 crash reports) |
| Approve a run (Face ID) | ✓ | — |
| Reject a run with a reason (Face ID) | ✓ | ✗ reason field sits under the keyboard; cannot be submitted |
| Allow / deny an agent permission | ✓ / ✓ — in the chat that is waiting, with a banner on every other screen | — / ✓ (Attention screen only) |
| Retry a failed stage | ✓ | — |
| Start a workflow | ✓ | ✓ |
| Hand over to another provider | ✓ | ✓ |
| Change model; change mode | ✓; ✓ | ✓; ✓ |
| Stop a streaming turn | ✓ | ✓ |
| Retry a message the desktop refused | ✓ | ✗ desktop replays the refusal's empty result |
| Live theme switch; reconnect after the desktop drops | ✓; ✓ | — |
| Network discovery | ✓ (found the real desktop) | — |

— = not run in that app.

## Not yet verified

- QR scanning with the phone camera. Two bugs are fixed but untested on a camera:
  the scanner made a new camera controller on every rebuild, so the preview sat
  in the top-left corner and never settled; and the desktop's QR code could not
  be read at all. It was a fixed version-4 code with no alignment pattern and
  wrong format bits, and it cut the ~160-byte invitation off at 77 bytes. The
  desktop code (`renderer/src/ui/qrCodeSvg.tsx`) is now a standard byte-mode,
  ECC-M encoder. A capture from the running desktop decodes to the full
  invitation with Core Image's QR detector.
- Pairing with the real desktop app — only the stage desktop has been used.
- Android — not built.

## Known differences from the Expo app

- Tabular figures are not applied to the iOS system font, so numeric meta
  chips are a few points narrower; italic spacing differs slightly.
- Sidebar rows' accessibility labels are their own text; Expo's start with the
  icon glyph (`✓, Title, caption, ›`).
- Retrying a refused message sends a new command id (Expo resends the same one,
  which the desktop answers with the refusal's empty result).

## Archiving the Expo app

The Expo app has been archived and is being removed. The Flutter app in
`apps/praxis-mobile` is the only phone app in use.

Done:

- `npm run test:flutter` and `npm run mobile:stage-host` run the Flutter app.
- The device driver and the `mobile-device-testing` skill's docs use the Flutter
  app by default.
- Root `AGENTS.md` lists the Flutter app.

Not right yet:

- `scripts/deploy-iphone.sh --app expo` still points at `apps/praxis-mobile`, so
  it deploys the Flutter app. The `expo` option should be removed.
- The root `workspaces` still lists `apps/praxis-mobile`. That folder has no
  `package.json`, so it is not an npm workspace. The lockfile lists it too.

Still to do, in this order:

1. **Commit the per-message usage change** already in the working tree
   (`packages/core/src/host/mobileProtocol.ts`,
   `apps/praxis-desktop/main/src/main/mobileSessionProjection.ts`): the
   desktop sends each reply's tokens and cost, which the Flutter app shows.
2. **Decide where the PRAXISMOBILE plans live.** `apps/praxis-mobile/docs/plans`,
   `project.praxis.md` and `docs/PLAN_MAP.md` are a folder-backed project
   linked from `apps/praxis-desktop/docs/PLAN_MAP.md` and `master-plan.md`.
   Move them (e.g. to `apps/praxis-mobile/docs`) and fix those two links, or
   keep them in the archived folder.
3. **Remove the Expo workspace from the root build.** Take `apps/praxis-mobile`
   out of the root `workspaces`, drop the `build:mobile`, `test:mobile` and
   `mobile:fixture` scripts and the `test:mobile` step in `test`, then run
   `npm install` to regenerate the lockfile. Keep the `//optionalDependencies`
   bindings note in mind.
4. **Remove the `--app expo` option** from `scripts/deploy-iphone.sh` (see above).
5. **Delete the archived Expo app folder.** History keeps it.
6. **Publish the skill**: `tools/device-driver/publish-skill.sh` (bumps the
   version; the published copy still describes the Expo app).
7. Remove the Expo app from the phone when you no longer want it.

## How to run

```bash
npm run build:core && npm --prefix apps/praxis-desktop/main run compile   # once, for the stage desktop
npm run mobile:stage-host        # prints a pairing invitation (127.0.0.1 — reachable from the simulator)
npm run test:flutter
cd apps/praxis-mobile && flutter run -d <simulator>
npm run mobile:deploy            # physical iPhone, Release
```

The stage desktop's control port (`http://127.0.0.1:43191`) takes `/theme/light`,
`/theme/dark`, `/reply`, `/permission` and `/fail-next`.


## FX-BF-108 — first-release implementation, 2026-10-05

The workspace now retains multiple named, independently pinned desktops with
one active connection. Desktops is available from navigation and connection
failures. Pairing is additive, changed keys require explicit replacement,
forgetting is local and scoped, and project/theme/composer state belongs to its
saved desktop. Late replies and biometric prompts cannot cross a switch.

`flutter analyze --no-pub` is clean and `flutter test --no-pub` passes **96 tests**
(no skips), including migration failures, colliding IDs, stale replies, approval
isolation, picker journeys and two real encrypted-protocol stage hosts using
one phone identity. The existing stage fixture was run from temporary copied
state; all new integration-test hosts use system temporary directories.

Unsigned iOS Release and iOS simulator debug builds compile. Android Release
fails before compilation with **deleted Android v1 embedding** in the existing
incomplete Android foundation. No Android/native project files were changed.

Simulator evidence uses iPhone 15 Pro / iOS 17.2 and temporary stage desktops;
it is not physical-device or two actual desktop application evidence. Required
physical iOS/Android QR/LAN/resume and release qualification remains open, as do
attachment-draft handling and the complete visual/interruption matrix. See
[implementation contract and evidence](docs/multiple-desktop-connections.md).
FX-BF-108 remains Backlog; FX-BE-167–169 stay behind their delivery gates.
