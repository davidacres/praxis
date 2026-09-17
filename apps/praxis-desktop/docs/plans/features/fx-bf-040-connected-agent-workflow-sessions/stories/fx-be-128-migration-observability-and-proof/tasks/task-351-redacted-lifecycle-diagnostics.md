---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.733Z
**Type:** Task
**Priority:** Medium
id: TASK-351
title: Add redacted lifecycle diagnostics, audit events, and support docs
status: Planned
story: FX-BE-128
updated: 2026-09-17
dependencies: [TASK-339, TASK-347, TASK-349]
validation: [npm run test:core, npm run test:desktop]
---

# Add redacted lifecycle diagnostics, audit events, and support docs

## Goal

Make failures diagnosable by boundary without leaking tokens, prompts, local
secrets, or private provider data.

## Done when

- Selection, binding, host launch, skill activation, stage, artifact, gate,
  approval, and recovery events have stable redacted identities.
- Session and run inspectors show a concise user digest with a path to detailed
  diagnostics for operators.
- Documentation states supported adapters, trust requirements, fallback modes,
  and known unsupported/scaffold hosts.

## Notes

Keep raw historical events for audit, but filter transport/diagnostic markup
from normal chat presentation.

## Description


## Dependencies



## Comments
