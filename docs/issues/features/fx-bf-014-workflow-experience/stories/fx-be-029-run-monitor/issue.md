# FX-BE-029 — Run Monitor

**Type:** Story  **Status:** Planned  **Priority:** P1  **Depends on:** FX-BE-027

## Business or operational impact
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

## Validation
- `npm run check-types`
- `npm run build:renderer`
- `npm run build:desktop`
- `npm run test:desktop`

## Close when
A run reads as a status board and every stage's evidence is one click away in the right pane.
