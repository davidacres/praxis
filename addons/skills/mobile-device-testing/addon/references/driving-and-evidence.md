# Driving the app and reading the results

## How the driver works

`step.sh` runs one XCUITest (`xcodebuild test-without-building`) that attaches
to the installed app by bundle id (`PRAXIS_APP_BUNDLE_ID`, default
`com.acresweb.praxis.mobile.praxis`, the Flutter app), performs the actions, then writes:

| File (in `.run/`) | Contents |
| --- | --- |
| `tree.txt` | Full accessibility tree: element type, frame `{{x, y}, {w, h}}` in points, label |
| `screen.png` | Screenshot after the actions (view it to check layout) |
| `run.log` | Full xcodebuild output, including `DRIVER …` lines |

`bash labels.sh [max-label-length]` prints the de-duplicated element types and
labels — usually enough to choose the next target.

## Actions

Separate with `;;`. Each step costs 10–20 s of overhead, so combine actions.

| Action | Effect |
| --- | --- |
| `launch` | Relaunch the app fresh (first action only). Otherwise the running app is brought forward |
| `tap:<label>` | Tap the element whose label or identifier equals `<label>` exactly |
| `tapprefix:<text>` | Tap the first element whose label starts with `<text>` |
| `type:<text>` | Type into the focused field — tap the field first |
| `wait:<seconds>` | Pause (streamed replies: 20–40 s) |
| `home` / `activate` | Send the app to the background / bring it back |
| `swipeup` / `swipedown` | Scroll |
| `tapxy:<x>,<y>` | Tap a point (points from top-left) — last resort |

The second argument to `step.sh` is how long to settle before the snapshot
(default 1.5 s).

## Matching labels

Labels come from `accessibilityLabel`s. Composite controls join their parts:

- A multiline text field's label includes its placeholder
  (`Session message Describe what the agent should do…`) → `tapprefix:Session message`.
- A picker row includes its caption
  (`Haiku, haiku · 200k context`) → `tapprefix:Haiku, haiku`.
- A sidebar session row starts with its status glyph
  (`✓, <title>, …` finished, `●, <title>, …` live) → `tapprefix:✓, <title>`.

`DRIVER NOT FOUND <label>` means nothing matched within 8 s; the step carries
on. Read `labels.sh` to see what was actually there.

## Pitfalls seen in practice

- **The keyboard covers controls.** After typing, the keyboard occupies roughly
  the bottom 350 pt. A tap on an element under it lands on the keyboard or its
  predictions bar (it may insert a word). Compare the target's frame with the
  `Typing Predictions` element's y before tapping; if hidden, that is an app bug
  worth reporting.
- **Text typed into the wrong place** usually means the previous tap missed:
  check `DRIVER tapped` lines in the step output.
- **Stale screens.** After a desktop or network change, wait a few seconds and
  re-read before concluding anything.
- **Long transcripts** put hundreds of labels in the tree; filter `labels.sh`
  output with `grep` or `tail`.

## Evidence to report

For each journey: the build (commit or build time), the device (name, iOS
version, simulator or physical), each step and what it showed (quote the key
labels), a screenshot you looked at for layout claims, and the outcome. Keep
claims to what the tree and screenshot show; the driver cannot see the desktop.
