# change-diff — PRX-S111-184 (WF-0C7166C7-implement)

Base: `e6e3e8a0`. Targeted verification additions; no production behavior or workflow definitions changed.

- Add a registered Electron/ACP queue test for captured page identity and immutable staged images after renderer reload.
- Verify production API binding compatibility across turns, credential rotation, model and policy changes without exposing credentials.
- Retain separate real-provider native reuse classification, native receipts and runtime evidence. Preserve conservative unverified CLI identity.
- Refresh catalog and scoped assertion documentation. Runtime results and unresolved acceptance requirements remain in the verification report.

## Patch

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
index 81d87c7e..aaa47238 100644
--- a/apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts
+++ b/apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts
@@ -487,3 +487,62 @@ test('a CLI member without resume capability reconstructs context on its second
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
index 778c1c0d..26f5fd60 100644
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
+        "line": 491,
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
index 05dfac65..5c6c756c 100644
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
+Automation: **Playwright**, [durableTeamChat.spec.ts:491](../../apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts#L491).
+Title: **queued page context and staged image reach the provider after navigation and composer replacement**.
+
+**Given** a temporary profile, coordination root, attachment store and scripted ACP provider, with the first dispatch held at a barrier.
+**When** an issue-context turn and PNG are queued, a replacement composer image is staged and the renderer reloads before dispatch is released.
+**Then** the queued turn keeps its original page identity and immutable attachment references; only its prompt contains the captured page sentinel; the agent receives exactly one PNG. The earlier prompt excludes the future queued page context.
+
+The live-provider checks now retain per-member reuse classification, native context receipts and runtime recovery evidence. Six distinct completed attempts and session isolation are asserted; a reconstruction pass explicitly leaves native reuse unproved. Production has no authoritative CLI account reference, so the conservative per-turn identity remains in place.
diff --git a/docs/praxis-tests/index.md b/docs/praxis-tests/index.md
index 92d48a12..508286bd 100644
--- a/docs/praxis-tests/index.md
+++ b/docs/praxis-tests/index.md
@@ -1,6 +1,6 @@
 # Praxis Test catalogue

-This catalogue describes **800 Playwright tests** under `apps/praxis-desktop/main/e2e`. Each entry is a structured English contract linked to its exact source file and line. Run `npm run test:praxis-contracts` to detect drift before QA.
+This catalogue describes **801 Playwright tests** under `apps/praxis-desktop/main/e2e`. Each entry is a structured English contract linked to its exact source file and line. Run `npm run test:praxis-contracts` to detect drift before QA.

 | ID | Area | Test | Automation |
 | --- | --- | --- | --- |
@@ -322,8 +322,8 @@ This catalogue describes **800 Playwright tests** under `apps/praxis-desktop/mai
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
@@ -336,6 +336,7 @@ This catalogue describes **800 Playwright tests** under `apps/praxis-desktop/mai
 | PT-2467F68DB7 | durable Team Chat | re-opening a team chat whose first load failed reads its transcript again | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:392` |
 | PT-0DD1738998 | durable Team Chat | a tool member's pending permission is attached to its attempt and a restart never reuses the approval | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:427` |
 | PT-2633FBDC53 | durable Team Chat | a CLI member without resume capability reconstructs context on its second turn | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:463` |
+| PT-EE0AB4E23D | durable Team Chat | queued page context and staged image reach the provider after navigation and composer replacement | `apps/praxis-desktop/main/e2e/durableTeamChat.spec.ts:491` |
 | PT-5D69F1868B | easymode | EasyMode exposes the shared sidebar material through its feed and header | `apps/praxis-desktop/main/e2e/easymode.spec.ts:30` |
 | PT-E4A060174B | easymode | legacy enableEasyMode false still uses the sole sidebar | `apps/praxis-desktop/main/e2e/easymode.spec.ts:69` |
 | PT-D7A1079D36 | easymode | Preview omits retired switches and the sole sidebar stays active | `apps/praxis-desktop/main/e2e/easymode.spec.ts:79` |
```
