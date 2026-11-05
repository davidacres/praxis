# test-contracts — PRX-T111-476 / TASK-476

Stage: **WF-B4020B47-test-contracts**. Frozen implementation: `3edbca0772bdc589e42fff742423ee6c24caf1e5`; the worktree HEAD matched it and was clean at entry. This stage changes catalog documentation only.

## Result

- **Playwright catalog:** `npm run test:praxis-contracts` exit 0 — **801 Playwright tests catalogued and linked**, no warnings. TASK-476 changed no e2e spec, so `catalog.json` and `index.md` are unchanged.
- **TASK-476 Node contracts:** **13**, all in `node:test` — 10 in `teamChatTransitions.test.ts`, 3 in `aiSessionManager.test.ts`. Five are new, four strengthened or re-linked, four re-linked only.
- **Source audit** (SHA1(file + newline + title) id, exact title at the linked line, matching anchor): all 13 pass. No duplicate `## PT-` contract headings anywhere in `docs/praxis-tests`.
- **Focused run:** `npm run build:core` then `node --test packages/core/out/ai/assistant/teamChatTransitions.test.js packages/core/out/ai/aiSessionManager.test.js` — **48 passed, 0 failed, 0 skipped**. Both files are registered in `packages/core/package.json`'s test list.
- **Not run (scheduled-run policy):** full functional/theme e2e suites, live API proofs, manual theme passes. No UI changed, so there was no visual check and no screenshot.

## Coverage links

| ID | Automation (node:test) | Contract file | Change |
| --- | --- | --- | --- |
| PT-8E485B3B5F | [teamChatTransitions.test.ts:15](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L15) | [FX-BE-179](fx-be-179-conversations.md#pt-8e485b3b5f) | strengthened: conflict and replay isolation |
| PT-F7F5BC2C12 | [teamChatTransitions.test.ts:34](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L34) | FX-BE-179 | strengthened: stale write leaves state unchanged; link 27→34 |
| PT-23E865D1FD | [teamChatTransitions.test.ts:44](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L44) | FX-BE-179 | strengthened: duplicate completion isolation, post-completion replay; link 35→44 |
| PT-C84E1A276D | [teamChatTransitions.test.ts:69](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L69) | FX-BE-179 | link 52→69 |
| PT-485FAE251E | [teamChatTransitions.test.ts:74](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L74) | [FX-BE-182](fx-be-182-interruption-recovery.md#pt-485fae251e) | link 58→74 |
| PT-064522325E | [teamChatTransitions.test.ts:87](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L87) | FX-BE-182 | link 71→87 |
| PT-D03716DB85 | [teamChatTransitions.test.ts:103](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L103) | FX-BE-182 | link 87→103 |
| PT-13C1D24EAC | [teamChatTransitions.test.ts:124](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L124) | FX-BE-179 | new |
| PT-3685D04B40 | [teamChatTransitions.test.ts:136](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L136) | FX-BE-179 | new |
| PT-0C9BBBAC15 | [teamChatTransitions.test.ts:149](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L149) | FX-BE-179 | new |
| PT-CCDCE2367D | [aiSessionManager.test.ts:621](../../packages/core/src/ai/aiSessionManager.test.ts#L621) | [FX-BE-181](fx-be-181-provider-context.md#pt-ccdce2367d) | strengthened: full ownership deep-equal, provider ID absent; link 596→621 |
| PT-9C176941C7 | [aiSessionManager.test.ts:636](../../packages/core/src/ai/aiSessionManager.test.ts#L636) | FX-BE-179 | new |
| PT-9CFDECE31C | [aiSessionManager.test.ts:647](../../packages/core/src/ai/aiSessionManager.test.ts#L647) | FX-BE-179 | new |

### Acceptance criteria → contracts

| Criterion | Contracts |
| --- | --- |
| Duplicate submit with identical payload returns the original turn; same command ID with a different payload is rejected | PT-8E485B3B5F, PT-23E865D1FD (replay after completion) |
| Reject a second running turn | PT-F7F5BC2C12 (same turn), PT-13C1D24EAC (distinct turn) |
| Reject stale revision writes | PT-F7F5BC2C12 |
| Reject duplicate participant completion | PT-23E865D1FD, PT-D03716DB85 (recovered import) |
| Reject completion by a fenced attempt | PT-23E865D1FD (stale/replaced epoch), PT-3685D04B40 (superseded attempt, current epoch) |
| Distinct conversation, turn, participant and attempt IDs plus an optional provider session ID, with no title or diagnostic parsing | PT-CCDCE2367D, PT-9CFDECE31C, PT-9C176941C7; types themselves are checked by `tsc` |

## Findings

1. **Stale-revision coverage is narrow (ambiguous).** Only `startConversationTurn` is exercised at a stale revision. Stale `reserve`, `advance` and `complete` writes are not asserted directly. Their revision guard is shared, but the contracts do not claim those paths.
2. **"No association requires parsing a title or diagnostic event" is not asserted by a test.** It holds structurally: the IDs are typed fields and persistence round-trips them exactly. No test shows that a lookup avoids title parsing, so the contracts don't claim it.
3. **PT-3685D04B40 fixture shortcut.** The first attempt is marked `failed` by direct mutation, not by a transition. The contract states this.
4. **Stale line hints in contracts for files this ticket did not change (not fixed, out of scope).** These lines moved because of earlier commits such as `fafbacc8`. Titles and ids are unchanged; only line hints are stale:
   - FX-BE-181: PT-ACA148E624 `teamChatBindings.test.ts` 6→7; PT-9DCCCF8D27, PT-0A0EAED4F7, PT-86B267D61F, PT-A7F41C3F50, PT-E4566B69A9 `teamChatContext.test.ts` +2 (15/22/25/33/44 → 17/24/27/35/46); PT-8322FDF906, PT-B3B7D355CB, PT-D453C7A90A `teamChatCoordinator.test.ts` +21 (466/476/491 → 487/497/512).
   - FX-BE-182: PT-0AA1A09AEC, PT-3C03B20D14, PT-122958093E, PT-804A2C0AC4, PT-E116B00BE3 `teamChatCoordinator.test.ts` +21 (539/552/570/606/613 → 560/573/591/627/634).
   - Parameterised titles, which a literal-title audit can't match: PT-EFAC0E337F and PT-9C568AE082 (`teamChatCoordinator.test.ts:592`), and the six `teamChatRecovery.test.ts:7` matrix cases.
5. **Node contracts are still outside the generator.** `praxis-test-catalog.cjs` indexes Playwright only, so a clean validator result does not cover Node contracts. The audit above is the evidence for the 13. An extended Node inventory would make it deterministic.
