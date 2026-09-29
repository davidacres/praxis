---
**Status:** 📋 Proposed
**Type:** Feature
type: Feature
id: FX-BF-030
title: "Account-free remote access over a relay"
status: backlog
slug: identity-and-azure-relay
stories: [FX-BE-078, FX-BE-079, FX-BE-086]
updated: 2026-09-29
dependencies: [FX-BE-075]
---

# FX-BF-030: Account-free remote access over a relay

**Priority:** Low
**Created:** 2026-09-09

## Outcome

A phone paired by QR can reach its desktop from any network, with no account, no inbound router port and no VPN. Both sides connect outbound to a small relay that forwards ciphertext; identity is the paired device key.

## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-079](stories/fx-be-079-account-free-relay-and-remote-pairing/story.md) | Account-free relay and remote pairing |
| 2 | [FX-BE-086](stories/fx-be-086-deferred-internet-notifications/story.md) | Deferred internet notifications |
| Optional | [FX-BE-078](stories/fx-be-078-genericsystem-and-roleover-integration/story.md) | GenericSystem and Roleover integration (no longer a prerequisite for remote access) |

## Implementation boundaries

The desktop remains the execution authority; mobile owns presentation and transport clients. The existing Noise IK secure channel and length-prefixed framing are reused unchanged and run above the relay stream, so the relay is untrusted. Existing access modes are enforced by the host: local-only disables relay registration and closes live remote channels. Follow the mobile architecture and ownership map.

## Delivery priority

Deferred until the local release is complete. Nothing in FX-BE-079 needs GenericSystem, Roleover or Azure.

## Open decision

Who operates the public relay: the owner only, or a default instance shipped to other users with self-hosting as an option. TASK-216 records the hosting choice; a public multi-user instance adds uptime and abuse duties that the single-owner case does not.

## Close when

All child outcomes are implemented and verified. Dependencies are start prerequisites; feature/story containment is not a prerequisite on the parent.

## Dependencies

- FX-BE-075

## Verification

Use deterministic host/protocol fixtures and disposable project directories. Run focused contract and integration checks (`flutter analyze`, `flutter test`, the core host tests). For UI changes, build the affected app and inspect fresh captures. Prove regression guards fail on the broken behaviour. Real relay hosting is an explicit opt-in; record real-service evidence separately from mocks. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Description


## Comments
