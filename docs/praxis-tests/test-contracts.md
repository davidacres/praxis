# test-contracts

Ticket: **PRX-S111-184 / FX-BE-184**. Stage: **WF-C10627E5-test-contracts**.
Frozen implementation: `66b759f966743bef5b70f582723b0df23d7a573e`. HEAD matched this revision and the tree was clean before authoring. The supplied snapshot includes the implementation and retained release evidence. This stage changes catalog documentation only.

## Exact inventory and result

- **800 generated Playwright contracts across 173 spec files**, including **67 curated flows**. The catalog was already current at entry. Regeneration preserved all 800 ids and flows; one flow was corrected to distinguish keyboard Pin from clicked Unpin.
- **25 scoped supplemental Node source contracts, representing 32 runtime cases**, in [release-proof contracts](fx-be-184-release-proof.md). Two templates expand to three capability cases and six filesystem-fault cases. Exact runtime titles and derived ids are now linked there, alongside the stable template-group ids.
- **825 source contracts = 800 Playwright + 25 selected Node contracts**. Expanded scoped inventory: **832 cases = 800 statically discovered Playwright + 32 selected Node runtime cases**. Neither figure is a complete monorepo runtime count: the generator excludes Node, dynamic titles and non-direct `test(...)` declarations. Earlier Node supplements and unrelated unit suites are not included in these totals.
- Fresh deterministic validator: `npm run test:praxis-contracts` **exit 0**, 800 catalogued and linked, no warnings, both before and after `--write`.
- Additional source audit: all **825** source contracts match their exact title, source line and SHA1(file + newline + title) id; **zero stale links or duplicate ids** within that set. Parameterized group identities are explicitly distinguished from runtime identities. Two strengthened Node contracts intentionally supersede earlier supplement prose under the same ids.

The [generated catalog](catalog.json) and [index](index.md) link every discovered Playwright test. The Node supplement supplies runner, file, line, title, stable id and Given/When/Then for each selected contract. Contract validation proves inventory consistency, not assertion success.

## Coverage links

The focused durable-team-chat files contain **14 Playwright contracts**: 12 in the ordinary/smoke spec (one is a transport-only test), and two opt-in real-provider tests. Their exact entries are below. The [implementation verification report](fx-be-184-verification-report.md) contains the broader AC1–AC12 assertion map, including assistant integration tests; use the source links here and in the supplement for current line locations.

| ID | Automation (Playwright) | Exact title |
| --- | --- | --- |
| PT-1D3CF0B299 | [durableTeamChat.live.spec.ts:96](../../apps/praxis-desktop/main/e2e/durableTeamChat.live.spec.ts#L96) | real CLI member continues a durable team chat across an app restart |
| PT-75844A4FF6 | [durableTeamChat.live.spec.ts:109](../../apps/praxis-desktop/main/e2e/durableTeamChat.live.spec.ts#L109) | real API member continues a durable team chat across an app restart |
| PT-592434CA9B | [durableTeamChat.spec.ts:13](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L13) | two windows converge, queue capture survives navigation and stale controls cannot cancel replacement work |
| PT-D8BE3D65EB | [durableTeamChat.spec.ts:70](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L70) | subscription buffers a racing revision and discards responses after selection changes |
| PT-C44D501ACA | [durableTeamChat.spec.ts:101](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L101) | unknown outcome requires recorded reconciliation and acknowledged retry, then converges to a committed reply |
| PT-EA127A3852 | [durableTeamChat.spec.ts:142](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L142) | a migrated chat continues from imported history without reusing unproved runtime identity |
| PT-829EB33638 | [durableTeamChat.spec.ts:173](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L173) | keyboard cancellation preserves accepted messages and cancels only the selected queued turn |
| PT-204ED6FAA3 | [durableTeamChat.spec.ts:199](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L199) | an unconfirmed submission retries its original command after both acknowledgements are lost |
| PT-2B5E9C8D8A | [durableTeamChat.spec.ts:252](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L252) | an app restart mid-reply leaves the turn for the user to resolve; nothing is replayed |
| PT-E29A82FCB9 | [durableTeamChat.spec.ts:288](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L288) | a queued turn resumes after restart before any chat is opened |
| PT-F202472C30 | [durableTeamChat.spec.ts:319](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L319) | a storage write failure is shown and the accepted transcript remains |
| PT-2467F68DB7 | [durableTeamChat.spec.ts:356](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L356) | re-opening a team chat whose first load failed reads its transcript again |
| PT-0DD1738998 | [durableTeamChat.spec.ts:391](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L391) | a tool member's pending permission is attached to its attempt and a restart never reuses the approval |
| PT-2633FBDC53 | [durableTeamChat.spec.ts:427](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L427) | a CLI member without resume capability reconstructs context on its second turn |

| Ticket requirement | Contract evidence | Limit |
| --- | --- | --- |
| 486: named assertions and artifacts for each acceptance criterion | [AC1–AC12 map](fx-be-184-verification-report.md), [retained evidence](fx-be-184-retained-evidence.md), catalog and supplement | The map records partial coverage; it is not an all-criteria pass. |
| 486: write failures, corrupt data, duplicates, concurrent writers and crash boundaries | [crash, context, binding, repository and startup contracts](fx-be-184-release-proof.md); two-window, restart, ENOSPC and permission tests above | Repository concurrency uses two instances in one process. The separate two-window UI test covers window convergence. |
| 486: temporary profiles, repositories and coordination roots | Node repository fixtures use temporary files; live CLI creates a temporary working directory; ordinary UI tests use `launchTestApp` isolated profiles | Inspection of the scoped fixtures is not a global write-path audit. Retained screenshots/receipts are evidence outputs, not user-profile or plans write paths. |
| 486: real API and CLI continuation with attempt/context evidence | PT-1D3CF0B299 and PT-75844A4FF6 above | Opt-in, with explicit skip conditions. Existing report records CLI reconstruction success, API credential skip and no demonstrated real CLI session reuse. Neither was executed in this stage. |
| 487: prescribed commands pass or have unresolved evidence | [verification report](fx-be-184-verification-report.md), [retained command evidence](fx-be-184-retained-evidence.md) | Inherited first full functional run failed; later isolated passes do not replace that result. Manual dark-theme verification remains incomplete. |

## Stale and ambiguous contracts

1. **Replaced stale stage report.** This file previously described FX-BE-183 at `622613fb` (790 entries) and listed findings since addressed. The frozen FX-BE-184 source now asserts the second window's active member, standalone navigation, Preview then Apply/refusal, title-only migration isolation, unchanged migration inputs, uncertain-commit reconciliation and disabled dispatch after activation failure. The prior report's contrary statements are no longer current.
2. **Parameterized count clarified.** The Node supplement's “25 cases” was a count of source definitions, not runtime cases. It now records 25 definitions / 32 runtime cases and nine exact parameter-expanded titles, preserving existing group ids.
3. **Keyboard wording corrected.** PT-592434CA9B presses Enter to Pin but clicks Unpin. The flow now says so. Its queue-capture title still exceeds the assertions: queued page-context content and attachments are not compared in this UI test. Dock/float session/attempt identity is also not compared. These are coverage gaps, not passing evidence.
4. **Platform boundary.** PT-4485239A20 returns early on Windows before directory-flush/uncertain-commit reconciliation assertions. The supplement now states the boundary; a Windows pass cannot prove those assertions.
5. **Generator boundaries remain.** Dynamic-title and non-direct test calls are omitted; all entries carry `project: functional`, including the two real-provider tests actually assigned to `live-agent`. PT-D8BE3D65EB runs a transport unit assertion under Playwright without launching an app. Generic generated Then prose and validation of nonempty flows cannot prove behavioral coverage. No generator implementation was changed in this stage.
6. **Unresolved release evidence.** The frozen report records an API skip for missing credentials, incomplete manual dark-theme interaction, and a failed first full functional run (745 passed, 4 failed, 14 skipped). Real CLI continuation reconstructed context and did not demonstrate native session reuse. The pending-approval recovery state differs from the design matrix (`outcome_unknown` for tool-capable attempts); automatic replay is refused. No skip is counted as a pass here.
7. **Legacy association ambiguity.** Legacy records do not prove a runtime-session association; the tests verify no synthetic association is invented. This is not evidence that a provable association was imported. The removed classic sidebar has no independent surface to verify.

## Verification performed by this stage

`npm run test:praxis-contracts -- --write` and the subsequent validator passed (800 entries; all 800 existing contracts carried over). A separate source/hash audit verified all 800 catalog links and 25 Node source links and found no mismatches or collisions. `git diff --check` passed.

No application code or automated test changed. Builds, runtime unit suites, full functional/theme suites, real-provider calls and manual visual interaction were not rerun in this catalog stage; their prior results remain explicitly inherited in the linked implementation evidence. No screenshot was captured or visually verified in this stage. This report completes the test-contracts artifact without advancing any other workflow stage.
