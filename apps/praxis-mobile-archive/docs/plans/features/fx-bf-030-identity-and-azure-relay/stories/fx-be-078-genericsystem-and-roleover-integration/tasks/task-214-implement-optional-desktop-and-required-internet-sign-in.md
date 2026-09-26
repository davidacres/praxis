---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-214
title: "Implement optional desktop and required internet sign-in"
status: backlog
story: FX-BE-078
updated: 2026-09-09
dependencies: [TASK-213]
---

# TASK-214: Implement optional desktop and required internet sign-in

**Priority:** Low
**Created:** 2026-09-09

## Goal

Use system-browser authentication and protected token storage where supported by the audited service. Prompt desktop sign-in only to enable internet access; mobile signs in for the remote host list. Separate cloud identity from local pairing grants.

## Implementation entry points

Existing GenericSystem/Roleover repositories after audit; proposed Praxis connection API and desktop/mobile identity adapters. Paths outside this mobile folder remain host/service-owned; consult the architecture ownership map before editing.

## Acceptance criteria

- Desktop startup and local-only access work signed out. Wrong issuer/audience, expired credentials and token-refresh failure fail remote access closed with a re-authentication path.
- Preserve the access-mode and product-scope decisions in the mobile architecture document.

## Dependencies

- TASK-213

## Verification

Use deterministic host/protocol/agent fixtures and disposable project directories. Run focused contract and integration checks; for UI changes build the affected app, inspect fresh captures across theme axes and phone sizes, and verify keyboard/screen-reader behaviour. Prove regression guards fail on the broken behaviour. Paid agents and real Azure infrastructure are explicit opt-ins. Never run a Praxis write path against this repository's plans.

## Completion evidence

Not implemented. Record source paths, commands, results, inspected captures and remaining limitations when completing this item. Parent completion requires verified child outcomes.

## Description


## Comments


