# Chat and session grouping verification

Implemented in the standard sidebar: reorder rows at their top/bottom edges; drop on a row centre to create a group; drop on a group to add members; drag whole groups to reorder; rename inline using the pencil or a double-click. Enter saves, Escape cancels. Groups collapse and can be dissolved without deleting sessions. Layouts persist in the desktop profile separately for unassigned chats and each project’s General/Ticket lists.

## Passed

- Renderer typecheck and core-import check.
- Renderer production build, renderer copy, and desktop TypeScript build.
- `sessionGroups.spec.ts`: real Electron/native dragging across all three lists, group reordering, inline rename/cancel, collapse/expand, full Electron restart persistence, opening a grouped chat, dragging out, and ungrouping.
- Fault injection: disabling native drag causes the reorder assertion to fail as expected.
- Visual inspection of `session-groups.png` from the built Electron app.
- `git diff --check`. No snapshot baselines updated.

## Complete desktop functional suite

`npm run test:desktop`: **430 passed, 10 failed, 2 skipped** (9.1 minutes). The grouping test passed in this run. The suite is not fully green; these failures remain outside this scoped implementation:

- e2e/aiCliAgentHost.spec.ts:329:5 › ticket-selected Claude Code runs review and analysis without using Vercel (10.2s)
- e2e/aiPermissions.spec.ts:126:5 › the composer Autopilot mode starts a CLI session without a permission pause (20.2s)
- e2e/aiSessions.spec.ts:136:5 › composer selects a board and open ticket, names the session, and streams to completion (15.9s)
- e2e/aiWorkflows.spec.ts:189:5 › analysis uses the selected runtime and continues implementation in the same session (8.9s)
- e2e/aiWorkflows.spec.ts:313:5 › analysis runs through the selected OpenAI provider and model (18.5s)
- e2e/aiWorkflows.spec.ts:469:5 › local peer review runs the three sections against the gateway (18.2s)
- e2e/settingsReset.spec.ts:36:5 › clears app-owned project, workspace, and board data without deleting shared connections (3.3s)
- e2e/workflowModelTiers.spec.ts:157:5 › two stage sessions of one run with no controller gather under one run header (10.1s)
- e2e/workflowModelTiers.spec.ts:294:5 › a run header in Sessions archives or deletes all of its stage sessions, and leaves the run itself alone (10.2s)
- e2e/workflowRunWorkspace.spec.ts:179:5 › a controller session starts a run: the run is a tree node, its stage session nests under the controller and fills the centre (10.1s)

Failure evidence includes an existing missing completion `title`, an existing “Archive” versus “Archive instead” assertion mismatch, absent analysis/review controls or responses, workflow session rows/run groups absent from the existing sidebar filtering, and a settings-reset launch navigation race. The completion title, archive label, and session filtering are unchanged from the pre-change Sidebar source. A complete pre-change baseline suite was not run, so this report does not assert that every suite failure predates the patch.

Source changes: `renderer/src/app/Sidebar.tsx`, new `renderer/src/app/SessionOrganizer.tsx`, new `renderer/src/app/sessionOrganizer.css`, and new `main/e2e/sessionGroups.spec.ts`. Existing dirty source work was preserved. The full suite also regenerated its diagnostic screenshots.
