---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-392
title: "Qualify account-free relay for release"
status: backlog
story: FX-BE-079
updated: 2026-09-30
dependencies: [TASK-216, TASK-218, TASK-389, TASK-390, TASK-391]
---

# TASK-392: Qualify account-free relay for release

**Priority:** High
**Created:** 2026-09-30

## Goal

Close the remaining release-verification gaps for account-free remote access with repeatable automated coverage, a hosted TLS/reverse-proxy exercise, and a physical-phone journey across LAN and mobile data. Produce evidence that the QR relay route, Flutter fallback, desktop policy enforcement, encrypted relay traffic and route changes work together without accounts, inbound router ports or duplicate commands.

## Scope

- Add deterministic Flutter coverage for LAN-first connection, relay fallback after an unreachable or timed-out LAN attempt, non-fallback on terminal authentication/policy failures, relay close-code mapping, and reconnect without duplicate command application.
- Make the Flutter stage-host integration fixture reliable: correct the repository script path, prevent stale invitation files from enabling tests when the host is absent, and document the one-command test sequence.
- Exercise the running Electron app against a real local relay, verify that Internet relay mode registers the desktop, and prove the generated compact and JSON invitations carry the expected relay URL and 32-character channel while local-only invitations do not.
- Deploy the relay behind a representative TLS reverse proxy, verify `wss://` desktop and phone connections, record how the proxy supplies the client address, and prove per-address admission limits use the intended address rather than collapsing all clients onto the proxy address.
- Complete a physical-phone journey from a separate network: pair, read, start/continue work, approve, retry and cancel; switch between LAN and mobile data; revoke the device; and change the desktop from Internet relay to Local-only and Off.
- Capture test commands, versions, relay configuration, inspected screenshots/logs, and explicit limitations without committing credentials, private keys or payload contents.

## Acceptance criteria

- `npm test --workspace=@praxis/mobile-relay`, the core suite, the desktop mobile suite, `flutter analyze`, `flutter test`, and the focused Electron Mobile Access E2E suite pass from a clean dependency install.
- Automated Flutter tests fail when relay fallback is removed, when a terminal authentication failure incorrectly falls back, or when a route change applies a command twice.
- The stage-host tests skip cleanly when the host is absent and pass when started through the documented root script; no stale invitation file can create a false failure or false pass.
- A running Electron instance registers with a local relay in Internet relay mode, emits a pairing invitation containing the live relay route, and removes that route after switching to Local-only or Off.
- A hosted `wss://` relay behind the chosen proxy passes registration, pairing, traffic, reconnect, timeout, quota and per-address limiting checks; the evidence states the trusted-proxy/client-address configuration.
- A physical phone on mobile data completes the supported work journey without inbound router ports or VPN, then prefers LAN when available and returns to the relay when LAN is unavailable without duplicate work.
- Relay-side inspection finds no plaintext application payload or private key. Revocation, Local-only and Off close an established remote channel and prevent reconnection.
- Fresh screenshots show the Mobile Access state and QR presentation in the running desktop app; user-facing copy describes the implemented relay accurately.

## Dependencies

- TASK-216
- TASK-218
- TASK-389
- TASK-390
- TASK-391

## Verification

Use disposable settings, pairing identities and relay state. Run the repository builds before Electron E2E, including renderer copy. Keep the public-host exercise opt-in and record the exact endpoint and proxy configuration without secrets. Preserve useful screenshots under `.praxis/session-artifacts/`. Never point a Praxis write path at this repository's real plan files.

## Completion evidence

Not implemented. Record automated test counts, physical devices and network routes used, hosted relay/proxy configuration, inspected screenshots, mutation or regression proof, and any remaining production limitation before marking complete.

## Description


## Comments
