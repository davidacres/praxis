# TASK-503 validation report — PRX-T113-503 / FX-BF-113

Status: **UI gate not green.** The prior pass records the planned automated checks below; manual
launcher and baseline-main checks remain unrun. Geometry and visual contract hold across the
full matrix; nine functional e2e tests fail deterministically, of which **one is a product defect**
(keyboard focus into the note title), the rest are stale or over-broad specs and one environment test.
Date: 2026-11-01. Product revision tested: `336ec028` (no product change since).
This task is validation only: no product code, spec, snapshot, setting or workflow was changed.

## Iteration 2 recovery review disposition

Recovery input revision: `8bbd5835`. The working tree was clean. The supplied findings describe an
earlier snapshot: that revision already deletes `zzTask503Capture.spec.ts` and supersedes the partial
report. This recovery changes documentation only; historical suite results below are retained evidence,
not fresh runs in this recovery.

1. **Committed throwaway spec:** addressed by its deletion in `8bbd5835`. Fresh functional discovery
   exits 0: **729 tests in 157 files**, with no `zzTask503Capture` entry. No replacement capture script
   is committed or added under the discovery path.
2. **Import-time writes:** addressed by removing the entire offending module, including its top-level
   `mkdirSync` and repository JSON output code. No lazy-output replacement is needed for deleted code.
3. **Null sleeve measurement:** the unsafe helper is deleted with that module. No repaired helper is
   shipped. The prior pass's completed matrix and retained captures are listed below; they were not
   regenerated in this recovery.
4. **Inaccurate scope report:** corrected in the input revision and clarified here. Relative to
   `a81aab04`, the capture spec is deleted; relative to `336ec028`, only the two Markdown artifacts
   differ. This recovery itself modifies those two artifacts only.
5. **Acceptance incomplete:** remains unresolved; this is a **failed UI gate**, not approval to advance.
   TASK-501 owns the editor focus defect; TASK-502 owns the selector/reload and stale geometry/tab-order
   coverage fixes described below. These are dependency owners, not a claim that a later ticket is
   scheduled or that the failures are waived. The supplied validation-only plan explicitly prohibits
   product/spec fixes here. Validation must run again after those repairs. No tracker transitions or
   comments were sent.

Fresh recovery checks: `npm run test:praxis-contracts` exits 0 (**766 tests catalogued and linked**);
`npx playwright test --project=functional --list` exits 0 as above. No UI was changed, no snapshots
were updated, and no full suites or manual journeys were repeated during this documentation recovery.

## Concurrency note (read first)

A second agent session ran this same stage in this worktree at the same time (commit `01b22d6b`,
`recovery-matrix/` captures). The workflow's auto-commit `a81aab04 "Implement (workflow stage)"` then
swept this session's throwaway capture spec `apps/praxis-desktop/main/e2e/zzTask503Capture.spec.ts`
into history; it is **removed** again in this commit so it never runs as part of the suite. The other
session also overwrote one of this session's PNGs mid-run; that capture was regenerated and re-inspected.
Its notes that remain valid are folded in below (sandbox EPERM detail, Classic removal). This report
supersedes `01b22d6b`'s: it completes the screenshot matrix that one stopped short of, and classifies the
failures with targeted probes.

## Passed

| Command | Result |
| --- | --- |
| `npm run build:core` | exit 0 |
| `npm run build:renderer` (core-import guard + tsc + vite) | exit 0; existing >500 kB chunk warning only |
| `npm run desktop:copy-renderer` | exit 0 |
| `npm run build:desktop` (trusted-IPC guard + tsc) | exit 0 |
| `npm run check-types` | exit 0, all workspaces |
| `npm run check-core-imports --workspace=@praxis/desktop-renderer` | exit 0 |
| `npm run test:praxis-contracts` | exit 0 — `766 Playwright tests catalogued and linked` |
| `npm test --workspace=@praxis/desktop-renderer` | tests 18, pass 18, fail 0 |
| `npm run test:desktop:git` (includes `notesStore.test.ts`) | tests 107, pass 107, fail 0 (the other session saw 4 `listen EPERM` failures only under a sandbox; unsandboxed it is 107/107) |
| `npm run test:desktop:themes` (`themes` + `theme-regressions`) | **47 passed (2.4m)**, exit 0; no snapshot actual/diff produced |
| Folder gate `folder` + `folderMulti` + `editIssue` + `newIssue` | **15 passed**. AGENTS.md says 13; the files now hold 3+3+2+7 = 15 tests, so the documented count is stale, not a regression |
| `notesShelfGeometry.spec.ts` (all 8) | passed in focused and full runs |
| `notes`, `noteSessionHandoff`, `notesPersistence` specs | all passed |

## Failed

`npm run test:desktop` (functional, 4 workers): **706 passed, 10 failed, 13 skipped (24.6m)**.
Focused notes/shelf run (7 specs): 32 passed, 7 failed, 2 skipped; serial re-run of the failing specs:
6 still fail. Every failure below was re-run alone; spec-defect classifications were confirmed by running
a throwaway copy with only the selector fixed (not committed).

| Test | Error | Classification |
| --- | --- | --- |
| `sessionShelfNotes.spec.ts:96` keyboard pencil → title focus | `note-title` not focused after Enter on the pencil | **Product defect (FX-BF-113).** Fails in every run, including with the project picker absent. A direct probe shows focus stays on `BUTTON testid=session-shelf-notes` after Enter. The focus effect at `renderer/src/app/SessionShelf.tsx:155` does not take hold. Contract: "keyboard users land in the editor". Not fixed (validation-only task) |
| `sessionShelfNotes.spec.ts:66`, `:107` | `chooseOption(... 'Shelf Notes')` timed out | **Spec defect.** The project is created over raw IPC with no reload, so the renderer's picker never lists it. Passes once `page.reload()` follows `createProject` |
| `sidebarNotes.spec.ts:41`, `:83` | strict mode: `getByRole('button', { name: 'Create' })` → 6 elements | **Spec defect.** The non-exact name also matches the Easy Mode "Create new session/note/run" buttons. With `exact: true`, `:83` passes; `:41` then hits a second over-broad locator: `/Ideas/` matches both the group row and "Actions for group Ideas" |
| `sessionShelf.spec.ts:51` (assert `:92`) | spine stack off-centre by 22.5 px (≤1 expected) | **Stale spec caused by FX-BF-113 (TASK-498).** The contract places the plus/pencil "inside the current rail, occupying vertical space", so spines centre in the space above the controls (visible in `full-rail-light-closed.png`). The spec was not updated |
| `easymode.spec.ts:1377` (assert `:1511`) | Tab from "Show more" does not reach `easymode-runs-divider` | **Caused by FX-BF-113 (TASK-499).** `NotesSection` now sits between Sessions and the divider (`EasyModeSidebar.tsx:223`), so Tab lands in Notes. The spec's tab order is stale. **Owner decision:** the divider is still labelled "Resize Sessions and Runs" although Notes now sits between them |
| `marketplace.spec.ts:271` | `Skills (0)` expected, got `Skills (1)` | Known environment-dependent (an extra discovered skill); unrelated to notes. Fails alone too |
| `aiPermissions.spec.ts:36` | failed in the full run | **Flaky**: passed alone |
| `themeAccent.spec.ts:33` | failed in the full run | Known flaky: passed alone |
| `sessionShelf.spec.ts:306` | card transform not identity | **Flaky** (hover/animation): failed in the 4-worker focused run, passed serially and in the full run |

## Rail measurements

`getBoundingClientRect` in a real window, with real `themeId`/`themeMode`, surface pack and display
size from seeded settings (verified by `data-theme` / `data-surface` / `data-display-size` attributes).
"Baseline" = same document with `.session-shelf__actions` hidden. Inset = pane left − rail right.

| Scenario | theme / surface | scale | rail w (baseline) | pane left (baseline) | inset | sleeve left vs rail right | h-overflow |
| --- | --- | --- | --- | --- | --- | --- | --- |
| light standard | praxis-light / parchment | 1 | 14.00 (14.00) | 18 (18) | 4 | 13 / 14 (flush, 1 px border overlap) | none |
| dark standard | praxis-dark / parchment | 1 | 14.00 (14.00) | 18 (18) | 4 | 13 / 14 | none |
| material: Aurora Glass | praxis-light / aurora-glass | 1 | 14.00 (14.00) | 18 (18) | 4 | 13 / 14 | none |
| material: Graphite | praxis-dark / graphite | 1 | 14.00 (14.00) | 18 (18) | 4 | 13 / 14 | none |
| large display | praxis-light / parchment | 1.16 | 16.23 (16.23) = 14 × 1.16 | 20.23 (20.23) | 4 | 15.23 / 16.23 | none |
| 110 % zoom | praxis-light / parchment | 1 | 13.99 (13.99) | 17.98 (17.98) | 3.99 | 13.08 / 13.99 | none |
| narrow 720 px, notes | praxis-dark | 1 | 14.00 (14.00) | 18 (18) | 4 | 13 / 14 | none |
| full rail (5 spines) | praxis-light / parchment | 1 | 14.00 (14.00) | 18 (18) | 4 | 13 / 14 | spines 0, actions 0 |
| full rail, narrow 720 px | praxis-dark | 1 | 14.00 (14.00) | 18 (18) | 4 | 13 / 14 | spines 0, actions 0 |

Every row has the sleeve both closed and open, and the rail and inset are identical in both states.
**14 px at standard scale and an unchanged allocation everywhere else: verified.**

## Screenshots (opened and inspected)

These live in `.praxis/session-artifacts/task-503/` (gitignored; raw numbers in `m-*.json`):

- `light-parchment-standard.png`, `dark-parchment-standard.png`, `light-aurora-glass.png`, `dark-graphite.png`, `light-large-scale.png`, `light-zoom-110.png`, `dark-narrow-720.png`: the notes sleeve is open with a saved note. It sits flush to the rail with a fine border and an accent focus ring on the body, and shows the Saved / Send to session… / New note row and the recent-notes list. The plus/pencil marks are at the foot of the rail.
- `full-rail-light-closed.png`, `full-rail-dark-narrow-720-open.png`: five spines with the controls still reachable below them. At 720 px with no project, the sleeve shows the "Save to project…" picker.
- `sidebar-notes-classic.png` / `-window.png`, `sidebar-notes-easy.png` / `-window.png`: the Notes section shows the expanded "Ideas (2)" group, "Release (1)" and an ungrouped note. "Release checklist" is linked into two groups.
- `send-preview-dialog.png`: a group send preview listing 2 notes, the "New session…" destination, optional instructions, Cancel, and "Continue in new session".
- `journey-keyboard-pencil.png`: the state after Enter on the pencil; focus has stayed on the pencil (the defect above).
- `narrow-720-on-resize.png`: see the observations below.

## Journeys (keyboard and pointer)

These were driven through Playwright keyboard and click events on the built app with a scratch profile and provider spies. **This is automated interaction, not a hand-driven `scripts/run-app.sh` session.**

- Keyboard: pencil focus + Enter opens the sleeve, but focus does **not** move into the title (defect). Escape closes the sleeve and returns focus to the pencil. The plus button opens the new-session view; the session count stayed at 8, so nothing was created or sent.
- Pointer: sidebar group actions → Send to session… → preview of 2 notes → Cancel. Provider calls stayed at **0** and the session count was unchanged.
- The passing `notes`, `noteSessionHandoff`, `notesPersistence`, `sidebarNotes:110/:152` and `sessionShelfNotes:43` specs cover the rest:
  - capture on both surfaces
  - linked edits shown once per membership
  - ungroup and delete
  - project isolation and restart
  - autosave error and Retry
  - explicit single and group send to existing and new sessions, with no provider calls on save, group, open or cancel

## Observations outside FX-BF-113 (not failures)

- At a 720 px window the titlebar's layout toggles collapse: "Toggle sidebar" has a 0×0 box. A sidebar that is already showing cannot be hidden to reach the shelf until the window widens. This is titlebar behaviour, not notes behaviour.
- The Classic sidebar was removed on purpose (f977690f). `enableEasyMode: false` renders the same sectioned sidebar, so the "Classic and Easy Mode" captures are identical by design.

## Not run

- A hand-driven pass through `scripts/run-app.sh` with a real pointer. The same journeys were automated instead, as described above.
- A baseline run on `main`, for cause attribution beyond the code reading and probes above.
- `npm run test:core` and the root `npm run build`, which also builds .NET: both are outside the plan's command list.

## Snapshots changed

None. `--update-snapshots` was not used.

## Code changed

None in product code or specs. This commit removes the throwaway capture spec that the workflow
auto-commit `a81aab04` swept in, and updates this report and `.praxis/change-diff.md`.
