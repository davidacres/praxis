# test-contracts — PRX-T111-480 / TASK-480

Audit of the existing FX-BE-181 implementation against TASK-480. No production defect was found; only tests were added, in
[teamChatExecutionAdapter.test.ts](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts) (production adapter, temp folders, local HTTP stub, no credentials).

| Criterion | Test | Given / When / Then |
| --- | --- | --- |
| AC1 | `TASK-480 AC1: two compatible API tool members reuse provider sessions…` | Two API tool members, two turns, then a second chat → four dispatches, two bindings and two `ASSISTANT-<binding>` session keys; the other chat shares none. |
| AC2 | `TASK-480 AC2: a no-tools API member completes without a tool session…` | project-only API member against a local SSE stub → `completeWithTools` never called, no provider session id, usage with `attempt:<id>` reference. |
| AC3 | `TASK-480 AC3: endpoint, instruction version and folder realpath…`; `…without native resume reconstructs…` | Endpoint, instruction text/version or folder realpath changes → digest changes (symlink to the same folder does not); no native resume → reconstruction prompt sent. |
| AC4 | `TASK-480 AC4: changed permissions invalidate an old binding…` | auto→manual and full→read-only → execute rejected before any provider call; switching back never revives the invalid binding. |
| AC5 | `TASK-480 AC5: tool-runtime usage is attributed once per attempt…` | Terminal record with usage and context tokens → exactly one `attempt:<id>` reference. |

Executed: `cd apps/praxis-desktop/main && npm run compile && node --test out/main/teamChatExecutionAdapter.test.js` → 13 passed, 0 failed.
Not run (scheduled-run policy): full functional/theme e2e suites, live-provider proofs, manual theme passes.
