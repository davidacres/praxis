# test-contracts — PRX-T111-481 / TASK-481

Audit of the existing FX-BE-181 context implementation against TASK-481. No production defect was found; only tests were added, in
[teamChatContext.test.ts](../../packages/core/src/ai/assistant/teamChatContext.test.ts) and
[teamChatCoordinator.test.ts](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts) (in-memory repositories, no provider or credentials).

| Criterion | Test | Given / When / Then |
| --- | --- | --- |
| AC1 | `TASK-481 AC1: native continuation omits own reply…` (context); `TASK-481 AC1: second-turn native prompt repeats neither…` (coordinator) | Two members, two turns → the second-turn native prompt lacks the member's own reply and earlier delivered messages, and contains the peer reply and intervening/current turn once. |
| AC2 | `TASK-481 AC2: a fresh binding gets instructions…` | Fresh binding → instructions, pinned decision, summary version, recent messages and current turn once each; queued future turn absent. |
| AC3 | `TASK-481 AC3: long fixture beyond legacy limits…` | >12 messages and >3000 chars → pinned early decision and later correction kept, related by `decisionCorrections`, summary `sourceMessageIds` asserted. |
| AC4 | `TASK-481 AC4: oversized pinned context, missing pinned source…` (context); `TASK-481 AC4: unavailable summarizer, oversized current input…` (coordinator) | Budget, missing-source and attachment failures throw `TeamChatContextRequired`; the coordinator ends `context_required`, emits the event, never calls `execute`, summary attempts ≤ 8. |
| AC5 | `TASK-481 AC5: uncertain acceptance invalidates the cursor…` | `TeamChatAcceptanceUnknown` → binding `invalid`, delivered ids unchanged, one `execute` call, turn `outcome_unknown`; a fresh binding starts with no delivered ids (full reconstruction). |

Executed: `cd packages/core && npx tsc -p . && node --test out/ai/assistant/teamChatContext.test.js out/ai/assistant/teamChatCoordinator.test.js out/ai/assistant/teamChatTransitions.test.js out/ai/assistant/teamChatBindings.test.js out/ai/assistant/teamChatCrashBoundaries.test.js` → 64 passed, 0 failed.
Not run (scheduled-run policy): full functional/theme e2e suites, live-provider proofs, manual theme passes.
