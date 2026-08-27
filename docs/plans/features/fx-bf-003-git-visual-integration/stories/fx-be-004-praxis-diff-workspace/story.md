---
id: FX-BE-004
title: Praxis diff workspace and safe Git workflows
status: complete
feature: FX-BF-003
issue: docs/issues/features/fx-bf-003-git-visual-integration/stories/fx-be-004-praxis-diff-workspace/issue.md
updated: 2026-08-27
tasks: [TASK-038, TASK-039, TASK-040, TASK-041, TASK-042, TASK-043]
dependencies: [FX-BE-003]
validation:
  - npm run test --workspace @ticket-manager/core
  - npm run test:git --workspace @ticket-manager/electron-app
  - npm run check-types --workspace @ticket-manager/electron-app
  - npm run build --workspace @ticket-manager/frontend
  - npm run copy-renderer --workspace @ticket-manager/electron-app
  - npm run test:e2e --workspace @ticket-manager/electron-app -- e2e/gitGraph.spec.ts
  - git diff --check
---

## Praxis Diff Workspace And Safe Git Workflows

Parent feature folder: `fx-bf-003-git-visual-integration`

## User or operational impact

Make reviewing Git changes in the Praxis desktop app clean, easy, and clear. A user can move from the graph or working tree into a readable file comparison, understand exactly what changed, and take a safe next action without interpreting raw patch output.

## Scope

- Structured working, staged, commit, commit-range, branch, and ref comparisons.
- Full-width Inline, Split, and Hunk views with line numbers, syntax color, word-level emphasis, wrap, whitespace filtering, file navigation, and change navigation.
- Whole-file, hunk, and selected-line staging/unstaging; explicit discard confirmation; untracked and binary-file states.
- WIP graph entry, stash/pop, branch compare, rename, merge, rebase, pinning, smart visibility, commit context actions, history, and blame.
- Three-pane merge/rebase/cherry-pick/revert conflict resolution with current, incoming, editable output, line selection, safe resolution, and operation abort.

## Acceptance criteria

- No raw or truncated patch is used as the primary user experience.
- Clicking a file from WIP or commit details opens the same consistent diff workspace and preserves the graph context on return.
- Split, Inline, and Hunk modes remain readable at wide and narrow desktop sizes and work without color as the only state signal.
- Staging and destructive actions identify their scope; discard and history-rewriting operations require plain-language confirmation.
- Git commands remain in Electron main, use argument arrays or validated patch stdin, and expose only typed serializable IPC contracts.
- Conflicts open an actionable resolver and cannot be saved while Git conflict markers remain.

## Task list

- `TASK-038` — Structured comparison and patch model
- `TASK-039` — Clean responsive diff workspace
- `TASK-040` — WIP and granular change actions
- `TASK-041` — Graph-native workflows, history, and blame
- `TASK-042` — Three-way conflict resolution
- `TASK-043` — Verification, accessibility, and documentation

## Notes

The UX is inspired by GitKraken’s low-friction file selection and comparison modes, but remains visually consistent with Praxis. The renderer never executes Git or parses untrusted subprocess output directly.

## Close when

All acceptance criteria have current unit, integration, packaged Electron, and visual evidence; the copied renderer contains the verified build; and the feature plan no longer contradicts the delivered mutation scope.

## Completion evidence

- Core graph/diff/parser suite: 7/7 passed.
- Real temporary-repository Git service suite passed, including partial stage/unstage, untracked changes, stash/pop, file history/blame, merge conflict resolution, and backend conflict-marker rejection.
- Frontend production build and Electron type check passed; copied renderer `index.html` matches the built renderer checksum.
- Complete `gitGraph.spec.ts`: 3/3 passed against Electron, covering keyboard activation, responsive and reduced-motion layouts, Inline/Split/Hunks, selected-line controls, history, blame, and a real three-way conflict.
- Current visual evidence: `praxis-diff-workspace.png`, `praxis-diff-workspace-narrow.png`, and `praxis-conflict-editor.png`.
- `git diff --check` passed.

The repository-wide Electron suite currently has unrelated legacy board-navigation and AI/session-state failures. They are recorded at the parent feature and are not used as evidence for this independently testable Git slice.
