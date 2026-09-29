---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-217
title: "Implement the account-free byte relay with per-host quotas"
status: backlog
story: FX-BE-079
updated: 2026-09-29
dependencies: [TASK-216]
---

# TASK-217: Implement the account-free byte relay with per-host quotas

**Priority:** Low
**Created:** 2026-09-09

## Goal

A relay that pairs two outbound WebSockets by opaque channel ID and forwards bytes it cannot read. Registration requires a signed challenge from a host key registered at pairing. Enforce per-host-key connection caps, handshake timeouts, message-size and rate limits, and idle expiry. No accounts, no payload logging, TLS only. Deployable as a single container or worker.

## Implementation entry points

The relay service chosen by TASK-216.

## Acceptance criteria

- A guessed channel ID, forged registration or unsigned connection gets no forwarding.
- Caps, timeouts, size and rate limits reject abusive fixtures; secrets and payloads are absent from logs and committed config.

## Dependencies

- TASK-216

## Verification

Use deterministic host/protocol fixtures and disposable project directories. Run focused contract and integration checks (`flutter analyze`, `flutter test`, the core host tests). For UI changes, build the affected app and inspect fresh captures. Prove regression guards fail on the broken behaviour. Real relay hosting is an explicit opt-in; record real-service evidence separately from mocks. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Description


## Comments
