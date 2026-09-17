---
**Status:** 📋 Proposed
**Created:** 2026-09-17T21:33:43.730Z
**Type:** Task
**Priority:** Medium
id: TASK-342
title: Compile skill activation and record native/tool/context outcomes
status: Planned
story: FX-BE-125
updated: 2026-09-17
dependencies: [TASK-340]
validation: [npm run test:core, npm run test:desktop]
---

# Compile skill activation and record native/tool/context outcomes

## Goal

Use the selected host's capabilities to activate skills truthfully for both
interactive sessions and workflow stages.

## Done when

- Skill selection resolves version, scope, trust, inputs, and required
  capabilities before launch.
- Native activation is recorded only after host confirmation; fallback modes
  are explicit and visible in session/run provenance.
- A stage receives the same selected skills as the originating binding unless
  the workflow node declares an intentional override.

## Notes

Never map “selected” to “native.” Preserve fallback behavior for hosts that
only support prompt context or tool-backed skills.

## Description


## Dependencies



## Comments
