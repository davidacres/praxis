---
id: TASK-048
title: Add packaged Electron, accessibility, and responsive verification
status: complete
story: FX-BE-005
updated: 2026-08-27
dependencies: [TASK-046, TASK-047]
validation: ["npm run frontend:build", "npm run electron:check-types", "npm run electron:copy-renderer", "npm run test:e2e --workspace @ticket-manager/electron-app -- e2e/gitGraph.spec.ts"]
---

## Add packaged Electron, accessibility, and responsive verification

## Goal

Prove the complete project-to-repository-to-graph flow in the copied Electron renderer.

## Done when

- E2E covers folderless, non-repository, initialize-confirmation, valid repository, worktree, and recovery flows.
- Narrow and wide layouts remain usable and actions have accessible names/focus states.
- Raw Git errors do not appear in the primary UI.
- Build, typecheck, copied-renderer, focused tests, and `git diff --check` pass.

## Notes

Capture screenshots for the onboarding states and retain them only when they represent the intended product contract.
