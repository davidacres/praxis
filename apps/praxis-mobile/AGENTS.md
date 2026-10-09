# Agent notes: `apps/praxis-mobile`

This is the Praxis phone app, built in Flutter. It is the only phone app in the
repo. It mirrors the desktop's mobile protocol (`packages/mobile-protocol/src`).
Current verified state is in [STATUS.md](STATUS.md).

## Layout

| Folder | What it is |
| --- | --- |
| `lib/protocol/` | Noise IK, framing, wire vocabulary, `MobileSecureClient` over `dart:io` |
| `lib/core/` | Pure logic: models (extension types over the JSON), markdown parser, usage, runs, gadgets, attention, invitation, palette |
| `lib/app/` | Store (connection lifecycle, bootstrap, events, commands), keychain storage, theme, identity check, diagnostics, discovery |
| `lib/ui/`, `lib/screens/` | Widgets and screens |
| `tool/stage_host.cjs` | Development desktop: the desktop's real `MobileLanServer` + host services over rich sample data, auto-confirming pairing |

## Rules that are easy to break

- **Keep `test/core/logic_test.dart` in step with `lib/core/`.** Every pure
  logic change gets its test case there.
- **Text goes through `ts()` (`lib/ui/kit.dart`).** It applies SF's tracking and
  CoreText's line height; a bare `TextStyle` renders wider than the iOS system
  metrics `ts()` reproduces. The root `DefaultTextStyle` is deliberately neutral
  — Material's type scale adds letter spacing and line height to every `Text`.
- **`issuedAt` must be `YYYY-MM-DDTHH:MM:SS.mmmZ`** (`isoNow()`); Dart's
  `toIso8601String` emits microseconds and the desktop rejects the command.
- **Tappable things use `Pressable`** with a stable accessibility label, since
  `tools/device-driver` finds controls by label.
- **Motif SVGs go through `flattenMotifSvg`** — flutter_svg rasterises
  `<pattern>` and ignores `<mask>`.

## Testing

`flutter analyze` must be clean and `flutter test` green. For UI changes, run
the stage host, pair the simulator app, and check the same screen on the
desktop (see STATUS.md "How to run").
