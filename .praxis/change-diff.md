# change-diff — PRX-S111-179 (FX-BE-179)

## Summary
Implements durable conversation contracts and atomic storage for Praxis team chat:
- Core typed contracts in `packages/core/src/ai/assistant/assistantTypes.ts`
- Atomic repository in `apps/praxis-desktop/main/src/main/adapters/teamChatRepository.ts`
- Pure state transitions in `packages/core/src/ai/assistant/teamChatTransitions.ts`
- TeamChatStore integration in `packages/core/src/ai/assistant/teamChatStore.ts`
- Comprehensive test coverage in unit and git test suites
- Linked test contracts in `docs/praxis-tests/`

## Changed Files
```
apps/praxis-desktop/main/package.json              |   2 +-
 .../src/main/adapters/teamChatRepository.test.ts   |  91 +++++++
 .../main/src/main/adapters/teamChatRepository.ts   | 125 +++++++++
 apps/praxis-desktop/main/src/main/assistantIpc.ts  |   4 +-
 docs/praxis-tests/catalog.json                     | 294 ++++++++++++++++++---
 docs/praxis-tests/index.md                         |  76 +++---
 packages/core/package.json                         |   2 +-
 packages/core/src/ai/agentTypes.ts                 |  11 +
 .../core/src/ai/assistant/assistantEngine.test.ts  |   4 +-
 packages/core/src/ai/assistant/assistantTypes.ts   | 107 ++++++++
 packages/core/src/ai/assistant/teamChatStore.ts    |  70 +++--
 .../src/ai/assistant/teamChatTransitions.test.ts   |  55 ++++
 .../core/src/ai/assistant/teamChatTransitions.ts   |  94 +++++++
 packages/core/src/index.ts                         |   2 +
 14 files changed, 838 insertions(+), 99 deletions(-)
```

## Diff (adb2a91b..00dd78a7)
```diff
diff --git a/apps/praxis-desktop/main/package.json b/apps/praxis-desktop/main/package.json
index 0f9a053b..77a3eea7 100644
--- a/apps/praxis-desktop/main/package.json
+++ b/apps/praxis-desktop/main/package.json
@@ -31,7 +31,7 @@
     "test:e2e": "npm run copy-renderer && npm run compile && npx playwright test",
     "test:workflows": "npm run compile && node --test scripts/fixNodePtyPermissions.test.cjs out/main/shellEnvironment.test.js out/main/workflowCheckProcess.test.js out/main/workflowCheckRunner.test.js out/main/testRunnerSummary.test.js out/main/workflowMergeRunner.test.js out/main/ticketWriteBackCommit.test.js out/main/worktreeDependencyLinks.test.js out/main/runDisplayWake.test.js out/main/runDependencies.test.js out/main/affectedTestsRunner.test.js out/main/workflowIssueWriteBack.test.js out/main/taskNotificationPolicy.test.js out/main/workflowAgentStage.test.js out/main/stageHandoverGuard.test.js out/main/workflowWorkspace.test.js out/main/runWork.test.js out/main/mapWorktrees.test.js out/main/contextSnapshotHost.test.js out/main/coordinationHost.test.js out/main/coordinationHook.test.js out/main/coordinationInstance.test.js out/main/workflowProjectTrust.test.js out/main/adapters/electronAddonStorage.test.js",
     "pretest:git": "node -e \"require('electron')\"",
-    "test:git": "npm run compile && node --test out/main/gitService.test.js out/main/projectSnapshot.test.js out/main/adapters/jsonKeyValueStore.test.js out/main/notesStore.test.js out/main/minimaxUsage.test.js out/main/alibabaCodingPlanUsage.test.js out/main/antigravityUsage.test.js out/main/providerUsageBatch.test.js out/main/providerUsageHistory.test.js out/main/ticketReviewApply.test.js out/main/windowState.test.js out/main/autoUpdate.test.js out/main/windowBroadcast.test.js out/main/logPersistence.test.js out/main/promptClarityDiagnostics.test.js out/main/semanticModelDownload.test.js out/main/codeIntelligenceSession.test.js out/main/codeIntelligenceCleanup.test.js",
+    "test:git": "npm run compile && node --test out/main/gitService.test.js out/main/projectSnapshot.test.js out/main/adapters/jsonKeyValueStore.test.js out/main/adapters/teamChatRepository.test.js out/main/notesStore.test.js out/main/minimaxUsage.test.js out/main/alibabaCodingPlanUsage.test.js out/main/antigravityUsage.test.js out/main/providerUsageBatch.test.js out/main/providerUsageHistory.test.js out/main/ticketReviewApply.test.js out/main/windowState.test.js out/main/autoUpdate.test.js out/main/windowBroadcast.test.js out/main/logPersistence.test.js out/main/promptClarityDiagnostics.test.js out/main/semanticModelDownload.test.js out/main/codeIntelligenceSession.test.js out/main/codeIntelligenceCleanup.test.js",
     "test:mobile": "npm run compile && node --test out/main/mobileHostServices.test.js out/main/mobileScheduledRuns.test.js out/main/scheduledRunRequests.test.js out/main/mobileRunProjection.test.js out/main/mobileSessionProjection.test.js out/main/mobileSessionChanges.test.js out/main/mobileImagePreview.test.js out/main/mobilePermissions.test.js out/main/mobileAccessLifecycle.test.js out/main/mobileLanServer.test.js out/main/mobileRelayClient.test.js out/main/mobilePairingRegistry.test.js out/main/mobileDiscoveryAdvertiser.test.js out/main/mobileEndToEnd.test.js out/main/mobileAppearance.test.js",
     "check-ipc-senders": "node scripts/checkTrustedIpc.cjs",
     "predist:mac:publish": "npm run copy-renderer && node ../../../scripts/build-service.mjs --package --platform darwin",
diff --git a/apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts b/apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts
new file mode 100644
index 00000000..81aebdea
--- /dev/null
+++ b/apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts
@@ -0,0 +1,91 @@
+import { test } from 'node:test';
+import * as assert from 'node:assert/strict';
+import * as fs from 'node:fs';
+import * as os from 'node:os';
+import * as path from 'node:path';
+import { TeamChatStore } from '@praxis/core';
+import { FileTeamChatRepository, TeamChatCommitUncertainError, TeamChatStorageError } from './teamChatRepository';
+
+function profile(t: { after(fn: () => void): void }): string {
+  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-chat-'));
+  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
+  return path.join(directory, 'team-chats.json');
+}
+test('two windows and two chats retain concurrent accepted mutations and isolate returned objects', async t => {
+  const file = profile(t);
+  const first = new FileTeamChatRepository(file);
+  const second = new FileTeamChatRepository(file);
+  const a = new TeamChatStore(first); const b = new TeamChatStore(second);
+  const [one, two] = await Promise.all([a.create('p'), b.create('p')]);
+  await Promise.all([a.rename(one.id, 'one'), b.rename(two.id, 'two'), b.saveMessages(one.id, [{ id: 'm', role: 'user', text: 'hello', createdAt: 'now' }])]);
+  assert.equal(a.get(one.id)?.title, 'one'); assert.equal(b.get(two.id)?.title, 'two');
+  assert.equal(a.get(one.id)?.messages.length, 1);
+  const snapshot = first.read(); snapshot.teamChats.length = 0;
+  assert.equal(second.read().teamChats.length, 2);
+  assert.equal(second.read().revision, 5);
+});
+test('pre-rename failure preserves committed bytes and rejects acknowledgement; next mutation uses old state', async t => {
+  const file = profile(t); const repository = new FileTeamChatRepository(file); const store = new TeamChatStore(repository);
+  const chat = await store.create('p'); const old = fs.readFileSync(file, 'utf8');
+  const rename = t.mock.method(fs.promises, 'rename', async () => { throw new Error('injected before rename'); });
+  await assert.rejects(store.rename(chat.id, 'lost'), /injected before rename/);
+  assert.equal(fs.readFileSync(file, 'utf8'), old); assert.equal(store.get(chat.id)?.title, 'New team chat');
+  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['team-chats.json']);
+  rename.mock.restore();
+  await store.rename(chat.id, 'kept'); assert.equal(store.get(chat.id)?.title, 'kept');
+});
+test('post-rename failure halts writes until receipt reconciliation', async t => {
+  if (process.platform === 'win32') { t.skip('Windows does not flush directories'); return; }
+  const file = profile(t); const repository = new FileTeamChatRepository(file); const store = new TeamChatStore(repository);
+  const chat = await store.create('p');
+  const originalOpen = fs.promises.open;
+  const open = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
+    if (args[0] === path.dirname(file)) throw new Error('directory flush unavailable');
+    return originalOpen(...args);
+  });
+  await assert.rejects(store.rename(chat.id, 'committed'), TeamChatCommitUncertainError);
+  open.mock.restore();
+  await assert.rejects(store.rename(chat.id, 'blocked'), TeamChatCommitUncertainError);
+  await repository.reconcile(snapshot => { assert.equal(snapshot.teamChats[0].title, 'committed'); });
+  await store.rename(chat.id, 'reconciled');
+});
+test('corrupt and unsupported files fail visibly without replacing data; legacy data remains readable', async t => {
+  const file = profile(t);
+  for (const raw of ['{broken', '{}', '{"schemaVersion":99,"teamChats":[]}', '{"teamChats":[{}]}']) {
+    fs.writeFileSync(file, raw);
+    assert.throws(() => new FileTeamChatRepository(file), TeamChatStorageError);
+    assert.equal(fs.readFileSync(file, 'utf8'), raw);
+  }
+  fs.writeFileSync(file, '{"teamChats":[]}');
+  const repository = new FileTeamChatRepository(file);
+  await assert.rejects(repository.transaction(draft => { draft.teamChats.push({} as never); }), /Invalid chat/);
+  assert.equal(fs.readFileSync(file, 'utf8'), '{"teamChats":[]}');
+});
+
+test('durable submit and completion commit together and replay returns the original turn', async t => {
+  const { conversationPayloadDigest, submitConversationTurn, startConversationTurn, reserveConversationAttempt, completeConversationAttempt, advanceConversationAttempt } = await import('@praxis/core');
+  const file = profile(t); const repository = new FileTeamChatRepository(file); const store = new TeamChatStore(repository);
+  await repository.transaction(draft => { draft.conversations.push({ schemaVersion: 2, id: 'c', title: 'chat', createdAt: 'now', updatedAt: 'now', revision: 0, coordinatorEpoch: 'epoch', participants: [], messages: [], turns: [], bindings: [], summaries: [], pinnedMessageIds: [], commandReceipts: [] }); });
+  const payload = { text: 'hello' };
+  const turn: import('@praxis/core').ConversationTurn = { id: 't', commandId: 'cmd', payloadDigest: conversationPayloadDigest(payload), userMessageId: 'u', acceptedSequence: 1, plan: { participants: [{ id: 'p', role: 'lead', instructionVersion: '1', instructions: 'help', defaults: {} }], runtimeOptions: {} }, state: 'queued', completedParticipantIds: [], attempts: [] };
+  const message: import('@praxis/core').ConversationMessage = { id: 'u', role: 'user', text: 'hello', createdAt: 'now', sequence: 1, turnId: 't', attachments: [] };
+  const submit = () => store.transition('c', chat => submitConversationTurn(chat, 0, payload, turn, message));
+  await Promise.all([submit(), submit()]);
+  assert.equal(repository.read().conversations[0].messages.length, 1);
+  assert.equal(repository.read().conversations[0].commandReceipts[0].turnId, 't');
+  await store.transition('c', chat => startConversationTurn(chat, 1, 't'));
+  const attempt: import('@praxis/core').ConversationAttempt = { id: 'a', turnId: 't', participantId: 'p', ordinal: 1, coordinatorEpoch: 'epoch', state: 'prepared', contextReceipt: { digest: 'context', messageIds: ['u'] }, createdAt: 'now', usageReferences: [], toolEvidenceReferences: [] };
+  await store.transition('c', chat => reserveConversationAttempt(chat, 2, attempt));
+  await store.transition('c', chat => advanceConversationAttempt(chat, 3, 't', 'a', 'epoch', 'dispatching', 'now'));
+  const finish = () => store.transition('c', chat => completeConversationAttempt(chat, 4, 't', 'a', 'epoch', { ...message, id: 'reply', role: 'lead', participantId: 'p', sequence: 2 }, attempt.contextReceipt));
+  const before = fs.readFileSync(file, 'utf8');
+  const rename = t.mock.method(fs.promises, 'rename', async () => { throw new Error('completion commit failed'); });
+  await assert.rejects(finish(), /completion commit failed/);
+  assert.equal(fs.readFileSync(file, 'utf8'), before);
+  rename.mock.restore();
+  await finish();
+  const reloaded = new FileTeamChatRepository(file).read().conversations[0];
+  assert.equal(reloaded.messages.length, 2);
+  assert.equal(reloaded.turns[0].attempts[0].state, 'completed');
+  assert.equal(reloaded.turns[0].attempts[0].contextReceipt.digest, 'context');
+});
diff --git a/apps/praxis-desktop/main/src/main/adapters/teamChatRepository.ts b/apps/praxis-desktop/main/src/main/adapters/teamChatRepository.ts
new file mode 100644
index 00000000..1ab794f2
--- /dev/null
+++ b/apps/praxis-desktop/main/src/main/adapters/teamChatRepository.ts
@@ -0,0 +1,125 @@
+import * as fs from 'node:fs';
+import * as path from 'node:path';
+import { randomUUID } from 'node:crypto';
+import type { TeamChatRepository, TeamChatSnapshot } from '@praxis/core';
+
+type Writer = { queue: Promise<void>; uncertain: boolean };
+// All windows route IPC to main. All adapter instances for a profile share this lock.
+const writers = new Map<string, Writer>();
+export class TeamChatStorageError extends Error {}
+export class TeamChatCommitUncertainError extends TeamChatStorageError {}
+
+function decode(raw: string): TeamChatSnapshot {
+  const value = JSON.parse(raw);
+  if (!value || !Array.isArray(value.teamChats)) throw new Error('Missing teamChats array.');
+  for (const chat of value.teamChats) {
+    if (!chat || typeof chat.id !== 'string' || typeof chat.projectId !== 'string' || typeof chat.title !== 'string' ||
+        typeof chat.createdAt !== 'string' || typeof chat.updatedAt !== 'string' || !Array.isArray(chat.messages) ||
+        chat.messages.some((message: Record<string, unknown>) => !message || typeof message.id !== 'string' || typeof message.text !== 'string' ||
+          typeof message.createdAt !== 'string' || !['user', 'lead', 'dev', 'qa', 'security', 'product'].includes(String(message.role)))) throw new Error('Invalid chat record.');
+  }
+  // Legacy data stays legacy; migration/activation is a separate story.
+  if (value.schemaVersion === undefined && Object.keys(value).every(key => key === 'teamChats')) {
+    return { schemaVersion: 2, revision: 0, teamChats: value.teamChats, conversations: [] };
+  }
+  if (value.schemaVersion !== 2 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.conversations)) throw new Error('Invalid conversation envelope.');
+  for (const conversation of value.conversations) {
+    if (!conversation || conversation.schemaVersion !== 2 || typeof conversation.id !== 'string' || !Number.isSafeInteger(conversation.revision) ||
+        conversation.revision < 0 || typeof conversation.coordinatorEpoch !== 'string' ||
+        !['messages', 'participants', 'turns', 'bindings', 'summaries', 'pinnedMessageIds', 'commandReceipts'].every(key => Array.isArray(conversation[key]))) throw new Error('Invalid durable conversation.');
+  }
+  const uniqueIds = (items: { id: string }[]) => items.every(item => item && typeof item.id === 'string' && item.id.length > 0) && new Set(items.map(item => item.id)).size === items.length;
+  if (!uniqueIds(value.teamChats) || !uniqueIds(value.conversations)) throw new Error('Duplicate conversation identity.');
+  for (const conversation of value.conversations) {
+    if (typeof conversation.title !== 'string' || typeof conversation.createdAt !== 'string' || typeof conversation.updatedAt !== 'string' ||
+        !uniqueIds(conversation.messages) || !uniqueIds(conversation.turns) || !uniqueIds(conversation.participants)) throw new Error('Invalid conversation identity or transcript.');
+    let sequence = 0;
+    for (const message of conversation.messages) {
+      if (!Number.isSafeInteger(message.sequence) || message.sequence <= sequence || typeof message.turnId !== 'string' ||
+          typeof message.text !== 'string' || typeof message.createdAt !== 'string' || !Array.isArray(message.attachments) ||
+          !['user', 'lead', 'dev', 'qa', 'security', 'product'].includes(message.role)) throw new Error('Invalid conversation message.');
+      sequence = message.sequence;
+    }
+    for (const turn of conversation.turns) {
+      if (!['queued', 'running', 'completed', 'awaiting_approval', 'context_required', 'failed', 'interrupted', 'outcome_unknown', 'cancelling', 'cancelled'].includes(turn.state) ||
+          typeof turn.commandId !== 'string' || typeof turn.payloadDigest !== 'string' || !turn.plan || !Array.isArray(turn.plan.participants) ||
+          !Array.isArray(turn.completedParticipantIds) || !Array.isArray(turn.attempts) || !uniqueIds(turn.attempts)) throw new Error('Invalid conversation turn.');
+      for (const attempt of turn.attempts) {
+        if (attempt.turnId !== turn.id || typeof attempt.participantId !== 'string' || typeof attempt.coordinatorEpoch !== 'string' ||
+            !Number.isSafeInteger(attempt.ordinal) || attempt.ordinal < 1 || !attempt.contextReceipt || typeof attempt.contextReceipt.digest !== 'string' ||
+            !Array.isArray(attempt.contextReceipt.messageIds) || !['prepared', 'dispatching', 'running', 'awaiting_approval', 'completed', 'failed', 'interrupted', 'outcome_unknown', 'cancelled'].includes(attempt.state)) throw new Error('Invalid conversation attempt.');
+      }
+    }
+    const commandIds = new Set<string>();
+    for (const receipt of conversation.commandReceipts) {
+      if (!receipt || typeof receipt.commandId !== 'string' || commandIds.has(receipt.commandId) || typeof receipt.payloadDigest !== 'string' ||
+          !conversation.turns.some((turn: { id: string }) => turn.id === receipt.turnId) || !Number.isSafeInteger(receipt.revision) ||
+          receipt.revision < 1 || receipt.revision > conversation.revision || receipt.outcome !== 'accepted') throw new Error('Invalid command receipt.');
+      commandIds.add(receipt.commandId);
+    }
+  }
+  return value as TeamChatSnapshot;
+}
+
+export class FileTeamChatRepository implements TeamChatRepository {
+  private readonly filePath: string;
+  private readonly writer: Writer;
+  public constructor(filePath: string) {
+    this.filePath = path.resolve(filePath);
+    let writer = writers.get(this.filePath);
+    if (!writer) { writer = { queue: Promise.resolve(), uncertain: false }; writers.set(this.filePath, writer); }
+    this.writer = writer;
+    this.read(); // Fail visibly before accepting any command against corrupt data.
+  }
+  public read(): TeamChatSnapshot {
+    try { return decode(fs.readFileSync(this.filePath, 'utf8')); }
+    catch (error) {
+      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 2, revision: 0, teamChats: [], conversations: [] };
+      throw new TeamChatStorageError(`Cannot read team chat storage ${this.filePath}: ${String(error)}`);
+    }
+  }
+  public transaction<T>(mutate: (draft: TeamChatSnapshot) => T): Promise<T> {
+    const write = this.writer.queue.then(async () => {
+      if (this.writer.uncertain) throw new TeamChatCommitUncertainError('Team chat commit is uncertain; reload and reconcile before writing.');
+      const current = this.read();
+      const draft = structuredClone(current);
+      const result = mutate(draft);
+      if (result instanceof Promise) throw new Error('Team chat mutations must be synchronous.');
+      draft.revision = current.revision + 1;
+      const serialized = JSON.stringify(draft, null, 2);
+      decode(serialized);
+      await this.commit(serialized);
+      return structuredClone(result);
+    });
+    this.writer.queue = write.then(() => undefined, () => undefined);
+    return write;
+  }
+  /** Reconciliation must inspect the reloaded receipts before acknowledging an uncertain command. */
+  public reconcile(inspect: (snapshot: TeamChatSnapshot) => void): Promise<void> {
+    const recovery = this.writer.queue.then(() => { inspect(this.read()); this.writer.uncertain = false; });
+    this.writer.queue = recovery.then(() => undefined, () => undefined);
+    return recovery;
+  }
+  private async commit(serialized: string): Promise<void> {
+    const directory = path.dirname(this.filePath);
+    await fs.promises.mkdir(directory, { recursive: true });
+    const temp = `${this.filePath}.${randomUUID()}.tmp`;
+    let renamed = false;
+    try {
+      const file = await fs.promises.open(temp, 'wx', 0o600);
+      try { await file.writeFile(serialized, 'utf8'); await file.sync(); } finally { await file.close(); }
+      await fs.promises.rename(temp, this.filePath);
+      renamed = true;
+      if (process.platform !== 'win32') {
+        const folder = await fs.promises.open(directory, 'r');
+        try { await folder.sync(); } finally { await folder.close(); }
+      }
+    } catch (error) {
+      if (renamed) {
+        this.writer.uncertain = true;
+        throw new TeamChatCommitUncertainError(`Team chat rename succeeded but durability is uncertain: ${String(error)}`);
+      }
+      throw error;
+    } finally { await fs.promises.rm(temp, { force: true }).catch(() => undefined); }
+  }
+}
diff --git a/apps/praxis-desktop/main/src/main/assistantIpc.ts b/apps/praxis-desktop/main/src/main/assistantIpc.ts
index 12667f57..c7e36e62 100644
--- a/apps/praxis-desktop/main/src/main/assistantIpc.ts
+++ b/apps/praxis-desktop/main/src/main/assistantIpc.ts
@@ -23,7 +23,7 @@ import {
   type WireImageAttachment,
   type IssueDetails
 } from '@praxis/core';
-import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
+import { FileTeamChatRepository } from './adapters/teamChatRepository';
 import { assistantCapabilityNote } from './assistantCapability';
 import { sanitizeImages } from './aiIpc';
 import { reviewIssueWithRuntime } from './aiReviewRuntime';
@@ -38,7 +38,7 @@ const TRANSCRIPT_CHECKPOINT = 'Virtual Team transcript checkpoint';
 
 /** `userData/team-chats.json` — per-profile like the other AI stores, so e2e profiles never share chats. */
 function getTeamChatStore(): TeamChatStore {
-  if (!chatStore) chatStore = new TeamChatStore(new JsonKeyValueStore(path.join(app.getPath('userData'), 'team-chats.json')));
+  if (!chatStore) chatStore = new TeamChatStore(new FileTeamChatRepository(path.join(app.getPath('userData'), 'team-chats.json')));
   return chatStore;
 }
 
diff --git a/docs/praxis-tests/catalog.json b/docs/praxis-tests/catalog.json
index 4ff1eea6..9dcfd332 100644
--- a/docs/praxis-tests/catalog.json
+++ b/docs/praxis-tests/catalog.json
@@ -3,7 +3,7 @@
   "generatedBy": "apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs",
   "runner": "playwright",
   "scope": "apps/praxis-desktop/main/e2e",
-  "testCount": 768,
+  "testCount": 782,
   "tests": [
     {
       "id": "PT-DD79DC7C96",
@@ -8011,7 +8011,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 415,
+        "line": 414,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8027,7 +8027,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 461,
+        "line": 460,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8043,7 +8043,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 509,
+        "line": 508,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8059,7 +8059,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 633,
+        "line": 632,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8075,7 +8075,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 768,
+        "line": 769,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8091,7 +8091,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 806,
+        "line": 809,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8107,7 +8107,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 830,
+        "line": 833,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8123,7 +8123,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 847,
+        "line": 850,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8139,7 +8139,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 864,
+        "line": 867,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8155,7 +8155,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 902,
+        "line": 909,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8171,7 +8171,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 919,
+        "line": 926,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8187,7 +8187,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 959,
+        "line": 970,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8203,7 +8203,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1006,
+        "line": 1019,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8213,13 +8213,29 @@
         "then": "the automated assertions for this test pass and record the described user-visible result"
       }
     },
+    {
+      "id": "PT-7C571CC649",
+      "title": "a ticket whose working copy cannot be set up pauses the schedule with the reason instead of hanging, and a retry carries on",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
+        "line": 1053,
+        "project": "functional"
+      },
+      "area": "scheduled Runs",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "a ticket whose working copy cannot be set up pauses the schedule with the reason instead of hanging, and a retry carries on",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
     {
       "id": "PT-2370A6254B",
       "title": "an older schedule refresh cannot overwrite a newer failure status",
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1040,
+        "line": 1100,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8235,7 +8251,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1068,
+        "line": 1128,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8251,7 +8267,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1136,
+        "line": 1196,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8261,13 +8277,29 @@
         "then": "the automated assertions for this test pass and record the described user-visible result"
       }
     },
+    {
+      "id": "PT-6DDE4C4F48",
+      "title": "auto-detect parallel button detects independent tasks and sets them as parallel using the selected parallel number",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
+        "line": 1227,
+        "project": "functional"
+      },
+      "area": "scheduled Runs",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "auto-detect parallel button detects independent tasks and sets them as parallel using the selected parallel number",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
     {
       "id": "PT-984829ACD0",
       "title": "two independent tickets run at once within the cap, a third waits for a lane and the next step waits for the first",
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1167,
+        "line": 1253,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8283,7 +8315,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1222,
+        "line": 1314,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8293,13 +8325,45 @@
         "then": "the automated assertions for this test pass and record the described user-visible result"
       }
     },
+    {
+      "id": "PT-13C1844C59",
+      "title": "an approval gate is determined autonomously and recorded in the run ledger without waiting for user input",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
+        "line": 1356,
+        "project": "functional"
+      },
+      "area": "scheduled Runs",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "an approval gate is determined autonomously and recorded in the run ledger without waiting for user input",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
+    {
+      "id": "PT-AE3B01630D",
+      "title": "a long run's report folds repeats: stops by kind, a bouncing hand-over once, one row per ticket",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
+        "line": 1384,
+        "project": "functional"
+      },
+      "area": "scheduled Runs",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "a long run's report folds repeats: stops by kind, a bouncing hand-over once, one row per ticket",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
     {
       "id": "PT-6B8DD4C416",
       "title": "a parallel run whose readiness is blocked starts nothing in any lane and says why",
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1264,
+        "line": 1455,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -8309,13 +8373,29 @@
         "then": "the automated assertions for this test pass and record the described user-visible result"
       }
     },
+    {
+      "id": "PT-794E9F0536",
+      "title": "a schedule whose workflow needs trust can be reviewed and trusted from its row and from the editor",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
+        "line": 1473,
+        "project": "functional"
+      },
+      "area": "scheduled Runs",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "a schedule whose workflow needs trust can be reviewed and trusted from its row and from the editor",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
     {
       "id": "PT-2C5ADB8DC0",
       "title": "a schedule paused on an untrusted workflow offers to review and trust it, then carries on",
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts",
-        "line": 1281,
+        "line": 1536,
         "project": "functional"
       },
       "area": "scheduled Runs",
@@ -9019,7 +9099,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/sessionShelf.spec.ts",
-        "line": 146,
+        "line": 144,
         "project": "functional"
       },
       "area": "session Shelf",
@@ -9035,7 +9115,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/sessionShelf.spec.ts",
-        "line": 190,
+        "line": 188,
         "project": "functional"
       },
       "area": "session Shelf",
@@ -9051,7 +9131,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/sessionShelf.spec.ts",
-        "line": 264,
+        "line": 262,
         "project": "functional"
       },
       "area": "session Shelf",
@@ -9067,7 +9147,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/sessionShelf.spec.ts",
-        "line": 306,
+        "line": 304,
         "project": "functional"
       },
       "area": "session Shelf",
@@ -9078,8 +9158,88 @@
       }
     },
     {
-      "id": "PT-A0F01650EE",
-      "title": "the rail stays 14px with both controls inside it, and the plus opens a new session without sending",
+      "id": "PT-B3B664E022",
+      "title": "a session started from the shelf stays in the shelf as its own preview card",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/sessionShelfNew.spec.ts",
+        "line": 62,
+        "project": "functional"
+      },
+      "area": "session Shelf New",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "a session started from the shelf stays in the shelf as its own preview card",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
+    {
+      "id": "PT-FFA325C092",
+      "title": "a goal that matches one of today's sessions can be added to it with ⌘↵",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/sessionShelfNew.spec.ts",
+        "line": 92,
+        "project": "functional"
+      },
+      "area": "session Shelf New",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "a goal that matches one of today's sessions can be added to it with ⌘↵",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
+    {
+      "id": "PT-036F938299",
+      "title": "the creation cells label themselves, fill solid, and draw their glyphs on whole pixels",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/sessionShelfNew.spec.ts",
+        "line": 111,
+        "project": "functional"
+      },
+      "area": "session Shelf New",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "the creation cells label themselves, fill solid, and draw their glyphs on whole pixels",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
+    {
+      "id": "PT-B7C1C62EB2",
+      "title": "a note becomes a session goal in one press",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/sessionShelfNew.spec.ts",
+        "line": 143,
+        "project": "functional"
+      },
+      "area": "session Shelf New",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "a note becomes a session goal in one press",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
+    {
+      "id": "PT-1B797E8BFB",
+      "title": "with no usable provider the card keeps the goal and offers setup instead of sending",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/sessionShelfNew.spec.ts",
+        "line": 170,
+        "project": "functional"
+      },
+      "area": "session Shelf New",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "with no usable provider the card keeps the goal and offers setup instead of sending",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
+    {
+      "id": "PT-F699F5C08F",
+      "title": "the rail stays 14px with both controls inside it, and the new-session cell opens its card without sending",
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts",
@@ -9088,9 +9248,9 @@
       },
       "area": "session Shelf Notes",
       "flow": {
-        "given": "an isolated desktop app launched without an open new session, with the sidebar hidden so the session shelf rail shows",
-        "when": "the rail width and the plus and pencil control boxes are measured, then the plus (session-shelf-new) is clicked",
-        "then": "the rail is 14px times --ui-scale (within 0.5px), both controls sit inside the rail horizontally and do not overflow its bottom, the new-session composer appears, the AI session count is unchanged (nothing created or sent), and the rail width is unchanged after the click"
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "the rail stays 14px with both controls inside it, and the new-session cell opens its card without sending",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
       }
     },
     {
@@ -9099,7 +9259,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts",
-        "line": 66,
+        "line": 68,
         "project": "functional"
       },
       "area": "session Shelf Notes",
@@ -9115,7 +9275,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts",
-        "line": 96,
+        "line": 98,
         "project": "functional"
       },
       "area": "session Shelf Notes",
@@ -9131,7 +9291,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts",
-        "line": 107,
+        "line": 109,
         "project": "functional"
       },
       "area": "session Shelf Notes",
@@ -9147,7 +9307,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts",
-        "line": 138,
+        "line": 140,
         "project": "functional"
       },
       "area": "session Shelf Notes",
@@ -9163,7 +9323,7 @@
       "source": {
         "runner": "playwright",
         "file": "apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts",
-        "line": 155,
+        "line": 157,
         "project": "functional"
       },
       "area": "session Shelf Notes",
@@ -9173,6 +9333,70 @@
         "then": "the notes card stays visible and the project picker is no longer shown"
       }
     },
+    {
+      "id": "PT-EF2C1AEDFA",
+      "title": "each spine draws its session's state, with a cap only where you are needed",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/sessionShelfStates.spec.ts",
+        "line": 85,
+        "project": "functional"
+      },
+      "area": "session Shelf States",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "each spine draws its session's state, with a cap only where you are needed",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
+    {
+      "id": "PT-F7A9150AF3",
+      "title": "an approval card shows the request and answers it in place",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/sessionShelfStates.spec.ts",
+        "line": 114,
+        "project": "functional"
+      },
+      "area": "session Shelf States",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "an approval card shows the request and answers it in place",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
+    {
+      "id": "PT-B8E2DBE94C",
+      "title": "a working card shows the live step and the task list, and stops the session",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/sessionShelfStates.spec.ts",
+        "line": 128,
+        "project": "functional"
+      },
+      "area": "session Shelf States",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "a working card shows the live step and the task list, and stops the session",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
+    {
+      "id": "PT-CEE2C36E6A",
+      "title": "arrow keys walk the shelf, and done and failed cards lead with their outcome",
+      "source": {
+        "runner": "playwright",
+        "file": "apps/praxis-desktop/main/e2e/sessionShelfStates.spec.ts",
+        "line": 142,
+        "project": "functional"
+      },
+      "area": "session Shelf States",
+      "flow": {
+        "given": "the Praxis desktop test fixture is prepared in an isolated application context",
+        "when": "arrow keys walk the shelf, and done and failed cards lead with their outcome",
+        "then": "the automated assertions for this test pass and record the described user-visible result"
+      }
+    },
     {
       "id": "PT-2B75887CEB",
       "title": "a session shows its agent and the skills it used, and a skill lists the sessions that used it",
diff --git a/docs/praxis-tests/index.md b/docs/praxis-tests/index.md
index 4561c991..9e3743c3 100644
--- a/docs/praxis-tests/index.md
+++ b/docs/praxis-tests/index.md
@@ -1,6 +1,6 @@
 # Praxis Test catalogue
 
-This catalogue describes **768 Playwright tests** under `apps/praxis-desktop/main/e2e`. Each entry is a structured English contract linked to its exact source file and line. Run `npm run test:praxis-contracts` to detect drift before QA.
+This catalogue describes **782 Playwright tests** under `apps/praxis-desktop/main/e2e`. Each entry is a structured English contract linked to its exact source file and line. Run `npm run test:praxis-contracts` to detect drift before QA.
 
 | ID | Area | Test | Automation |
 | --- | --- | --- | --- |
@@ -504,26 +504,31 @@ This catalogue describes **768 Playwright tests** under `apps/praxis-desktop/mai
 | PT-8AECE655BF | scheduled Runs | a retired preview opt-out does not hide the board schedule shortcut | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:306` |
 | PT-86743A6E61 | scheduled Runs | tickets can be dragged from the hopper onto the flow graph and reordered on it | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:314` |
 | PT-F1D9810DD2 | scheduled Runs | a ticket dropped onto another shares its step, drawn as parallel lanes, and the steps are saved | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:348` |
-| PT-273152A227 | scheduled Runs | dragging a group ticket from the scheduler sidebar adds its unfinished child tickets | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:415` |
-| PT-8738E01F29 | scheduled Runs | capture the composer and lineup for visual review (opt-in) | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:461` |
-| PT-4FBFA8B98D | scheduled Runs | scheduled runs have a grouped sidebar and project tickets stay outside the main pane | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:509` |
-| PT-D31B062F2D | scheduled Runs | sidebar uses classic recency groups and expands group tickets | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:633` |
-| PT-706E3FFD23 | scheduled Runs | a due schedule starts by itself, and a provider at its allowance pauses it before anything launches | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:768` |
-| PT-9EEC436CE9 | scheduled Runs | Run now starts drafts and future schedules immediately, records one attempt and opens the live view | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:806` |
-| PT-9DA156CF24 | scheduled Runs | the hand-over point is a setting: raised past a provider's usage, Run now launches instead of pausing | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:830` |
-| PT-76F292ED66 | scheduled Runs | the editor can Run now without a scheduled start time and still obeys the provider budget gate | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:847` |
-| PT-9EBCCE6CC4 | scheduled Runs | a ticket that cannot be launched pauses the run with the reason, keeps its order, and can be skipped | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:864` |
-| PT-6890A4393F | scheduled Runs | quitting with a schedule pending asks first, and offers to minimise instead | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:902` |
-| PT-7600A815C3 | scheduled Runs | an idle failed stage pauses the schedule and retries in the same workflow | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:919` |
-| PT-5153FD33AA | scheduled Runs | the stage-failure panel names the stage it shows, beside a stage paused for a missing tool or script | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:959` |
-| PT-EB1C51515B | scheduled Runs | a workflow whose check stage needs a tool that is not installed is refused before the run starts | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1006` |
-| PT-2370A6254B | scheduled Runs | an older schedule refresh cannot overwrite a newer failure status | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1040` |
-| PT-9BE6F17E92 | scheduled Runs | an agent request file becomes an ordered draft while Praxis is running, and the skill that explains it is installed | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1068` |
-| PT-5BB7C25EC5 | scheduled Runs | parallel lanes are a deliberate choice in the editor: a budget warning shows, and the choice survives saving | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1136` |
-| PT-984829ACD0 | scheduled Runs | two independent tickets run at once within the cap, a third waits for a lane and the next step waits for the first | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1167` |
-| PT-57F1A1F35B | scheduled Runs | two parallel tickets that both merge into the base checkout take turns | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1222` |
-| PT-6B8DD4C416 | scheduled Runs | a parallel run whose readiness is blocked starts nothing in any lane and says why | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1264` |
-| PT-2C5ADB8DC0 | scheduled Runs | a schedule paused on an untrusted workflow offers to review and trust it, then carries on | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1281` |
+| PT-273152A227 | scheduled Runs | dragging a group ticket from the scheduler sidebar adds its unfinished child tickets | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:414` |
+| PT-8738E01F29 | scheduled Runs | capture the composer and lineup for visual review (opt-in) | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:460` |
+| PT-4FBFA8B98D | scheduled Runs | scheduled runs have a grouped sidebar and project tickets stay outside the main pane | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:508` |
+| PT-D31B062F2D | scheduled Runs | sidebar uses classic recency groups and expands group tickets | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:632` |
+| PT-706E3FFD23 | scheduled Runs | a due schedule starts by itself, and a provider at its allowance pauses it before anything launches | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:769` |
+| PT-9EEC436CE9 | scheduled Runs | Run now starts drafts and future schedules immediately, records one attempt and opens the live view | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:809` |
+| PT-9DA156CF24 | scheduled Runs | the hand-over point is a setting: raised past a provider's usage, Run now launches instead of pausing | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:833` |
+| PT-76F292ED66 | scheduled Runs | the editor can Run now without a scheduled start time and still obeys the provider budget gate | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:850` |
+| PT-9EBCCE6CC4 | scheduled Runs | a ticket that cannot be launched pauses the run with the reason, keeps its order, and can be skipped | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:867` |
+| PT-6890A4393F | scheduled Runs | quitting with a schedule pending asks first, and offers to minimise instead | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:909` |
+| PT-7600A815C3 | scheduled Runs | an idle failed stage pauses the schedule and retries in the same workflow | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:926` |
+| PT-5153FD33AA | scheduled Runs | the stage-failure panel names the stage it shows, beside a stage paused for a missing tool or script | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:970` |
+| PT-EB1C51515B | scheduled Runs | a workflow whose check stage needs a tool that is not installed is refused before the run starts | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1019` |
+| PT-7C571CC649 | scheduled Runs | a ticket whose working copy cannot be set up pauses the schedule with the reason instead of hanging, and a retry carries on | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1053` |
+| PT-2370A6254B | scheduled Runs | an older schedule refresh cannot overwrite a newer failure status | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1100` |
+| PT-9BE6F17E92 | scheduled Runs | an agent request file becomes an ordered draft while Praxis is running, and the skill that explains it is installed | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1128` |
+| PT-5BB7C25EC5 | scheduled Runs | parallel lanes are a deliberate choice in the editor: a budget warning shows, and the choice survives saving | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1196` |
+| PT-6DDE4C4F48 | scheduled Runs | auto-detect parallel button detects independent tasks and sets them as parallel using the selected parallel number | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1227` |
+| PT-984829ACD0 | scheduled Runs | two independent tickets run at once within the cap, a third waits for a lane and the next step waits for the first | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1253` |
+| PT-57F1A1F35B | scheduled Runs | two parallel tickets that both merge into the base checkout take turns | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1314` |
+| PT-13C1844C59 | scheduled Runs | an approval gate is determined autonomously and recorded in the run ledger without waiting for user input | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1356` |
+| PT-AE3B01630D | scheduled Runs | a long run's report folds repeats: stops by kind, a bouncing hand-over once, one row per ticket | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1384` |
+| PT-6B8DD4C416 | scheduled Runs | a parallel run whose readiness is blocked starts nothing in any lane and says why | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1455` |
+| PT-794E9F0536 | scheduled Runs | a schedule whose workflow needs trust can be reviewed and trusted from its row and from the editor | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1473` |
+| PT-2C5ADB8DC0 | scheduled Runs | a schedule paused on an untrusted workflow offers to review and trust it, then carries on | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:1536` |
 | PT-4BED3303D0 | security Remediation | unregistered renderers cannot read settings or emit privileged one-way messages | `apps/praxis-desktop/main/e2e/securityRemediation.spec.ts:15` |
 | PT-119034639B | security Remediation | OAuth rejects missing, mismatched and replayed state without consuming the legitimate authorization | `apps/praxis-desktop/main/e2e/securityRemediation.spec.ts:27` |
 | PT-29ECE51EF8 | security Remediation | secret reads repair permissive file modes and encrypted values remain retrievable | `apps/praxis-desktop/main/e2e/securityRemediation.spec.ts:50` |
@@ -567,16 +572,25 @@ This catalogue describes **768 Playwright tests** under `apps/praxis-desktop/mai
 | PT-0F10648F67 | session Recovery | interrupted CLI sessions also wait for selection and resume through ACP | `apps/praxis-desktop/main/e2e/sessionRecovery.spec.ts:99` |
 | PT-75B0F93373 | session Recovery | teardown drains an ACP task even when the session list already reports completion | `apps/praxis-desktop/main/e2e/sessionRecovery.spec.ts:110` |
 | PT-4972638424 | session Shelf | collapsed session shelf shows the last 5 sessions, distinguishes today, and reveals cards on hover and focus | `apps/praxis-desktop/main/e2e/sessionShelf.spec.ts:51` |
-| PT-1FCF628060 | session Shelf | the shelf card sends a quick reply into the session | `apps/praxis-desktop/main/e2e/sessionShelf.spec.ts:146` |
-| PT-90617ED6C8 | session Shelf | the shelf closes reliably on pointer leave and outside clicks without interrupting replies | `apps/praxis-desktop/main/e2e/sessionShelf.spec.ts:190` |
-| PT-FFEA37801D | session Shelf | only the revealed spine glows when moving across all five sessions | `apps/praxis-desktop/main/e2e/sessionShelf.spec.ts:264` |
-| PT-2EE0F7086B | session Shelf | shelf books follow spines, retain drafts, delay hover and distinguish selection | `apps/praxis-desktop/main/e2e/sessionShelf.spec.ts:306` |
-| PT-A0F01650EE | session Shelf Notes | the rail stays 14px with both controls inside it, and the plus opens a new session without sending | `apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts:43` |
-| PT-062E28E533 | session Shelf Notes | the notes pencil opens the editor with focus in the title; typing saves; Escape returns focus and reopening keeps the text | `apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts:66` |
-| PT-773AA26797 | session Shelf Notes | activating the pencil with the keyboard puts focus in the note title | `apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts:96` |
-| PT-B4FF318316 | session Shelf Notes | a failed save keeps the draft, flags the pencil and recovers on Retry | `apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts:107` |
-| PT-F5F522F4DD | session Shelf Notes | Escape closes the project picker before it closes the notes card | `apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts:138` |
-| PT-6109A0FF71 | session Shelf Notes | picking a project with the mouse keeps the notes card open | `apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts:155` |
+| PT-1FCF628060 | session Shelf | the shelf card sends a quick reply into the session | `apps/praxis-desktop/main/e2e/sessionShelf.spec.ts:144` |
+| PT-90617ED6C8 | session Shelf | the shelf closes reliably on pointer leave and outside clicks without interrupting replies | `apps/praxis-desktop/main/e2e/sessionShelf.spec.ts:188` |
+| PT-FFEA37801D | session Shelf | only the revealed spine glows when moving across all five sessions | `apps/praxis-desktop/main/e2e/sessionShelf.spec.ts:262` |
+| PT-2EE0F7086B | session Shelf | shelf books follow spines, retain drafts, delay hover and distinguish selection | `apps/praxis-desktop/main/e2e/sessionShelf.spec.ts:304` |
+| PT-B3B664E022 | session Shelf New | a session started from the shelf stays in the shelf as its own preview card | `apps/praxis-desktop/main/e2e/sessionShelfNew.spec.ts:62` |
+| PT-FFA325C092 | session Shelf New | a goal that matches one of today's sessions can be added to it with ⌘↵ | `apps/praxis-desktop/main/e2e/sessionShelfNew.spec.ts:92` |
+| PT-036F938299 | session Shelf New | the creation cells label themselves, fill solid, and draw their glyphs on whole pixels | `apps/praxis-desktop/main/e2e/sessionShelfNew.spec.ts:111` |
+| PT-B7C1C62EB2 | session Shelf New | a note becomes a session goal in one press | `apps/praxis-desktop/main/e2e/sessionShelfNew.spec.ts:143` |
+| PT-1B797E8BFB | session Shelf New | with no usable provider the card keeps the goal and offers setup instead of sending | `apps/praxis-desktop/main/e2e/sessionShelfNew.spec.ts:170` |
+| PT-F699F5C08F | session Shelf Notes | the rail stays 14px with both controls inside it, and the new-session cell opens its card without sending | `apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts:43` |
+| PT-062E28E533 | session Shelf Notes | the notes pencil opens the editor with focus in the title; typing saves; Escape returns focus and reopening keeps the text | `apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts:68` |
+| PT-773AA26797 | session Shelf Notes | activating the pencil with the keyboard puts focus in the note title | `apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts:98` |
+| PT-B4FF318316 | session Shelf Notes | a failed save keeps the draft, flags the pencil and recovers on Retry | `apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts:109` |
+| PT-F5F522F4DD | session Shelf Notes | Escape closes the project picker before it closes the notes card | `apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts:140` |
+| PT-6109A0FF71 | session Shelf Notes | picking a project with the mouse keeps the notes card open | `apps/praxis-desktop/main/e2e/sessionShelfNotes.spec.ts:157` |
+| PT-EF2C1AEDFA | session Shelf States | each spine draws its session's state, with a cap only where you are needed | `apps/praxis-desktop/main/e2e/sessionShelfStates.spec.ts:85` |
+| PT-F7A9150AF3 | session Shelf States | an approval card shows the request and answers it in place | `apps/praxis-desktop/main/e2e/sessionShelfStates.spec.ts:114` |
+| PT-B8E2DBE94C | session Shelf States | a working card shows the live step and the task list, and stops the session | `apps/praxis-desktop/main/e2e/sessionShelfStates.spec.ts:128` |
+| PT-CEE2C36E6A | session Shelf States | arrow keys walk the shelf, and done and failed cards lead with their outcome | `apps/praxis-desktop/main/e2e/sessionShelfStates.spec.ts:142` |
 | PT-2B75887CEB | session Skill Usage | a session shows its agent and the skills it used, and a skill lists the sessions that used it | `apps/praxis-desktop/main/e2e/sessionSkillUsage.spec.ts:22` |
 | PT-3C45DBB445 | session Team | a session can add several team members; a lone reviewer offers to draft an ask | `apps/praxis-desktop/main/e2e/sessionTeam.spec.ts:21` |
 | PT-1EF3C80135 | session Usage Quota | composer usage panel draws provider quota windows as bars with a collapsed meter | `apps/praxis-desktop/main/e2e/sessionUsageQuota.spec.ts:44` |
diff --git a/packages/core/package.json b/packages/core/package.json
index bc91fbf0..9f85b6e4 100644
--- a/packages/core/package.json
+++ b/packages/core/package.json
@@ -7,7 +7,7 @@
   "scripts": {
     "check-types": "tsc --noEmit -p .",
     "compile": "tsc -p .",
-    "test": "tsc -p . && node --test out/notes/noteValidation.test.js out/workflows/affectedTests.test.js out/notes/noteSnapshot.test.js out/git/gitGraph.test.js out/git/gitParsing.test.js out/git/gitWorktreeManager.test.js out/config/appSettings.test.js out/ai/tools/unifiedDiff.test.js out/ai/tools/pathSandbox.test.js out/ai/tools/networkAddress.test.js out/ai/tools/localTools.test.js out/ai/tools/browserTools.test.js out/ai/readOnlyFilesMcp.test.js out/ai/readOnlyShell.test.js out/ai/browserMcpServer.test.js out/ai/trackerMcpServer.test.js out/ai/assistant/assistantEngine.test.js out/ai/ticketContext.test.js out/ai/gateway/wire.test.js out/ai/providers/anthropicWire.test.js out/ai/providers/reasoningSupport.test.js out/ai/providers/geminiWire.test.js out/ai/providers/modelPricing.test.js out/ai/providers/providerPreflight.test.js out/ai/providers/customProviders.test.js out/ai/providers/providerProbe.test.js out/ai/providers/localRuntimeDetection.test.js out/ai/providerLimitError.test.js out/ai/acp/acpAgentHost.test.js out/ai/aiSessionManager.test.js out/ai/skillUsage.test.js out/ai/sessionChangeSummary.test.js out/ai/backgroundTasks.test.js out/ai/ticketReview.test.js out/ai/humanReview.test.js out/ai/sessionHandover.test.js out/ai/contextSnapshot.test.js out/ai/coordination/coordination.test.js out/ai/gadgets/validation.test.js out/ai/gadgets/gadgetRepair.test.js out/ai/gadgets/gadgetLifecycle.test.js out/ai/gadgets/fixtures.test.js out/ai/agentEventUtils.test.js out/ai/sessionChangeEncoder.test.js out/ai/diagnosisBrief.test.js out/ai/diagnosisState.test.js out/ai/aiUsageStats.test.js out/ai/agentRuntime/discovery.test.js out/ai/agentRuntime/agentCatalog.test.js out/ai/agentRuntime/agentAuthoring.test.js out/ai/agentRuntime/bundledAgents.test.js out/ai/agentRuntime/manager.test.js out/ai/agentRuntime/nativeSources.test.js out/ci/githubActionsEvidenceProvider.test.js out/ci/gitLabCiEvidenceProvider.test.js out/ci/ciEvidenceImport.test.js out/ci/ciSecurityReports.test.js out/folder/boardConfigFile.test.js out/folder/folderFs.test.js out/folder/markdownPlanParser.test.js out/folder/markdownStatusWriter.test.js out/github/githubBoardService.test.js out/gitlab/gitLabBoardService.test.js out/jira/jiraShape.test.js out/marketplace/semver.test.js out/marketplace/integrity.test.js out/marketplace/addonManifest.test.js out/marketplace/registryClient.test.js out/marketplace/marketplaceService.test.js out/marketplace/tarballManifest.test.js out/workspaces/workspacePaths.test.js out/projects/projectActivity.test.js out/projects/projectWorkflow.test.js out/projects/projectService.test.js out/projects/projectImportPlanner.test.js out/projects/runProfile.test.js out/projects/runProfileDiscovery.test.js out/projects/runProfileStore.test.js out/projects/previewAccess.test.js out/projects/runServiceManager.test.js out/projects/runReconciliation.test.js out/projects/browserDiagnostics.test.js out/projects/previewVerification.test.js out/projects/deploymentProfile.test.js out/projects/deploymentProfileStore.test.js out/projects/publishManifest.test.js out/projects/deploymentRunState.test.js out/projects/deploymentRunStore.test.js out/deployments/directProcessExecutor.test.js out/deployments/directoryTarget.test.js out/deployments/directDeploymentOrchestrator.test.js out/deployments/directDeliveryJourney.test.js out/deployments/githubActionsExecutor.test.js out/deployments/githubActionsObserver.test.js out/deployments/githubActionsOrchestrator.test.js out/deployments/githubActionsResults.test.js out/workflows/workflowValidation.test.js out/workflows/workflowStore.test.js out/workflows/workflowRun.test.js out/workflows/stageModel.test.js out/ai/workflowModelRecommendation.test.js out/workflows/workflowGates.test.js out/workflows/workflowApprovalGadgets.test.js out/workflows/workflowTemplates.test.js out/workflows/workflowDesignerState.test.js out/workflows/workflowRunSummary.test.js out/workflows/workflowDeploymentPhase.test.js out/workflows/workflowOrchestrator.test.js out/workflows/workflowStageTask.test.js out/workflows/workflowEvidence.test.js out/workflows/checkFindings.test.js out/workflows/checkResultAdapters.test.js out/workflows/workflowThresholdGates.test.js out/workflows/checkPresets.test.js out/workflows/checkEnvironmentFailure.test.js out/workflows/checkToolPreflight.test.js out/workflows/checkCommandArgs.test.js out/workflows/waiverRegister.test.js out/workflows/workflowMultiOwnerGates.test.js out/workflows/structuredReviewFindings.test.js out/workflows/reviewFixLoop.test.js out/workflows/workflowLoops.test.js out/workflows/workflowEstimate.test.js out/workflows/workflowImprove.test.js out/workflows/workflowMap.test.js out/workflows/fullSdlcTemplates.test.js out/workflows/sdlcLoopTemplates.test.js out/workflows/workflowAddonTemplates.test.js out/workflows/workflowPlanPublishing.test.js out/host/mobileProtocol.test.js out/host/mobileExecutionBoundary.test.js out/host/mobileCommandLedger.test.js out/host/mobileAccessPolicy.test.js out/host/mobileConnectionLifecycle.test.js out/host/mobileAccessAdministration.test.js out/host/mobilePairingHandshake.test.js out/host/mobileTrustStore.test.js out/host/mobileHostDiscovery.test.js out/host/mobileReconnect.test.js out/host/mobileLanOnly.test.js out/codeIntelligence/mcpBridge.test.js out/scheduledRuns/scheduledRun.test.js out/scheduledRuns/scheduledRunStore.test.js out/scheduledRuns/scheduledRunRequest.test.js out/scheduledRuns/scheduledBudget.test.js out/scheduledRuns/scheduledRunRunner.test.js out/scheduledRuns/scheduledRunParallel.test.js out/scheduledRuns/scheduledRunDetail.test.js out/scheduledRuns/scheduledTicketStatus.test.js out/ai/feedback/feedbackTypes.test.js out/ai/feedback/sessionFeedbackScorer.test.js out/ai/feedback/sessionFeedbackStore.test.js out/ai/feedback/promptRewriteHelper.test.js out/ai/feedback/goldenCorpus.test.js out/ai/feedback/feedbackV2.test.js out/ai/feedback/promptClarity.test.js out/ai/feedback/feedbackCoaching.test.js"
+    "test": "tsc -p . && node --test out/notes/noteValidation.test.js out/workflows/affectedTests.test.js out/notes/noteSnapshot.test.js out/git/gitGraph.test.js out/git/gitParsing.test.js out/git/gitWorktreeManager.test.js out/config/appSettings.test.js out/ai/tools/unifiedDiff.test.js out/ai/tools/pathSandbox.test.js out/ai/tools/networkAddress.test.js out/ai/tools/localTools.test.js out/ai/tools/browserTools.test.js out/ai/readOnlyFilesMcp.test.js out/ai/readOnlyShell.test.js out/ai/browserMcpServer.test.js out/ai/trackerMcpServer.test.js out/ai/assistant/assistantEngine.test.js out/ai/assistant/teamChatTransitions.test.js out/ai/ticketContext.test.js out/ai/gateway/wire.test.js out/ai/providers/anthropicWire.test.js out/ai/providers/reasoningSupport.test.js out/ai/providers/geminiWire.test.js out/ai/providers/modelPricing.test.js out/ai/providers/providerPreflight.test.js out/ai/providers/customProviders.test.js out/ai/providers/providerProbe.test.js out/ai/providers/localRuntimeDetection.test.js out/ai/providerLimitError.test.js out/ai/acp/acpAgentHost.test.js out/ai/aiSessionManager.test.js out/ai/skillUsage.test.js out/ai/sessionChangeSummary.test.js out/ai/backgroundTasks.test.js out/ai/ticketReview.test.js out/ai/humanReview.test.js out/ai/sessionHandover.test.js out/ai/contextSnapshot.test.js out/ai/coordination/coordination.test.js out/ai/gadgets/validation.test.js out/ai/gadgets/gadgetRepair.test.js out/ai/gadgets/gadgetLifecycle.test.js out/ai/gadgets/fixtures.test.js out/ai/agentEventUtils.test.js out/ai/sessionChangeEncoder.test.js out/ai/diagnosisBrief.test.js out/ai/diagnosisState.test.js out/ai/aiUsageStats.test.js out/ai/agentRuntime/discovery.test.js out/ai/agentRuntime/agentCatalog.test.js out/ai/agentRuntime/agentAuthoring.test.js out/ai/agentRuntime/bundledAgents.test.js out/ai/agentRuntime/manager.test.js out/ai/agentRuntime/nativeSources.test.js out/ci/githubActionsEvidenceProvider.test.js out/ci/gitLabCiEvidenceProvider.test.js out/ci/ciEvidenceImport.test.js out/ci/ciSecurityReports.test.js out/folder/boardConfigFile.test.js out/folder/folderFs.test.js out/folder/markdownPlanParser.test.js out/folder/markdownStatusWriter.test.js out/github/githubBoardService.test.js out/gitlab/gitLabBoardService.test.js out/jira/jiraShape.test.js out/marketplace/semver.test.js out/marketplace/integrity.test.js out/marketplace/addonManifest.test.js out/marketplace/registryClient.test.js out/marketplace/marketplaceService.test.js out/marketplace/tarballManifest.test.js out/workspaces/workspacePaths.test.js out/projects/projectActivity.test.js out/projects/projectWorkflow.test.js out/projects/projectService.test.js out/projects/projectImportPlanner.test.js out/projects/runProfile.test.js out/projects/runProfileDiscovery.test.js out/projects/runProfileStore.test.js out/projects/previewAccess.test.js out/projects/runServiceManager.test.js out/projects/runReconciliation.test.js out/projects/browserDiagnostics.test.js out/projects/previewVerification.test.js out/projects/deploymentProfile.test.js out/projects/deploymentProfileStore.test.js out/projects/publishManifest.test.js out/projects/deploymentRunState.test.js out/projects/deploymentRunStore.test.js out/deployments/directProcessExecutor.test.js out/deployments/directoryTarget.test.js out/deployments/directDeploymentOrchestrator.test.js out/deployments/directDeliveryJourney.test.js out/deployments/githubActionsExecutor.test.js out/deployments/githubActionsObserver.test.js out/deployments/githubActionsOrchestrator.test.js out/deployments/githubActionsResults.test.js out/workflows/workflowValidation.test.js out/workflows/workflowStore.test.js out/workflows/workflowRun.test.js out/workflows/stageModel.test.js out/ai/workflowModelRecommendation.test.js out/workflows/workflowGates.test.js out/workflows/workflowApprovalGadgets.test.js out/workflows/workflowTemplates.test.js out/workflows/workflowDesignerState.test.js out/workflows/workflowRunSummary.test.js out/workflows/workflowDeploymentPhase.test.js out/workflows/workflowOrchestrator.test.js out/workflows/workflowStageTask.test.js out/workflows/workflowEvidence.test.js out/workflows/checkFindings.test.js out/workflows/checkResultAdapters.test.js out/workflows/workflowThresholdGates.test.js out/workflows/checkPresets.test.js out/workflows/checkEnvironmentFailure.test.js out/workflows/checkToolPreflight.test.js out/workflows/checkCommandArgs.test.js out/workflows/waiverRegister.test.js out/workflows/workflowMultiOwnerGates.test.js out/workflows/structuredReviewFindings.test.js out/workflows/reviewFixLoop.test.js out/workflows/workflowLoops.test.js out/workflows/workflowEstimate.test.js out/workflows/workflowImprove.test.js out/workflows/workflowMap.test.js out/workflows/fullSdlcTemplates.test.js out/workflows/sdlcLoopTemplates.test.js out/workflows/workflowAddonTemplates.test.js out/workflows/workflowPlanPublishing.test.js out/host/mobileProtocol.test.js out/host/mobileExecutionBoundary.test.js out/host/mobileCommandLedger.test.js out/host/mobileAccessPolicy.test.js out/host/mobileConnectionLifecycle.test.js out/host/mobileAccessAdministration.test.js out/host/mobilePairingHandshake.test.js out/host/mobileTrustStore.test.js out/host/mobileHostDiscovery.test.js out/host/mobileReconnect.test.js out/host/mobileLanOnly.test.js out/codeIntelligence/mcpBridge.test.js out/scheduledRuns/scheduledRun.test.js out/scheduledRuns/scheduledRunStore.test.js out/scheduledRuns/scheduledRunRequest.test.js out/scheduledRuns/scheduledBudget.test.js out/scheduledRuns/scheduledRunRunner.test.js out/scheduledRuns/scheduledRunParallel.test.js out/scheduledRuns/scheduledRunDetail.test.js out/scheduledRuns/scheduledTicketStatus.test.js out/ai/feedback/feedbackTypes.test.js out/ai/feedback/sessionFeedbackScorer.test.js out/ai/feedback/sessionFeedbackStore.test.js out/ai/feedback/promptRewriteHelper.test.js out/ai/feedback/goldenCorpus.test.js out/ai/feedback/feedbackV2.test.js out/ai/feedback/promptClarity.test.js out/ai/feedback/feedbackCoaching.test.js"
   },
   "dependencies": {
     "@agentclientprotocol/sdk": "^1.4.0",
diff --git a/packages/core/src/ai/agentTypes.ts b/packages/core/src/ai/agentTypes.ts
index 01533a3f..894599c9 100644
--- a/packages/core/src/ai/agentTypes.ts
+++ b/packages/core/src/ai/agentTypes.ts
@@ -464,7 +464,18 @@ export interface BackgroundTask {
   producerId?: string;
 }
 
+/** Projection only; the conversation attempt remains authoritative. */
+export interface TeamChatExecutionOwnership {
+  conversationId: string;
+  turnId: string;
+  participantId: string;
+  attemptId: string;
+  coordinatorEpoch: string;
+  providerSessionId?: string;
+}
+
 export interface AgentSessionRecord {
+  teamChatExecution?: TeamChatExecutionOwnership;
   backgroundTasks?: BackgroundTask[];
   issueKey: string;
   sessionId: string;
diff --git a/packages/core/src/ai/assistant/assistantEngine.test.ts b/packages/core/src/ai/assistant/assistantEngine.test.ts
index 9001228a..d5b34321 100644
--- a/packages/core/src/ai/assistant/assistantEngine.test.ts
+++ b/packages/core/src/ai/assistant/assistantEngine.test.ts
@@ -91,8 +91,8 @@ test('a workflow proposal is dropped outside the workflow page', async () => {
 });
 
 test('team chat store persists, titles from the first message, renames and deletes', async () => {
-  const data: Record<string, unknown> = {};
-  const store = new TeamChatStore({ get: <T>(k: string) => data[k] as T | undefined, update: async (k: string, v: unknown) => { data[k] = v; } } as never);
+  let data: import('./assistantTypes').TeamChatSnapshot = { schemaVersion: 2, revision: 0, teamChats: [], conversations: [] };
+  const store = new TeamChatStore({ read: () => structuredClone(data), transaction: async mutate => { const draft = structuredClone(data); const result = mutate(draft); data = draft; return result; } });
   const chat = await store.create('p1', 'PRX-1');
   await store.create('p2');
   await store.saveMessages(chat.id, [{ id: '1', role: 'user', text: 'Review the login flow', createdAt: 'x' }, { id: '2', role: 'qa', text: 'ok', createdAt: 'y' }]);
diff --git a/packages/core/src/ai/assistant/assistantTypes.ts b/packages/core/src/ai/assistant/assistantTypes.ts
index 67ed127c..c4f5fe55 100644
--- a/packages/core/src/ai/assistant/assistantTypes.ts
+++ b/packages/core/src/ai/assistant/assistantTypes.ts
@@ -92,3 +92,110 @@ export interface TeamChatRecord {
 
 /** A chat without its transcript, for the sidebar list. */
 export type TeamChatSummary = Omit<TeamChatRecord, 'messages'> & { messageCount: number; personas: AssistantRole[] };
+
+/** Versioned authoritative state; legacy transcripts remain readable until migration. */
+export interface ConversationParticipant {
+  id: string;
+  role: AssistantRole;
+  instructionVersion: string;
+  instructions: string;
+  defaults: Readonly<Record<string, string | number | boolean>>;
+}
+export type ConversationTurnState = 'queued' | 'running' | 'completed' | 'awaiting_approval' | 'context_required' | 'failed' | 'interrupted' | 'outcome_unknown' | 'cancelling' | 'cancelled';
+export type ConversationAttemptState = 'prepared' | 'dispatching' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'interrupted' | 'outcome_unknown' | 'cancelled';
+export interface ConversationAttachment { id: string; digest: string; mediaType: string; size: number; }
+export interface ConversationMessage extends AssistantMessage {
+  sequence: number;
+  turnId: string;
+  participantId?: string;
+  attachments: ConversationAttachment[];
+  context?: PageAssistantContext;
+}
+export interface ConversationContextReceipt { digest: string; messageIds: string[]; bindingId?: string; }
+export interface ConversationAttempt {
+  id: string;
+  turnId: string;
+  participantId: string;
+  ordinal: number;
+  coordinatorEpoch: string;
+  state: ConversationAttemptState;
+  bindingId?: string;
+  providerSessionId?: string;
+  contextReceipt: ConversationContextReceipt;
+  dispatchIntent?: string;
+  createdAt: string;
+  completedAt?: string;
+  error?: string;
+  resultMessageId?: string;
+  usageReferences: string[];
+  toolEvidenceReferences: string[];
+}
+export interface ConversationTurn {
+  id: string;
+  commandId: string;
+  payloadDigest: string;
+  userMessageId: string;
+  acceptedSequence: number;
+  plan: { participants: ConversationParticipant[]; runtimeOptions: Readonly<Record<string, string | number | boolean>>; context?: PageAssistantContext };
+  state: ConversationTurnState;
+  completedParticipantIds: string[];
+  attempts: ConversationAttempt[];
+}
+export interface ConversationBinding {
+  id: string;
+  conversationId: string;
+  participantId: string;
+  providerRuntime: string;
+  providerSessionId?: string;
+  compatibilityDigest: string;
+  deliveredMessageIds: string[];
+  nativeOutputMessageIds: string[];
+  status: 'valid' | 'invalid';
+}
+export interface ConversationSummary {
+  id: string; version: number; sourceStart: number; sourceEnd: number; sourceDigest: string;
+  text: string; attemptId: string; provider: string; supersedesId?: string;
+}
+export interface ConversationCommandReceipt {
+  commandId: string; payloadDigest: string; turnId: string; revision: number; outcome: 'accepted';
+}
+export interface DurableConversation extends Omit<TeamChatRecord, 'messages' | 'projectId'> {
+  schemaVersion: 2;
+  projectId?: string;
+  revision: number;
+  coordinatorEpoch: string;
+  participants: ConversationParticipant[];
+  messages: ConversationMessage[];
+  turns: ConversationTurn[];
+  bindings: ConversationBinding[];
+  summaries: ConversationSummary[];
+  pinnedMessageIds: string[];
+  commandReceipts: ConversationCommandReceipt[];
+}
+export interface TeamChatSnapshot {
+  schemaVersion: 2;
+  revision: number;
+  teamChats: TeamChatRecord[];
+  conversations: DurableConversation[];
+}
+/** The repository owns serialization, isolation and durable publication. */
+export interface TeamChatRepository {
+  read(): TeamChatSnapshot;
+  transaction<T>(mutate: (draft: TeamChatSnapshot) => T): Promise<T>;
+}
+
+export interface SubmitConversationCommand {
+  conversationId: string;
+  commandId: string;
+  expectedRevision: number;
+  text: string;
+  selectedParticipantIds: string[];
+  context?: PageAssistantContext;
+  attachmentRefs: ConversationAttachment[];
+  runtimeOptions: Readonly<Record<string, string | number | boolean>>;
+}
+export interface ConversationCommandResult {
+  turnId: string;
+  revision: number;
+  state: ConversationTurnState;
+}
diff --git a/packages/core/src/ai/assistant/teamChatStore.ts b/packages/core/src/ai/assistant/teamChatStore.ts
index 5c57c8d1..b9511f14 100644
--- a/packages/core/src/ai/assistant/teamChatStore.ts
+++ b/packages/core/src/ai/assistant/teamChatStore.ts
@@ -1,15 +1,27 @@
-import type { KeyValueStore } from '../../host/stateStore';
 import { deriveChatTitle } from './assistantEngine';
-import type { AssistantMessage, AssistantRole, TeamChatRecord, TeamChatSummary } from './assistantTypes';
-
-const KEY = 'teamChats';
+import type { AssistantMessage, AssistantRole, TeamChatRecord, TeamChatSummary, TeamChatRepository, DurableConversation } from './assistantTypes';
 
 /** Durable team-chat transcripts, one record per conversation. */
 export class TeamChatStore {
-  public constructor(private readonly store: KeyValueStore) {}
+  public constructor(private readonly store: TeamChatRepository) {}
+
+  /** Apply a pure validated transition under the profile-wide commit lock. */
+  public async transition(id: string, apply: (current: DurableConversation) => DurableConversation): Promise<DurableConversation> {
+    return this.store.transaction(draft => {
+      const index = draft.conversations.findIndex(chat => chat.id === id);
+      if (index < 0) throw new Error(`Conversation ${id} was not found.`);
+      const current = draft.conversations[index];
+      const next = apply(structuredClone(current));
+      if (next.id !== id || next.schemaVersion !== 2 || next.revision < current.revision || next.revision > current.revision + 1) {
+        throw new Error('Invalid conversation transition.');
+      }
+      draft.conversations[index] = structuredClone(next);
+      return structuredClone(next);
+    });
+  }
 
   private all(): TeamChatRecord[] {
-    return this.store.get<TeamChatRecord[]>(KEY) ?? [];
+    return this.store.read().teamChats;
   }
 
   public list(projectId: string): TeamChatSummary[] {
@@ -38,39 +50,43 @@ export class TeamChatStore {
       updatedAt: now,
       messages: []
     };
-    await this.store.update(KEY, [...this.all(), chat]);
+    await this.store.transaction(draft => { draft.teamChats.push(structuredClone(chat)); });
     return chat;
   }
 
   /** Replaces a chat's transcript. A still-untitled chat is named from its first user message. */
   public async saveMessages(id: string, messages: readonly AssistantMessage[]): Promise<TeamChatRecord> {
-    const chats = this.all();
-    const index = chats.findIndex(chat => chat.id === id);
-    if (index < 0) throw new Error(`Team chat ${id} was not found.`);
-    const current = chats[index];
-    const firstUser = messages.find(message => message.role === 'user');
-    const next: TeamChatRecord = {
-      ...current,
-      messages: [...messages],
-      updatedAt: new Date().toISOString(),
-      title: current.title === 'New team chat' && firstUser ? deriveChatTitle(firstUser.text) : current.title
-    };
-    await this.store.update(KEY, chats.map((chat, i) => (i === index ? next : chat)));
-    return next;
+    return this.store.transaction(draft => {
+      const chats = draft.teamChats;
+      const index = chats.findIndex(chat => chat.id === id);
+      if (index < 0) throw new Error(`Team chat ${id} was not found.`);
+      const current = chats[index];
+      const firstUser = messages.find(message => message.role === 'user');
+      const next: TeamChatRecord = {
+        ...current,
+        messages: [...messages],
+        updatedAt: new Date().toISOString(),
+        title: current.title === 'New team chat' && firstUser ? deriveChatTitle(firstUser.text) : current.title
+      };
+      draft.teamChats = chats.map((chat, i) => (i === index ? next : chat));
+      return structuredClone(next);
+    });
   }
 
   public async rename(id: string, title: string): Promise<TeamChatRecord> {
     const trimmed = title.trim();
     if (!trimmed) throw new Error('A chat needs a name.');
-    const chats = this.all();
-    const current = chats.find(chat => chat.id === id);
-    if (!current) throw new Error(`Team chat ${id} was not found.`);
-    const next = { ...current, title: trimmed.slice(0, 120) };
-    await this.store.update(KEY, chats.map(chat => (chat.id === id ? next : chat)));
-    return next;
+    return this.store.transaction(draft => {
+      const chats = draft.teamChats;
+      const current = chats.find(chat => chat.id === id);
+      if (!current) throw new Error(`Team chat ${id} was not found.`);
+      const next = { ...current, title: trimmed.slice(0, 120) };
+      draft.teamChats = chats.map(chat => (chat.id === id ? next : chat));
+      return structuredClone(next);
+    });
   }
 
   public async remove(id: string): Promise<void> {
-    await this.store.update(KEY, this.all().filter(chat => chat.id !== id));
+    await this.store.transaction(draft => { draft.teamChats = draft.teamChats.filter(chat => chat.id !== id); });
   }
 }
diff --git a/packages/core/src/ai/assistant/teamChatTransitions.test.ts b/packages/core/src/ai/assistant/teamChatTransitions.test.ts
new file mode 100644
index 00000000..b32f8e05
--- /dev/null
+++ b/packages/core/src/ai/assistant/teamChatTransitions.test.ts
@@ -0,0 +1,55 @@
+import { test } from 'node:test';
+import * as assert from 'node:assert/strict';
+import type { ConversationAttempt, ConversationMessage, ConversationTurn, DurableConversation } from './assistantTypes';
+import { conversationPayloadDigest, submitConversationTurn, startConversationTurn, reserveConversationAttempt, completeConversationAttempt, advanceConversationAttempt } from './teamChatTransitions';
+
+function fixture() {
+  const chat: DurableConversation = { schemaVersion: 2, id: 'c', title: 'chat', createdAt: 'now', updatedAt: 'now', revision: 0, coordinatorEpoch: 'epoch', participants: [], messages: [], turns: [], bindings: [], summaries: [], pinnedMessageIds: [], commandReceipts: [] };
+  const payload = { text: 'hello', selectedParticipantIds: ['p'] };
+  const turn: ConversationTurn = { id: 't', commandId: 'cmd', payloadDigest: conversationPayloadDigest(payload), userMessageId: 'u', acceptedSequence: 1, plan: { participants: [{ id: 'p', role: 'lead', instructionVersion: '1', instructions: 'help', defaults: {} }], runtimeOptions: {} }, state: 'queued', completedParticipantIds: [], attempts: [] };
+  const message: ConversationMessage = { id: 'u', role: 'user', text: 'hello', createdAt: 'now', sequence: 1, turnId: 't', attachments: [] };
+  const attempt: ConversationAttempt = { id: 'a', turnId: 't', participantId: 'p', ordinal: 1, coordinatorEpoch: 'epoch', state: 'prepared', contextReceipt: { digest: 'digest', messageIds: ['u'] }, createdAt: 'now', usageReferences: [], toolEvidenceReferences: [] };
+  const reply: ConversationMessage = { ...message, id: 'r', role: 'lead', participantId: 'p', sequence: 2, text: 'reply' };
+  return { chat, payload, turn, message, attempt, reply };
+}
+test('submit is atomic, isolated and idempotent after acknowledgement loss; conflicting reuse fails', () => {
+  const { chat, payload, turn, message } = fixture();
+  const accepted = submitConversationTurn(chat, 0, payload, turn, message);
+  assert.equal(chat.messages.length, 0);
+  assert.equal(accepted.messages.length, 1);
+  assert.equal(accepted.turns.length, 1);
+  assert.equal(accepted.commandReceipts[0].revision, 1);
+  assert.deepEqual(submitConversationTurn(accepted, 0, { selectedParticipantIds: ['p'], text: 'hello' }, turn, message), accepted);
+  assert.throws(() => submitConversationTurn(accepted, 1, { text: 'other' }, turn, message), /payload conflict/);
+  turn.plan.participants[0].instructions = 'changed';
+  assert.equal(accepted.turns[0].plan.participants[0].instructions, 'help');
+});
+test('stale revisions, duplicate identities and a second running turn are rejected', () => {
+  const { chat, payload, turn, message } = fixture();
+  const accepted = submitConversationTurn(chat, 0, payload, turn, message);
+  assert.throws(() => startConversationTurn(accepted, 0, 't'), /revision conflict/);
+  const running = startConversationTurn(accepted, 1, 't');
+  assert.throws(() => startConversationTurn(running, 2, 't'), /active/);
+  assert.throws(() => submitConversationTurn(accepted, 1, payload, { ...turn, commandId: 'other' }, message), /Invalid/);
+});
+test('completion atomically records final reply and context; duplicate and fenced attempts cannot complete', () => {
+  const { chat, payload, turn, message, attempt, reply } = fixture();
+  const running = startConversationTurn(submitConversationTurn(chat, 0, payload, turn, message), 1, 't');
+  const prepared = reserveConversationAttempt(running, 2, attempt);
+  assert.throws(() => completeConversationAttempt(prepared, 3, 't', 'a', 'epoch', reply, attempt.contextReceipt), /Invalid/);
+  const reserved = advanceConversationAttempt(prepared, 3, 't', 'a', 'epoch', 'dispatching', 'now');
+  assert.throws(() => reserveConversationAttempt(reserved, 4, { ...attempt, id: 'b', ordinal: 2 }), /Invalid/);
+  assert.throws(() => completeConversationAttempt(reserved, 4, 't', 'a', 'old', reply, attempt.contextReceipt), /fenced/);
+  const fenced = structuredClone(reserved); fenced.coordinatorEpoch = 'new';
+  assert.throws(() => completeConversationAttempt(fenced, 4, 't', 'a', 'epoch', reply, attempt.contextReceipt), /fenced/);
+  const done = completeConversationAttempt(reserved, 4, 't', 'a', 'epoch', reply, attempt.contextReceipt);
+  assert.equal(done.turns[0].state, 'completed');
+  assert.equal(done.turns[0].attempts[0].resultMessageId, 'r');
+  assert.equal(done.messages.length, 2);
+  assert.equal(reserved.messages.length, 1);
+  assert.throws(() => completeConversationAttempt(done, 5, 't', 'a', 'epoch', { ...reply, id: 'r2', sequence: 3 }, attempt.contextReceipt), /duplicate/);
+});
+test('payload canonicalization rejects non-JSON values', () => {
+  assert.throws(() => conversationPayloadDigest({ value: undefined }), /JSON/);
+  assert.throws(() => conversationPayloadDigest(NaN), /JSON/);
+});
diff --git a/packages/core/src/ai/assistant/teamChatTransitions.ts b/packages/core/src/ai/assistant/teamChatTransitions.ts
new file mode 100644
index 00000000..6bc520ee
--- /dev/null
+++ b/packages/core/src/ai/assistant/teamChatTransitions.ts
@@ -0,0 +1,94 @@
+import { createHash } from 'node:crypto';
+import type { ConversationAttempt, ConversationMessage, ConversationTurn, DurableConversation } from './assistantTypes';
+
+/** Stable JSON encoding: object key order must not change command identity. */
+export function conversationPayloadDigest(payload: unknown): string {
+  const canonical = (value: unknown): string => {
+    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
+    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
+    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
+    if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
+      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
+    }
+    throw new Error('Command payload must contain only JSON values.');
+  };
+  return createHash('sha256').update(canonical(payload)).digest('hex');
+}
+function revision(current: DurableConversation, expected: number): void {
+  if (current.revision !== expected) throw new Error('Conversation revision conflict.');
+}
+function changed(current: DurableConversation, expected: number): DurableConversation {
+  revision(current, expected);
+  const next = structuredClone(current);
+  next.revision++;
+  return next;
+}
+export function submitConversationTurn(current: DurableConversation, expected: number, payload: unknown, turn: ConversationTurn, message: ConversationMessage): DurableConversation {
+  const digest = conversationPayloadDigest(payload);
+  const receipt = current.commandReceipts.find(item => item.commandId === turn.commandId);
+  if (receipt) {
+    if (receipt.payloadDigest !== digest) throw new Error('Command payload conflict.');
+    return structuredClone(current);
+  }
+  const next = changed(current, expected);
+  if (turn.state !== 'queued' || turn.attempts.length || turn.completedParticipantIds.length || turn.payloadDigest !== digest ||
+      turn.userMessageId !== message.id || message.turnId !== turn.id || message.role !== 'user' || message.participantId ||
+      message.sequence !== (current.messages.at(-1)?.sequence ?? 0) + 1 || turn.acceptedSequence !== message.sequence ||
+      current.turns.some(item => item.id === turn.id) || current.messages.some(item => item.id === message.id) ||
+      !turn.plan.participants.length || new Set(turn.plan.participants.map(item => item.id)).size !== turn.plan.participants.length ||
+      new Set(turn.plan.participants.map(item => item.role)).size !== turn.plan.participants.length) throw new Error('Invalid accepted turn.');
+  next.turns.push(structuredClone(turn));
+  next.messages.push(structuredClone(message));
+  next.commandReceipts.push({ commandId: turn.commandId, payloadDigest: digest, turnId: turn.id, revision: next.revision, outcome: 'accepted' });
+  return next;
+}
+export function startConversationTurn(current: DurableConversation, expected: number, turnId: string): DurableConversation {
+  const next = changed(current, expected);
+  if (next.turns.some(turn => !['queued', 'completed', 'cancelled'].includes(turn.state))) throw new Error('Conversation already has an active or paused turn.');
+  const turn = next.turns.find(item => item.state === 'queued');
+  if (!turn || turn.id !== turnId) throw new Error('Turn is not the next queued turn.');
+  turn.state = 'running';
+  return next;
+}
+const terminal = new Set(['completed', 'failed', 'interrupted', 'outcome_unknown', 'cancelled']);
+export function reserveConversationAttempt(current: DurableConversation, expected: number, attempt: ConversationAttempt): DurableConversation {
+  const next = changed(current, expected);
+  const turn = next.turns.find(item => item.id === attempt.turnId);
+  const participant = turn?.plan.participants.find(item => !turn.completedParticipantIds.includes(item.id));
+  if (!turn || turn.state !== 'running' || participant?.id !== attempt.participantId || attempt.coordinatorEpoch !== current.coordinatorEpoch ||
+      attempt.state !== 'prepared' || attempt.ordinal !== turn.attempts.filter(item => item.participantId === attempt.participantId).length + 1 ||
+      next.turns.some(item => item.attempts.some(existing => existing.id === attempt.id)) || turn.attempts.some(item => !terminal.has(item.state))) throw new Error('Invalid or fenced attempt.');
+  turn.attempts.push(structuredClone(attempt));
+  return next;
+}
+/** Advance dispatch evidence without changing the immutable accepted plan. */
+export function advanceConversationAttempt(current: DurableConversation, expected: number, turnId: string, attemptId: string, epoch: string, state: 'dispatching' | 'running' | 'awaiting_approval', timestamp: string): DurableConversation {
+  const next = changed(current, expected);
+  const turn = next.turns.find(item => item.id === turnId);
+  const attempt = turn?.attempts.find(item => item.id === attemptId);
+  const allowed: Record<string, string[]> = { prepared: ['dispatching'], dispatching: ['running'], running: ['awaiting_approval'], awaiting_approval: ['running'] };
+  if (!turn || turn.state !== 'running' || !attempt || epoch !== current.coordinatorEpoch || epoch !== attempt.coordinatorEpoch || !allowed[attempt.state]?.includes(state)) {
+    throw new Error('Invalid or fenced attempt transition.');
+  }
+  attempt.state = state;
+  if (state === 'dispatching') attempt.dispatchIntent = timestamp;
+  return next;
+}
+export function completeConversationAttempt(current: DurableConversation, expected: number, turnId: string, attemptId: string, epoch: string, message: ConversationMessage, receipt: ConversationAttempt['contextReceipt']): DurableConversation {
+  const next = changed(current, expected);
+  const turn = next.turns.find(item => item.id === turnId);
+  const attempt = turn?.attempts.find(item => item.id === attemptId);
+  if (!turn || !attempt || turn.state !== 'running' || epoch !== current.coordinatorEpoch || epoch !== attempt.coordinatorEpoch ||
+      (!['dispatching', 'running', 'awaiting_approval'].includes(attempt.state) || !attempt.dispatchIntent) || turn.attempts.filter(item => item.participantId === attempt.participantId).at(-1)?.id !== attemptId ||
+      turn.completedParticipantIds.includes(attempt.participantId) || message.turnId !== turnId || message.participantId !== attempt.participantId ||
+      message.role !== turn.plan.participants.find(item => item.id === attempt.participantId)?.role || next.messages.some(item => item.id === message.id) ||
+      message.sequence !== (current.messages.at(-1)?.sequence ?? 0) + 1 || receipt.digest !== attempt.contextReceipt.digest ||
+      JSON.stringify(receipt) !== JSON.stringify(attempt.contextReceipt)) throw new Error('Invalid, duplicate or fenced completion.');
+  attempt.state = 'completed';
+  attempt.resultMessageId = message.id;
+  attempt.completedAt = message.createdAt;
+  turn.completedParticipantIds.push(attempt.participantId);
+  if (turn.completedParticipantIds.length === turn.plan.participants.length) turn.state = 'completed';
+  next.messages.push(structuredClone(message));
+  return next;
+}
diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts
index 9191dae5..e99f2400 100644
--- a/packages/core/src/index.ts
+++ b/packages/core/src/index.ts
@@ -219,3 +219,5 @@ export { runProviderPrompt } from './ai/providerPrompt';
 export * from './notes/noteTypes';
 export * from './notes/noteValidation';
 export * from './notes/noteSnapshot';
+
+export * from './ai/assistant/teamChatTransitions';

```
