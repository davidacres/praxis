---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-241
title: "Prove live mobile-desktop journey"
status: planned
story: FX-BE-083
updated: 2026-09-22
dependencies: [TASK-237, TASK-238, TASK-239, TASK-240]
---

# TASK-241: Prove live mobile-desktop journey

**Priority:** High
**Created:** 2026-09-22

## Goal

Provide release-grade evidence that the shipped mobile application connects to a real Praxis desktop host and completes the local continuation, execution, and decision journeys without canned data or cloud dependencies.

## Implementation entry points

Mobile development/release build, desktop LAN host, disposable project fixtures, integration automation, and retained simulator/physical-device evidence.

## Acceptance criteria

- A fresh mobile installation pairs with a desktop, reconnects after interruption, lists real sessions, opens a transcript, and sends a follow-up whose response visibly streams on both clients while the turn runs on desktop.
- The same installation starts existing work, observes progress, resolves a request-specific approval, and cancels or retries a run where supported.
- A revoked device and a different host at the previous address are denied; no cached data crosses host identity boundaries.
- iOS and Android physical-device evidence covers foreground, background/return, host sleep, address change, and temporary network loss.
- GenericSystem, Roleover, Azure, VPN, public DNS, and demo fixtures are unavailable throughout the local proof.

## Dependencies

- TASK-237
- TASK-238
- TASK-239
- TASK-240

## Verification

- Run the complete focused protocol, desktop host, mobile, workflow, and permission suites from a clean build.
- Retain dated logs and screenshots/video for supported iOS and Android physical devices, plus exact host/app revisions and network setup.
- Demonstrate that the evidence guard fails when the mobile app is switched back to demo data or a pending host command.

## Done when

- The evidence package proves the production mobile binary communicates with the production desktop host for all local milestone journeys.
- Any unsupported platform or scenario is explicitly documented and keeps the owning story open.

## Notes

This supersedes helper-only evidence from TASK-224, TASK-227, and TASK-230 as the final integration gate; those completed tasks remain historical records.
