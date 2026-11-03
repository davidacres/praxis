# test-contracts

Ticket: PRX-S111-181 / FX-BE-181. Stage: WF-8195AF14-test-contracts.
Frozen implementation and inspected change-diff: `531c908b5821ee4ea75f4b0a17548f026cb7e55d` against its first parent. HEAD matched the snapshot and the worktree was clean before authoring. No implementation or test source was changed.

## Inventory and artifacts

The deterministic catalog contains **784 Playwright contracts across 171 source files**, with **zero duplicate IDs or file/title links**, no stale identities and no moved-line warnings. The snapshot adds **18 test registrations: 2 Playwright + 16 node:test**. The 16 new Node registrations have supplemental Given/When/Then contracts with exact runner, source, line, title and stable hashed ID. The scoped union is **800 contracts (784 generated + 16 supplemental)**; this excludes predecessor supplemental contracts and other Node suites and is not a complete monorepo runtime test count.

Coverage links: [generated contracts](catalog.json), [automation index](index.md), [16 supplemental provider/context contracts](fx-be-181-provider-context.md), [predecessor coordinator contracts](fx-be-180-coordinator.md), [deterministic validator/generator](../../apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs).

The two new Playwright entries are enriched in place without changing identity:

- **PT-31EBA5B105**, [assistant.spec.ts:882](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L882), `durable no-tools API turns retain bounded history and usage without allocating agent sessions`.
- **PT-691B8EDBF3**, [assistant.spec.ts:917](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L917), `durable tool members reuse two runtime sessions for four attempts and isolate another chat`.

## Acceptance coverage and assertion boundaries

| Requirement | Exact automation coverage | Limits / findings |
| --- | --- | --- |
| Two tool members, four attempts, two sessions; chat isolation | [assistant.spec.ts:917](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L917); [coordinator:445](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L445) | Mocked API tool runtime in e2e; coordinator stub verifies binding IDs rather than actual provider sessions. Live external account reuse is unverified. |
| No-tools completion without AgentSessionRecord; attributable usage | [assistant.spec.ts:882](../../apps/praxis-desktop/main/e2e/assistant.spec.ts#L882); [adapter:6](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L6) | E2e checks unchanged session count and 25 total tokens/one reference per turn. Adapter test injects dispatch rather than exercising production configuration resolution. |
| Compatibility changes invalidate; missing native capability reconstructs | [bindings:6](../../packages/core/src/ai/assistant/teamChatBindings.test.ts#L6); [ACP host:593](../../packages/core/src/ai/acp/acpAgentHost.test.ts#L593) | Pure configuration-dimension loop; does not exercise effective settings/account resolution in production. Scripted ACP advertises resume or no capability; it does not prove all provider-specific resume failures. |
| Current permissions revalidated; old binding cannot recover revoked access | [adapter:24](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L24) | Old digest rejects before dispatch. No actual permission revocation, old-binding selection or tool gate invocation occurs. Existing ACP permission tests pass in the focused suite, but do not establish the combined durable-chat journey. |
| Usage once per attempt; occupancy separate from spend | [coordinator:445](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L445); [session manager:128](../../packages/core/src/ai/aiSessionManager.test.ts#L128) | Duplicate reference array deduplicates; ACP unit assertion keeps context occupancy separate from token totals. No repeated provider callback/restart exactly-once accounting journey is proved. |
| Native context excludes delivered messages and own output | [context:25](../../packages/core/src/ai/assistant/teamChatContext.test.ts#L25); [ACP host:593](../../packages/core/src/ai/acp/acpAgentHost.test.ts#L593) | One prepared native selection and scripted prompt equality are tested separately. No real multi-member native provider verifies delivery once across multiple turns/recovery. |
| Fresh context includes instructions, pins, summary, recent/current; no queued future | [context:15](../../packages/core/src/ai/assistant/teamChatContext.test.ts#L15), [context:33](../../packages/core/src/ai/assistant/teamChatContext.test.ts#L33), [context:44](../../packages/core/src/ai/assistant/teamChatContext.test.ts#L44) | Tests assert message counts/IDs and selected substrings, not every prompt section or occurrence count. Late earlier-turn reply eligibility is asserted. |
| Long history retains early pin and later correction with source IDs | [context:33](../../packages/core/src/ai/assistant/teamChatContext.test.ts#L33) | 19 historical messages and an early 4000-character decision exceed old limits; exact receipt is m0, m1, current and correction metadata is present. m1 text is generic history, not a semantic correction. No model resolution of contradictory decisions is proved. |
| Unavailable summary/mandatory overflow stops dispatch visibly | [coordinator:466](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L466), [coordinator:491](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L491); [context:22](../../packages/core/src/ai/assistant/teamChatContext.test.ts#L22) | Stored context_required and zero dispatch are verified. No UI renders this state in these tests; oversized current input and tiny total budget are covered, not a dedicated oversized-pin-only fixture. |
| Uncertain acceptance invalidates cursor and enters recovery without blind resend | [coordinator:476](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L476) | Checks outcome_unknown, one dispatch and rejected retry. Despite its title, no binding status or delivery cursor is asserted, and the seeded binding has an empty compatibility digest. Recovery resolution is untested here. |
| Persistence of provenance, corrections and ownership | [repository:93](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L93); [session manager:596](../../packages/core/src/ai/aiSessionManager.test.ts#L596) | Temp file repository checks reload and invalid pinned/state rejection; manager uses an in-memory storage adapter. Neither simulates process interruption during native delivery. |

## Stale and ambiguous catalog contracts

The previous required report described FX-BE-180 at `c7199a3d` and unrelated historical QA iterations. It has been replaced for this snapshot. Predecessor supplemental documents retain their historical snapshot references intentionally; they are not current execution evidence.

The generator scans only direct static `test(...)` calls under desktop `main/e2e`. Dynamic title expressions and modified calls are omitted; all generated projects are labelled functional even for theme/live-agent routing. Thus 784 is the exact deterministic inventory count, not the expanded Playwright execution count or complete automated suite. Generic generated flows are shape-validated, not behavior-validated; this stage reviewed the snapshot's new tests rather than every historical contract.

The validator does not validate supplemental Node documents, duplicate IDs, index.md consistency or runner metadata comprehensively. Independent checks verified new supplemental source/title/line/hash links, uniqueness, and generated catalog/index identity. Stable IDs use SHA1(file + newline + title): line movement preserves identity, while file/title changes generate new IDs. No existing test was renamed or renumbered.

## Verification

- `npm run build:core` and `npm run build:desktop`: passed, including main IPC sender check.
- `node --test packages/core/out/ai/assistant/teamChatBindings.test.js packages/core/out/ai/assistant/teamChatContext.test.js packages/core/out/ai/assistant/teamChatCoordinator.test.js packages/core/out/ai/aiSessionManager.test.js packages/core/out/ai/acp/acpAgentHost.test.js`: **79 passed, 0 failed** (includes an existing nested subtest).
- `node --test apps/praxis-desktop/main/out/main/teamChatExecutionAdapter.test.js apps/praxis-desktop/main/out/main/adapters/teamChatRepository.test.js`: **9 passed, 0 failed**.
- `npm run test:praxis-contracts`: passed, **784 linked Playwright contracts**, no warnings. Independent supplemental link/ID and catalog/index checks passed. `git diff --check`: passed.

**88 focused Node tests passed** across seven files, including all 16 new Node registrations. The two new Playwright tests were inspected but not executed in this catalog-only stage. No full suite, live-provider or visual verification was performed; no screenshots were captured. Catalog validation is static contract evidence, not a claim that 784 end-to-end tests passed. Findings above remain for review/QA; no workflow stage was advanced or approved.
