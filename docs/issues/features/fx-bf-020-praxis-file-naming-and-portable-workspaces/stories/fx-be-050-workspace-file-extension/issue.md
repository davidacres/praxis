# FX-BE-050 — A workspace file is .praxis.json, not .praxis

**Type:** Story  **Status:** Complete  **Priority:** P2  **Depends on:** FX-BE-048, FX-BE-049

## Business or operational impact
The bespoke `.praxis` extension was justified by "the user opens it with Praxis" — but there is no `fileAssociations` entry and no `open-file` handler, so double-clicking one has never opened anything. It bought only the dialog filter, while costing editor highlighting, GitHub rendering and schema association. FX-BE-049 then made the file something you *commit*, so it is read and reviewed far more than opened.

## Scope
- Suffix `.workspace.praxis.json`; filter extension `json`.
- The naming rule collapses to one form: `<name>.praxis.<ext>`.
- This repo's file renamed; every reference updated.

## Acceptance criteria
- Saved as `<slug>.workspace.praxis.json`, both dialogs filter on it, round-trip works.
- No bare `.workspace.praxis` reference remains.

## Close when
All three Praxis files follow one naming form and the workspace file is readable in an editor and on GitHub.
