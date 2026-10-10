---
**Status:** ✅ Complete
**Created:** 2026-08-27T21:20:02.000Z
**Type:** Task
**Priority:** Medium
id: TASK-046
title: Add project-scoped Git navigation and onboarding states
status: Done
story: FX-BE-005
updated: 2026-10-10
dependencies: [TASK-044]
validation: ["npm run frontend:build"]
---

# TASK-046: Add project-scoped Git navigation and onboarding states

## Add project-scoped Git navigation and onboarding states

## Goal

Move Git access into the active project hierarchy and design clear empty states for folderless and non-repository projects.

## Done when

- Global Git Graph is removed or clearly presented as unavailable without project context.
- Project Git navigation is visible only when meaningful, with accessible labels and keyboard behavior.
- Folderless, non-repository, and valid-repository states have distinct copy and actions.
- The visual treatment matches Praxis project and Git Graph surfaces.

## Notes

Keep the user on the project context while choosing a folder or returning from setup.

## Description


## Dependencies



## Comments

**2026-10-10:** Closed during backlog review: the work is implemented in the shipped code (renderer, main and core) and the parent feature's 'As built' notes; the ticket's status had not been rolled up.
