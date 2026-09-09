import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  applyWorkflowRunCommand,
  approveStage,
  assembleTemplateLibrary,
  assessTemplateReadiness,
  builtInWorkflowTemplates,
  bypassGate as bypassWorkflowGate,
  advanceJoins,
  createWorkflowRun,
  deleteProjectWorkflow,
  instantiateTemplateForProject,
  isEvidenceExpired,
  loadProjectWorkflows,
  migrateWorkflow,
  normalizeWorkflow,
  isRunSettled,
  readEvidenceBundle,
  readEvidenceContent,
  recoverWorkflowRun,
  resolveWorkflowCatalog,
  summarizeWorkflowRun,
  validateWorkflow,
  workflowFileName,
  writeProjectWorkflow,
  WorkflowRunStore,
  type AgentCatalogSnapshot,
  type TemplateReadiness,
  type WorkflowCatalog,
  type WorkflowDefinition,
  type WorkflowEvidenceView,
  type WorkflowGateKind,
  type WorkflowPolicyProfile,
  type WorkflowRun,
  type WorkflowRunSummary,
  type WorkflowTemplate,
  type WorkflowValidationResult
} from '@praxis/core';
import { getProjectStore } from './projectStoreInstance';
import { getAgentRuntimeManager } from './agentRuntimeInstance';
import { marketplaceWorkflowTemplates } from './marketplaceInstance';
import { getWorkflowOrchestrator, writeBackToIssue } from './workflowOrchestratorInstance';
import { evidenceStorageRoot } from './workflowEvidenceStorage';
import {
  getWorkflowPolicyStore,
  getWorkflowStore,
  getWorkflowBackingStore,
  projectWorkflowsKey
} from './workflowStoreInstance';

function runStore(): WorkflowRunStore {
  return new WorkflowRunStore(getWorkflowBackingStore());
}

/**
 * The "global" template tier: the user's saved global workflows plus any enabled
 * `workflow-template` marketplace add-ons. Add-on definitions are normalised,
 * forced to `scope: 'global'`, and dropped if they do not validate.
 */
async function globalTemplateDefinitions(): Promise<WorkflowDefinition[]> {
  const saved = getWorkflowStore().list();
  const savedIds = new Set(saved.map(definition => definition.id));
  const fromAddons: WorkflowDefinition[] = [];
  for (const raw of await marketplaceWorkflowTemplates()) {
    try {
      const normalized = normalizeWorkflow({ ...(raw as object), scope: 'global' });
      if (!normalized || savedIds.has(normalized.id)) continue;
      if (validateWorkflow(normalized).valid) fromAddons.push(normalized);
    } catch {
      /* a malformed add-on template is skipped, not fatal */
    }
  }
  return [...saved, ...fromAddons];
}

function policyFor(projectId: string): WorkflowPolicyProfile | undefined {
  return getWorkflowPolicyStore().effectiveForProject(projectId)?.profile;
}

function summarize(run: WorkflowRun): WorkflowRunSummary {
  return summarizeWorkflowRun(run, policyFor(run.projectId));
}

/** Initial/recovered records; live mutations go through the orchestrator chain. */
async function saveRun(run: WorkflowRun): Promise<WorkflowRun> {
  await runStore().save(run);
  if (isRunSettled(run)) void writeBackToIssue(run);
  return run;
}

async function withRun(runId: string, apply: (run: WorkflowRun) => WorkflowRun): Promise<WorkflowRunSummary> {
  await getWorkflowOrchestrator().updateRun(runId, apply);
  const run = runStore().get(runId);
  if (!run) throw new Error(`Run ${runId} was not found.`);
  return summarize(run);
}

/**
 * On startup, close any attempt that was in flight when the app last stopped.
 * Completed stages are untouched; an interrupted one is surfaced for retry.
 */
export async function recoverWorkflowRunsOnStartup(): Promise<void> {
  const store = runStore();
  const now = new Date().toISOString();
  for (const run of store.list()) {
    const recovered = recoverWorkflowRun(run, now);
    if (recovered.interrupted.length > 0) await saveRun(recovered.run);
    // Re-enter the loop so anything still runnable is picked back up. The
    // orchestrator holds no state of its own, so this is all recovery needs.
    if (!isRunSettled(recovered.run) || recovered.run.worktreePath) void getWorkflowOrchestrator().step(run.runId);
  }
}

/**
 * Governed delivery workflow IPC (FX-BF-012 / FX-BE-021).
 *
 * The designer edits project-scoped definitions. Those live canonically in a
 * project's `.praxis/workflows` folder, but a draft is also mirrored to the
 * global workflows.json under a per-project key so an uncommitted edit survives
 * a restart. Reads merge both, folder winning.
 */

async function projectFolder(projectId: string): Promise<string | undefined> {
  const project = getProjectStore().get(projectId);
  return project?.workspaceFolder;
}

function draftDefinitions(projectId: string): WorkflowDefinition[] {
  const raw = getWorkflowBackingStore().get<unknown[]>(projectWorkflowsKey(projectId));
  if (!Array.isArray(raw)) return [];
  return raw
    .map(entry => migrateWorkflow(entry).definition)
    .filter((entry): entry is WorkflowDefinition => !!entry);
}

async function projectDefinitions(projectId: string): Promise<WorkflowDefinition[]> {
  const folder = await projectFolder(projectId);
  const committed = folder ? (await loadProjectWorkflows(folder)).workflows.map(entry => entry.definition) : [];
  const committedIds = new Set(committed.map(definition => definition.id));
  // A committed definition is authoritative; a draft only shows through when
  // nothing with its id has been committed yet.
  const drafts = draftDefinitions(projectId).filter(definition => !committedIds.has(definition.id));
  return [...committed, ...drafts];
}

async function catalogSnapshot(): Promise<AgentCatalogSnapshot> {
  try {
    const snapshot = await getAgentRuntimeManager().list();
    return { agents: snapshot.agents, skills: snapshot.skills, capabilities: snapshot.capabilities };
  } catch {
    return { agents: [], skills: [], capabilities: {} };
  }
}

async function saveDraft(projectId: string, definition: WorkflowDefinition): Promise<void> {
  const existing = draftDefinitions(projectId).filter(candidate => candidate.id !== definition.id);
  await getWorkflowBackingStore().update(projectWorkflowsKey(projectId), [...existing, definition]);
}

async function dropDraft(projectId: string, workflowId: string): Promise<void> {
  const remaining = draftDefinitions(projectId).filter(candidate => candidate.id !== workflowId);
  await getWorkflowBackingStore().update(projectWorkflowsKey(projectId), remaining);
}

/**
 * Persists a project definition to its canonical home. A folder-backed project
 * gets a real `.praxis/workflows/<id>.json` file (version-controllable,
 * shareable); a folderless project falls back to the app-local draft store.
 */
async function persistProjectWorkflow(projectId: string, definition: WorkflowDefinition): Promise<string | undefined> {
  const folder = await projectFolder(projectId);
  if (!folder) {
    await saveDraft(projectId, definition);
    return undefined;
  }
  const filePath = await writeProjectWorkflow(folder, definition);
  // The committed file is now authoritative; a leftover draft only confuses.
  await dropDraft(projectId, definition.id);
  return filePath;
}

export function registerWorkflowIpc(): void {
  ipcMain.handle('workflows:listTemplates', async (_event, projectId: string): Promise<WorkflowTemplate[]> => {
    const project = await projectDefinitions(projectId);
    return assembleTemplateLibrary({
      global: await globalTemplateDefinitions(),
      project: project.map(definition => ({ definition }))
    });
  });

  ipcMain.handle('workflows:templateReadiness', async (_event, projectId: string): Promise<TemplateReadiness[]> => {
    const snapshot = await catalogSnapshot();
    const templates = [
      ...builtInWorkflowTemplates(),
      ...(await globalTemplateDefinitions()),
      ...(await projectDefinitions(projectId))
    ];
    return templates.map(template => assessTemplateReadiness(template, snapshot));
  });

  ipcMain.handle('workflows:catalog', async (_event, projectId: string): Promise<WorkflowCatalog> => {
    return resolveWorkflowCatalog({
      builtIn: builtInWorkflowTemplates(),
      global: await globalTemplateDefinitions(),
      project: (await projectDefinitions(projectId)).map(definition => ({ definition, source: 'project' as const }))
    });
  });

  ipcMain.handle(
    'workflows:get',
    async (_event, projectId: string, workflowId: string): Promise<WorkflowDefinition | undefined> => {
      return (await projectDefinitions(projectId)).find(definition => definition.id === workflowId);
    }
  );

  ipcMain.handle(
    'workflows:instantiate',
    async (_event, projectId: string, templateId: string, name?: string): Promise<WorkflowDefinition> => {
      const templates = [...builtInWorkflowTemplates(), ...(await globalTemplateDefinitions()), ...(await projectDefinitions(projectId))];
      const template = templates.find(candidate => candidate.id === templateId);
      if (!template) throw new Error(`Template ${templateId} was not found.`);

      const copy = instantiateTemplateForProject({
        template,
        projectId,
        at: new Date().toISOString(),
        ...(name ? { newName: name } : {})
      });
      const result = validateWorkflow(copy);
      if (!result.valid) {
        throw new Error(`The template did not produce a valid workflow: ${result.errors.map(issue => issue.message).join('; ')}`);
      }
      await saveDraft(projectId, copy);
      return copy;
    }
  );

  ipcMain.handle(
    'workflows:save',
    async (_event, projectId: string, definition: WorkflowDefinition): Promise<WorkflowDefinition> => {
      const normalized = normalizeWorkflow(definition);
      if (normalized.scope !== 'project' || normalized.projectId !== projectId) {
        throw new Error('The designer can only save a project-scoped workflow for its own project.');
      }
      const result = validateWorkflow(normalized);
      if (!result.valid) {
        throw new Error(`Workflow is invalid: ${result.errors.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`);
      }
      // Reject an id that could not be committed as a file, even for a
      // folderless project — so a project that later gains a folder can always
      // commit what it already authored.
      workflowFileName(normalized.id);

      const next: WorkflowDefinition = { ...normalized, updatedAt: new Date().toISOString() };
      await persistProjectWorkflow(projectId, next);
      return next;
    }
  );

  ipcMain.handle('workflows:remove', async (_event, projectId: string, workflowId: string): Promise<void> => {
    await dropDraft(projectId, workflowId);
    const folder = await projectFolder(projectId);
    if (folder) await deleteProjectWorkflow(folder, workflowId);
  });

  ipcMain.handle(
    'workflows:validate',
    async (_event, _projectId: string, definition: WorkflowDefinition): Promise<WorkflowValidationResult> => {
      return validateWorkflow(normalizeWorkflow(definition));
    }
  );

  ipcMain.handle(
    'workflows:effectivePolicy',
    async (_event, projectId: string): Promise<WorkflowPolicyProfile | undefined> => {
      return getWorkflowPolicyStore().effectiveForProject(projectId)?.profile;
    }
  );

  // ── Runs ───────────────────────────────────────────────────────────────

  ipcMain.handle(
    'workflows:startRun',
    async (
      _event,
      projectId: string,
      workflowId: string,
      taskTitle: string,
      issue?: { issueKey: string; connectionId?: string }
    ): Promise<WorkflowRunSummary> => {
      const definition = (await projectDefinitions(projectId)).find(candidate => candidate.id === workflowId);
      if (!definition) throw new Error(`Workflow ${workflowId} was not found for this project.`);

      const result = validateWorkflow(definition, policyFor(projectId));
      if (!result.valid) {
        throw new Error(`Cannot start an invalid workflow: ${result.errors.map(issue => issue.message).join('; ')}`);
      }

      const run = createWorkflowRun({
        runId: randomUUID(),
        projectId,
        definition: { ...definition, name: `${definition.name} — ${taskTitle}`.trim() },
        at: new Date().toISOString(),
        ...(issue?.issueKey ? { issueKey: issue.issueKey, issueConnectionId: issue.connectionId } : {})
      });
      await saveRun(run);
      // Hand it straight to the orchestrator; deterministic stages start now.
      void getWorkflowOrchestrator().step(run.runId);
      return summarize(run);
    }
  );

  ipcMain.handle('workflows:listRuns', async (_event, projectId: string): Promise<WorkflowRunSummary[]> => {
    return runStore()
      .forProject(projectId)
      .map(run => summarize(run));
  });

  ipcMain.handle('workflows:getRun', async (_event, runId: string): Promise<WorkflowRunSummary | undefined> => {
    const run = runStore().get(runId);
    return run ? summarize(run) : undefined;
  });

  ipcMain.handle(
    'workflows:advanceStage',
    async (
      _event,
      runId: string,
      nodeId: string,
      outcome: 'succeeded' | 'failed',
      detail?: { error?: string; snapshotRef?: string }
    ): Promise<WorkflowRunSummary> => {
      return withRun(runId, run => {
        const at = new Date().toISOString();
        let next = applyWorkflowRunCommand(run, {
          kind: 'node-started',
          nodeId,
          at,
          sessionId: `manual-${nodeId}`
        });
        const node = next.definition.nodes.find(candidate => candidate.id === nodeId);
        const artifacts =
          outcome === 'succeeded' && node && 'outputs' in node
            ? node.outputs.map(contract => ({ contractId: contract.id, kind: contract.kind }))
            : [];
        next = applyWorkflowRunCommand(next, {
          kind: outcome === 'succeeded' ? 'node-succeeded' : 'node-failed',
          nodeId,
          at,
          ...(outcome === 'succeeded'
            ? { artifacts, ...(detail?.snapshotRef ? { snapshotRef: detail.snapshotRef } : {}) }
            : { error: detail?.error ?? 'Stage failed.' })
        } as never);
        return advanceJoins(next, at);
      }).then(async summary => {
        await getWorkflowOrchestrator().step(runId);
        return runStore().get(runId) ? summarize(runStore().get(runId) as WorkflowRun) : summary;
      });
    }
  );

  ipcMain.handle(
    'workflows:approveRun',
    async (_event, runId: string, actor: string, note?: string): Promise<WorkflowRunSummary> => {
      await withRun(runId, run => {
        const approval = run.definition.nodes.find(node => node.type === 'approval');
        if (!approval) throw new Error('This workflow has no approval stage.');

        const result = approveStage(
          run,
          approval.id,
          { actor, at: new Date().toISOString(), ...(note ? { note } : {}) },
          policyFor(run.projectId)
        );
        if (!result.ok) throw new Error(result.reason ?? 'Approval was refused.');
        return result.run;
      });
      await getWorkflowOrchestrator().step(runId);
      return summarize(runStore().get(runId)!);
    }
  );

  ipcMain.handle(
    'workflows:bypassGate',
    async (_event, runId: string, gate: string, actor: string, reason: string): Promise<WorkflowRunSummary> => {
      await withRun(runId, run => {
        const approval = run.definition.nodes.find(node => node.type === 'approval');
        if (!approval) throw new Error('This workflow has no approval stage.');

        const result = bypassWorkflowGate(
          run,
          approval.id,
          { gate: gate as WorkflowGateKind, actor, reason, at: new Date().toISOString() },
          policyFor(run.projectId)
        );
        if (!result.ok) throw new Error(result.reason ?? 'The bypass was refused.');
        return result.run;
      });
      await getWorkflowOrchestrator().step(runId);
      return summarize(runStore().get(runId)!);
    }
  );

  ipcMain.handle('workflows:retryStage', async (_event, runId: string, nodeId: string): Promise<WorkflowRunSummary> => {
    const summary = await withRun(runId, run =>
      applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId, at: new Date().toISOString() })
    );
    await getWorkflowOrchestrator().step(runId);
    const run = runStore().get(runId);
    return run ? summarize(run) : summary;
  });

  ipcMain.handle('workflows:cancelRun', async (_event, runId: string, reason?: string): Promise<WorkflowRunSummary> => {
    await getWorkflowOrchestrator().cancel(runId, reason);
    const run = runStore().get(runId);
    if (!run) throw new Error(`Run ${runId} was not found.`);
    return summarize(run);
  });

  ipcMain.handle(
    'workflows:getEvidence',
    async (_event, runId: string, nodeId: string, attempt: number): Promise<WorkflowEvidenceView> => {
      const run = runStore().get(runId);
      if (!run) return { expired: false };

      const key = { projectId: run.projectId, runId, nodeId, attempt };
      const { bundle } = await readEvidenceBundle(evidenceStorageRoot(), key);
      const entry = bundle?.entries[0];
      if (!entry) return { expired: false };

      const expired = isEvidenceExpired(entry.retention);
      if (entry.presence !== 'present' || expired) return { entry, expired };

      try {
        const content = await readEvidenceContent(evidenceStorageRoot(), key, entry);
        return { entry, content, expired: false };
      } catch {
        // The manifest exists but its content file does not (e.g. removed out
        // of band) — report the entry so the UI can say "unavailable" rather
        // than silently returning nothing.
        return { entry, expired: false };
      }
    }
  );
}
