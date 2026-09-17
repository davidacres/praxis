---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.729Z
**Type:** Task
**Priority:** Medium
id: TASK-340
title: Enforce host scope, trust, capability, sandbox, and tool-mode preflight
status: Planned
story: FX-BE-124
updated: 2026-09-17
dependencies: [TASK-338, TASK-339]
validation: [npm run test:core, npm run test:desktop]
---

# Enforce host scope, trust, capability, sandbox, and tool-mode preflight

## Goal

Make the binding that passes readiness the same binding that is launched, with
fail-closed safety checks at the final execution boundary.

## Done when

- Profile, host, and skill scope are resolved explicitly; wrong-scope ids do
  not fall through to another catalog item.
- Trust, fingerprint, capability, working-directory, sandbox, and tool-mode
  requirements are checked immediately before launch.
- Read-only, project-only, and full modes produce the documented filesystem and
  mutation behavior for both interactive and stage sessions.

## Notes

Record blocking reasons and adapter capabilities, not secrets, in readiness
and audit diagnostics.

## Description


## Dependencies



## Comments
