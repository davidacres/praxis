---
id: FX-BE-029
title: Run Monitor
status: complete
feature: FX-BF-014
issue: docs/issues/features/fx-bf-014-workflow-experience/stories/fx-be-029-run-monitor/issue.md
updated: 2026-09-02
tasks: ['TASK-126', 'TASK-127', 'TASK-128']
dependencies: [FX-BE-027]
validation: [npm run check-types, npm run build:renderer, npm run build:desktop, npm run test:desktop]
---

# Run Monitor

## User or operational impact

A run's state is legible in two seconds — a sentence, a pipeline picture, a gate ledger — not a data table.

## Scope

- A docked run rail (left) with live status dots that update in place via `onRunChanged` without moving the selection; a `Start a run` form with a workflow picker.
- The run board: the `role=status` explanation sentence, a read-only auto-laid-out pipeline diagram with lane-tinted nodes and converging branch groups, the gate ledger as a captioned `<table>`, and a collapsed timeline.
- Stage detail in `pane-aux` on node click: attempt count, snapshot ref, produced artifacts, last error, `Open session` for an agent stage, and the quieter per-stage `Retry` / `Mark done` / `Mark failed` actions.
- Run-level `Approve` / `Cancel` with a confirm; `Re-run` on a settled run.

## Acceptance criteria

- Starting a check-only run drives it to `awaiting-approval` with the board updating itself and no user action.
- The pipeline diagram shows every lane state distinctly, colour always paired with a glyph or word.
- `Approve` is enabled only when the engine allows it; a blocked approval's tooltip names the gate.
- Clicking a stage in the diagram opens its evidence in `pane-aux`.

## Task list

- `TASK-126` — Build the run rail with live status dots and the start form.
- `TASK-127` — Build the run board: sentence, read-only pipeline diagram, gate ledger table, timeline.
- `TASK-128` — Build the stage detail panel in pane-aux with evidence, session link, and the action hierarchy.

## Close when

A run reads as a status board and every stage's evidence is one click away in the right pane.
