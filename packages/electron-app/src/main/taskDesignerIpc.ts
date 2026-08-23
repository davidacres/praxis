import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcMain } from 'electron';
import {
  GENERATED_FEATURES_DIRECTORY_NAME,
  GENERATED_FEATURES_ROOT_SEGMENT,
  MASTER_PLAN_DIRECTORY_NAME,
  MASTER_PLAN_FILE_NAME,
  buildTaskDesignerGeneratedFeatureMarkdown,
  buildTaskDesignerGeneratedStoryMarkdown,
  buildTaskDesignerMasterPlanArtifacts,
  normalizeTaskDesignerPersistedState,
  recommendTaskDesignerFlowWithGateway,
  validateTaskDesignerConnectorGraph,
  type Board,
  type IssueDetails,
  type TaskDesignerIssueNodePayload,
  type TaskDesignerMasterPlanResult,
  type TaskDesignerPersistedState,
  type TaskDesignerRecommendationConnector,
  type TaskDesignerRecommendationNode,
  type TaskDesignerRelatedIssueRelation,
  type TaskDesignerResolvedDroppedIssue,
  type TaskDesignerResolvedIssueRelation,
  type TaskDesignerSetStateResult
} from '@ticket-manager/core';
import { resolveGatewayOptions } from './aiInstance';
import { getServiceForConnection } from './serviceRegistry';
import { getSettingsBackend } from './settingsBackendInstance';
import { getTaskDesignerStore, taskDesignerCanvasKey } from './taskDesignerStoreInstance';

/**
 * Task Designer IPC — the desktop counterpart of the extension's
 * `taskDesignerPanelManager` host handlers. Canvas persistence lives in a JSON
 * file under userData; issue resolution goes through the connection's backend;
 * flow recommendations go through the Vercel gateway; the master plan is
 * written into the configured AI working directory.
 *
 * Error style mirrors the extension's ok:false posts: operational failures
 * (no gateway key, too few nodes, graph cycle, missing working directory)
 * reject the invoke promise and the renderer shows the message in its feedback
 * pill. Only `setState` uses a result envelope, because it also carries the
 * corrective state the renderer must adopt (same contract as the extension's
 * persistCanvasStateResult).
 */

function pickFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function fallbackIssueKeyProjectKey(issueKey: string): string {
  const jiraStyle = /^([A-Za-z][A-Za-z0-9_]+)-\d+$/.exec(issueKey);
  if (jiraStyle) {
    return jiraStyle[1].toUpperCase();
  }
  const gitLabStyle = issueKey.includes('#') ? issueKey.split('#')[0]?.trim() : undefined;
  return gitLabStyle || 'UNKNOWN';
}

/** Port of the extension's `normalizeIssuePayload`. */
function normalizeIssuePayload(
  issue: Partial<IssueDetails>,
  requestedIssueKey?: string
): TaskDesignerIssueNodePayload | undefined {
  const issueKey = pickFirstString(issue.key, requestedIssueKey);
  if (!issueKey) {
    return undefined;
  }

  return {
    issueKey,
    summary: pickFirstString(issue.summary) ?? issueKey,
    issueType: pickFirstString(issue.issueType) ?? 'Unknown',
    status: pickFirstString(issue.status) ?? 'Unknown',
    assignee: pickFirstString(issue.assignee),
    priority: pickFirstString(issue.priority),
    projectKey: pickFirstString(issue.projectKey) ?? fallbackIssueKeyProjectKey(issueKey)
  };
}

async function resolveDroppedIssue(
  issueKey: string,
  connectionId?: string
): Promise<TaskDesignerResolvedDroppedIssue> {
  const service = await getServiceForConnection(connectionId);
  const issue = await service.getIssue(issueKey);
  const mainIssue = normalizeIssuePayload(issue, issueKey);
  if (!mainIssue) {
    throw new Error(`Unable to resolve ${issueKey}.`);
  }

  const relatedIssueKeys = new Map<string, TaskDesignerRelatedIssueRelation>();
  for (const dependencyKey of issue.dependsOn ?? []) {
    const trimmed = dependencyKey.trim();
    if (trimmed && trimmed !== mainIssue.issueKey) {
      relatedIssueKeys.set(trimmed, 'dependsOn');
    }
  }
  for (const subTask of issue.subTasks ?? []) {
    const trimmed = subTask.key.trim();
    if (trimmed && trimmed !== mainIssue.issueKey) {
      relatedIssueKeys.set(trimmed, 'subTask');
    }
  }

  const relatedIssues: TaskDesignerResolvedDroppedIssue['relatedIssues'] = [];
  const relations: TaskDesignerResolvedIssueRelation[] = [];
  for (const [relatedIssueKey, relation] of relatedIssueKeys.entries()) {
    try {
      const relatedIssue = await service.getIssue(relatedIssueKey);
      const normalizedRelatedIssue = normalizeIssuePayload(relatedIssue, relatedIssueKey);
      if (!normalizedRelatedIssue) {
        continue;
      }
      relatedIssues.push({ ...normalizedRelatedIssue, relation });
      relations.push(
        relation === 'dependsOn'
          ? {
              relation,
              sourceIssueKey: normalizedRelatedIssue.issueKey,
              targetIssueKey: mainIssue.issueKey
            }
          : {
              relation,
              sourceIssueKey: mainIssue.issueKey,
              targetIssueKey: normalizedRelatedIssue.issueKey
            }
      );
    } catch {
      // Skip unresolved related issues but still allow the main drop to succeed.
    }
  }

  return { mainIssue, relatedIssues, relations };
}

async function recommendFlow(
  nodes: TaskDesignerRecommendationNode[],
  connectors: TaskDesignerRecommendationConnector[]
) {
  const { apiKey, gatewayUrl } = await resolveGatewayOptions();
  if (!apiKey) {
    throw new Error('No Vercel AI Gateway API key configured. Add one under Settings → AI Provider.');
  }
  if (nodes.length < 2) {
    throw new Error('Add at least two ticket nodes before requesting an AI recommendation.');
  }
  return recommendTaskDesignerFlowWithGateway(nodes, connectors, { apiKey, gatewayUrl });
}

async function recommendBoardFlow(board: Board) {
  const { apiKey, gatewayUrl } = await resolveGatewayOptions();
  if (!apiKey) {
    throw new Error('No Vercel AI Gateway API key configured. Add one under Settings → AI Provider.');
  }

  const service = await getServiceForConnection(board.connectionId);
  const details = await service.getBoardDetails(board);
  if (details.issues.length === 0) {
    throw new Error(`Board "${board.name}" has no tickets to recommend.`);
  }
  if (details.issues.length < 2) {
    throw new Error(`Board "${board.name}" needs at least two tickets for AI recommendation.`);
  }

  const nodes: TaskDesignerRecommendationNode[] = details.issues.map((issue, index) => ({
    id: `board-${issue.key}-${index}`,
    issueKey: issue.key,
    summary: issue.summary,
    issueType: issue.issueType,
    status: issue.status,
    assignee: issue.assignee,
    priority: issue.priority,
    projectKey: issue.projectKey
  }));
  const recommendation = await recommendTaskDesignerFlowWithGateway(nodes, [], { apiKey, gatewayUrl });
  return { boardName: board.name, nodes, recommendation };
}

function ticketOnlyGraph(state: TaskDesignerPersistedState) {
  const ticketNodes = state.nodes.filter(node => node.type === 'ticket');
  const ticketNodeIds = new Set(ticketNodes.map(node => node.id));
  const ticketConnectors = state.connectors.filter(
    connector => ticketNodeIds.has(connector.sourceNodeId) && ticketNodeIds.has(connector.targetNodeId)
  );
  return { ticketNodes, ticketConnectors };
}

async function generateMasterPlan(
  state: TaskDesignerPersistedState
): Promise<TaskDesignerMasterPlanResult> {
  const normalized = normalizeTaskDesignerPersistedState(state).state;
  const { ticketNodes, ticketConnectors } = ticketOnlyGraph(normalized);
  if (ticketNodes.length === 0) {
    throw new Error('Add at least one ticket node before generating a master plan.');
  }

  const graphError = validateTaskDesignerConnectorGraph(ticketConnectors);
  if (graphError) {
    throw new Error(`Cannot generate master plan: ${graphError.message}`);
  }

  const workingDirectory = getSettingsBackend().read().ai.workingDirectory.trim();
  if (!workingDirectory) {
    throw new Error('Set a working directory under Settings → AI before generating a master plan.');
  }

  const plansDirectory = path.join(workingDirectory, MASTER_PLAN_DIRECTORY_NAME);
  const masterPlanFile = path.join(plansDirectory, MASTER_PLAN_FILE_NAME);
  const generatedFeaturesRoot = path.join(
    plansDirectory,
    GENERATED_FEATURES_ROOT_SEGMENT,
    GENERATED_FEATURES_DIRECTORY_NAME
  );
  const artifacts = buildTaskDesignerMasterPlanArtifacts(ticketNodes, ticketConnectors);

  try {
    await fs.promises.mkdir(plansDirectory, { recursive: true });
    await fs.promises.writeFile(masterPlanFile, artifacts.masterPlanMarkdown, 'utf8');
    await fs.promises.rm(generatedFeaturesRoot, { recursive: true, force: true });
    await fs.promises.mkdir(generatedFeaturesRoot, { recursive: true });
    for (const feature of artifacts.features) {
      const featureDirectoryName = `feature-${feature.ref}-${feature.slug}`;
      const featureDirectory = path.join(generatedFeaturesRoot, featureDirectoryName);
      await fs.promises.mkdir(featureDirectory, { recursive: true });
      await fs.promises.writeFile(
        path.join(featureDirectory, `${featureDirectoryName}.md`),
        buildTaskDesignerGeneratedFeatureMarkdown(feature),
        'utf8'
      );
      for (const story of feature.stories) {
        await fs.promises.writeFile(
          path.join(featureDirectory, `story-${feature.ref}-${story.storyNumber}-${story.slug}.md`),
          buildTaskDesignerGeneratedStoryMarkdown(story),
          'utf8'
        );
      }
    }
  } catch (error) {
    throw new Error(
      `Unable to write ${MASTER_PLAN_DIRECTORY_NAME}\\${MASTER_PLAN_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    outputPath: masterPlanFile,
    generatedFeaturesPath: generatedFeaturesRoot,
    generatedFeatureCount: artifacts.features.length,
    generatedStoryCount: artifacts.storyCount
  };
}

export function registerTaskDesignerIpc(): void {
  ipcMain.handle('taskDesigner:getState', async (_event, boardId: string, connectionId?: string) => {
    const store = getTaskDesignerStore();
    const key = taskDesignerCanvasKey(boardId, connectionId);
    const recovered = normalizeTaskDesignerPersistedState(store.get<unknown>(key));
    if (recovered.repaired) {
      await store.update(key, recovered.state);
    }
    return recovered.state;
  });

  ipcMain.handle(
    'taskDesigner:setState',
    async (
      _event,
      boardId: string,
      connectionId: string | undefined,
      state: TaskDesignerPersistedState
    ): Promise<TaskDesignerSetStateResult> => {
      const store = getTaskDesignerStore();
      const key = taskDesignerCanvasKey(boardId, connectionId);
      const recovered = normalizeTaskDesignerPersistedState(state);
      if (recovered.repaired) {
        await store.update(key, recovered.state);
        return {
          ok: false,
          warning: recovered.warning ?? 'Recovered invalid canvas state while saving.',
          state: recovered.state
        };
      }
      const graphError = validateTaskDesignerConnectorGraph(recovered.state.connectors);
      if (graphError) {
        const persisted = normalizeTaskDesignerPersistedState(store.get<unknown>(key)).state;
        return { ok: false, warning: graphError.message, state: persisted };
      }
      await store.update(key, recovered.state);
      return { ok: true, state: recovered.state };
    }
  );

  ipcMain.handle('taskDesigner:resolveIssue', async (_event, issueKey: string, connectionId?: string) => {
    const trimmed = issueKey?.trim();
    if (!trimmed) {
      throw new Error('Dropped issue key is missing.');
    }
    return resolveDroppedIssue(trimmed, connectionId);
  });

  ipcMain.handle(
    'taskDesigner:recommendFlow',
    async (
      _event,
      nodes: TaskDesignerRecommendationNode[],
      connectors: TaskDesignerRecommendationConnector[]
    ) => recommendFlow(nodes, connectors)
  );

  ipcMain.handle('taskDesigner:recommendBoardFlow', async (_event, board: Board) => recommendBoardFlow(board));

  ipcMain.handle(
    'taskDesigner:generateMasterPlan',
    async (
      _event,
      _boardId: string,
      _connectionId: string | undefined,
      state: TaskDesignerPersistedState
    ) => generateMasterPlan(state)
  );
}
