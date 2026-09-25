# Praxis Flutter — status

_Last updated 2026-09-25._ A Flutter port of the Expo app in `apps/praxis-mobile`,
built to reach feature and visual parity with it. This file says what has been
verified and what has not; nothing below is claimed without a test or a
simulator screenshot behind it.

## Verified

**Protocol** — a Dart port of `@praxis/mobile-protocol` (Noise
`IK_25519_ChaChaPoly_SHA256`, length-prefixed records, status frames, pairing,
request correlation, failure classification).

- `test/protocol/noise_test.dart`: byte-exact against the same `snow` vectors
  the TypeScript suite uses (IK, NK, XX), plus live channel, wrong-key and
  record-reassembly cases.
- `test/protocol/stage_host_test.dart`: the Dart client pairs with the
  desktop's **real** `MobileLanServer` (`pairing-required` → `pairing-pending`
  → `ready`), reads, replays; a wrong pinned key reports `handshake-rejected`,
  a dead port `unreachable`.

**Logic** — `test/core/logic_test.dart` ports the Expo renderer tests
(markdown, usage, theme/motif, workflow runs, gadgets, pairing invitation,
session options): 43 cases pass.

**On the iPhone 15 Pro simulator, paired with `tool/stage_host.cjs`**, the
Flutter app was driven with the repo's device driver and compared screenshot
by screenshot with a fresh Release build of the Expo app on the same data:

| Screen | Result |
| --- | --- |
| Connect landing (Praxis Dark) | renders; pairing by pasted invitation works end to end |
| Sidebar (runs, sessions, badges, settings) | matches Expo — label widths measured pixel-equal |
| Chat with full markdown reply | matches |
| Streaming session, meta chips, usage panel | matches |
| Gadgets (choice, confirmation, form, table, chart, progress, diff, artifact, handoff, conflict, approval) | all render; the choice answer reached the desktop (gadget completed, session continued) |
| Run awaiting approval, details strip, stage bar | matches |
| Workflow steps sheet | matches |
| Attention (permission, approval, failure) | matches |
| Activity | matches (≈1pt/card vertical drift) |
| Settings: Desktop connection, Permissions, App settings | pixel-equal |
| Provider picker, model picker, session options sheet | match |
| New chat → first message creates a desktop session and streams the reply | works |
| Desktop theme + hexagon motif (masked corner lattice) | matches |
| Approve a run from Attention (Face ID prompt, enrolled simulator match) | run moved to succeeded on the desktop |
| Allow an agent permission; retry a failed stage | both applied on the desktop; Attention emptied live |
| Changes view: file list and inline diff | works |
| Live theme switch (desktop → Praxis Dark) | phone follows immediately |
| Desktop stops → RECONNECTING, composer blocked with reason; desktop back → LIVE | works |
| Display size Large | scales text and controls |

Text metrics were calibrated against CoreText: Flutter omits SF's size-specific
tracking and inherits Material's type scale; `ts()` in `lib/ui/kit.dart` applies
the measured tracking table and CoreText's line height, so text lines up with
the Expo app to the pixel.

## Not yet verified

- Reject a run with a reason, answering a mutating gadget.
- Start a workflow, handover to another provider, cancel a streaming turn.
- Progress view.
- QR scanning (needs a camera — the simulator has none), LAN discovery.
- Pairing with the real desktop app (only the stage host, which runs the
  desktop's own `MobileLanServer` and host services, has been used).
- Android — not built.

## Known differences from the Expo app

- Tabular figures (`fontVariant: ['tabular-nums']`) are not applied by Flutter
  to the iOS system font, so numeric meta chips are a few points narrower.
- Italic is synthesised by Flutter; spacing around italic runs differs slightly.
- Accessibility labels on sidebar rows are the row's own text; Expo's are the
  auto-joined children including the icon glyph (`✓, Title, caption, ›`).

## How to run

```bash
# once: compiled desktop modules the stage host reuses
npm run build:core && npm --prefix apps/praxis-desktop/main run compile

node apps/praxis-flutter/tool/stage_host.cjs     # prints a pairing invitation
cd apps/praxis-flutter
flutter test                                     # protocol + logic (+ live stage-host test)
flutter run -d <simulator>                       # paste the invitation under "Add connection"
```
