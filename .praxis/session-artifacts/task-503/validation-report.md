# TASK-503 validation report — PRX-T113-503 / FX-BF-113

Status: **FAILED / incomplete acceptance.** Validation ran; the UI gate is not green.
Date: 2026-11-01. Product revision tested: `336ec028c5f9e5efc2c15baa783bceb22df7f149`.
This delivery changes evidence only. No product fix or release-readiness claim is made.

## Recovery diagnosis and scope

The supplied most recent failure says only “The stage session was aborted”; it provides no stack or structured findings, so its cause cannot be established. The tracked report describes older missing-dependency attempts. Current local dependency preflight passes: root `.bin/tsc`, `vite`, `electron`, `playwright` exist; `require('electron')` resolves inside this checkout. No dependencies were installed, linked or copied. Initial Git status was clean.

The supplied plan was preserved: sequential per-surface builds, guards, focused tests, full functional gate and theme gate. `caffeinate -d` accompanied UI runs. The initial sandbox denied localhost servers; permitted execution resolved the unit-suite failures. No assertions, snapshots, workflows or product code were changed.

## Passed

| Command | Result |
| --- | --- |
| `npm run build:core` | Exit 0; `tsc -p .`. |
| `npm run build:renderer` | Exit 0; core-import guard, TypeScript and Vite; 293 modules transformed. Existing chunk-size warning. |
| `npm run desktop:copy-renderer` | Exit 0; built renderer copied into main/renderer. |
| `npm run build:desktop` | Exit 0; trusted IPC guard and TypeScript. |
| `npm run check-types` | Exit 0 across all five workspaces, including IPC/import guards. |
| `npm run check-core-imports --workspace=@praxis/desktop-renderer` | Exit 0. |
| `npm run test:praxis-contracts` | Exit 0: `Praxis Tests: 766 Playwright tests catalogued and linked.` |
| `npm test --workspace=@praxis/desktop-renderer` | `tests 18`, `pass 18`, `fail 0`, `skipped 0`; four notes unit files. |
| `npm run test:desktop:git` — permitted execution | `tests 107`, `pass 107`, `fail 0`, `skipped 0`; includes notesStore. |
| `npm run test:desktop:themes` | `47 passed (1.9m)`, themes + theme-regressions; exit 0. |
| Folder compatibility subset in full functional run | All **15** tests in folder, folderMulti, editIssue and newIssue passed. The supplied plan's count of 13 is stale for this revision; coverage was not changed. |

## Failed

Verbatim suite summaries:

- Focused seven specs, `npx playwright test --project=functional notes.spec.ts sessionShelf.spec.ts sessionShelfNotes.spec.ts sidebarNotes.spec.ts noteSessionHandoff.spec.ts notesPersistence.spec.ts notesShelfGeometry.spec.ts --workers=1`: `7 failed`, `2 skipped`, `32 passed (5.6m)`; exit 1.
- `npm run test:desktop`: `9 failed`, `14 skipped`, `706 passed (23.0m)`; 729 selected, configured four workers, retries 0; exit 1.
- Initial sandbox unit execution: `tests 107`, `pass 103`, `fail 4`. Four semanticModelDownload localhost servers failed with `listen EPERM: operation not permitted 127.0.0.1`; the unchanged permitted run passed all 107.
- Initial sandbox focused execution: `41 failed`, with localhost EPERM blocking application validation. Superseded by the permitted serial focused run above.

| Test location | Observed failure | Classification / reproduction |
| --- | --- | --- |
| sessionShelf:51 (assertion :92) | Spine centering offset 22.5px; expected <=1px. | Shelf geometry finding, reproduced in serial focused and full runs. Causation not isolated. |
| sessionShelf:190 (:203) | Hover did not reveal card. | Variable pointer behavior: failed serial focused, passed full. Not established as a stable regression. |
| sessionShelf:306 (:333) | Revealed card transform did not reach expected identity matrix. | Failed full, passed serial focused; variable pointer/animation behavior. |
| sessionShelfNotes:66 (chipSelect:40) | Shelf Notes project option click timed out. | FX-BF-113 interaction/test finding, reproduced serial focused and full. |
| sessionShelfNotes:96 (:104) | Note title inactive after keyboard pencil activation. | FX-BF-113 keyboard focus finding, reproduced serial focused and full. |
| sessionShelfNotes:107 (chipSelect:40) | Project option click timed out before failed-save journey. | FX-BF-113 interaction/test finding, reproduced serial focused and full; does not prove save recovery failed. |
| sidebarNotes:41 (:59) | Non-exact Create locator matched six buttons. | Test-selector defect in feature coverage; reproduced serial focused and full; group operation not reached. |
| sidebarNotes:83 (:93) | Same Create strict-mode violation. | Test-selector defect; deletion journey not reached. |
| easymode:1377 (:1511) | Tab after Show more did not focus Sessions/Runs divider. | Reproduced once alone with `--grep 'a long session list folds' --workers=1`: 1 failed. Adjacent sidebar focus finding; feature causation unproven. |
| marketplace:271 | Full run expected Skills (1), got Skills (2) at :294. | Plan flags this as environment-dependent. Single isolated run failed earlier at :282: expected Skills (0), got Skills (1). Extra discovered skill; unrelated to notes. |

Read-only Git comparison found no difference from local `main` for these five failing spec files. History includes sessionShelf `1609a970`, easymode `668a1441`, marketplace `abcd022a`, and notes specs `202bb056`. That establishes existing test history, **not** that runtime failures predate FX-BF-113. No baseline-main execution was performed. No code fix is permitted by this task's validation-only boundary.

## Rail measurements

All eight notesShelfGeometry tests passed in both permitted focused and full runs. These are assertion bounds, not an exported raw measurement dataset:

| Scenario | Verified bounds / allocation |
| --- | --- |
| Standard scale 1 | Rail 14 CSS px ±0.5; pane left and rail-to-pane gap match hidden-actions baseline within 0.5px. |
| Large scale 1.16 | Rail 16.24 CSS px ±0.5; same baseline comparison. |
| Full rail | Five spines; controls reachable within rail; no horizontal growth or action/spine horizontal overflow beyond 1px. |
| Focus / open sleeve | Rail and workspace allocation unchanged; focused-control ring geometry checked. |
| Light/dark media query | Baseline geometry passed. These tests do not switch actual app themeMode. |
| 110% page zoom | Rail 14 × scale in CSS pixels; geometry assertions passed. |
| Actual theme + material + narrow matrix | **Incomplete**; see capture failure below. No numerical pass claimed. |

## Visual evidence and capture failure

Fresh evidence is under `recovery-matrix/`. Two PNGs were opened and visually inspected:

- `recovery-matrix/light-parchment-standard.png`: real light theme and Parchment verified by DOM attributes. Rail plus/pencil appear at lower left; workspace inset visible. Sleeve is closed in the actual PNG, so this is **not** open-sleeve evidence.
- `recovery-matrix/dark-parchment-standard.png`: real dark theme and Parchment verified. Sleeve appears attached to the rail with a fine border; three seeded recent notes visible. No gross viewport overflow is visible. Does not establish keyboard focus-ring correctness.

Capture tooling initially failed because installed TypeScript has no JS transpileModule API. External Playwright loader then ran the script. A direct persisted settings change did not live-apply themeMode/surface on this path; reloading applies startup settings and verified attributes. The revised matrix captured the two images above, then failed measuring an absent sleeve (`Cannot read properties of null (reading 'getBoundingClientRect')`) before the Graphite case completed. Capture stopped; no further retries or product changes. Partial rows were not persisted, so no raw matrix measurement table is claimed.

Other images already present in the artifact directory were not produced or validated by this recovery and are not presented as current proof. A separately appearing untracked `apps/praxis-desktop/main/e2e/zzTask503Capture.spec.ts` was not created by this recovery, not executed by the original full-suite discovery, and is left untouched/unstaged. Concurrent desktop activity cannot be ruled out, limiting attribution of pointer-sensitive failures.

Logs `task-503-*.log`, the external `capture-script.ts`, and copied available full-run trace/context evidence in `full-functional-evidence/` are preserved locally. One marketplace trace attachment was reported missing by the full runner; its console error remains in the log. PNGs/logs are ignored and not committed; useful fresh evidence is published at handoff.

## Manual interaction / journeys

Real Electron UI was exercised through existing Playwright keyboard/click tests, using isolated scratch profiles and mocked provider channels. This was automated interaction, not a complete manual run through the normal launcher.

Verified automated journeys include shelf new-session creation without auto-send; shared notes persistence, project isolation, linked edits and ungrouping/deletion across restart; no provider calls for ordinary note actions or cancellation; note/group preview, existing-session send, new-session staging, explicit send and rejection/retry. Failed shelf and sidebar journeys are listed above and are not counted as complete. The two project-picker layering tests were skipped by their existing conditions when no picker was present.

## Not run / incomplete

- Complete keyboard-only **and** pointer manual journey matrix (create/capture/rename/edit/delete/reopen/groups/all destinations/tooltips). Existing E2E coverage is not a substitute for claiming this manual acceptance.
- Normal `scripts/run-app.sh` launcher pass. Scratch launchTestApp was used instead.
- Fresh Graphite/material, large-display, zoom and minimum-width screenshot matrix; raw baseline measurements for that matrix; fresh expanded-group and send-preview screenshots. Capture stopped on the absent sleeve.
- Classic sidebar verification: this revision intentionally removes Classic; easymode:378 checks legacy preferences cannot restore it. No Classic UI was reintroduced.
- A separate baseline-main run; regression causation remains unproven where noted.
- Entire failing easymode/marketplace files rerun alone: one failing test from each was reproduced in isolation instead. Shelf/notes failures already ran serially in the focused suite. No repeated retry loop was used.
- `npm run test:core` and unrelated broad suites: outside the supplied validation command sequence.

## Snapshots changed

None. No `--update-snapshots` used. Theme gate produced no failing snapshot actual/diff images to accept.

## Code changed

None. Only this report and the required `.praxis/change-diff.md` are committed. The plan, product source, tests, snapshots, workflow gates and ticket states are preserved. TASK-503 acceptance remains unsatisfied; downstream verification must not treat this evidence commit as a green UI gate.
