# Agent notes: `apps/praxis-flutter`

A Flutter port of the Expo phone app (`apps/praxis-mobile`). **The Expo app is
the reference**: behaviour, wording and layout are ported from its source, not
reinvented. Current verified state is in [STATUS.md](STATUS.md).

## Layout

| Folder | What it is | Ported from |
| --- | --- | --- |
| `lib/protocol/` | Noise IK, framing, wire vocabulary, `MobileSecureClient` over `dart:io` | `packages/mobile-protocol/src` |
| `lib/core/` | Pure logic: models (extension types over the JSON), markdown parser, usage, runs, gadgets, attention, invitation, palette | `apps/praxis-mobile/renderer/*.ts` |
| `lib/app/` | Store (connection lifecycle, bootstrap, events, commands), keychain storage, theme, identity check, diagnostics, discovery | `app/store/*`, `app/*.ts` |
| `lib/ui/`, `lib/screens/` | Widgets and screens | `app/*.tsx`, `screens/*.tsx` |
| `tool/stage_host.cjs` | Development desktop: the desktop's real `MobileLanServer` + host services over rich sample data, auto-confirming pairing | — |

## Rules that are easy to break

- **Keep `test/core/logic_test.dart` in step with the Expo renderer tests.**
  When a `renderer/*.ts` module changes, port the change and its test cases.
- **Text goes through `ts()` (`lib/ui/kit.dart`).** It applies SF's tracking and
  CoreText's line height; a bare `TextStyle` renders ~5% wider than the Expo
  app. The root `DefaultTextStyle` is deliberately neutral — Material's type
  scale adds letter spacing and line height to every `Text`.
- **`issuedAt` must be `YYYY-MM-DDTHH:MM:SS.mmmZ`** (`isoNow()`); Dart's
  `toIso8601String` emits microseconds and the desktop rejects the command.
- **Tappable things use `Pressable`** with the same accessibility label as the
  Expo control, so `tools/device-driver` drives both apps.
- **Motif SVGs go through `flattenMotifSvg`** — flutter_svg rasterises
  `<pattern>` and ignores `<mask>`.

## Testing

`flutter analyze` must be clean and `flutter test` green. For UI changes, run
the stage host, pair the simulator app, and compare with the Expo app on the
same screen (see STATUS.md "How to run").
