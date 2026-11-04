# test-contracts

Ticket: **PRX-S111-182 / FX-BE-182**. Stage: **WF-CB8E1255-test-contracts**.
Frozen implementation: `5843c95e9b813738de067dbd6fa87dd92755200b`. HEAD matched that revision and the worktree was clean before authoring. Inspected the tracked [change-diff](../../.praxis/change-diff.md), frozen source and recovery tests. Code intelligence returned stale matches, so source inspection used this worktree. Only catalog documentation is changed in this stage.

## Exact inventory and coverage links

The deterministic inventory contains **784 Playwright contracts across 171 source files**. There are **zero duplicate IDs or file/title links**, no stale identities and no moved-line warnings. The generated [catalog](catalog.json) and [automation index](index.md) are already current; two Given/When/Then flows are enriched and retain their generated identities.

Added [17 supplemental Node contracts](fx-be-182-interruption-recovery.md), each with exact runner, source file, line, runtime title, stable generated ID and Given/When/Then assertions. These cover six expanded recovery matrix cases, six coordinator cases, three transition cases, one repository case and one adapter case. The scoped union is **801 contracts: 784 generated Playwright + 17 selected Node cases**. This is not the complete monorepo automated suite or an expanded Playwright execution count; historical supplemental documents and other Node suites are excluded. No source test was renamed or renumbered.

## Acceptance coverage and limits

| Requirement | Exact automated coverage | Assertion boundary / finding |
| --- | --- | --- |
| Recovery before dispatch / after dispatch; conservative tool-capable and opaque outcomes | [recovery matrix:7](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L7), six cases | Prepared attempts become interrupted; dispatched text becomes interrupted; dispatched tools/opaque become outcome_unknown. These are seeded pure transitions, not process crash injection at all four requested crash points. No after-tool-success crash fixture exists in this scoped suite. |
| Durable result imported once for the same attempt | [coordinator:539](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L539), [coordinator:592](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L592), [transitions:87](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L87), [repository:115](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L115) | Repeated accept/restart gives one reply; file reload preserves completion and epoch evidence, including a prepared attempt without dispatch intent. Usage references are asserted in explicit accept, not token totals or fault-injected atomic recovery. |
| No blind retry of uncertain attempt; informed resolution | [coordinator:552](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L552), [coordinator:606](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L606), [coordinator:476](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L476) | Missing acknowledgement and wrong observation reject; valid resolution records a decision and retains predecessor; direct retry rejects without repository mutation. No real read-only external-action reconciliation or later-work blocking journey is proved by these cases. |
| Late duplicate completion and epoch fencing | [transitions:35](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L35), [transitions:58](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L58), [transitions:71](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L71) | Pure transitions reject duplicate/old-epoch completion, foreign conversation, turn, participant, attempt and epoch result evidence and completion on a cancelled turn. No late duplicate tool-event test or another attempt's resource-claim release race is asserted. |
| Cancellation waits for execution settlement | [coordinator:570](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L570), [existing cancellation:405](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L405), [adapter:15](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L15) | Active case is cancelling until a held promise resolves, then imports that result and completes with one reply. Older case permits either cancelled or outcome_unknown. No combined completed-member retention, remaining-member skipping and queued-turn cancellation assertion; no actual CLI abort/permission integration proof. |
| Capability evidence precedes provider invocation | [production adapter:31](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L31) | Failed callback prevents launch; successful callback reports toolCapable before launch. Callback completion is exercised, not a disk crash between evidence and dispatch. |
| Partial output retained; approvals reconnected or interrupted by stable request identity | No scoped assertion found | Evidence type declarations and runtime-identity observations do not prove partial-output persistence or pending permission recovery. Reported as uncovered; no invented contract. |

Existing [assistant no-tools:882](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L882) and [tool-session reuse:917](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L917) cover provider/context behavior, not recovery. They remain historical supporting contracts, not evidence for the missing interruption journeys.

## Stale and ambiguous contracts

- Refreshed the stale report snapshot and split its obsolete startup-import title into the two exact runtime titles (nonempty and empty reply). Three transition links moved by one line and are refreshed without changing IDs. The old unsuffixed ID is retired because that runtime title no longer exists. Scheduler ID PT-F574E99346 is retained; its prior title-derived ID PT-7600A815C3 was replaced in the frozen implementation when the asserted retry behavior changed. Historical supplemental documents retain their own snapshot provenance; they are not current execution results.
- The title “recovered result imports atomically once with usage and original epoch” overstates its assertions: one reply, completion and usage references are checked, but no injected atomic-write failure or token totals. The new contract states the narrow proof.
- “active cancellation remains cancelling until execution settles and records evidence” ends completed after importing a post-abort result. It does not prove terminal cancellation. The older cancellation assertion accepts either cancelled or outcome_unknown.
- “uncertain acceptance invalidates the binding” does not assert binding status or cursor invalidation. “startup evidence and recovered reply survive repeated durable epoch changes” seeds final-result evidence; it is not a real provider crash/reconciliation experiment.
- The generator scans direct static `test(...)` calls in desktop E2E only. Dynamic titles and modified test calls are omitted, and every entry is labelled functional even for other project routing. Generic generated prose is shape-checked, not behavior-checked. Thus a passing catalog is not full-suite QA.
- The repository validator does not validate supplemental Node contracts, duplicate IDs or index consistency comprehensively. Independent checks validate these 17 source/title/line/hash links, including six expanded matrix titles, uniqueness against the catalog, and catalog/index links. IDs use SHA1(file + newline + title): line movement preserves identity; source/title renames change it.

## Verification

- `npm run build:core`: passed.
- `npm run build:desktop`: passed, including IPC sender check.
- `node --test packages/core/out/ai/assistant/teamChatRecovery.test.js packages/core/out/ai/assistant/teamChatTransitions.test.js packages/core/out/ai/assistant/teamChatCoordinator.test.js`: **31 passed, 0 failed**.
- `node --test apps/praxis-desktop/main/out/main/teamChatExecutionAdapter.test.js apps/praxis-desktop/main/out/main/adapters/teamChatRepository.test.js`: **11 passed, 0 failed**.
- `npm run test:praxis-contracts`: passed, **784 linked Playwright tests**, no warnings.
- Independent supplemental identity/source/line/title and generated catalog/index checks: passed. `git diff --check`: passed.

**42 focused Node tests passed**, including all 17 supplemental cases. No Playwright, full-suite, live-provider or visual run was performed in this documentation-only stage; no screenshots were captured. No other workflow stage was advanced or approved. The coverage gaps above remain review/QA findings.

## Returned QA finding

The reported shelf failure (1 failed, 50 passed, 4 skipped) was addressed in the frozen implementation at [sessionShelf.spec.ts:84](../../apps/praxis-desktop/main/e2e/sessionShelf.spec.ts#L84): the centring measurement now includes the 24px overflow button and polls layout settlement, retaining the one-pixel tolerance. Omitting the button produced a 12px offset. The enriched contract states the actual measured group. The supplied change-diff records a passing serial rerun; this documentation stage does not claim a fresh Playwright run or a green broad suite. Its initial broad run had four failures, subsequently passing in focused serial reruns.
