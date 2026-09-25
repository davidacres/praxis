# Praxis Flutter — status

_Last updated 2026-09-25._ A Flutter port of the Expo app in `apps/praxis-mobile`,
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
| Allow / deny an agent permission | ✓ / ✓ | — / ✓ |
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

Done in the repository already:

- `scripts/deploy-iphone.sh` (and `npm run mobile:deploy`) deploys the Flutter
  app by default; `--app expo` still deploys the old one.
- The device driver moved to `tools/device-driver` and drives the Flutter app
  by default; the `mobile-device-testing` skill's docs and its bundled copy are
  updated for Flutter.
- Root `AGENTS.md` lists the Flutter app; `npm run test:flutter` and
  `npm run mobile:stage-host` exist.

Still to do, in this order:

1. **Commit the per-message usage change** already in the working tree
   (`packages/core/src/host/mobileProtocol.ts`,
   `apps/praxis-desktop/main/src/main/mobileSessionProjection.ts`): the
   desktop sends each reply's tokens and cost, which the Flutter app shows.
   The uncommitted Expo edits in the same change can go with the archive.
2. **Decide where the PRAXISMOBILE plans live.** `apps/praxis-mobile/docs/plans`,
   `project.praxis.md` and `docs/PLAN_MAP.md` are a folder-backed project
   linked from `apps/praxis-desktop/docs/PLAN_MAP.md` and `master-plan.md`.
   Move them (e.g. to `apps/praxis-flutter/docs`) and fix those two links, or
   keep them in the archived folder.
3. **Remove the Expo workspace**: take `apps/praxis-mobile` out of the root
   `workspaces`, drop the `build:mobile`, `test:mobile` and `mobile:fixture`
   scripts and `test:mobile` from `test`, then `npm install` to regenerate the
   lockfile (keep the `//optionalDependencies` bindings note in mind).
4. **Move the folder**: `git mv apps/praxis-mobile archive/praxis-mobile`, or
   delete it — history keeps it either way.
5. **Publish the skill**: `tools/device-driver/publish-skill.sh` (bumps the
   version; the published copy still describes the Expo app).
6. Remove the Expo app from the phone when you no longer want it.

`packages/mobile-protocol` stays: the desktop uses it.

## How to run

```bash
npm run build:core && npm --prefix apps/praxis-desktop/main run compile   # once, for the stage desktop
npm run mobile:stage-host        # prints a pairing invitation (127.0.0.1 — reachable from the simulator)
npm run test:flutter
cd apps/praxis-flutter && flutter run -d <simulator>
npm run mobile:deploy            # physical iPhone, Release
```

The stage desktop's control port (`http://127.0.0.1:43191`) takes `/theme/light`,
`/theme/dark`, `/reply`, `/permission` and `/fail-next`.
