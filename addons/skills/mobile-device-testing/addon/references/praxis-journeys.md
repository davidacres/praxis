# Praxis app journeys

Tested step sequences for the Praxis mobile app (Release build). Labels match
the app as of mobile host surface revision 3; if one is not found, read
`labels.sh` and adapt.

## Is it connected?

```sh
bash step.sh "launch;;wait:7"
bash labels.sh | grep -E "Connected to the desktop|RECONNECTING|OFFLINE|Waiting for confirmation|Access revoked|not paired"
```

- `Connected to the desktop` (the LIVE badge) — ready.
- A Connect screen with a titled card (e.g. `Access revoked`,
  `Invitation expired`, `Desktop unreachable`, `Waiting for confirmation`) —
  the card's message says what to do; relay it.

## Pair a device (needs the user)

1. Ask the user to create an invitation on the desktop (Settings → Mobile
   access → Create pairing invitation) and either scan the QR on the phone
   (`tap:Scan pairing QR` opens the camera; the user points it at the screen)
   or copy the invitation text to you.
2. With the text: `tapprefix:Pairing invitation;;type:<invitation>` then
   `tap:Pair and connect`.
3. The app shows `Waiting for confirmation` and the phone's name on the desktop
   (`Phone <prefix>`). Ask the user to confirm that device on the desktop and
   grant a project. The app continues by itself once confirmed.

## New chat with a chosen provider and model

```sh
bash step.sh "tap:Open navigation;;tap:New chat;;wait:1"
bash labels.sh | tail -8                     # provider and model chips show the current choice
bash step.sh "tap:<current provider label>;;wait:2"
bash labels.sh | grep -E "Local agent|API|no API key|turned off"   # available and unavailable providers, with reasons
bash step.sh "tapprefix:<Provider>, ;;wait:1;;tapprefix:Default;;wait:6"
bash labels.sh | tail -8                     # the model list the desktop reports
bash step.sh "tapprefix:<Model>, ;;tapprefix:Session message;;type:Reply with exactly: ok;;tap:Send message;;wait:30"
```

Pass: the reply appears as an `AI AGENT` message, the chips show the chosen
provider and model (they now come from the desktop's session record), and the
usage line shows desktop-reported figures.

## Change an existing session between turns

Open the session from the sidebar (`tap:Open navigation;;tapprefix:✓, <title>`).
When no turn is running the chips show a ▾ and are editable.

- Model: `tap:<model chip label>` → `tapprefix:<Model>, ` — applies immediately.
- Provider: `tap:<provider chip label>` → `tapprefix:<Provider>, ` → a
  confirmation appears (`Hand over to …?`) → `tap:Hand over`. This starts a
  turn on the new provider (spends tokens); ask first.
- Mode: `tapprefix:Session options` → `tap:Review` (or Chat/Analysis) →
  `tap:Close session options`.

Pass: notices such as `Model changed to …` / `Handed over to …` appear in the
transcript, the chips update, and no handover brief text is shown.

While a turn runs, tapping a chip shows why it is locked instead of opening a picker.

## Reconnect

- Background: `bash step.sh "home;;wait:40;;activate;;wait:1"` then check the
  badge, then send a short message to prove commands work.
- Desktop restart: restart Praxis desktop (ask first), then within ~10 s the
  badge returns to `Connected to the desktop` without user action.

## Settings pages

`tap:Open navigation;;tapprefix:◇, Permissions` and
`tapprefix:⌁, Desktop connection` show the real grant (device name, paired and
last-connected times, capabilities, projects) and connection details. Leave
with `tap:Back to navigation;;tap:Close navigation`.
