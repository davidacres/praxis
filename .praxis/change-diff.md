# change-diff — PRX-S111-184 / WF-0C7166C7-implement

Base `e6e3e8a0`; implementation `47c0f4fd`, keyboard verification harness `64e542df`.

Adds queued page/image wire coverage, production identity compatibility coverage, independent native reuse evidence, explicit window activation for keyboard tests, and current verification provenance. No production/workflow behavior changed. Full suite not completed and live API skipped by user instruction; release acceptance stays open.

```diff
diff --git a/apps/praxis-desktop/main/e2e/durableTeamChat.live.spec.ts b/apps/praxis-desktop/main/e2e/durableTeamChat.live.spec.ts
index 6bb11f59..42348949 100644
--- a/apps/praxis-desktop/main/e2e/durableTeamChat.live.spec.ts
+++ b/apps/praxis-desktop/main/e2e/durableTeamChat.live.spec.ts
@@ -76,9 +76,18 @@ async function continuationAcrossRestart(label: string, seed: Record<string, unk
   const conversation = (await win.evaluate(id => window.praxis.assistant.getConversation(id), id))!;
   const attempts = conversation.turns.flatMap(turn => turn.attempts.map(attempt => ({ turnId: turn.id, attemptId: attempt.id, participantId: attempt.participantId, state: attempt.state,
     coordinatorEpoch: attempt.coordinatorEpoch, bindingId: attempt.bindingId, providerSessionId: attempt.providerSessionId,
-    contextReceipt: attempt.contextReceipt, usage: attempt.usage })));
+    contextReceipt: attempt.contextReceipt, nativeContextReceipt: attempt.nativeContextReceipt,
+    recoveryEvidence: attempt.recoveryEvidence, usage: attempt.usage })));
+  const sessionReuse = ['part-dev', 'part-lead'].map(participantId => {
+    const member = attempts.filter(attempt => attempt.participantId === participantId);
+    const reused = Boolean(member[0]?.providerSessionId && member[0].providerSessionId === member[1]?.providerSessionId);
+    return { participantId, reused, firstBindingId: member[0]?.bindingId, secondBindingId: member[1]?.bindingId,
+      firstSessionId: member[0]?.providerSessionId, secondSessionId: member[1]?.providerSessionId,
+      proof: reused ? 'native-session-reused' : 'context-reconstructed-native-reuse-unproved' };
+  });
   const evidence = { check: label, codename, conversationId: id, recordedAt: new Date().toISOString(), runtimeOptions,
     bindings: conversation.bindings.map(({ id, providerRuntime, status, providerSessionId, deliveredMessageIds }) => ({ id, providerRuntime, status, providerSessionId, delivered: deliveredMessageIds.length })),
+    sessionReuse, nativeReuseProved: sessionReuse.every(member => member.reused),
     attempts, replies: conversation.messages.filter(m => m.role !== 'user').map(m => m.text) };
   fs.mkdirSync(ARTIFACTS, { recursive: true });
   fs.writeFileSync(path.join(ARTIFACTS, `durable-team-chat-live-${label}.json`), JSON.stringify(evidence, null, 2));
@@ -88,10 +97,16 @@ async function continuationAcrossRestart(label: string, seed: Record<string, unk
     const memberAttempts = attempts.filter(attempt => attempt.participantId === participantId);
     expect(memberAttempts).toHaveLength(3);
     expect(memberAttempts[2].coordinatorEpoch).not.toBe(memberAttempts[0].coordinatorEpoch);
+    expect(memberAttempts.every(attempt => attempt.state === 'completed')).toBe(true);
+    if (sessionReuse.find(member => member.participantId === participantId)!.reused) {
+      expect(memberAttempts[1].bindingId).toBe(memberAttempts[0].bindingId);
+    }
     for (const attempt of memberAttempts) expect(attempt.contextReceipt.messageIds).toContain(conversation.messages[0].id);
   }
   const firstTurnSessions = conversation.turns[0].attempts.map(attempt => attempt.providerSessionId).filter(Boolean);
   if (firstTurnSessions.length) expect(new Set(firstTurnSessions).size).toBe(2);
+  const secondTurnSessions = conversation.turns[1].attempts.map(attempt => attempt.providerSessionId).filter(Boolean);
+  if (secondTurnSessions.length) expect(new Set(secondTurnSessions).size).toBe(2);
   // The third turn's context includes the pinned decision, whether reused natively or reconstructed.
   const firstMessage = conversation.messages[0].id;
   const third = conversation.turns[2].attempts.at(-1)!;
diff --git a/apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts b/apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts
index 81d87c7e..81db7d9d 100644
--- a/apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts
+++ b/apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts
@@ -185,9 +185,12 @@ test('keyboard cancellation preserves accepted messages and cancels only the sel
     await win.getByTestId('assistant-send').click();
     const queued = win.getByTestId('assistant-turn-status').filter({ hasText: 'Queued' });
     await expect(queued).toHaveCount(1);
+    // Electron's native keyboard target can belong to another concurrently launched window.
+    await win.bringToFront();
     await queued.getByRole('button', { name: 'Cancel queued turn' }).press('Enter');
     await expect(queued).toHaveCount(0);
     await expect(win.getByTestId('assistant-turn-status')).toContainText('dev: running');
+    await win.bringToFront();
     await win.getByRole('button', { name: 'Stop', exact: true }).press('Enter');
     await expect(win.getByTestId('assistant-turn-status')).toHaveCount(0);
     await expect(win.getByTestId('assistant-message-user')).toHaveText(['Active accepted message', 'Queued accepted message']);
@@ -487,3 +490,62 @@ test('a CLI member without resume capability reconstructs context on its second
     fs.rmSync(path.dirname(promptLog), { recursive: true, force: true });
   }
 });
+
+test('queued page context and staged image reach the provider after navigation and composer replacement', async () => {
+  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-queued-image-'));
+  const promptLog = path.join(folder, 'prompts.jsonl');
+  try {
+    app = await launchTestApp({ ai: { activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath: path.resolve(__dirname, 'fixtures/fakeAcpAgent.mjs') } } } }, undefined,
+      { FAKE_ACP_PROMPT_LOG: promptLog }, { openNewSession: false });
+    const win = app.window;
+    const id = await win.evaluate(() => window.praxis.assistant.createChat('').then(chat => chat.id));
+    // Hold the first dispatch without using a timing assumption about provider speed.
+    await app.electronApp.evaluate((_electron, modulePath) => {
+      const coordinator = process.getBuiltinModule('module')!.createRequire(modulePath)(modulePath).getTeamChatCoordinator();
+      const execute = coordinator.executionAdapter.execute.bind(coordinator.executionAdapter);
+      let first = true;
+      const gate = new Promise<void>(resolve => { coordinator.releaseQueuedImageTest = resolve; });
+      coordinator.executionAdapter.execute = async (params: unknown) => {
+        if (first) {
+          first = false;
+          await gate;
+        }
+        return execute(params);
+      };
+    }, path.resolve(__dirname, '../out/main/assistantIpc.js'));
+    const original = await win.evaluate(async ({ id, folder }) => {
+      const runtimeOptions = { provider: 'claude-code-cli' as const, toolMode: 'read-only' as const, workingDirectory: folder };
+      const submit = async (text: string, attachmentRefs: import('@praxis/core').ConversationAttachment[] = [], context?: import('@praxis/core').SubmitConversationCommand['context']) => {
+        const snapshot = (await window.praxis.assistant.getConversation(id))!;
+        return window.praxis.assistant.submitTurn({ conversationId: id, commandId: crypto.randomUUID(), expectedRevision: snapshot.revision,
+          text, selectedParticipantIds: ['part-dev'], attachmentRefs, runtimeOptions, ...(context ? { context } : {}) });
+      };
+      await submit('First queued-image test turn');
+      const refs = await window.praxis.assistant.stageAttachments(id, [{ mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }]);
+      await submit('IMAGE_ECHO captured question', refs, { pageType: 'issue', entityId: 'ORIGINAL-184', title: 'Original issue', summary: 'Captured page sentinel' });
+      // A later composer image is staged, but was never attached to this accepted turn.
+      await window.praxis.assistant.stageAttachments(id, [{ mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }]);
+      return refs;
+    }, { id, folder });
+    const queued = (await win.evaluate(id => window.praxis.assistant.getConversation(id), id))!;
+    expect(queued.turns[1].state).toBe('queued');
+    await win.reload();
+    await app.electronApp.evaluate((_electron, modulePath) => {
+      process.getBuiltinModule('module')!.createRequire(modulePath)(modulePath).getTeamChatCoordinator().releaseQueuedImageTest();
+    }, path.resolve(__dirname, '../out/main/assistantIpc.js'));
+    await expect.poll(() => win.evaluate(async id => (await window.praxis.assistant.getConversation(id))?.turns[1].state, id), { timeout: 20000 }).toBe('completed');
+    const conversation = (await win.evaluate(id => window.praxis.assistant.getConversation(id), id))!;
+    const message = conversation.messages.find(message => message.id === conversation.turns[1].userMessageId)!;
+    expect(message.attachments).toEqual(original);
+    expect(conversation.turns[1].plan.context?.entityId).toBe('ORIGINAL-184');
+    expect(conversation.messages.at(-1)?.text).toContain('IMAGES_RECEIVED:1:image/png');
+    const prompts = fs.readFileSync(promptLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { promptText: string });
+    expect(prompts).toHaveLength(2);
+    expect(prompts[0].promptText).not.toContain('Captured page sentinel');
+    expect(prompts[1].promptText).toContain('Captured page sentinel');
+  } finally {
+    if (app) await closeTestApp(app);
+    app = undefined;
+    fs.rmSync(folder, { recursive: true, force: true });
+  }
+});
diff --git a/apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts b/apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts
index 4e4e2182..103907a8 100644
--- a/apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts
+++ b/apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts
@@ -86,3 +86,37 @@ test('unverified CLI identity cannot be stabilized by turn or participant accoun
     assert.equal(second.providerRuntime, first.providerRuntime);
   }
 });
+
+test('production API compatibility follows credentials, model and policy without exposing credentials', async () => {
+  const { DEFAULT_APP_SETTINGS, resolveTeamChatBinding } = await import('@praxis/core');
+  let apiKey = 'fixture-key-first';
+  const adapter = createProductionTeamChatExecutionAdapter({
+    settings: () => structuredClone(DEFAULT_APP_SETTINGS),
+    resolveRuntimeConfiguration: async () => 'fixture-runtime',
+    resolveConnectionOptions: async () => ({ apiKey, model: 'fixture-model' }),
+    completeWithTools: async () => { throw new Error('prepare must not dispatch'); }
+  });
+  const params = {
+    conversation: { id: 'chat' },
+    participant: { id: 'lead', instructionVersion: '1', instructions: 'help', defaults: {} },
+    turn: { id: 'first', plan: { runtimeOptions: { provider: 'vercel-gateway', toolMode: 'project-only', permissionMode: 'manual' } } }
+  } as unknown as TeamChatExecutionParams;
+  const first = await adapter.prepare!(params);
+  const bindings: import('@praxis/core').ConversationBinding[] = [];
+  const initial = resolveTeamChatBinding(bindings, first, 'first-binding');
+  params.turn.id = 'second';
+  assert.equal(resolveTeamChatBinding(bindings, await adapter.prepare!(params), 'unused'), initial);
+  assert.ok(!JSON.stringify(first).includes(apiKey), 'resolved identity must not contain the API key');
+  apiKey = 'fixture-key-second';
+  const changedAccount = await adapter.prepare!(params);
+  assert.notEqual(changedAccount.accountReference, first.accountReference);
+  assert.equal(resolveTeamChatBinding(bindings, changedAccount, 'replacement').id, 'replacement');
+  assert.equal(initial.status, 'invalid');
+  const changes: Record<string, string>[] = [{ model: 'changed-model' }, { permissionMode: 'auto' }, { toolMode: 'read-only' }];
+  for (const change of changes) {
+    const original = params.turn.plan.runtimeOptions;
+    params.turn.plan.runtimeOptions = { ...original, ...change };
+    assert.notDeepEqual(await adapter.prepare!(params), changedAccount);
+    params.turn.plan.runtimeOptions = original;
+  }
+});
diff --git a/docs/praxis-tests/catalog.json b/docs/praxis-tests/catalog.json
index 778c1c0d..de8b1e82 100644
--- a/docs/praxis-tests/catalog.json
+++ b/docs/praxis-tests/catalog.json
@@ -3,7 +3,7 @@
   "generatedBy": "apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs",
   "runner": "playwright",
   "scope": "apps/praxis-desktop/main/e2e",
-  "testCount": 800,
+  "testCount": 801,
   "tests": [
     {
       "id": "PT-DD79DC7C96",
@@ -5099,7 +5099,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/durableTeamChat.live.spec.ts",
-        "line": 103,
+        "line": 118,
         "project": "functional"
       },
       "area": "durable Team Chat.live",
@@ -5115,7 +5115,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/durableTeamChat.live.spec.ts",
-        "line": 116,
+        "line": 131,
         "project": "functional"
       },
       "area": "durable Team Chat.live",
@@ -5211,7 +5211,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts",
-        "line": 203,
+        "line": 206,
         "project": "functional"
       },
       "area": "durable Team Chat",
@@ -5227,7 +5227,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts",
-        "line": 256,
+        "line": 259,
         "project": "functional"
       },
       "area": "durable Team Chat",
@@ -5243,7 +5243,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts",
-        "line": 292,
+        "line": 295,
         "project": "functional"
       },
       "area": "durable Team Chat",
@@ -5259,7 +5259,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts",
-        "line": 323,
+        "line": 326,
         "project": "functional"
       },
       "area": "durable Team Chat",
@@ -5275,7 +5275,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts",
-        "line": 392,
+        "line": 395,
         "project": "functional"
       },
       "area": "durable Team Chat",
@@ -5291,7 +5291,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts",
-        "line": 427,
+        "line": 430,
         "project": "functional"
       },
       "area": "durable Team Chat",
@@ -5307,7 +5307,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts",
-        "line": 463,
+        "line": 466,
         "project": "functional"
       },
       "area": "durable Team Chat",
@@ -5317,6 +5317,22 @@
         "then": "the fixture's second prompt contains both SECOND_TURN and FIRST_TURN_SENTINEL, and the second attempt's context receipt lists both first-turn message ids"
       }
     },
+    {
+      "id": "PT-EE0AB4E23D",
+      "title": "queued page context and staged image reach the provider after navigation and composer replacement",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts",
+        "line": 494,
+        "project": "functional"
+      },
+      "area": "durable Team Chat",
+      "flow": {
+        "given": "An isolated durable conversation with a held first dispatch, a queued issue-context turn and a staged PNG.",
+        "when": "A different composer image is staged, the renderer reloads and the first dispatch is released.",
+        "then": "Both turns complete; only the queued provider prompt contains the captured page sentinel, its durable attachment refs remain identical and the ACP agent receives exactly one PNG."
+      }
+    },
     {
       "id": "PT-5D69F1868B",
       "title": "EasyMode exposes the shared sidebar material through its feed and header",
diff --git a/docs/praxis-tests/fx-be-184-release-proof.md b/docs/praxis-tests/fx-be-184-release-proof.md
index 05dfac65..55b90b22 100644
--- a/docs/praxis-tests/fx-be-184-release-proof.md
+++ b/docs/praxis-tests/fx-be-184-release-proof.md
@@ -262,3 +262,25 @@ Title: **queued page identity and attachment references survive caller mutation
 **Given** a running turn held behind a barrier and a second accepted turn with issue context and an image reference.
 **When** the caller changes the page identity, summary, draft and attachment list before releasing the first turn.
 **Then** the queued provider invocation receives the original page identity, summary, text and immutable image reference. Both turns complete.
+
+## WF-0C7166C7 implementation additions
+
+### PT-DD3C1A1EA1
+
+Automation: **node:test**, [teamChatExecutionAdapter.test.ts:90](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L90).
+Title: **production API compatibility follows credentials, model and policy without exposing credentials**.
+
+**Given** the production adapter resolving an API credential and captured policy.
+**When** a second turn keeps the configuration, then the credential, model or policy changes.
+**Then** compatible turns keep one binding; credential rotation invalidates it; model and policy changes alter compatibility; the resolved configuration contains no plaintext credential. This proves binding compatibility, not native CLI authentication or resume capability.
+
+### PT-EE0AB4E23D
+
+Automation: **Playwright**, [durableTeamChat.spec.ts:494](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L494).
+Title: **queued page context and staged image reach the provider after navigation and composer replacement**.
+
+**Given** a temporary profile, coordination root, attachment store and scripted ACP provider, with the first dispatch held at a barrier.
+**When** an issue-context turn and PNG are queued, a replacement composer image is staged and the renderer reloads before dispatch is released.
+**Then** the queued turn keeps its original page identity and immutable attachment references; only its prompt contains the captured page sentinel; the agent receives exactly one PNG. The earlier prompt excludes the future queued page context.
+
+The live-provider checks now retain per-member reuse classification, native context receipts and runtime recovery evidence. Six distinct completed attempts and session isolation are asserted; a reconstruction pass explicitly leaves native reuse unproved. Production has no authoritative CLI account reference, so the conservative per-turn identity remains in place.
diff --git a/docs/praxis-tests/fx-be-184-retained-evidence.md b/docs/praxis-tests/fx-be-184-retained-evidence.md
index 28346502..b85fa976 100644
--- a/docs/praxis-tests/fx-be-184-retained-evidence.md
+++ b/docs/praxis-tests/fx-be-184-retained-evidence.md
@@ -503,3 +503,143 @@ The current full functional run passed the previously recorded assistant drag/re
 The final focused command was `npm run test:e2e --workspace=@praxis/desktop-main -- assistant.spec.ts quickSession.spec.ts durableTeamChat.spec.ts standaloneConversations.spec.ts --project=functional`: **45 passed**, 0 failed, 0 skipped, on `6d627c90`.

 Release acceptance remains open: supply `PRAXIS_LIVE_API_PROVIDER` and `PRAXIS_LIVE_API_KEY` (and optionally `PRAXIS_LIVE_API_MODEL`) through the supported environment and rerun the live check; provide authoritative CLI account/resume capability before counting native reuse; complete the remaining manual journey; resolve the unconditional permission-matrix state discrepancy and obtain a clean full functional run. None of those gaps is represented by mock evidence or catalog validation.
+
+## WF-0C7166C7 current execution
+
+Execution source: `47c0f4fd`; final durable keyboard harness: `64e542df`. Full suite not completed; live API skipped by user instruction. Logs below are current, separate from inherited evidence above. Raw temp logs may expire; retained hashes and tails identify their results.
+
+### core-permitted
+
+Source: `/tmp/fx184-implement-core-permitted.log`. SHA256: `16e4d0d65496edd6adf1299fac068f221859b1ec9a8652ae7bd8c4668ffdee3d`.
+
+```text
+✔ isPortableFolderPath reports whether a stored path will travel (0.052333ms)
+ℹ tests 1942
+ℹ suites 9
+ℹ pass 1940
+ℹ fail 0
+ℹ cancelled 0
+ℹ skipped 2
+ℹ todo 0
+ℹ duration_ms 11681.0665
+```
+
+### main-final
+
+Source: `/tmp/fx184-implement-main-final.log`. SHA256: `745182aa1ff83cf98172ea916e12c10a66db9c3dfc2ac0b9e4592b233093c581`.
+
+```text
+✔ saveWindowStateSync: persists bounds from BrowserWindow mock (14.740459ms)
+ℹ tests 141
+ℹ suites 0
+ℹ pass 141
+ℹ fail 0
+ℹ cancelled 0
+ℹ skipped 0
+ℹ todo 0
+ℹ duration_ms 8188.832667
+```
+
+### renderer
+
+Source: `/tmp/fx184-implement-renderer.log`. SHA256: `8b2ea47b2ccb2ea044673edf785ea455227209dfac1a91896c68444d24a6c3c1`.
+
+```text
+✔ keys, tokens, money and durations read short (13.077666ms)
+ℹ tests 34
+ℹ suites 0
+ℹ pass 34
+ℹ fail 0
+ℹ cancelled 0
+ℹ skipped 0
+ℹ todo 0
+ℹ duration_ms 6306.016459
+```
+
+### types-final
+
+Source: `/tmp/fx184-implement-types-final.log`. SHA256: `51d94c0337861376a40c3eca26d153776547311e23045a250b47457242cc2a2d`.
+
+```text
+
+
+> @praxis/mobile-protocol@0.0.0 check-types
+> tsc --noEmit -p .
+
+
+> @praxis/mobile-relay@0.0.0 check-types
+> tsc --noEmit -p .
+
+```
+
+### renderer-build
+
+Source: `/tmp/fx184-implement-renderer-build.log`. SHA256: `60abf557a36285f42d1d66d22723a2416658bae1c0a5a47a6560f77ebb6d9351`.
+
+```text
+
+> desktop:copy-renderer
+> npm run copy-renderer --workspace=@praxis/desktop-main
+
+
+> @praxis/desktop-main@0.6.1 copy-renderer
+> node scripts/copy-renderer.cjs
+
+copied /Users/daveacres/dev/tools/praxis/.worktrees/WF-C10627E5-governed-delivery-fx-be-184-durable-team-chat-re/apps/praxis-desktop/renderer/dist -> /Users/daveacres/dev/tools/praxis/.worktrees/WF-C10627E5-governed-delivery-fx-be-184-durable-team-chat-re/apps/praxis-desktop/main/renderer
+```
+
+### desktop-build
+
+Source: `/tmp/fx184-implement-desktop-build.log`. SHA256: `5abe6a66c2837265a4c94e9cdcd4e233744bedc3f05912426fa48f914300b58c`.
+
+```text
+
+
+> @praxis/desktop-main@0.6.1 compile
+> npm run check-ipc-senders && tsc -p .
+
+
+> @praxis/desktop-main@0.6.1 check-ipc-senders
+> node scripts/checkTrustedIpc.cjs
+
+```
+
+### focused-final
+
+Source: `/tmp/fx184-implement-focused-final.log`. SHA256: `0f04cdea1271ca598995ff4657201bff44c5dca876517f826e8d851841173451`.
+
+```text
+  1 failed
+  45 passed (2.8m)
+```
+
+### durable-final
+
+Source: `/tmp/fx184-implement-durable-final.log`. SHA256: `1c2690c267df3f63c763ecbbf488bf246b8a18e4c3948e06712eb7e8c05a27dc`.
+
+```text
+[6/13] [functional] › e2e/durableTeamChat.spec.ts:206:5 › an unconfirmed submission retries its original command after both acknowledgements are lost
+[7/13] [functional] › e2e/durableTeamChat.spec.ts:259:5 › an app restart mid-reply leaves the turn for the user to resolve; nothing is replayed
+[8/13] [functional] › e2e/durableTeamChat.spec.ts:295:5 › a queued turn resumes after restart before any chat is opened
+[9/13] [functional] › e2e/durableTeamChat.spec.ts:326:5 › a storage write failure is shown and the accepted transcript remains
+[10/13] [functional] › e2e/durableTeamChat.spec.ts:395:5 › re-opening a team chat whose first load failed reads its transcript again
+[11/13] [functional] › e2e/durableTeamChat.spec.ts:430:5 › a tool member's pending permission is attached to its attempt and a restart never reuses the approval
+[12/13] [functional] › e2e/durableTeamChat.spec.ts:466:5 › a CLI member without resume capability reconstructs context on its second turn
+[13/13] [functional] › e2e/durableTeamChat.spec.ts:494:5 › queued page context and staged image reach the provider after navigation and composer replacement
+  13 passed (1.3m)
+```
+
+### catalog-final
+
+Source: `/tmp/fx184-implement-catalog-final.log`. SHA256: `5440996828891ec7e2bca126e90af10c82bed736638ec2c0fa82748ba12f5a27`.
+
+```text
+Wrote 801 Praxis Test contracts to docs/praxis-tests (801 existing contracts carried over).
+
+> test:praxis-contracts
+> node apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs
+
+Praxis Tests: 801 Playwright tests catalogued and linked.
+```
+
+Visually inspected light-theme artifact: `.praxis/session-artifacts/WF-0C7166C7-two-windows.png`, 468697 bytes, SHA256 `9e17079ad3bc12f772f0dc2108af90c8143ce0ac3a4062518759e3a06a80a83e`. Automated evidence only; manual dark/light checklist remains incomplete.
diff --git a/docs/praxis-tests/fx-be-184-verification-report.md b/docs/praxis-tests/fx-be-184-verification-report.md
index a58bd5cf..39ddbc1f 100644
--- a/docs/praxis-tests/fx-be-184-verification-report.md
+++ b/docs/praxis-tests/fx-be-184-verification-report.md
@@ -1,5 +1,41 @@
 # FX-BE-184 durable team-chat release verification report

+
+## WF-0C7166C7 final implementation evidence
+
+Implementation commits: `47c0f4fd` (queue/image wire assertion, production compatibility test and live evidence classification), `64e542df` (native window activation before keyboard controls). This section describes current execution; all older sections below are historical evidence and do not establish current release acceptance.
+
+User direction: do not execute the full e2e suite or live API check. **Full suite: not run to completion; no passing result.** Earlier invocations were interrupted (exit 130: 14 passed / 4 interrupted / 746 unrun, then 37 passed / 4 interrupted / 723 unrun). Neither was restarted after the final instruction. **Live API: skipped by instruction**, not passed; no credentials requested. Real CLI and separate theme projects were not repeated. The focused assistant test still exercises its theme/surface-pack contrast assertions.
+
+Current commands: `npm run build:core`, `npm run check-types`, `npm run build:renderer`, `npm run desktop:copy-renderer`, `npm run build:desktop` exited 0. `npm run test:core`: **1,940 passed, 2 skipped, 0 failed**; `npm run test:desktop:git`: **141 passed**; `npm run test:renderer`: **34 passed**. Initial sandbox runs had loopback EPERM and watcher EMFILE; unchanged permitted runs passed. Core/renderer production sources were unchanged by these implementation commits.
+
+Focused command: `npm run test:e2e --workspace=@praxis/desktop-main -- e2e/assistant.spec.ts e2e/quickSession.spec.ts e2e/durableTeamChat.spec.ts e2e/standaloneConversations.spec.ts --project=functional --reporter=line --output=/tmp/fx184-focused-final-results`: **45 passed, 1 failed**, exit 1. The queued-cancellation Enter interaction retained the queue despite DOM focus. Explicit native window activation was added before keyboard cancellation and Stop. Subsequent `npm run test:e2e --workspace=@praxis/desktop-main -- e2e/durableTeamChat.spec.ts --project=functional --reporter=line --output=/tmp/fx184-durable-final-results`: **13 passed, 0 failed/skipped**, exit 0 (1.3 min), using the final test source in `64e542df`. This targeted pass does not rewrite the initial focused failure. Earlier queue-fixture failures (undefined JSON field and release-barrier initialization race) were fixed before the passing wire test.
+
+Catalog generation and `npm run test:praxis-contracts`: exit 0, **801** linked Playwright contracts. Registration remains in the existing owning suites; no check or assertion was weakened. [Retained evidence](fx-be-184-retained-evidence.md#wf-0c7166c7-current-execution) contains log hashes and output tails. [Assertion supplement](fx-be-184-release-proof.md#wf-0c7166c7-implementation-additions) names the added tests.
+
+The AC1–AC12 matrix below remains the full coverage map. For current execution provenance: its core assertions ran in the core runner, persistence/adapter assertions in main's `test:git`, subscription assertions in `test:renderer`, and assistant/quick-session/standalone assertions in the focused Electron runner. All use production revision `47c0f4fd`; final durable Electron assertions use test revision `64e542df`. Each runner's retained artifact is indexed in the current evidence section. Unexecuted live/manual claims remain unresolved.
+
+| Criterion | Exact current named assertion or explicit gap | Runner / current result | Evidence |
+| --- | --- | --- | --- |
+| AC1 | duplicate runtime events and a duplicate submit command converge to one turn and one usage reference | core / pass | core log |
+| AC2 | production API compatibility follows credentials, model and policy without exposing credentials; real native CLI reuse unresolved | main / pass; live unexecuted | main log; native reuse classification in live spec |
+| AC3 | two windows converge, queue capture survives navigation and stale controls cannot cancel replacement work | durable Electron / pass | durable log; retained screenshot |
+| AC4 | a pending approval at crash is never reused by the replacement attempt | core / pass | core log; unconditional interrupted matrix remains discrepant where prior tool activity cannot be excluded |
+| AC5 | queued page context and staged image reach the provider after navigation and composer replacement | durable Electron / pass | durable log; PT-EE0AB4E23D |
+| AC6 | every resolved compatibility dimension invalidates reuse and switching back stays fresh | core / pass | core log; production API test adds credential/policy proof |
+| AC7 | migration is deterministic, lossless, isolated and never schedules imported history | core / pass | core log; legacy provable association remains unavailable |
+| AC8 | a standalone chat stays navigable beside the single team-chat row | focused Electron / pass | focused log; classic sidebar absent, EasyModeSidebar remains applicable |
+| AC9 | keyboard cancellation preserves accepted messages and cancels only the selected queued turn | durable Electron / pass after harness fix | durable log; initial focused failure retained |
+| AC10 | pre-rename failure preserves committed bytes and rejects acknowledgement; next mutation uses old state | main / pass | main log |
+| AC11 | Preview then Apply updates the ticket; Apply is refused on an incompatible page | focused Electron / pass | focused log; complete manual journey unresolved |
+| AC12 | 801 catalog entries validated; no complete full-suite or live API result claimed | catalog / pass, release gate open | catalog log and this report |
+
+Visual inspection: opened the current two-window screenshot and checked both accepted user messages, both member replies, one sidebar conversation row and 50-token usage. Preserved separately as `.praxis/session-artifacts/WF-0C7166C7-two-windows.png`; publish at handoff. This is automated light-theme evidence, not completion of the prescribed hand-driven light/dark journey. No snapshots were updated.
+
+All new fixture data, profiles, coordination roots, attachment storage and logs use temporary directories; injected dispatch barriers die with the isolated app. No user data or repository plans are used as write targets. Existing backup/rollback boundaries below remain unchanged. Production still reconstructs unverified CLI identities; pending approvals cannot exclude prior external actions, so `outcome_unknown` and reconciliation/duplicate-risk gates remain intact.
+
+Implementation additions and focused verification are complete. Release acceptance remains open for real API proof, authoritative native CLI reuse, the complete manual journey and a completed full functional run. No ticket or workflow stage was advanced.
+
 Ticket: **PRX-S111-184 / FX-BE-184** (TASK-486, TASK-487). Feature: **FX-BF-111**. Base: `c6e81e86`.
 Node:test contracts: [fx-be-184-release-proof.md](fx-be-184-release-proof.md). Playwright contracts: [catalog.json](catalog.json) (800 tests, curated flows for every new id).

diff --git a/docs/praxis-tests/index.md b/docs/praxis-tests/index.md
index 92d48a12..15461110 100644
--- a/docs/praxis-tests/index.md
+++ b/docs/praxis-tests/index.md
@@ -1,6 +1,6 @@
 # Praxis Test catalogue

-This catalogue describes **800 Playwright tests** under `apps/praxis-desktop/main/e2e`. Each entry is a structured English contract linked to its exact source file and line. Run `npm run test:praxis-contracts` to detect drift before QA.
+This catalogue describes **801 Playwright tests** under `apps/praxis-desktop/main/e2e`. Each entry is a structured English contract linked to its exact source file and line. Run `npm run test:praxis-contracts` to detect drift before QA.

 | ID | Area | Test | Automation |
 | --- | --- | --- | --- |
@@ -322,20 +322,21 @@ This catalogue describes **800 Playwright tests** under `apps/praxis-desktop/mai
 | PT-FEA2A13581 | coordination Wait | a person clicking in the in-app browser takes it from the agent driving it | `apps/praxis-desktop/main/e2e/coordinationWait.spec.ts:148` |
 | PT-3DF668A3C4 | css Tokens | --border-subtle follows the theme border and --radius-xs scales with the display | `apps/praxis-desktop/main/e2e/cssTokens.spec.ts:13` |
 | PT-F55156EA04 | dead Connection | an unreachable connection is skipped instead of blanking the board list | `apps/praxis-desktop/main/e2e/deadConnection.spec.ts:31` |
-| PT-1D3CF0B299 | durable Team Chat.live | real CLI member continues a durable team chat across an app restart | `apps/praxis-desktop/main/e2e/durableTeamChat.live.spec.ts:103` |
-| PT-75844A4FF6 | durable Team Chat.live | real API member continues a durable team chat across an app restart | `apps/praxis-desktop/main/e2e/durableTeamChat.live.spec.ts:116` |
+| PT-1D3CF0B299 | durable Team Chat.live | real CLI member continues a durable team chat across an app restart | `apps/praxis-desktop/main/e2e/durableTeamChat.live.spec.ts:118` |
+| PT-75844A4FF6 | durable Team Chat.live | real API member continues a durable team chat across an app restart | `apps/praxis-desktop/main/e2e/durableTeamChat.live.spec.ts:131` |
 | PT-592434CA9B | durable Team Chat | two windows converge, queue capture survives navigation and stale controls cannot cancel replacement work | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:13` |
 | PT-D8BE3D65EB | durable Team Chat | subscription buffers a racing revision and discards responses after selection changes | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:70` |
 | PT-C44D501ACA | durable Team Chat | unknown outcome requires recorded reconciliation and acknowledged retry, then converges to a committed reply | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:101` |
 | PT-EA127A3852 | durable Team Chat | a migrated chat continues from imported history without reusing unproved runtime identity | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:142` |
 | PT-829EB33638 | durable Team Chat | keyboard cancellation preserves accepted messages and cancels only the selected queued turn | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:173` |
-| PT-204ED6FAA3 | durable Team Chat | an unconfirmed submission retries its original command after both acknowledgements are lost | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:203` |
-| PT-2B5E9C8D8A | durable Team Chat | an app restart mid-reply leaves the turn for the user to resolve; nothing is replayed | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:256` |
-| PT-E29A82FCB9 | durable Team Chat | a queued turn resumes after restart before any chat is opened | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:292` |
-| PT-F202472C30 | durable Team Chat | a storage write failure is shown and the accepted transcript remains | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:323` |
-| PT-2467F68DB7 | durable Team Chat | re-opening a team chat whose first load failed reads its transcript again | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:392` |
-| PT-0DD1738998 | durable Team Chat | a tool member's pending permission is attached to its attempt and a restart never reuses the approval | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:427` |
-| PT-2633FBDC53 | durable Team Chat | a CLI member without resume capability reconstructs context on its second turn | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:463` |
+| PT-204ED6FAA3 | durable Team Chat | an unconfirmed submission retries its original command after both acknowledgements are lost | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:206` |
+| PT-2B5E9C8D8A | durable Team Chat | an app restart mid-reply leaves the turn for the user to resolve; nothing is replayed | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:259` |
+| PT-E29A82FCB9 | durable Team Chat | a queued turn resumes after restart before any chat is opened | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:295` |
+| PT-F202472C30 | durable Team Chat | a storage write failure is shown and the accepted transcript remains | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:326` |
+| PT-2467F68DB7 | durable Team Chat | re-opening a team chat whose first load failed reads its transcript again | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:395` |
+| PT-0DD1738998 | durable Team Chat | a tool member's pending permission is attached to its attempt and a restart never reuses the approval | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:430` |
+| PT-2633FBDC53 | durable Team Chat | a CLI member without resume capability reconstructs context on its second turn | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:466` |
+| PT-EE0AB4E23D | durable Team Chat | queued page context and staged image reach the provider after navigation and composer replacement | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:494` |
 | PT-5D69F1868B | easymode | EasyMode exposes the shared sidebar material through its feed and header | `apps/praxis-desktop/main/e2e/easymode.spec.ts:30` |
 | PT-E4A060174B | easymode | legacy enableEasyMode false still uses the sole sidebar | `apps/praxis-desktop/main/e2e/easymode.spec.ts:69` |
 | PT-D7A1079D36 | easymode | Preview omits retired switches and the sole sidebar stays active | `apps/praxis-desktop/main/e2e/easymode.spec.ts:79` |
```
