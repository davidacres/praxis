# test-contracts

Ticket: **PRX-S111-183 / FX-BE-183**. Stage: **WF-D0CF973C-test-contracts**.
Frozen implementation: `622613fbed15edab22f77d4c2597e3bf784f1b4a`. HEAD matched that revision and the worktree was clean before authoring. Only catalog documentation changes in this stage; no source or test file was edited.

## Exact inventory

- **790 Playwright contracts across 172 spec files** (784 before this ticket: +7 new, −6 removed by rename, +5 renamed-in). Zero duplicate ids. The validator passes with **no warnings** after `--write` refreshed three moved `marketplace.spec.ts` lines (303→307, 334→338, 375→379).
- **57 curated Given/When/Then flows** (45 carried over + 12 written in this stage). All other entries carry generated prose.
- **16 supplemental node:test contracts** in [fx-be-183-renderer-migration.md](fx-be-183-renderer-migration.md), with exact file, line, title and SHA1 id. None collides with a catalog id or with the FX-BE-179…182 supplements.
- Scoped union for this ticket: **806 = 790 Playwright + 16 Node**. This is not the full monorepo suite; other Node suites and earlier supplements are not counted here.

### Identity changes made by the implementation

The ids of renamed tests changed because an id hashes file + title. Old ids were all generic (no curated prose was lost).

| Removed id | Replaced by | Title now |
| --- | --- | --- |
| PT-99F1FB5440 | PT-8306C7A150 | assistant composer accepts queued turns and animates its border while the team replies |
| PT-6AF261DEFF | PT-682AE3DBE7 | CLI team-chat reconstructs when account identity cannot be proved |
| PT-9ADE9F9E42 | PT-8EF93BBA0B | an update-ticket proposal requires Preview Changes before applying |
| PT-B8B9837347 | PT-497E7C3D84 | an update-workflow proposal previews before changing the designer |
| PT-5E8DFAD0E8 | PT-1B219DB70F | durable activation rejects stale legacy turns and transcript writers |
| PT-7600A815C3 | PT-3348476BDF | an exhausted failed stage pauses the schedule and retries in the same workflow |

New: `durableTeamChat.spec.ts` — PT-592434CA9B (:12), PT-D8BE3D65EB (:67), PT-C44D501ACA (:98), PT-EA127A3852 (:139), PT-829EB33638 (:170), PT-204ED6FAA3 (:198). All 12 ids above now carry curated flows.

## Acceptance coverage

| Criterion | Automated evidence | Gap / finding |
| --- | --- | --- |
| 484 · Two windows share transcript, active member and queue after reload; dock/float keeps execution ownership | [durableTeamChat:12](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L12) PT-592434CA9B; [assistant:79](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L79); [assistant:212](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L212) PT-8306C7A150 | Shared transcript, queue status and post-reload replies are asserted. **Active member is not asserted** in the second window. Dock/float is checked only by transcript and timer continuity, not by execution ownership (no session/attempt identity compared across the switch). |
| 484 · One team-chat row in Classic and Easy Mode; typed internal executions excluded on load and on updates; standalone chats visible | [assistant:274](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L274) (no `ASSISTANT-` session rows live and after reload, one row); [assistant:471](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L471) (Easy Mode sidebar); durableTeamChat:12 | Only the Easy Mode sidebar exists now (the classic sidebar was removed on purpose), so "Classic" has no separate surface to test; the criterion is **ambiguous** as written. **No assertion that a standalone chat stays visible** beside the team-chat row. |
| 484 · Context detach is one message; mentions work; actions keep Preview Changes and apply only on the compatible page | [assistant:471](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L471) detach; [assistant:405](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L405) mention; [assistant:548](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L548) PT-8EF93BBA0B, [:566](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L566), [:581](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L581) PT-497E7C3D84; coordinator:673 PT-BCE1A74F9A | Preview is visible and Apply disabled before preview. **No test clicks Preview then Apply**, and no test checks Apply is refused on an incompatible page; the mismatched-workflow case only checks no error alert. |
| 484 · Queued submissions keep captured context and attachments; navigation cannot redirect a pending reply | durableTeamChat:12 (both replies land in the original chat after New chat); activation:51 PT-42C5554A52 (staged bytes survive mutation, cross-conversation refused) | **Captured page context of a queued turn is not asserted** in e2e (the second message is named "Queued original context" but its context is never checked). Attachments are proved at the store level only. |
| 484 · Keyboard + accessible names for stop, retry, queued cancel, pinned decisions, outcome resolution; errors stay until resolved | [durableTeamChat:170](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L170) stop/queued cancel; [:98](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L98) retry + reconciliation; [:12](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L12) pin; [:198](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L198) error alert; coordinator:636 PT-D81B94C6F4 | Covered. Unpin is clicked rather than keyboard-activated. |
| 485 · Legacy fixture preserves ids, titles, order, timestamps, roles, actions, choices, errors, ownership; rerun is a no-op | migration:13 PT-0FF1EBFFE5; activation:30 PT-0651E34994; [durableTeamChat:139](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L139) | Covered at unit level; e2e checks id, provenance and history continuity. |
| 485 · Provable session associations import typed links only after validation; ambiguous title matches never merge or delete | migration:39 PT-A1FF0FEC99 (diagnostics kept, no turns invented) | **Uncovered:** no test imports a provable session association, and none exercises an instruction-title match. |
| 485 · Migration failure leaves store and backup intact with durable dispatch disabled; activation blocks legacy writes | activation:44, :64, :76, :89, :97; [assistant:679](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L679) PT-1B219DB70F | Source unchanged on failure; legacy writes blocked. "Durable dispatch disabled after failure" is not asserted directly. |
| 485 · Active legacy execution makes cutover wait; no dual writers | activation:18 PT-1FC2813D4B, :97 PT-63819EA534 | Covered at the activation-fence unit level only; no e2e with a live legacy turn. |
| 485 · Expired legacy session continues with reconstructed context and appears once | durableTeamChat:139 PT-EA127A3852; assistant:352 PT-682AE3DBE7 | The fixture has no legacy session record, so "expired session" is approximated by "no binding"; reconstruction and single listing are asserted. |

## Stale and ambiguous contracts

- **Title overstates assertions:** PT-4485239A20 "…uncertain commit requires reconciliation" checks no reconciliation; PT-A75870DFCA "…without modifying the source" does not re-check the source after throwing; PT-592434CA9B mentions queue capture but never checks the captured context.
- **PT-D8BE3D65EB** is a transport unit test running inside the Playwright suite (no window launched). It inflates the e2e count and duplicates the renderer `node:test` coverage of the same module.
- **Out-of-scope spec edits in the frozen snapshot:** `scheduledRuns.spec.ts:926` was renamed and its expectations moved from attempt 1→2 to 3→4 (the same baseline id PT-7600A815C3 the FX-BE-182 stage restored); `marketplace.spec.ts`, `connectionsManager.spec.ts`, `scheduledRunEndToEnd.spec.ts`, `sessionShelf.spec.ts`, `sessionShelfNotes.spec.ts` and `sidebarNotes.spec.ts` were also edited. They are catalogued as they are, but they widen QA's affected-test set and are not FX-BE-183 work; review should confirm they belong in this ticket.
- **UI observation (not a test finding):** the sidebar row in the captured screenshot reads "team chat · 0 participants" while the Virtual Team has members. Worth a look in review.
- Generator limits still apply: dynamic-title tests are skipped and every entry is labelled `functional`. A clean validator proves inventory and links, not behaviour.

## Verification

- `npm run build` (core → renderer → copy-renderer → desktop, incl. IPC sender check): passed.
- `node --test` core `teamChatMigration` + `teamChatCoordinator`: **25 passed**. Main `teamChatActivation`: **8 passed**. Renderer `conversationSubscription`: **2 passed**.
- `npx playwright test e2e/durableTeamChat.spec.ts`: **6 passed** (29.5 s). The two-window queue screenshot was captured by that run.
- `npm run test:praxis-contracts`: **790 Playwright tests catalogued and linked**, no warnings.
- Supplemental ids recomputed from file + title; no collisions with the catalog.
- `assistant.spec.ts` and the full suite were not run in this stage; QA owns that.
