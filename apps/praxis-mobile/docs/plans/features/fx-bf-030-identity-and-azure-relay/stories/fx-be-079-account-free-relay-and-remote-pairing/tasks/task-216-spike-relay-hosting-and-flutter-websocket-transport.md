---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-216
title: "Spike relay hosting and Flutter WebSocket transport"
status: backlog
story: FX-BE-079
updated: 2026-09-29
dependencies: [FX-BE-076, FX-BE-077]
---

# TASK-216: Spike relay hosting and Flutter WebSocket transport

**Priority:** Low
**Created:** 2026-09-09

## Goal

Prove that a desktop and a phone, both connecting outbound, can pair through a byte-forwarding WebSocket relay and carry the existing Noise IK framing. Compare a small VPS/container with a serverless edge option (for example Cloudflare Workers with Durable Objects) on connection limits, idle cost, backpressure, latency and reconnect. Record a go/no-go ADR that also answers the open question in FX-BF-030 about who operates the public relay.

## Implementation entry points

A throwaway relay prototype, the Node listener side under `packages/core/src/host`, and `apps/praxis-mobile/lib/protocol`.

## Acceptance criteria

- One desktop and one physical phone on separate networks exchange encrypted fixture records through the prototype with no inbound router ports or VPN.
- The ADR records measured limits, estimated idle and active cost, the chosen hosting, and whether Flutter's WebSocket client meets the reconnect and backpressure needs.

## Dependencies

- FX-BE-076
- FX-BE-077

## Verification

Use deterministic host/protocol fixtures and disposable project directories. Run focused contract and integration checks (`flutter analyze`, `flutter test`, the core host tests). For UI changes, build the affected app and inspect fresh captures. Prove regression guards fail on the broken behaviour. Real relay hosting is an explicit opt-in; record real-service evidence separately from mocks. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Description


## Comments
