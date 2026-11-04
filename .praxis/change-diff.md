# change-diff — PRX-S111-182 (FX-BE-182), recovery iteration 3

## Scope and findings

The incoming revision already includes `1ed88e02`, which addresses the four review findings. This pass verifies and strengthens that repair.

1. Pre-dispatch final results import through the recovered-result path without a dispatch-intent requirement. Identity, originating epoch, latest-attempt and duplicate-import fences remain enforced. Added foreign-identity rejection checks and an explicit missing-result-ID fence. Empty final reply text is now recognized as durable evidence, including across repeated startup imports.
2. Results settling after abort use the same importer. Cancellation settlement coverage verifies one committed reply and retained reconciliation evidence.
3. Evidence retains the originating epoch in `coordinatorEpoch` and the later observing epoch in typed `observingEpoch`. The repository round-trip test reloads later-epoch reconciliation evidence across repeated restarts.
4. Direct unknown-outcome retry explicitly requires `resolveAttempt` with reconciliation evidence and duplicate-risk acknowledgement. Existing coverage proves rejection leaves storage unchanged.
5. The QA shelf assertion omitted the 24px overflow button from the centred group, causing a deterministic 12px offset. It now measures the entire group with the same one-pixel tolerance and waits for layout settlement. Product layout is unchanged.
6. The broad suite exposed an inherited scheduler test expecting manual recovery after attempt one. The runner already retries autonomously through its three-attempt budget. Updated the fixture to verify terminal failure retention and a successful replacement workflow. The retry marker now lives outside Git so the existing clean-base gate remains enforced. No workflow or product retry policy changed.

## Verification

Passed:

- `npm run build:core`
- `npm run test:core`: 1,912 passed, 2 skipped; permitted rerun after restricted loopback EPERM. Rerun passed after the final core changes.
- `npm run check-types`: all workspaces.
- `npm run build:renderer`
- `npm run desktop:copy-renderer`
- `npm run build:desktop`
- `npm run test:desktop:git`: 118 passed, including durable repository and execution-adapter coverage; rerun passed after final core changes.
- Focused `assistant.spec.ts`, `quickSession.spec.ts`, `aiPermissions.spec.ts`, `sessionShelf.spec.ts`: 36 passed, original shelf assertion failed; corrected shelf test passed separately.
- `npm run test:desktop`: 731 passed, 14 skipped, 4 failed in the initial four-worker broad run. All four failures plus corrected shelf geometry passed in a final serial rerun (5/5). Three pointer-sensitive cases passed unchanged in isolation; the scheduler fixture was repaired as described above. The broad run itself is not reported green. Overlapping the early shelf rerun also disrupted Playwright trace output; subsequent reruns were serial.
- Test catalog regenerated; `npm run test:praxis-contracts`: 784 tests catalogued and linked.
- `git diff --check`

The shelf hover screenshot was visually inspected and retained at `.praxis/session-artifacts/fxbe182-session-shelf-hover.png`. The card remains flush against the rail. No screenshot baselines were updated. This pass changes backend recovery and test fixtures, with no product UI changes.

Runtime evidence uses deterministic scripted ACP and mock API providers. No real-provider calls were made. Renderer cutover/recovery controls remain FX-BE-183; feature-wide visual/theme/real-provider release evidence remains FX-BE-184. No ticket transitions, dependency installation, publishing or workflow definition changes were performed.

## Patch

```diff
diff --git a/apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts b/apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts
index 7332313c..fc1c0054 100644
--- a/apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts
+++ b/apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts
@@ -923,9 +923,12 @@ test('quitting with a schedule pending asks first, and offers to minimise instea
   expect(await page.evaluate(() => window.praxis.scheduledRuns.list().then(list => list.length))).toBe(1);
 });

-test('an idle failed stage pauses the schedule and retries in the same workflow', async () => {
-  const { page, projectId, repo } = await launch({ env: { PRAXIS_E2E_SCHEDULE_TICK_MS: '500' } });
-  const marker = path.join(repo, 'retry-ready');
+test('an exhausted stage pauses the schedule and retrying the ticket preserves its failed workflow', async () => {
+  const { page, projectId } = await launch({ env: { PRAXIS_E2E_SCHEDULE_TICK_MS: '500' } });
+  // Keep the barrier outside Git: retrying a ticket correctly refuses a dirty base.
+  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-retry-marker-'));
+  tempDirs.push(markerDir);
+  const marker = path.join(markerDir, 'retry-ready');
   const workflowId = await page.evaluate(async ({ projectId, marker }) => {
     const now = new Date().toISOString();
     const id = 'schedule-retry-stage';
@@ -949,8 +952,10 @@ test('an idle failed stage pauses the schedule and retries in the same workflow'
   const flight = page.getByTestId('schedule-flight-card');
   await expect(flight).toHaveCount(1);
   await expect(flight.locator('[data-testid="schedule-task-row"][data-node="build"]')).toHaveAttribute('data-lane', 'failed');
-  await expect(flight.getByTestId('schedule-stage-failure')).toContainText('Build — needs attention');
-  await expect(flight.getByTestId('schedule-stage-failure')).toContainText('Attempt 1 of 3');
+  // The scheduler retries autonomously until the stage budget is exhausted.
+  await expect(flight.locator('[data-node="build"]')).toContainText('×3');
+  await expect(flight.getByTestId('schedule-stage-failure')).toHaveCount(0);
+  await expect(flight.getByTestId('schedule-retry')).toHaveText('Retry ticket');
   await expect(page.getByTestId('schedule-pause-banner')).toHaveAttribute('data-reason', 'failure');
   await expect(flight.getByTestId('schedule-review-workflow')).toBeVisible();
   await expect(page.getByTestId('schedule-deck-card')).toHaveCount(1);
@@ -959,12 +964,16 @@ test('an idle failed stage pauses the schedule and retries in the same workflow'
   await page.screenshot({ path: path.join(shots, 'scheduled-run-stage-failure.png') });
   fs.writeFileSync(marker, 'ready');
   await flight.getByTestId('schedule-retry').click();
-  // Retried, Build passed on its second attempt, and the approval stage was determined autonomously to complete the run.
-  await expect.poll(async () => (await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId))[0].status, { timeout: 10000 }).toBe('succeeded');
+  // A terminal failure remains auditable; ticket retry launches a fresh workflow.
+  await expect.poll(async () => (await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId)).filter(run => run.status === 'succeeded').length, { timeout: 10000 }).toBeGreaterThan(0);
   await expect(page.getByTestId('schedule-stage-failure')).toHaveCount(0);
   const after = await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId);
-  expect(after.map(run => run.runId)).toEqual(before.map(run => run.runId));
-  expect(after[0].stages.find(stage => stage.nodeId === 'build')?.attempts).toBe(2);
+  const original = after.find(run => run.runId === before[0].runId)!;
+  expect(original.status).toBe('failed');
+  expect(original.stages.find(stage => stage.nodeId === 'build')?.attempts).toBe(3);
+  const retried = after.find(run => run.runId !== original.runId && run.status === 'succeeded')!;
+  expect(retried).toBeDefined();
+  expect(retried.stages.find(stage => stage.nodeId === 'build')?.attempts).toBe(1);
 });

 test('the stage-failure panel names the stage it shows, beside a stage paused for a missing tool or script', async () => {
diff --git a/apps/praxis-desktop/main/e2e/sessionShelf.spec.ts b/apps/praxis-desktop/main/e2e/sessionShelf.spec.ts
index 93c65292..613dd4ef 100644
--- a/apps/praxis-desktop/main/e2e/sessionShelf.spec.ts
+++ b/apps/praxis-desktop/main/e2e/sessionShelf.spec.ts
@@ -81,13 +81,13 @@ test('collapsed session shelf shows the last 5 sessions, distinguishes today, an
   expect(spineVisuals.todayHeight).toBeGreaterThan(spineVisuals.earlierHeight);
   expect(spineVisuals.todayOpacity).toBeGreaterThan(spineVisuals.earlierOpacity);
   expect(spineVisuals.todayColor).toBe(spineVisuals.earlierColor);
-  const centred = await shelf.evaluate(element => {
+  await expect.poll(() => shelf.evaluate(element => {
     const bounds = element.querySelector('.session-shelf__spines')!.getBoundingClientRect();
-    const spines = element.querySelectorAll('.session-shelf__spine');
-    return Math.abs((spines[0].getBoundingClientRect().top + spines[spines.length - 1].getBoundingClientRect().bottom) / 2
+    // The overflow button belongs to the centred group alongside the five spines.
+    const entries = element.querySelectorAll('.session-shelf__spine, .session-shelf__more');
+    return Math.abs((entries[0].getBoundingClientRect().top + entries[entries.length - 1].getBoundingClientRect().bottom) / 2
       - (bounds.top + bounds.bottom) / 2);
-  });
-  expect(centred).toBeLessThanOrEqual(1);
+  })).toBeLessThanOrEqual(1);
   const cards = page.getByTestId('session-shelf-card');
   await expect(cards).toHaveCount(0);
   // Reproduce the missing-colour-token regression: inactive spines disappeared.
diff --git a/docs/praxis-tests/catalog.json b/docs/praxis-tests/catalog.json
index d6a10ee0..aef74ac2 100644
--- a/docs/praxis-tests/catalog.json
+++ b/docs/praxis-tests/catalog.json
@@ -8198,8 +8198,8 @@
       }
     },
     {
-      "id": "PT-7600A815C3",
-      "title": "an idle failed stage pauses the schedule and retries in the same workflow",
+      "id": "PT-F574E99346",
+      "title": "an exhausted stage pauses the schedule and retrying the ticket preserves its failed workflow",
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
@@ -8209,7 +8209,7 @@
       "area": "scheduled Runs",
       "flow": {
         "given": "the Praxis desktop test fixture is prepared in an isolated application context",
-        "when": "an idle failed stage pauses the schedule and retries in the same workflow",
+        "when": "an exhausted stage pauses the schedule and retrying the ticket preserves its failed workflow",
         "then": "the automated assertions for this test pass and record the described user-visible result"
       }
     },
@@ -8219,7 +8219,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 970,
+        "line": 979,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8235,7 +8235,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1019,
+        "line": 1028,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8251,7 +8251,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1053,
+        "line": 1062,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8267,7 +8267,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1100,
+        "line": 1109,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8283,7 +8283,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1128,
+        "line": 1137,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8299,7 +8299,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1196,
+        "line": 1205,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8315,7 +8315,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1227,
+        "line": 1236,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8331,7 +8331,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1253,
+        "line": 1262,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8347,7 +8347,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1314,
+        "line": 1323,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8363,7 +8363,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1356,
+        "line": 1365,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8379,7 +8379,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1384,
+        "line": 1393,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8395,7 +8395,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1455,
+        "line": 1464,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8411,7 +8411,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1473,
+        "line": 1482,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8427,7 +8427,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1536,
+        "line": 1545,
         "project": "functional"
       },
       "area": "scheduled Runs",
diff --git a/docs/praxis-tests/index.md b/docs/praxis-tests/index.md
index 25ae21ed..c688094f 100644
--- a/docs/praxis-tests/index.md
+++ b/docs/praxis-tests/index.md
@@ -516,21 +516,21 @@ This catalogue describes **784 Playwright tests** under `apps/praxis-desktop/mai
 | PT-76F292ED66 | scheduled Runs | the editor can Run now without a scheduled start time and still obeys the provider budget gate | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:850` |
 | PT-9EBCCE6CC4 | scheduled Runs | a ticket that cannot be launched pauses the run with the reason, keeps its order, and can be skipped | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:867` |
 | PT-6890A4393F | scheduled Runs | quitting with a schedule pending asks first, and offers to minimise instead | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:909` |
-| PT-7600A815C3 | scheduled Runs | an idle failed stage pauses the schedule and retries in the same workflow | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:926` |
-| PT-5153FD33AA | scheduled Runs | the stage-failure panel names the stage it shows, beside a stage paused for a missing tool or script | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:970` |
-| PT-EB1C51515B | scheduled Runs | a workflow whose check stage needs a tool that is not installed is refused before the run starts | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1019` |
-| PT-7C571CC649 | scheduled Runs | a ticket whose working copy cannot be set up pauses the schedule with the reason instead of hanging, and a retry carries on | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1053` |
-| PT-2370A6254B | scheduled Runs | an older schedule refresh cannot overwrite a newer failure status | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1100` |
-| PT-9BE6F17E92 | scheduled Runs | an agent request file becomes an ordered draft while Praxis is running, and the skill that explains it is installed | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1128` |
-| PT-5BB7C25EC5 | scheduled Runs | parallel lanes are a deliberate choice in the editor: a budget warning shows, and the choice survives saving | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1196` |
-| PT-6DDE4C4F48 | scheduled Runs | auto-detect parallel button detects independent tasks and sets them as parallel using the selected parallel number | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1227` |
-| PT-984829ACD0 | scheduled Runs | two independent tickets run at once within the cap, a third waits for a lane and the next step waits for the first | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1253` |
-| PT-57F1A1F35B | scheduled Runs | two parallel tickets that both merge into the base checkout take turns | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1314` |
-| PT-13C1844C59 | scheduled Runs | an approval gate is determined autonomously and recorded in the run ledger without waiting for user input | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1356` |
-| PT-AE3B01630D | scheduled Runs | a long run's report folds repeats: stops by kind, a bouncing hand-over once, one row per ticket | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1384` |
-| PT-6B8DD4C416 | scheduled Runs | a parallel run whose readiness is blocked starts nothing in any lane and says why | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1455` |
-| PT-794E9F0536 | scheduled Runs | a schedule whose workflow needs trust can be reviewed and trusted from its row and from the editor | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1473` |
-| PT-2C5ADB8DC0 | scheduled Runs | a schedule paused on an untrusted workflow offers to review and trust it, then carries on | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1536` |
+| PT-F574E99346 | scheduled Runs | an exhausted stage pauses the schedule and retrying the ticket preserves its failed workflow | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:926` |
+| PT-5153FD33AA | scheduled Runs | the stage-failure panel names the stage it shows, beside a stage paused for a missing tool or script | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:979` |
+| PT-EB1C51515B | scheduled Runs | a workflow whose check stage needs a tool that is not installed is refused before the run starts | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1028` |
+| PT-7C571CC649 | scheduled Runs | a ticket whose working copy cannot be set up pauses the schedule with the reason instead of hanging, and a retry carries on | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1062` |
+| PT-2370A6254B | scheduled Runs | an older schedule refresh cannot overwrite a newer failure status | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1109` |
+| PT-9BE6F17E92 | scheduled Runs | an agent request file becomes an ordered draft while Praxis is running, and the skill that explains it is installed | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1137` |
+| PT-5BB7C25EC5 | scheduled Runs | parallel lanes are a deliberate choice in the editor: a budget warning shows, and the choice survives saving | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1205` |
+| PT-6DDE4C4F48 | scheduled Runs | auto-detect parallel button detects independent tasks and sets them as parallel using the selected parallel number | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1236` |
+| PT-984829ACD0 | scheduled Runs | two independent tickets run at once within the cap, a third waits for a lane and the next step waits for the first | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1262` |
+| PT-57F1A1F35B | scheduled Runs | two parallel tickets that both merge into the base checkout take turns | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1323` |
+| PT-13C1844C59 | scheduled Runs | an approval gate is determined autonomously and recorded in the run ledger without waiting for user input | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1365` |
+| PT-AE3B01630D | scheduled Runs | a long run's report folds repeats: stops by kind, a bouncing hand-over once, one row per ticket | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1393` |
+| PT-6B8DD4C416 | scheduled Runs | a parallel run whose readiness is blocked starts nothing in any lane and says why | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1464` |
+| PT-794E9F0536 | scheduled Runs | a schedule whose workflow needs trust can be reviewed and trusted from its row and from the editor | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1482` |
+| PT-2C5ADB8DC0 | scheduled Runs | a schedule paused on an untrusted workflow offers to review and trust it, then carries on | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1545` |
 | PT-4BED3303D0 | security Remediation | unregistered renderers cannot read settings or emit privileged one-way messages | `apps/praxis-desktop/main/e2e/securityRemediation.spec.ts:15` |
 | PT-119034639B | security Remediation | OAuth rejects missing, mismatched and replayed state without consuming the legitimate authorization | `apps/praxis-desktop/main/e2e/securityRemediation.spec.ts:27` |
 | PT-29ECE51EF8 | security Remediation | secret reads repair permissive file modes and encrypted values remain retrievable | `apps/praxis-desktop/main/e2e/securityRemediation.spec.ts:50` |
diff --git a/packages/core/src/ai/assistant/teamChatCoordinator.test.ts b/packages/core/src/ai/assistant/teamChatCoordinator.test.ts
index be914336..6a8eb9e5 100644
--- a/packages/core/src/ai/assistant/teamChatCoordinator.test.ts
+++ b/packages/core/src/ai/assistant/teamChatCoordinator.test.ts
@@ -589,9 +589,9 @@ test('active cancellation remains cancelling until execution settles and records
   assert.ok(turn.attempts[0].recoveryEvidence!.some(e => e.provenance === 'execution-settled-after-abort'));
 });

-test('startup imports durable results once across repeated coordinator replacements', async () => {
+for (const text of ['restart result', '']) test('startup imports durable results once across repeated coordinator replacements: ' + JSON.stringify(text), async () => {
   const { repo, turn, attempt } = await recoveryFixture('outcome_unknown');
-  attempt.recoveryEvidence!.push({ ...attempt.recoveryEvidence![0], id: 'final', kind: 'final_result', result: { text: 'restart result' } });
+  attempt.recoveryEvidence!.push({ ...attempt.recoveryEvidence![0], id: 'final', kind: 'final_result', result: { text } });
   let invocations = 0;
   for (let i = 0; i < 2; i++) {
     const coordinator = new TeamChatCoordinator({ repository: repo, idSource: () => 'epoch-' + i,
@@ -599,7 +599,7 @@ test('startup imports durable results once across repeated coordinator replaceme
     await coordinator.initialize();
   }
   assert.equal(invocations, 0);
-  assert.equal(repo.read().conversations[0].messages.filter(m => m.text === 'restart result').length, 1);
+  assert.equal(repo.read().conversations[0].messages.filter(m => m.role === 'lead' && m.text === text).length, 1);
   assert.equal(repo.read().conversations[0].turns.find(t => t.id === turn.id)!.state, 'completed');
 });

diff --git a/packages/core/src/ai/assistant/teamChatCoordinator.ts b/packages/core/src/ai/assistant/teamChatCoordinator.ts
index 7953d408..3c39bc7f 100644
--- a/packages/core/src/ai/assistant/teamChatCoordinator.ts
+++ b/packages/core/src/ai/assistant/teamChatCoordinator.ts
@@ -131,7 +131,7 @@ export class TeamChatCoordinator {
         for (const turn of updated.turns) {
           const attempt = turn.attempts.at(-1);
           if (attempt && ['interrupted', 'outcome_unknown'].includes(attempt.state) &&
-              attempt.recoveryEvidence?.some(e => e.kind === 'final_result' && (e.result?.text ?? e.data?.text))) {
+              attempt.recoveryEvidence?.some(e => e.kind === 'final_result' && typeof (e.result?.text ?? e.data?.text) === 'string')) {
             await this.importRecoveredResult(updated.id, turn.id, attempt.id);
           }
         }
@@ -443,7 +443,7 @@ export class TeamChatCoordinator {
       const t = conv.turns.find(item => item.id === turnId);
       const a = t?.attempts.find(item => item.id === attemptId);
       if (a?.state === 'completed' && a.resultMessageId) return conv;
-      const evidence = a?.recoveryEvidence?.find(item => item.kind === 'final_result' && (item.result?.text ?? item.data?.text));
+      const evidence = a?.recoveryEvidence?.find(item => item.kind === 'final_result' && typeof (item.result?.text ?? item.data?.text) === 'string');
       if (!a || !t || !evidence) {
         throw new Error('Cannot accept an attempt without a recovered final result.');
       }
diff --git a/packages/core/src/ai/assistant/teamChatTransitions.test.ts b/packages/core/src/ai/assistant/teamChatTransitions.test.ts
index 6b31be84..a223936a 100644
--- a/packages/core/src/ai/assistant/teamChatTransitions.test.ts
+++ b/packages/core/src/ai/assistant/teamChatTransitions.test.ts
@@ -42,6 +42,7 @@ test('completion atomically records final reply and context; duplicate and fence
   assert.throws(() => completeConversationAttempt(reserved, 4, 't', 'a', 'old', reply, attempt.contextReceipt), /fenced/);
   const fenced = structuredClone(reserved); fenced.coordinatorEpoch = 'new';
   assert.throws(() => completeConversationAttempt(fenced, 4, 't', 'a', 'epoch', reply, attempt.contextReceipt), /fenced/);
+  assert.throws(() => completeConversationAttempt(reserved, 4, 't', 'a', 'epoch', reply, attempt.contextReceipt, {}, 'missing-result'), /fenced/);
   const done = completeConversationAttempt(reserved, 4, 't', 'a', 'epoch', reply, attempt.contextReceipt);
   assert.equal(done.turns[0].state, 'completed');
   assert.equal(done.turns[0].attempts[0].resultMessageId, 'r');
@@ -93,6 +94,11 @@ test('pre-dispatch recovery requires exact durable result and imports only once'
   a.recoveryEvidence!.push({ id: 'result', conversationId: 'c', turnId: 't', participantId: 'p',
     attemptId: 'a', coordinatorEpoch: 'epoch', kind: 'final_result', observedAt: 'now', provenance: 'adapter',
     result: { text: reply.text } });
+  for (const field of ['conversationId', 'turnId', 'participantId', 'attemptId', 'coordinatorEpoch'] as const) {
+    const foreign = structuredClone(recovered);
+    foreign.turns[0].attempts[0].recoveryEvidence!.at(-1)![field] = 'foreign';
+    assert.throws(() => completeConversationAttempt(foreign, 4, 't', 'a', 'epoch', reply, a.contextReceipt, {}, 'result'), /fenced/);
+  }
   const completed = completeConversationAttempt(recovered, 4, 't', 'a', 'epoch', reply, a.contextReceipt, {}, 'result');
   assert.equal(completed.turns[0].attempts[0].state, 'completed');
   assert.throws(() => completeConversationAttempt(completed, 5, 't', 'a', 'epoch', reply, a.contextReceipt, {}, 'result'), /duplicate|fenced/);
diff --git a/packages/core/src/ai/assistant/teamChatTransitions.ts b/packages/core/src/ai/assistant/teamChatTransitions.ts
index 493fa8fc..89497f26 100644
--- a/packages/core/src/ai/assistant/teamChatTransitions.ts
+++ b/packages/core/src/ai/assistant/teamChatTransitions.ts
@@ -82,7 +82,7 @@ export function completeConversationAttempt(current: DurableConversation, expect
     item.id === recoveredResultId && item.kind === 'final_result' && item.conversationId === current.id &&
     item.turnId === turnId && item.attemptId === attemptId && item.participantId === attempt.participantId &&
     item.coordinatorEpoch === attempt.coordinatorEpoch && (item.result?.text ?? item.data?.text) === message.text);
-  if (!turn || !attempt || (recovered && !['interrupted', 'outcome_unknown', 'failed'].includes(turn.state)) || (!recovered && (turn.state !== 'running' || epoch !== current.coordinatorEpoch || epoch !== attempt.coordinatorEpoch)) ||
+  if (!turn || !attempt || (recoveredResultId !== undefined && !recovered) || (recovered && !['interrupted', 'outcome_unknown', 'failed'].includes(turn.state)) || (!recovered && (turn.state !== 'running' || epoch !== current.coordinatorEpoch || epoch !== attempt.coordinatorEpoch)) ||
       (!(recovered ? ['interrupted', 'outcome_unknown', 'failed'] : ['dispatching', 'running', 'awaiting_approval']).includes(attempt.state) || (!recovered && !attempt.dispatchIntent)) || turn.attempts.filter(item => item.participantId === attempt.participantId).at(-1)?.id !== attemptId ||
       turn.completedParticipantIds.includes(attempt.participantId) || message.turnId !== turnId || message.participantId !== attempt.participantId ||
       message.role !== turn.plan.participants.find(item => item.id === attempt.participantId)?.role || next.messages.some(item => item.id === message.id) ||
```
