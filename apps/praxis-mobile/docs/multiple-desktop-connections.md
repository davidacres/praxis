# Multiple desktop connections

FX-BF-108 owns this Flutter implementation. It currently supports one active
desktop, with multiple saved pairings. Concurrent observation and notifications
remain behind FX-BE-166 and FX-BE-086 respectively.

## Storage contract

`praxis.mobile.desktops.v1` is a secure-storage JSON document with `version: 1`,
an independently nullable `activeEntryId`, and `entries`. Each entry has a random
stable local `entryId`, `configuration` (host ID, pinned public key, reported
name, LAN/optional relay route and selected project), optional `nickname`,
`appearance`, `lastUsedAt`, and a map of unsent `drafts` keyed by conversation or
new-chat ID. The phone key and display size keep their existing global keys.

The host ID plus pinned key identifies a pairing. Names and addresses cannot
establish trust. Authentication of that same identity updates its routes and
reported name without losing its local nickname. A changed key needs a new
invitation and explicit confirmation; replacement gets a new local entry ID
and discards the old identity's appearance and drafts. Nicknames survive that
explicit replacement. Duplicate display names remain distinguishable by host
ID and endpoint in the picker.

`DesktopRepository` accepts an injectable `DesktopStorage` adapter and serializes
reads and mutations. It surfaces I/O failures, validates records independently,
and rejects unknown schema versions instead of overwriting them. A damaged
selected record leaves no selection; another desktop is never selected silently.
The picker reports recovered-record warnings and loading errors.

Legacy single-host configuration and appearance are migrated without generating
a phone identity or presenting an invitation. The new registry is written and
read back before legacy values are deleted. Interrupted cleanup resumes only
when the old identity is represented in the verified registry. Save failures
retain legacy values; unsupported/corrupt documents require recovery rather than
blind replacement. Back up the OS-protected data before attempting manual repair.

## Switching and drafts

Startup reconnects only the explicit saved selection. A failed selection offers
retry or the Desktops picker. Selecting another desktop closes the previous
transport, cancels polling/reconnect timers, clears host data/cursors/command
ledgers and invalidates biometric grace. Every transport operation is bound to
its captured connection, and registry writes check that connection before commit.
An old reply or approval prompt cannot issue a command against the new desktop.
No uncertain command is automatically resent after switching; host work continues.

The target cached theme is applied before connecting, with Praxis Dark as the
neutral fallback. Display size stays phone-global. Saved project selection is
checked against that desktop's permitted project list; a missing project opens
the picker with an explanation and permitted choices.

Composer text and new-chat provider/model/mode are saved under the local desktop
entry plus conversation/draft ID. Text is never a queued command. Drafts expire
after 30 days, are pruned when the registry is next written, and are removed with
their desktop. A successfully created chat removes its new-chat draft. Storage
failures appear in Diagnostics. The existing composer has no unsent attachment
upload control; attachment references/expiry and unavailable-file recovery still
need qualification before FX-BE-165 can close. Received attachment previews stay
bound to their owning connection, including multi-chunk reads.

Forgetting a desktop is a named, confirmed local removal. It removes only that
entry's preferences and drafts. It does not revoke the phone on the desktop;
revocation remains in Desktop Settings → Mobile access.

## Verification and remaining gates — 2026-10-05

- Flutter 3.47.5 / Dart 3.13.4: `flutter analyze --no-pub` clean.
- `flutter test --no-pub`: 96 passed, no skipped tests. Includes 11 registry
  tests, 8 adversarial store tests, 6 picker journeys/layout tests, and a two-host
  real encrypted-protocol integration test.
- Two stage hosts run the real desktop LAN listener and host services with
  distinct temp-backed keys and colliding session/project IDs. One phone key
  pairs with both; project conversation commands remain on their selected host.
  Stage hosts use `--host-id`, `--name`, `--state-dir`, `--port`, and `--control`.
  All integration-test host writes go to system temporary directories.
- `flutter build ios --release --no-codesign --no-pub` passed. This is an unsigned
  build, not a physical-device qualification claim.
- Simulator debug build passed. Flutter rejects simulator Release mode; simulator
  evidence must be described as debug evidence.
- `flutter build apk --release --no-pub` failed: deleted Android v1 embedding.
  The existing Android foundation is incomplete; no platform files were changed.
- Two actual desktop instances, signed physical iOS/Android QR/LAN/resume
  journeys, the complete native visual matrix, attachment draft handling, and
  additional reconnect/revocation/key-change qualification remain open in
  FX-BE-162–166. Stage evidence cannot close those gates.
- FX-BE-167–168 cannot begin until FX-BE-166 qualifies the first release.
  FX-BE-169 also depends on existing FX-BE-086 notification delivery. This change
  adds no relay/push infrastructure and publishes no external tracker issues.

Useful simulator screenshots and scenario captions are retained under
`.praxis/session-artifacts/`; see the handoff for the artifact links.
