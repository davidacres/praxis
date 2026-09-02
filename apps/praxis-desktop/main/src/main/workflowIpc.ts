import { ipcMain } from 'electron';
import {
  assembleTemplateLibrary,
  assessTemplateReadiness,
  builtInWorkflowTemplates,
  instantiateTemplateForProject,
  loadProjectWorkflows,
  migrateWorkflow,
  normalizeWorkflow,
  resolveWorkflowCatalog,
  validateWorkflow,
  type AgentCatalogSnapshot,
  type TemplateReadiness,
  type WorkflowCatalog,
  type WorkflowDefinition,
  type WorkflowPolicyProfile,
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
}
