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
  instantiateTemplateForProject,
  loadProjectWorkflows,
  migrateWorkflow,
  normalizeWorkflow,
  recoverWorkflowRun,
  resolveWorkflowCatalog,
  summarizeWorkflowRun,
  validateWorkflow,
  WorkflowRunStore,
  type AgentCatalogSnapshot,
  type TemplateReadiness,
  type WorkflowCatalog,
  type WorkflowDefinition,
  type WorkflowGateKind,
  type WorkflowPolicyProfile,
  type WorkflowRun,
  type WorkflowRunSummary,
  type WorkflowTemplate,
  type WorkflowValidationResult
} from '@praxis/core';
import { getProjectStore } from './projectStoreInstance';
import { getAgentRuntimeManager } from './agentRuntimeInstance';
import {
  getWorkflowPolicyStore,
  getWorkflowStore,
  getWorkflowBackingStore,
  projectWorkflowsKey
} from './workflowStoreInstance';

function runStore(): WorkflowRunStore {
  return new WorkflowRunStore(getWorkflowBackingStore());
}

function policyFor(projectId: string): WorkflowPolicyProfile | undefined {
  return getWorkflowPolicyStore().effectiveForProject(projectId)?.profile;
}

function summarize(run: WorkflowRun): WorkflowRunSummary {
  return summarizeWorkflowRun(run, policyFor(run.projectId));
}

async function withRun(runId: string, apply: (run: WorkflowRun) => WorkflowRun): Promise<WorkflowRunSummary> {
  const store = runStore();
  const run = store.get(runId);
  if (!run) throw new Error(`Run ${runId} was not found.`);
  const next = apply(run);
  await store.save(next);
  return summarize(next);
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
    if (recovered.interrupted.length > 0) await store.save(recovered.run);
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

export function registerWorkflowIpc(): void {
  ipcMain.handle('workflows:listTemplates', async (_event, projectId: string): Promise<WorkflowTemplate[]> => {
    const project = await projectDefinitions(projectId);
    return assembleTemplateLibrary({
      global: getWorkflowStore().list(),
      project: project.map(definition => ({ definition }))
    });
  });

  ipcMain.handle('workflows:templateReadiness', async (_event, projectId: string): Promise<TemplateReadiness[]> => {
    const snapshot = await catalogSnapshot();
    const templates = [
      ...builtInWorkflowTemplates(),
      ...getWorkflowStore().list(),
      ...(await projectDefinitions(projectId))
    ];
    return templates.map(template => assessTemplateReadiness(template, snapshot));
  });

  ipcMain.handle('workflows:catalog', async (_event, projectId: string): Promise<WorkflowCatalog> => {
    return resolveWorkflowCatalog({
      builtIn: builtInWorkflowTemplates(),
      global: getWorkflowStore().list(),
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
      const templates = [...builtInWorkflowTemplates(), ...getWorkflowStore().list(), ...(await projectDefinitions(projectId))];
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
      const next: WorkflowDefinition = { ...normalized, updatedAt: new Date().toISOString() };
      await saveDraft(projectId, next);
      return next;
    }
  );

  ipcMain.handle('workflows:remove', async (_event, projectId: string, workflowId: string): Promise<void> => {
    const remaining = draftDefinitions(projectId).filter(definition => definition.id !== workflowId);
    await getWorkflowBackingStore().update(projectWorkflowsKey(projectId), remaining);
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
    async (_event, projectId: string, workflowId: string, taskTitle: string): Promise<WorkflowRunSummary> => {
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
        at: new Date().toISOString()
      });
      await runStore().save(run);
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
      });
    }
  );

  ipcMain.handle(
    'workflows:approveRun',
    async (_event, runId: string, actor: string, note?: string): Promise<WorkflowRunSummary> => {
      const store = runStore();
      const run = store.get(runId);
      if (!run) throw new Error(`Run ${runId} was not found.`);
      const approval = run.definition.nodes.find(node => node.type === 'approval');
      if (!approval) throw new Error('This workflow has no approval stage.');

      const result = approveStage(
        run,
        approval.id,
        { actor, at: new Date().toISOString(), ...(note ? { note } : {}) },
        policyFor(run.projectId)
      );
      if (!result.ok) throw new Error(result.reason ?? 'Approval was refused.');
      await store.save(result.run);
      return summarize(result.run);
    }
  );

  ipcMain.handle(
    'workflows:bypassGate',
    async (_event, runId: string, gate: string, actor: string, reason: string): Promise<WorkflowRunSummary> => {
      const store = runStore();
      const run = store.get(runId);
      if (!run) throw new Error(`Run ${runId} was not found.`);
      const approval = run.definition.nodes.find(node => node.type === 'approval');
      if (!approval) throw new Error('This workflow has no approval stage.');

      const result = bypassWorkflowGate(
        run,
        approval.id,
        { gate: gate as WorkflowGateKind, actor, reason, at: new Date().toISOString() },
        policyFor(run.projectId)
      );
      if (!result.ok) throw new Error(result.reason ?? 'The bypass was refused.');
      await store.save(result.run);
      return summarize(result.run);
    }
  );

  ipcMain.handle('workflows:retryStage', async (_event, runId: string, nodeId: string): Promise<WorkflowRunSummary> => {
    return withRun(runId, run =>
      applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId, at: new Date().toISOString() })
    );
  });

  ipcMain.handle('workflows:cancelRun', async (_event, runId: string, reason?: string): Promise<WorkflowRunSummary> => {
    return withRun(runId, run =>
      applyWorkflowRunCommand(run, {
        kind: 'cancel',
        at: new Date().toISOString(),
        ...(reason ? { reason } : {})
      })
    );
  });
}
