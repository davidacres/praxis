# test-contracts

Ticket: **PRX-S111-182 / FX-BE-182**. Stage: **WF-CB8E1255-test-contracts**.
Frozen implementation: `7de011ad86cb8ae95288d416765130255af2307c`. HEAD matched that revision and the worktree was clean before authoring. Inspected the supplied tracked [change-diff](../../.praxis-change-diff.patch), the frozen source and its recovery tests. The supplied patch covers repository decoding, recovery types, coordinator and transitions; it contains no test changes. Additional recovery tests are present in the frozen tree. No implementation, automated test source or workflow definition was changed in this stage.

## Exact inventory and coverage links

The deterministic inventory contains **784 Playwright contracts across 171 source files**. There are **zero duplicate IDs or file/title links**, no stale identities and no moved-line warnings. The generated [catalog](catalog.json) and [automation index](index.md) are already current and remain unchanged.

Added [16 supplemental Node contracts](fx-be-182-interruption-recovery.md), each with exact runner, source file, line, runtime title, stable generated ID and Given/When/Then assertions. These cover six expanded recovery matrix cases, five coordinator cases, three transition cases, one repository case and one adapter case. The scoped union is **800 contracts: 784 generated Playwright + 16 selected Node cases**. This is not the complete monorepo automated suite or an expanded Playwright execution count; historical supplemental documents and other Node suites are excluded. No source test was renamed or renumbered.

## Acceptance coverage and limits

| Requirement | Exact automated coverage | Assertion boundary / finding |
| --- | --- | --- |
| Recovery before dispatch / after dispatch; conservative tool-capable and opaque outcomes | [recovery matrix:7](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L7), six cases | Prepared attempts become interrupted; dispatched text becomes interrupted; dispatched tools/opaque become outcome_unknown. These are seeded pure transitions, not process crash injection at all four requested crash points. No after-tool-success crash fixture exists in this scoped suite. |
| Durable result imported once for the same attempt | [coordinator:539](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L539), [coordinator:592](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L592), [transitions:86](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L86), [repository:115](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L115) | Repeated accept/restart gives one reply; file reload preserves completion and epoch evidence, including a prepared attempt without dispatch intent. Usage references are asserted in explicit accept, not token totals or fault-injected atomic recovery. |
| No blind retry of uncertain attempt; informed resolution | [coordinator:552](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L552), [coordinator:606](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L606), [coordinator:476](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L476) | Missing acknowledgement and wrong observation reject; valid resolution records a decision and retains predecessor; direct retry rejects without repository mutation. No real read-only external-action reconciliation or later-work blocking journey is proved by these cases. |
| Late duplicate completion and epoch fencing | [transitions:35](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L35), [transitions:57](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L57), [transitions:70](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L70) | Pure transitions reject duplicate/old-epoch completion, foreign conversation result evidence and completion on a cancelled turn. No late duplicate tool-event test or another attempt's resource-claim release race is asserted. |
| Cancellation waits for execution settlement | [coordinator:570](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L570), [existing cancellation:405](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L405), [adapter:15](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L15) | Active case is cancelling until a held promise resolves, then imports that result and completes with one reply. Older case permits either cancelled or outcome_unknown. No combined completed-member retention, remaining-member skipping and queued-turn cancellation assertion; no actual CLI abort/permission integration proof. |
| Capability evidence precedes provider invocation | [production adapter:31](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L31) | Failed callback prevents launch; successful callback reports toolCapable before launch. Callback completion is exercised, not a disk crash between evidence and dispatch. |
| Partial output retained; approvals reconnected or interrupted by stable request identity | No scoped assertion found | Evidence type declarations and runtime-identity observations do not prove partial-output persistence or pending permission recovery. Reported as uncovered; no invented contract. |

Existing [assistant no-tools:882](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L882) and [tool-session reuse:917](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L917) cover provider/context behavior, not recovery. They remain historical supporting contracts, not evidence for the missing interruption journeys.

## Stale and ambiguous contracts

- Replaced the stale FX-BE-181 required report. Historical supplemental documents retain their own snapshot provenance; they are not current execution results.
- The title “recovered result imports atomically once with usage and original epoch” overstates its assertions: one reply, completion and usage references are checked, but no injected atomic-write failure or token totals. The new contract states the narrow proof.
- “active cancellation remains cancelling until execution settles and records evidence” ends completed after importing a post-abort result. It does not prove terminal cancellation. The older cancellation assertion accepts either cancelled or outcome_unknown.
- “uncertain acceptance invalidates the binding” does not assert binding status or cursor invalidation. “startup evidence and recovered reply survive repeated durable epoch changes” seeds final-result evidence; it is not a real provider crash/reconciliation experiment.
- The generator scans direct static `test(...)` calls in desktop E2E only. Dynamic titles and modified test calls are omitted, and every entry is labelled functional even for other project routing. Generic generated prose is shape-checked, not behavior-checked. Thus a passing catalog is not full-suite QA.
- The repository validator does not validate supplemental Node contracts, duplicate IDs or index consistency comprehensively. Independent checks validate these 16 source/title/line/hash links, including six expanded matrix titles, uniqueness against the catalog, and catalog/index links. IDs use SHA1(file + newline + title): line movement preserves identity; source/title renames change it.

## Verification

- `npm run build:core`: passed.
- `npm run build:desktop`: passed, including IPC sender check.
- `node --test packages/core/out/ai/assistant/teamChatRecovery.test.js packages/core/out/ai/assistant/teamChatTransitions.test.js packages/core/out/ai/assistant/teamChatCoordinator.test.js`: **30 passed, 0 failed**.
- `node --test apps/praxis-desktop/main/out/main/teamChatExecutionAdapter.test.js apps/praxis-desktop/main/out/main/adapters/teamChatRepository.test.js`: **11 passed, 0 failed**.
- `npm run test:praxis-contracts`: passed, **784 linked Playwright tests**, no warnings.
- Independent supplemental identity/source/line/title and generated catalog/index checks: passed. `git diff --check`: passed.

**41 focused Node tests passed**, including all 16 supplemental cases. No Playwright, full-suite, live-provider or visual run was performed in this documentation-only stage; no screenshots were captured. No other workflow stage was advanced or approved. The coverage gaps above remain review/QA findings.
