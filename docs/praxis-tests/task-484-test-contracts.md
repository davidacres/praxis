# test-contracts — PRX-T111-484 / TASK-484

Stage: **WF-E45FE6DC-test-contracts**. Frozen implementation: `f27d2793958dbf817c6bea7d06ae474704ad8b55` (commits 91529dc3 + f27d2793). At entry the worktree HEAD matched it and was clean. This stage changes catalog documentation only.

## Result

- **Playwright catalog:** `npm run test:praxis-contracts` exit 0 before and after editing: **803 Playwright tests catalogued and linked**, no warnings. TASK-484 changed no Playwright spec, so `catalog.json` and `index.md` need no change.
- **TASK-484 Node contracts:** **50** new contracts in [FX-BE-183](fx-be-183-renderer-migration.md), one per `test(...)` in the six new renderer suites: `turnControlModel` 18, `assistantErrorState` 11, `assistantPendingSubmissions` 6, `assistantOwnership` 6, `assistantPageContextCompatibility` 4, `assistantShellMode` 5. FX-BE-183 now holds **67**. No existing id changed; no new id collides with any id under `docs/praxis-tests`.
- **Links re-pointed in FX-BE-183:** 3 coordinator line links had drifted by +44 (TASK-483 inserted tests above them): 752→796, 772→816, 789→833. The header count was also wrong (said 16, held 17).
- **Source audit** of all 67 FX-BE-183 contracts (id = SHA1(file + newline + title), exact title at the linked line): **67 pass, 0 stale, 0 duplicate**.
- **Focused run (executed):** `cd apps/praxis-desktop/renderer && npm test` — **87 passed, 0 failed, 0 skipped**. It includes all 50 TASK-484 cases. All six new files are in the renderer's explicit `test` list (registered in 91529dc3).
- **Visual check:** not performed in this stage. It writes no UI code. The implement stage's two-window capture is written by `durableTeamChat.spec.ts:13` to `.praxis/session-artifacts/durable-team-chat-two-windows.png`. This stage did not rerun that spec.
- **Not run (scheduled-run policy):** full functional and theme e2e suites, live API proofs, manual theme passes. The related Playwright specs below were **not rerun**: TASK-484 did not change them, and the e2e suite needs the downstream build and `copy-renderer` steps.

## Coverage links

Node ids are in [FX-BE-183](fx-be-183-renderer-migration.md). Playwright ids are in the [catalog](index.md).

| Criterion | Node contracts (TASK-484) | Related Playwright (catalog, not rerun) |
| --- | --- | --- |
| AC1 Two windows show the same transcript, active member and queue after reload; dock/float does not change execution ownership | Shell: PT-DAB2F1F6A7, PT-B25B27275D, PT-7A0843A5C7, PT-696C0C0697, PT-FFCB3D1974. Active member: PT-44BF2670FC. Queue cards: PT-9E606FAEC0, PT-75CB200106 | PT-592434CA9B (`durableTeamChat.spec.ts:13`, two windows + reload), PT-6A15DADEFB (`:598`), PT-396814BC61 (`assistant.spec.ts:79`, pin docks keeping the conversation) |
| AC2 Classic and Easy Mode show one team-chat row and hide typed internal executions on load and on updates; standalone chats stay | PT-34346A5FF8, PT-2DE5B3792B, PT-B0CE13F1CA, PT-9AA594E12B, PT-1382063EA4, PT-49235A44B7 | PT-631104B8EE (`assistant.spec.ts:590`), PT-592434CA9B (one `team-chat-row`) |
| AC3 Context detach lasts one message, mentions work, actions keep Preview Changes and apply only on the compatible page | PT-80C40253A2, PT-1E88700FF1, PT-6D6CA3D53C, PT-83457E3DBE; refusal stays visible: PT-09F7D3297F | PT-450D784024 (`assistant.spec.ts:471`, detach), PT-567A553B13 (`:405`, mentions), PT-8EF93BBA0B (`:548`), PT-402505393F (`:566`, apply refused off-page) |
| AC4 Queued submissions keep their captured context and attachments; navigation cannot redirect a pending reply | PT-BD0CF99286, PT-41278197F0, PT-62990BC025, PT-96EC2E8958, PT-FA89B07F58, PT-EFA0589DF2 | PT-EE0AB4E23D (`durableTeamChat.spec.ts:539`), PT-204ED6FAA3 (`:209`), PT-592434CA9B |
| AC5 Keyboard and accessible names for stop, retry, queued cancel, pinned decisions, outcome resolution; errors stay until resolved | Controls: PT-92969AEB8D, PT-9E606FAEC0, PT-637CF1FED3, PT-927686F7E1, PT-AD840E7667, PT-A34F9B1A04, PT-AE61A9350E, PT-681C9A8FEB, PT-A6A0E78880, PT-FE3B907B00. Keys: PT-EAA7BF25B7, PT-CEAE68BD12, PT-FE19C3FFCB, PT-CDB5A6BB83, PT-7C18D36E7B, PT-6E7FEB9FCB. Errors: PT-4491F9A277, PT-09F7D3297F, PT-78BE7EE221, PT-8DB52ECB5E, PT-A676CEEB78, PT-E159AF3259, PT-030D8B814F, PT-DCDAF64954, PT-DEFB098902, PT-B0B05FC202, PT-F6064101EE | PT-829EB33638 (`durableTeamChat.spec.ts:176`, Enter on Cancel queued turn / Stop), PT-C44D501ACA (`:104`, Retry dev / Record reconciliation / risk checkbox), PT-592434CA9B (Pin/Unpin decision by keyboard), PT-F202472C30 (`:329`, write error stays shown) |

Each Node id links to its file and line in FX-BE-183's "TASK-484" sections.

## Findings

1. **Classic sidebar has no live surface.** `app/Sidebar.tsx` now filters through `visibleSessions`, but nothing in `renderer/src` mounts `<Sidebar>` (the project tree was removed in f977690f). AC2's "Classic" half is covered only by the shared classifier tests, not by a rendered sidebar.
2. **Easy Mode filtering is mirrored, not imported.** `assistantOwnership.test.ts:60` copies the root-session filter from `EasyModeSidebar`/`EasyModeSessionsList` into the test. If a component's filter changes, this test will not notice. PT-631104B8EE is the only rendered check, and it does not seed a typed `teamChatExecution` record.
3. **Keyboard chords are proven only in the pure resolver.** ⌘/Ctrl+., ⌘/Ctrl+Shift+R and ⌘/Ctrl+Enter are tested through `resolveTurnKeyBinding`. No e2e presses them. The panel's keydown listener, focus moves to the first recovery control, and "composer Ctrl+Enter sends the message" (f27d2793) are not exercised end to end. The e2e tests press Enter on focused buttons instead.
4. **Error dismissal is not driven in the UI.** `assistant-error-dismiss` and `assistant-tool-error-dismiss` appear in no spec. `assistantErrorState.test.ts:73` proves only the resolver's `userDismissed` branch.
5. **"Dock/float does not change execution ownership" is proven on the shell model only.** `assistantShellMode.test.ts:53` shows the action issues no command and keeps the conversation id. No test watches main's turn/attempt owner across a real dock toggle while a turn is running.
6. **Title broader than its assertions.** `turnControlModel.test.ts:272` names "selects", but no SELECT element is asserted. The contract records this and does not claim it.
7. **Inherited, not caused by TASK-484:** the FX-BE-180 stale titles and FX-BE-181 line drift reported in [task-483](task-483-test-contracts.md) are unchanged here.
