import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { IssueDetails, IssueSummary } from '../types';
import type {
  TaskDesignerFlowRecommendation,
  TaskDesignerRecommendationConnector,
  TaskDesignerRecommendationNode
} from '../ai/aiReviewService';
import {
  normalizeTaskDesignerPersistedState,
  type TaskDesignerPersistedStateRecoveryResult
} from './taskDesignerStatePersistence';

const TASK_DESIGNER_STATE_KEY = 'ticketManager.taskDesigner.canvasState';
const MASTER_PLAN_DIRECTORY_NAME = 'plans';
const MASTER_PLAN_FILE_NAME = 'master-plan.md';
const GENERATED_FEATURES_ROOT_SEGMENT = 'features';
const GENERATED_FEATURES_DIRECTORY_NAME = 'generated-from-designer';
const GENERATED_STORIES_PER_FEATURE = 3;

interface TicketNode {
  id: string;
  issueKey: string;
  summary: string;
  issueType: string;
  status: string;
  assignee?: string;
  priority?: string;
  projectKey: string;
  x: number;
  y: number;
}

interface DirectedConnector {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
}

interface PersistedTaskDesignerState {
  nodes: TicketNode[];
  connectors: DirectedConnector[];
}

type PersistedTaskDesignerRecoveryResult = TaskDesignerPersistedStateRecoveryResult;

interface GeneratedStoryArtifact {
  readonly node: TicketNode;
  readonly order: number;
  readonly featureNumber: number;
  readonly storyNumber: number;
  readonly ref: string;
  readonly slug: string;
  readonly dependencies: readonly string[];
}

interface GeneratedFeatureArtifact {
  readonly featureNumber: number;
  readonly ref: string;
  readonly slug: string;
  readonly title: string;
  readonly stories: readonly GeneratedStoryArtifact[];
  readonly dependencies: readonly string[];
}

const DEFAULT_ARTIFACT_PRIORITY = 'P2';
const DEFAULT_ARTIFACT_COMPLEXITY = 'Low';
const DEFAULT_ARTIFACT_RISK = 'Low';
const DEFAULT_ARTIFACT_CONFIDENCE = 'High';

type RecommendTaskDesignerFlow = (
  nodes: readonly TaskDesignerRecommendationNode[],
  connectors: readonly TaskDesignerRecommendationConnector[]
) => Promise<TaskDesignerFlowRecommendation>;

interface TaskDesignerBoardRecommendationSeed {
  boardName: string;
  issues: readonly IssueSummary[];
}

type ResolveTaskDesignerBoardRecommendationSeed = () => Promise<TaskDesignerBoardRecommendationSeed | undefined>;

type ConnectorGraphValidationCode = 'duplicate-edge' | 'cycle';

interface ConnectorGraphValidationError {
  code: ConnectorGraphValidationCode;
  sourceNodeId: string;
  targetNodeId: string;
  message: string;
}

function createNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

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

function normalizeIssuePayload(issue: Partial<IssueDetails>, requestedIssueKey?: string): Omit<TicketNode, 'id' | 'x' | 'y'> | undefined {
  const issueKey = pickFirstString(issue.key, requestedIssueKey);
  if (!issueKey) {
    return undefined;
  }

  const summary = pickFirstString(issue.summary) ?? issueKey;
  const issueType = pickFirstString(issue.issueType) ?? 'Unknown';
  const status = pickFirstString(issue.status) ?? 'Unknown';
  const projectKey = pickFirstString(issue.projectKey) ?? fallbackIssueKeyProjectKey(issueKey);

  return {
    issueKey,
    summary,
    issueType,
    status,
    assignee: pickFirstString(issue.assignee),
    priority: pickFirstString(issue.priority),
    projectKey
  };
}

function toTicketNode(value: unknown, fallbackIndex = 0): TicketNode | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const issueKey = pickFirstString(value.issueKey, value.key);
  if (!issueKey) {
    return undefined;
  }

  const id = pickFirstString(value.id) ?? `ticket-${issueKey}-${fallbackIndex}`;
  const summary = pickFirstString(value.summary, value.title) ?? issueKey;
  const issueType = pickFirstString(value.issueType, value.type) ?? 'Unknown';
  const status = pickFirstString(value.status, value.state) ?? 'Unknown';
  const projectKey = pickFirstString(value.projectKey) ?? fallbackIssueKeyProjectKey(issueKey);
  const x = asNumber(value.x);
  const y = asNumber(value.y);
  const fallbackColumn = fallbackIndex % 4;
  const fallbackRow = Math.floor(fallbackIndex / 4);

  return {
    id,
    issueKey,
    summary,
    issueType,
    status,
    assignee: pickFirstString(value.assignee),
    priority: pickFirstString(value.priority),
    projectKey,
    x: x ?? (24 + (fallbackColumn * 280)),
    y: y ?? (72 + (fallbackRow * 150))
  };
}

function toDirectedConnector(value: unknown): DirectedConnector | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = asString(value.id);
  const sourceNodeId = asString(value.sourceNodeId);
  const targetNodeId = asString(value.targetNodeId);

  if (!id || !sourceNodeId || !targetNodeId) {
    return undefined;
  }

  return {
    id,
    sourceNodeId,
    targetNodeId
  };
}

function toRecommendationConnector(value: unknown): TaskDesignerRecommendationConnector | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sourceNodeId = asString(value.sourceNodeId);
  const targetNodeId = asString(value.targetNodeId);
  if (!sourceNodeId || !targetNodeId) {
    return undefined;
  }

  return {
    sourceNodeId,
    targetNodeId
  };
}

function toFlowRecommendation(value: unknown): TaskDesignerFlowRecommendation | undefined {
  if (!isRecord(value) || !Array.isArray(value.orderedNodeIds)) {
    return undefined;
  }

  const orderedNodeIds = value.orderedNodeIds
    .map(candidate => asString(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));
  if (orderedNodeIds.length === 0) {
    return undefined;
  }

  const connectors = Array.isArray(value.connectors)
    ? value.connectors
      .map(toRecommendationConnector)
      .filter((connector): connector is TaskDesignerRecommendationConnector => Boolean(connector))
    : [];

  return {
    orderedNodeIds,
    connectors,
    rationale: asOptionalString(value.rationale)
  };
}

function normalizePersistedStateWithRecovery(value: unknown): PersistedTaskDesignerRecoveryResult {
  return normalizeTaskDesignerPersistedState(value);
}

function normalizePersistedState(value: unknown): PersistedTaskDesignerState {
  return normalizePersistedStateWithRecovery(value).state;
}

function detectDuplicateConnector(connectors: readonly DirectedConnector[]): DirectedConnector | undefined {
  const seen = new Set<string>();
  for (const connector of connectors) {
    const key = `${connector.sourceNodeId}\u0000${connector.targetNodeId}`;
    if (seen.has(key)) {
      return connector;
    }
    seen.add(key);
  }
  return undefined;
}

function detectCycleConnector(connectors: readonly DirectedConnector[]): DirectedConnector | undefined {
  const adjacency = new Map<string, string[]>();
  for (const connector of connectors) {
    const neighbors = adjacency.get(connector.sourceNodeId);
    if (neighbors) {
      neighbors.push(connector.targetNodeId);
    } else {
      adjacency.set(connector.sourceNodeId, [connector.targetNodeId]);
    }
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  let cycleConnector: DirectedConnector | undefined;

  const visit = (nodeId: string): boolean => {
    visited.add(nodeId);
    active.add(nodeId);
    for (const nextNodeId of adjacency.get(nodeId) ?? []) {
      if (!visited.has(nextNodeId)) {
        if (visit(nextNodeId)) {
          return true;
        }
        continue;
      }
      if (active.has(nextNodeId)) {
        cycleConnector = {
          id: '',
          sourceNodeId: nodeId,
          targetNodeId: nextNodeId
        };
        return true;
      }
    }
    active.delete(nodeId);
    return false;
  };

  for (const nodeId of adjacency.keys()) {
    if (visited.has(nodeId)) {
      continue;
    }
    if (visit(nodeId)) {
      return cycleConnector;
    }
  }

  return undefined;
}

function validateConnectorGraph(connectors: readonly DirectedConnector[]): ConnectorGraphValidationError | undefined {
  const duplicate = detectDuplicateConnector(connectors);
  if (duplicate) {
    return {
      code: 'duplicate-edge',
      sourceNodeId: duplicate.sourceNodeId,
      targetNodeId: duplicate.targetNodeId,
      message: 'Duplicate directed links are not allowed.'
    };
  }

  const cycleConnector = detectCycleConnector(connectors);
  if (cycleConnector) {
    return {
      code: 'cycle',
      sourceNodeId: cycleConnector.sourceNodeId,
      targetNodeId: cycleConnector.targetNodeId,
      message: 'Directed links cannot create cycles.'
    };
  }

  return undefined;
}

export function validateTaskDesignerConnectorGraph(
  connectors: readonly Pick<DirectedConnector, 'id' | 'sourceNodeId' | 'targetNodeId'>[]
): ConnectorGraphValidationError | undefined {
  return validateConnectorGraph(connectors);
}

function toSingleLineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function compareNodeIds(
  leftNodeId: string,
  rightNodeId: string,
  nodeOrder: ReadonlyMap<string, number>
): number {
  const leftOrder = nodeOrder.get(leftNodeId) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = nodeOrder.get(rightNodeId) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return leftNodeId.localeCompare(rightNodeId);
}

function computeTopologicalNodeOrder(
  nodes: readonly TicketNode[],
  connectors: readonly DirectedConnector[]
): TicketNode[] | undefined {
  if (nodes.length === 0) {
    return [];
  }

  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    adjacency.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const connector of connectors) {
    if (!adjacency.has(connector.sourceNodeId) || !inDegree.has(connector.targetNodeId)) {
      continue;
    }
    adjacency.get(connector.sourceNodeId)?.push(connector.targetNodeId);
    inDegree.set(connector.targetNodeId, (inDegree.get(connector.targetNodeId) ?? 0) + 1);
  }

  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) => compareNodeIds(left, right, nodeOrder));
  }

  const queue = nodes
    .map(node => node.id)
    .filter(nodeId => (inDegree.get(nodeId) ?? 0) === 0);
  const orderedNodeIds: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) {
      continue;
    }
    orderedNodeIds.push(nodeId);
    for (const neighborNodeId of adjacency.get(nodeId) ?? []) {
      const nextInDegree = (inDegree.get(neighborNodeId) ?? 0) - 1;
      inDegree.set(neighborNodeId, nextInDegree);
      if (nextInDegree === 0) {
        queue.push(neighborNodeId);
      }
    }
  }

  if (orderedNodeIds.length !== nodes.length) {
    return undefined;
  }

  return orderedNodeIds
    .map(nodeId => nodeById.get(nodeId))
    .filter((node): node is TicketNode => Boolean(node));
}

export function computeTaskDesignerTopologicalOrder(
  nodes: readonly Pick<TicketNode, 'id'>[],
  connectors: readonly Pick<DirectedConnector, 'id' | 'sourceNodeId' | 'targetNodeId'>[]
): string[] | undefined {
  const normalizedNodes: TicketNode[] = nodes.map(node => ({
    id: node.id,
    issueKey: node.id,
    summary: node.id,
    issueType: 'Unknown',
    status: 'Unknown',
    projectKey: 'UNKNOWN',
    x: 0,
    y: 0
  }));
  const ordered = computeTopologicalNodeOrder(normalizedNodes, connectors);
  return ordered?.map(node => node.id);
}

function buildMasterPlanMarkdown(
  nodes: readonly TicketNode[],
  connectors: readonly DirectedConnector[]
): string {
  const orderedNodes = computeTopologicalNodeOrder(nodes, connectors) ?? [...nodes];
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const nodeOrder = new Map(orderedNodes.map((node, index) => [node.id, index]));
  const dependencyRows = connectors
    .filter(connector => nodeById.has(connector.sourceNodeId) && nodeById.has(connector.targetNodeId))
    .slice()
    .sort((left, right) => {
      const bySource = compareNodeIds(left.sourceNodeId, right.sourceNodeId, nodeOrder);
      if (bySource !== 0) {
        return bySource;
      }
      const byTarget = compareNodeIds(left.targetNodeId, right.targetNodeId, nodeOrder);
      if (byTarget !== 0) {
        return byTarget;
      }
      return left.id.localeCompare(right.id);
    });

  const description = `Generated from the Task Designer graph with ${orderedNodes.length} ticket node${orderedNodes.length === 1 ? '' : 's'} and ${dependencyRows.length} dependency link${dependencyRows.length === 1 ? '' : 's'}.`;
  const goals = [
    'Execute planned tickets in deterministic topological order.',
    'Keep graph dependencies explicit and reviewable in markdown.',
    'Persist a local master plan artifact under plans/.'
  ];
  const nonGoals = [
    'Does not execute or mutate tickets automatically.',
    'Does not infer extra dependencies beyond directed links.',
    'Does not modify manually-authored plan files outside generated artifacts.'
  ];

  const lines: string[] = [
    '# Task Designer Master Plan',
    '',
    '**Status:** Proposed',
    '**Type:** Master Plan',
    `**Priority:** ${DEFAULT_ARTIFACT_PRIORITY}`,
    `**Dependencies:** ${dependencyRows.length > 0 ? `${dependencyRows.length} directed graph link${dependencyRows.length === 1 ? '' : 's'}` : 'None'}`,
    `**Complexity:** ${DEFAULT_ARTIFACT_COMPLEXITY}`,
    `**Risk:** ${DEFAULT_ARTIFACT_RISK}`,
    `**Confidence:** ${DEFAULT_ARTIFACT_CONFIDENCE}`,
    '',
    '## Description',
    description,
    '',
    '## Goals',
    ...goals.map((goal, index) => `${index + 1}. ${goal}`),
    '',
    '## Non-Goals',
    ...nonGoals.map((nonGoal, index) => `${index + 1}. ${nonGoal}`),
    '',
    '## Phase Overview'
  ];

  if (orderedNodes.length === 0) {
    lines.push('1. No ticket nodes are currently defined.');
  } else {
    for (const [index, node] of orderedNodes.entries()) {
      lines.push(`${index + 1}. **Phase ${index + 1} — ${node.issueKey}:** ${toSingleLineText(node.summary) || '(no summary)'}`);
    }
  }

  lines.push('', '## Dependencies');
  if (dependencyRows.length === 0) {
    lines.push('1. No explicit directed dependencies are currently defined.');
  } else {
    for (const [index, connector] of dependencyRows.entries()) {
      const source = nodeById.get(connector.sourceNodeId);
      const target = nodeById.get(connector.targetNodeId);
      if (!source || !target) {
        continue;
      }
      lines.push(`${index + 1}. ${source.issueKey} → ${target.issueKey}`);
    }
  }

  lines.push(
    '',
    '## Verification',
    '1. Generate the master plan artifact from Task Designer and confirm the metadata block includes status, type, priority, dependencies, complexity, risk, and confidence.',
    '2. Verify each dependency row maps to an explicit connector in the graph.',
    '3. Re-generate without changing the graph and confirm the file content is unchanged.',
    '4. Run `npm run check-types`.'
  );

  return `${lines.join('\n')}\n`;
}

function toTwoDigitNumber(value: number): string {
  return value.toString().padStart(2, '0');
}

function toSlug(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
    .replace(/-$/g, '');
  return normalized || fallback;
}

function toExecutionPriority(priority?: string): string {
  const normalized = toSingleLineText(priority ?? '').toUpperCase();
  if (/^P[0-4]$/.test(normalized)) {
    return normalized;
  }
  return DEFAULT_ARTIFACT_PRIORITY;
}

function selectFeaturePriority(stories: readonly GeneratedStoryArtifact[]): string {
  const rank = new Map([
    ['P0', 0],
    ['P1', 1],
    ['P2', 2],
    ['P3', 3],
    ['P4', 4]
  ]);
  const priorities = stories.map(story => toExecutionPriority(story.node.priority));
  priorities.sort((left, right) => (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER));
  return priorities[0] ?? DEFAULT_ARTIFACT_PRIORITY;
}

function buildGeneratedFeatureArtifacts(
  nodes: readonly TicketNode[],
  connectors: readonly DirectedConnector[]
): GeneratedFeatureArtifact[] {
  const orderedNodes = computeTopologicalNodeOrder(nodes, connectors) ?? [...nodes];
  const nodeOrder = new Map(orderedNodes.map((node, index) => [node.id, index]));
  const byId = new Map(orderedNodes.map(node => [node.id, node]));
  const incomingDependencyByTarget = new Map<string, string[]>();
  for (const connector of connectors) {
    if (!byId.has(connector.sourceNodeId) || !byId.has(connector.targetNodeId)) {
      continue;
    }
    const refs = incomingDependencyByTarget.get(connector.targetNodeId);
    if (refs) {
      refs.push(connector.sourceNodeId);
    } else {
      incomingDependencyByTarget.set(connector.targetNodeId, [connector.sourceNodeId]);
    }
  }

  const storyArtifacts: GeneratedStoryArtifact[] = orderedNodes.map((node, index) => {
    const featureNumber = Math.floor(index / GENERATED_STORIES_PER_FEATURE) + 1;
    const storyNumber = (index % GENERATED_STORIES_PER_FEATURE) + 1;
    const ref = `${toTwoDigitNumber(featureNumber)}.${storyNumber}`;
    const dependencyIds = [...(incomingDependencyByTarget.get(node.id) ?? [])].sort((left, right) =>
      compareNodeIds(left, right, nodeOrder)
    );
    const dependencies = dependencyIds.map(sourceNodeId => {
      const sourceOrder = nodeOrder.get(sourceNodeId) ?? 0;
      const sourceFeature = Math.floor(sourceOrder / GENERATED_STORIES_PER_FEATURE) + 1;
      const sourceStory = (sourceOrder % GENERATED_STORIES_PER_FEATURE) + 1;
      return `${toTwoDigitNumber(sourceFeature)}.${sourceStory}`;
    });
    return {
      node,
      order: index + 1,
      featureNumber,
      storyNumber,
      ref,
      slug: toSlug(node.summary, `story-${toTwoDigitNumber(featureNumber)}-${storyNumber}`),
      dependencies
    };
  });

  const featureByNumber = new Map<number, GeneratedStoryArtifact[]>();
  for (const story of storyArtifacts) {
    const group = featureByNumber.get(story.featureNumber);
    if (group) {
      group.push(story);
    } else {
      featureByNumber.set(story.featureNumber, [story]);
    }
  }

  const featureArtifacts: GeneratedFeatureArtifact[] = [...featureByNumber.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([featureNumber, stories]) => {
      const dependencies = new Set<string>();
      for (const story of stories) {
        for (const dependency of story.dependencies) {
          const dependencyFeatureRef = dependency.split('.')[0];
          if (dependencyFeatureRef !== toTwoDigitNumber(featureNumber)) {
            dependencies.add(`Feature ${dependencyFeatureRef}`);
          }
        }
      }

      const firstStory = stories[0];
      const title = `Execution Slice ${toTwoDigitNumber(featureNumber)} — ${toSingleLineText(firstStory.node.summary) || firstStory.node.issueKey}`;
      return {
        featureNumber,
        ref: toTwoDigitNumber(featureNumber),
        slug: toSlug(title, `feature-${toTwoDigitNumber(featureNumber)}`),
        title,
        stories,
        dependencies: [...dependencies].sort((left, right) => left.localeCompare(right))
      };
    });

  return featureArtifacts;
}

function buildGeneratedFeatureMarkdown(feature: GeneratedFeatureArtifact): string {
  const priority = selectFeaturePriority(feature.stories);
  const lines: string[] = [
    `# Feature ${feature.ref}: ${feature.title}`,
    '',
    '**Status:** Proposed',
    '**Type:** Feature',
    `**Priority:** ${priority}`,
    `**Dependencies:** ${feature.dependencies.length > 0 ? feature.dependencies.join(', ') : 'None'}`,
    `**Complexity:** ${DEFAULT_ARTIFACT_COMPLEXITY}`,
    `**Risk:** ${DEFAULT_ARTIFACT_RISK}`,
    `**Confidence:** ${DEFAULT_ARTIFACT_CONFIDENCE}`,
    '',
    '## Description',
    `Generated from Task Designer graph order for story slice group ${feature.ref}.`,
    '',
    '## Items',
    '',
    '| Ref | Type | Name | Ticket | Status |',
    '| --- | --- | --- | --- | --- |'
  ];

  for (const story of feature.stories) {
    lines.push(`| ${story.ref} | Story | ${toSingleLineText(story.node.summary) || '(no summary)'} | ${story.node.issueKey} | ${story.node.status} |`);
  }

  lines.push('', '## Dependencies');
  if (feature.dependencies.length === 0) {
    lines.push('1. No cross-feature dependencies.');
  } else {
    for (const [index, dependency] of feature.dependencies.entries()) {
      lines.push(`${index + 1}. Depends on ${dependency}.`);
    }
  }

  lines.push(
    '',
    '## Verification',
    '1. Confirm the metadata block includes status, type, priority, dependencies, complexity, risk, and confidence.',
    '2. Execute stories in listed order and verify cross-feature dependencies are satisfied first.',
    '3. Run `npm run check-types`.'
  );
  return `${lines.join('\n')}\n`;
}

function buildGeneratedStoryMarkdown(story: GeneratedStoryArtifact): string {
  const priority = toExecutionPriority(story.node.priority);
  const lines: string[] = [
    `# Story ${story.ref}: ${toSingleLineText(story.node.summary) || story.node.issueKey}`,
    '',
    '**Status:** Proposed',
    '**Type:** Story',
    `**Priority:** ${priority}`,
    `**Dependencies:** ${story.dependencies.length > 0 ? story.dependencies.join(', ') : 'None'}`,
    `**Complexity:** ${DEFAULT_ARTIFACT_COMPLEXITY}`,
    `**Risk:** ${DEFAULT_ARTIFACT_RISK}`,
    `**Confidence:** ${DEFAULT_ARTIFACT_CONFIDENCE}`,
    `**Source Ticket:** ${story.node.issueKey}`,
    '',
    '## Description',
    `Implement execution phase ${story.order} from the Task Designer graph using ticket ${story.node.issueKey}.`,
    '',
    '## Implementation Activities',
    `1. Deliver the scope represented by ticket ${story.node.issueKey}.`,
    '2. Keep implementation aligned with upstream dependency ordering.',
    '3. Ensure the slice remains independently reviewable.',
    '',
    '## Acceptance Criteria',
    '1. The ticket scope is implemented as a functional, compilable slice.',
    '2. Graph dependencies are respected by execution order.',
    '3. `npm run check-types` passes.',
    '',
    '## References',
    `1. Ticket: ${story.node.issueKey}`,
    `2. Graph order: ${story.order}`
  ];

  if (story.dependencies.length > 0) {
    lines.push(`3. Upstream story refs: ${story.dependencies.join(', ')}`);
  }

  lines.push(
    '',
    '## Verification',
    `1. Validate behavior for ticket ${story.node.issueKey} in isolation.`,
    `2. Confirm prerequisite story refs are completed first: ${story.dependencies.length > 0 ? story.dependencies.join(', ') : 'None'}.`,
    '3. Run `npm run check-types`.'
  );
  return `${lines.join('\n')}\n`;
}

export class TaskDesignerPanelManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private nextNodeIndex = 0;

  public constructor(
    private readonly backendService: IssueTrackerService,
    private readonly workspaceState: vscode.Memento,
    private readonly recommendTaskDesignerFlow?: RecommendTaskDesignerFlow,
    private readonly resolveBoardRecommendationSeed?: ResolveTaskDesignerBoardRecommendationSeed
  ) {}

  public open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const persistedState = this.getPersistedCanvasState();
    const initialState = persistedState.state;
    this.syncNextNodeIndex(initialState.nodes);
    const nonce = createNonce();
    this.panel = vscode.window.createWebviewPanel(
      'ticketManager.taskDesigner',
      'Task Designer',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = this.getHtml(nonce, initialState, persistedState.warning);
    if (persistedState.repaired) {
      void this.workspaceState.update(TASK_DESIGNER_STATE_KEY, initialState);
    }

    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      undefined,
      []
    );

    this.panel.webview.onDidReceiveMessage(
      message => {
        void this.handleMessage(message);
      },
      undefined,
      []
    );
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    const type = asString(message.type);
    if (type === 'addTicket') {
      await this.handleAddTicketMessage(message);
      return;
    }

    if (type === 'persistCanvasState') {
      await this.handlePersistCanvasStateMessage(message);
      return;
    }

    if (type === 'toolbarAction') {
      const action = asString(message.action);
      if (action) {
        await vscode.window.setStatusBarMessage(`Task Designer: ${action} (coming soon)`, 1500);
      }
      return;
    }

    if (type === 'recommendCanvasFlow') {
      await this.handleRecommendCanvasFlowMessage(message);
      return;
    }

    if (type === 'recommendBoardFlow') {
      await this.handleRecommendBoardFlowMessage();
      return;
    }

    if (type === 'applyRecommendation') {
      await this.handleApplyRecommendationMessage(message);
      return;
    }

    if (type === 'generateMasterPlan') {
      await this.handleGenerateMasterPlanMessage(message);
    }
  }

  private async handleAddTicketMessage(message: Record<string, unknown>): Promise<void> {
    const issueKey = asString(message.issueKey)?.trim();
    if (!issueKey) {
      await this.panel?.webview.postMessage({
        type: 'addTicketResult',
        ok: false,
        error: 'Enter a ticket number before adding.'
      });
      return;
    }

    try {
      const issue = await this.backendService.getIssue(issueKey);
      await this.panel?.webview.postMessage({
        type: 'addTicketResult',
        ok: true,
        node: this.createTicketNode(issue, issueKey)
      });
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: 'addTicketResult',
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handlePersistCanvasStateMessage(message: Record<string, unknown>): Promise<void> {
    const recoveredState = normalizePersistedStateWithRecovery(message.state);
    const nextState = recoveredState.state;
    if (recoveredState.repaired) {
      this.syncNextNodeIndex(nextState.nodes);
      await this.workspaceState.update(TASK_DESIGNER_STATE_KEY, nextState);
      await this.panel?.webview.postMessage({
        type: 'persistCanvasStateResult',
        ok: false,
        error: recoveredState.warning ?? 'Recovered invalid canvas state while saving.',
        state: nextState
      });
      return;
    }
    const graphError = validateConnectorGraph(nextState.connectors);
    if (graphError) {
      const persistedState = this.getPersistedCanvasState().state;
      this.syncNextNodeIndex(persistedState.nodes);
      await this.panel?.webview.postMessage({
        type: 'persistCanvasStateResult',
        ok: false,
        error: graphError.message,
        state: persistedState
      });
      return;
    }
    this.syncNextNodeIndex(nextState.nodes);
    await this.workspaceState.update(TASK_DESIGNER_STATE_KEY, nextState);
    await this.panel?.webview.postMessage({
      type: 'persistCanvasStateResult',
      ok: true
    });
  }

  private async handleRecommendCanvasFlowMessage(message: Record<string, unknown>): Promise<void> {
    const currentState = normalizePersistedState(message.state);
    if (currentState.nodes.length < 2) {
      await this.panel?.webview.postMessage({
        type: 'recommendCanvasFlowResult',
        ok: false,
        error: 'Add at least two ticket nodes before requesting an AI recommendation.'
      });
      return;
    }

    if (!this.recommendTaskDesignerFlow) {
      await this.panel?.webview.postMessage({
        type: 'recommendCanvasFlowResult',
        ok: false,
        error: 'AI recommendation is not configured.'
      });
      return;
    }

    try {
      const recommendation = await this.recommendTaskDesignerFlow(
        currentState.nodes.map(node => ({
          id: node.id,
          issueKey: node.issueKey,
          summary: node.summary,
          issueType: node.issueType,
          status: node.status,
          assignee: node.assignee,
          priority: node.priority,
          projectKey: node.projectKey
        })),
        currentState.connectors.map(connector => ({
          sourceNodeId: connector.sourceNodeId,
          targetNodeId: connector.targetNodeId
        }))
      );
      await this.panel?.webview.postMessage({
        type: 'recommendCanvasFlowResult',
        ok: true,
        recommendation
      });
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: 'recommendCanvasFlowResult',
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleRecommendBoardFlowMessage(): Promise<void> {
    if (!this.recommendTaskDesignerFlow) {
      await this.panel?.webview.postMessage({
        type: 'recommendBoardFlowResult',
        ok: false,
        error: 'AI recommendation is not configured.'
      });
      return;
    }

    if (!this.resolveBoardRecommendationSeed) {
      await this.panel?.webview.postMessage({
        type: 'recommendBoardFlowResult',
        ok: false,
        error: 'Board recommendation is not configured.'
      });
      return;
    }

    try {
      const boardSeed = await this.resolveBoardRecommendationSeed();
      if (!boardSeed) {
        await this.panel?.webview.postMessage({
          type: 'recommendBoardFlowResult',
          ok: false,
          error: 'No board selected. Open a board first, then try AI board recommendation.'
        });
        return;
      }

      if (boardSeed.issues.length === 0) {
        await this.panel?.webview.postMessage({
          type: 'recommendBoardFlowResult',
          ok: false,
          error: `Board "${boardSeed.boardName}" has no tickets to recommend.`
        });
        return;
      }

      if (boardSeed.issues.length < 2) {
        await this.panel?.webview.postMessage({
          type: 'recommendBoardFlowResult',
          ok: false,
          error: `Board "${boardSeed.boardName}" needs at least two tickets for AI recommendation.`
        });
        return;
      }

      const nodes: TaskDesignerRecommendationNode[] = boardSeed.issues.map((issue, index) => ({
        id: `board-${issue.key}-${index}`,
        issueKey: issue.key,
        summary: issue.summary,
        issueType: issue.issueType,
        status: issue.status,
        assignee: issue.assignee,
        priority: issue.priority,
        projectKey: issue.projectKey
      }));
      const recommendation = await this.recommendTaskDesignerFlow(nodes, []);
      await this.panel?.webview.postMessage({
        type: 'recommendBoardFlowResult',
        ok: true,
        recommendation,
        boardName: boardSeed.boardName,
        nodes
      });
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: 'recommendBoardFlowResult',
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleApplyRecommendationMessage(message: Record<string, unknown>): Promise<void> {
    const recommendation = toFlowRecommendation(message.recommendation);
    if (!recommendation) {
      await this.panel?.webview.postMessage({
        type: 'applyRecommendationResult',
        ok: false,
        error: 'No valid recommendation to apply.'
      });
      return;
    }

    const previewNodes = Array.isArray(message.nodes)
      ? message.nodes.map(toTicketNode).filter((node): node is TicketNode => Boolean(node))
      : [];
    if (previewNodes.length < 2) {
      await this.panel?.webview.postMessage({
        type: 'applyRecommendationResult',
        ok: false,
        error: 'Recommendation preview is missing ticket nodes.'
      });
      return;
    }

    const byId = new Map(previewNodes.map(node => [node.id, node]));
    const orderedNodeIds: string[] = [];
    const seenNodeIds = new Set<string>();
    for (const nodeId of recommendation.orderedNodeIds) {
      if (!byId.has(nodeId) || seenNodeIds.has(nodeId)) {
        continue;
      }
      seenNodeIds.add(nodeId);
      orderedNodeIds.push(nodeId);
    }
    for (const node of previewNodes) {
      if (seenNodeIds.has(node.id)) {
        continue;
      }
      seenNodeIds.add(node.id);
      orderedNodeIds.push(node.id);
    }

    if (orderedNodeIds.length < 2) {
      await this.panel?.webview.postMessage({
        type: 'applyRecommendationResult',
        ok: false,
        error: 'Recommendation must include at least two ticket nodes.'
      });
      return;
    }

    const orderIndex = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index]));
    const connectors: DirectedConnector[] = [];
    const seenConnectors = new Set<string>();
    for (const connector of recommendation.connectors) {
      if (!orderIndex.has(connector.sourceNodeId) || !orderIndex.has(connector.targetNodeId)) {
        continue;
      }
      const sourceOrder = orderIndex.get(connector.sourceNodeId) ?? -1;
      const targetOrder = orderIndex.get(connector.targetNodeId) ?? -1;
      if (sourceOrder < 0 || targetOrder < 0 || sourceOrder >= targetOrder) {
        continue;
      }

      const connectorKey = `${connector.sourceNodeId}\u0000${connector.targetNodeId}`;
      if (seenConnectors.has(connectorKey)) {
        continue;
      }
      seenConnectors.add(connectorKey);
      connectors.push({
        id: `connector-${connectors.length}`,
        sourceNodeId: connector.sourceNodeId,
        targetNodeId: connector.targetNodeId
      });
    }

    if (connectors.length === 0) {
      for (let index = 0; index < orderedNodeIds.length - 1; index += 1) {
        connectors.push({
          id: `connector-${connectors.length}`,
          sourceNodeId: orderedNodeIds[index],
          targetNodeId: orderedNodeIds[index + 1]
        });
      }
    }

    const graphError = validateConnectorGraph(connectors);
    if (graphError) {
      await this.panel?.webview.postMessage({
        type: 'applyRecommendationResult',
        ok: false,
        error: graphError.message
      });
      return;
    }

    const nextState: PersistedTaskDesignerState = {
      nodes: orderedNodeIds
        .map(nodeId => byId.get(nodeId))
        .filter((node): node is TicketNode => Boolean(node))
        .map(node => ({ ...node })),
      connectors
    };

    this.syncNextNodeIndex(nextState.nodes);
    await this.workspaceState.update(TASK_DESIGNER_STATE_KEY, nextState);
    await this.panel?.webview.postMessage({
      type: 'applyRecommendationResult',
      ok: true,
      state: nextState
    });
  }

  private async handleGenerateMasterPlanMessage(message: Record<string, unknown>): Promise<void> {
    const state = normalizePersistedState(message.state);
    if (state.nodes.length === 0) {
      await this.panel?.webview.postMessage({
        type: 'generateMasterPlanResult',
        ok: false,
        error: 'Add at least one ticket node before generating a master plan.'
      });
      return;
    }

    const graphError = validateConnectorGraph(state.connectors);
    if (graphError) {
      await this.panel?.webview.postMessage({
        type: 'generateMasterPlanResult',
        ok: false,
        error: `Cannot generate master plan: ${graphError.message}`
      });
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      await this.panel?.webview.postMessage({
        type: 'generateMasterPlanResult',
        ok: false,
        error: 'Open a workspace folder before generating a master plan.'
      });
      return;
    }

    const plansDirectoryUri = vscode.Uri.joinPath(workspaceFolder.uri, MASTER_PLAN_DIRECTORY_NAME);
    const masterPlanFileUri = vscode.Uri.joinPath(plansDirectoryUri, MASTER_PLAN_FILE_NAME);
    const generatedFeaturesRootUri = vscode.Uri.joinPath(
      plansDirectoryUri,
      GENERATED_FEATURES_ROOT_SEGMENT,
      GENERATED_FEATURES_DIRECTORY_NAME
    );
    const markdown = buildMasterPlanMarkdown(state.nodes, state.connectors);
    const featureArtifacts = buildGeneratedFeatureArtifacts(state.nodes, state.connectors);

    try {
      await vscode.workspace.fs.createDirectory(plansDirectoryUri);
      await vscode.workspace.fs.writeFile(masterPlanFileUri, new TextEncoder().encode(markdown));
      await this.writeGeneratedFeatureStoryArtifacts(generatedFeaturesRootUri, featureArtifacts);
      await this.panel?.webview.postMessage({
        type: 'generateMasterPlanResult',
        ok: true,
        outputPath: masterPlanFileUri.fsPath,
        generatedFeaturesPath: generatedFeaturesRootUri.fsPath,
        generatedFeatureCount: featureArtifacts.length,
        generatedStoryCount: featureArtifacts.reduce((count, feature) => count + feature.stories.length, 0)
      });
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: 'generateMasterPlanResult',
        ok: false,
        error: `Unable to write ${MASTER_PLAN_DIRECTORY_NAME}\\${MASTER_PLAN_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  private async writeGeneratedFeatureStoryArtifacts(
    generatedFeaturesRootUri: vscode.Uri,
    featureArtifacts: readonly GeneratedFeatureArtifact[]
  ): Promise<void> {
    try {
      await vscode.workspace.fs.delete(generatedFeaturesRootUri, { recursive: true, useTrash: false });
    } catch {
      // no-op when generated output does not exist yet
    }
    await vscode.workspace.fs.createDirectory(generatedFeaturesRootUri);

    for (const feature of featureArtifacts) {
      const featureDirectoryName = `feature-${feature.ref}-${feature.slug}`;
      const featureDirectoryUri = vscode.Uri.joinPath(generatedFeaturesRootUri, featureDirectoryName);
      const featureFileUri = vscode.Uri.joinPath(featureDirectoryUri, `feature-${feature.ref}-${feature.slug}.md`);
      await vscode.workspace.fs.createDirectory(featureDirectoryUri);
      await vscode.workspace.fs.writeFile(
        featureFileUri,
        new TextEncoder().encode(buildGeneratedFeatureMarkdown(feature))
      );

      for (const story of feature.stories) {
        const storyFileName = `story-${feature.ref}-${story.storyNumber}-${story.slug}.md`;
        const storyFileUri = vscode.Uri.joinPath(featureDirectoryUri, storyFileName);
        await vscode.workspace.fs.writeFile(
          storyFileUri,
          new TextEncoder().encode(buildGeneratedStoryMarkdown(story))
        );
      }
    }
  }

  private getPersistedCanvasState(): PersistedTaskDesignerRecoveryResult {
    const raw = this.workspaceState.get<unknown>(TASK_DESIGNER_STATE_KEY);
    return normalizePersistedStateWithRecovery(raw);
  }

  private syncNextNodeIndex(nodes: readonly TicketNode[]): void {
    let maxIndex = -1;
    for (const node of nodes) {
      const match = /-(\d+)$/.exec(node.id);
      const parsed = match ? Number.parseInt(match[1], 10) : Number.NaN;
      if (Number.isFinite(parsed)) {
        maxIndex = Math.max(maxIndex, parsed);
      }
    }
    if (maxIndex < 0 && nodes.length > 0) {
      maxIndex = nodes.length - 1;
    }
    this.nextNodeIndex = maxIndex + 1;
  }

  private createTicketNode(issue: IssueDetails, requestedIssueKey?: string): TicketNode {
    const index = this.nextNodeIndex;
    this.nextNodeIndex += 1;
    const column = index % 4;
    const row = Math.floor(index / 4);
    const normalizedIssue = normalizeIssuePayload(issue, requestedIssueKey);
    if (!normalizedIssue) {
      throw new Error('Issue details are missing a valid issue key.');
    }

    return {
      id: `ticket-${normalizedIssue.issueKey}-${index}`,
      issueKey: normalizedIssue.issueKey,
      summary: normalizedIssue.summary,
      issueType: normalizedIssue.issueType,
      status: normalizedIssue.status,
      assignee: normalizedIssue.assignee,
      priority: normalizedIssue.priority,
      projectKey: normalizedIssue.projectKey,
      x: 24 + (column * 280),
      y: 72 + (row * 150)
    };
  }

  private getHtml(nonce: string, initialState: PersistedTaskDesignerState, initialWarning?: string): string {
    const initialStateLiteral = JSON.stringify(initialState)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    const initialWarningLiteral = JSON.stringify(initialWarning ?? '')
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Task Designer</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
    }
    .shell {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      border: 1px solid var(--vscode-panel-border);
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
    }
    .toolbar-title {
      margin-right: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .toolbar button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
    }
    .toolbar button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .toolbar button.is-active {
      border-color: var(--vscode-focusBorder);
      background: color-mix(in oklab, var(--vscode-button-secondaryBackground) 70%, var(--vscode-focusBorder) 30%);
    }
    .toolbar button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .ticket-add {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
      min-width: 280px;
    }
    .ticket-add input {
      flex: 1;
      min-width: 120px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
    }
    .ticket-add button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .ticket-add button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .toolbar-feedback {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      min-height: 1.2em;
      padding: 0 10px 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
    }
    .toolbar-feedback.error {
      color: var(--vscode-errorForeground);
    }
    .execution-summary {
      padding: 8px 10px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
      font-size: 12px;
    }
    .execution-summary-title {
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }
    .execution-summary-text {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      min-height: 1.2em;
    }
    .execution-summary-list {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 3px;
    }
    .execution-summary-item-key {
      color: var(--vscode-editor-foreground);
      font-weight: 600;
    }
    .execution-summary-item-summary {
      color: var(--vscode-descriptionForeground);
    }
    .recommendation-summary {
      padding: 8px 10px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
      font-size: 12px;
    }
    .recommendation-summary-title {
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }
    .recommendation-summary-text {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      min-height: 1.2em;
    }
    .recommendation-summary-list {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 3px;
    }
    .recommendation-summary-item-key {
      color: var(--vscode-editor-foreground);
      font-weight: 600;
    }
    .recommendation-summary-item-summary {
      color: var(--vscode-descriptionForeground);
    }
    .recommendation-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .recommendation-actions button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
    }
    .recommendation-actions button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .recommendation-actions-apply {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .recommendation-actions-apply:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    .recommendation-actions-reject {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .recommendation-actions-reject:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .canvas-surface {
      flex: 1;
      min-height: 0;
      background-color: var(--vscode-editor-background);
      background-image: radial-gradient(
        circle,
        var(--vscode-editorIndentGuide-background) 1px,
        transparent 1.5px
      );
      background-size: 20px 20px;
      position: relative;
      overflow: auto;
    }
    .nodes-layer {
      position: absolute;
      inset: 0;
      z-index: 1;
    }
    .connectors-layer {
      position: absolute;
      inset: 0;
      overflow: visible;
      z-index: 0;
      pointer-events: none;
    }
    .connector-hit-area {
      stroke: transparent;
      stroke-width: 14;
      fill: none;
      pointer-events: stroke;
      cursor: pointer;
    }
    .connector-line {
      fill: none;
      stroke: var(--vscode-descriptionForeground);
      stroke-width: 2;
      marker-end: url(#task-designer-arrowhead);
      pointer-events: none;
    }
    .connector-group.is-selected .connector-line {
      stroke: var(--vscode-focusBorder);
      stroke-width: 3;
    }
    .ticket-node {
      position: absolute;
      width: 250px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 10px;
      background: var(--vscode-editorWidget-background);
      box-shadow: 0 2px 8px color-mix(in oklab, var(--vscode-editor-background) 70%, black 30%);
      user-select: none;
      cursor: grab;
    }
    .ticket-node.dragging { cursor: grabbing; }
    .ticket-node.linking-source {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .ticket-node-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .ticket-node-delete {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 4px;
      font-size: 11px;
      line-height: 1;
      padding: 3px 6px;
      cursor: pointer;
    }
    .ticket-node-delete:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .ticket-node-key {
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    .ticket-node-summary {
      margin-top: 6px;
      font-weight: 600;
      line-height: 1.35;
    }
    .ticket-node-meta {
      margin-top: 8px;
      display: grid;
      gap: 4px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .ticket-node-meta-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .surface-hint {
      position: absolute;
      top: 16px;
      left: 16px;
      padding: 8px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="toolbar">
      <span class="toolbar-title">Task Designer</span>
      <button type="button" data-action="select">Select</button>
      <button type="button" data-action="ticket">Add Ticket</button>
      <button type="button" data-action="group">Add Group</button>
      <button type="button" data-action="link">Link</button>
      <button id="delete-connector-button" type="button" data-action="deleteConnector" disabled>Delete Link</button>
      <button id="generate-master-plan-button" type="button" data-action="generateMasterPlan">Generate Plan</button>
      <button id="recommend-flow-button" type="button" data-action="recommendFlow">AI Recommend</button>
      <button id="recommend-board-flow-button" type="button" data-action="recommendBoardFlow">AI From Board</button>
      <div class="ticket-add">
        <input id="ticket-key-input" type="text" placeholder="Ticket number (e.g. APP-123)" aria-label="Ticket number" />
        <button id="ticket-add-button" type="button">Add</button>
      </div>
    </header>
    <div id="toolbar-feedback" class="toolbar-feedback" aria-live="polite"></div>
    <section class="execution-summary" aria-live="polite">
      <div class="execution-summary-title">Execution Order</div>
      <div id="execution-summary-text" class="execution-summary-text"></div>
      <ol id="execution-summary-list" class="execution-summary-list"></ol>
    </section>
    <section class="recommendation-summary" aria-live="polite">
      <div class="recommendation-summary-title">AI Recommendation</div>
      <div id="recommendation-summary-text" class="recommendation-summary-text"></div>
      <ol id="recommendation-summary-list" class="recommendation-summary-list"></ol>
      <div class="recommendation-actions">
        <button id="apply-recommendation-button" class="recommendation-actions-apply" type="button" data-action="applyRecommendation" disabled>Apply</button>
        <button id="reject-recommendation-button" class="recommendation-actions-reject" type="button" data-action="rejectRecommendation" disabled>Discard</button>
      </div>
    </section>
    <main class="canvas-surface" aria-label="Task Designer canvas">
      <svg id="connectors-layer" class="connectors-layer" aria-hidden="true">
        <defs>
          <marker id="task-designer-arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--vscode-descriptionForeground)"></polygon>
          </marker>
        </defs>
      </svg>
      <div id="nodes-layer" class="nodes-layer"></div>
      <div class="surface-hint">Enter a ticket number to create nodes on the canvas.</div>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const ticketInput = document.getElementById('ticket-key-input');
    const ticketAddButton = document.getElementById('ticket-add-button');
    const deleteConnectorButton = document.getElementById('delete-connector-button');
    const generateMasterPlanButton = document.getElementById('generate-master-plan-button');
    const recommendFlowButton = document.getElementById('recommend-flow-button');
    const recommendBoardFlowButton = document.getElementById('recommend-board-flow-button');
    const applyRecommendationButton = document.getElementById('apply-recommendation-button');
    const rejectRecommendationButton = document.getElementById('reject-recommendation-button');
    const feedback = document.getElementById('toolbar-feedback');
    const connectorsLayer = document.getElementById('connectors-layer');
    const nodesLayer = document.getElementById('nodes-layer');
    const executionSummaryText = document.getElementById('execution-summary-text');
    const executionSummaryList = document.getElementById('execution-summary-list');
    const recommendationSummaryText = document.getElementById('recommendation-summary-text');
    const recommendationSummaryList = document.getElementById('recommendation-summary-list');
    const canvasSurface = document.querySelector('.canvas-surface');
    const surfaceHint = document.querySelector('.surface-hint');
    const initialState = ${initialStateLiteral};
    const initialWarning = ${initialWarningLiteral};
    const state = {
      nodes: Array.isArray(initialState.nodes) ? initialState.nodes.map(node => ({ ...node })) : [],
      connectors: Array.isArray(initialState.connectors) ? initialState.connectors.map(connector => ({ ...connector })) : [],
      recommendation: undefined,
      recommendationNodes: undefined,
      recommendationSource: undefined
    };
    const uiState = {
      activeTool: 'select',
      linkSourceNodeId: undefined,
      selectedConnectorId: undefined,
      nextConnectorIndex: 0,
      applyingRecommendation: false,
      generatingMasterPlan: false
    };

    function setGeneratingMasterPlan(isGenerating) {
      uiState.generatingMasterPlan = Boolean(isGenerating);
      if (generateMasterPlanButton instanceof HTMLButtonElement) {
        generateMasterPlanButton.disabled = uiState.generatingMasterPlan;
      }
    }

    function syncNextConnectorIndex() {
      let maxIndex = -1;
      for (const connector of state.connectors) {
        const match = /-(\\d+)$/.exec(connector.id);
        const parsed = match ? Number.parseInt(match[1], 10) : Number.NaN;
        if (Number.isFinite(parsed)) {
          maxIndex = Math.max(maxIndex, parsed);
        }
      }
      if (maxIndex < 0 && state.connectors.length > 0) {
        maxIndex = state.connectors.length - 1;
      }
      uiState.nextConnectorIndex = maxIndex + 1;
    }

    function setFeedback(text, isError) {
      feedback.textContent = text || '';
      feedback.classList.toggle('error', Boolean(isError));
    }

    function createMetaRow(label, value) {
      const row = document.createElement('div');
      row.className = 'ticket-node-meta-row';
      const left = document.createElement('span');
      left.textContent = label;
      const right = document.createElement('span');
      right.textContent = value || '—';
      row.append(left, right);
      return row;
    }

    function computeExecutionOrder() {
      const adjacency = new Map();
      const inDegree = new Map();
      for (const node of state.nodes) {
        adjacency.set(node.id, []);
        inDegree.set(node.id, 0);
      }

      for (const connector of state.connectors) {
        if (!adjacency.has(connector.sourceNodeId) || !inDegree.has(connector.targetNodeId)) {
          continue;
        }
        adjacency.get(connector.sourceNodeId).push(connector.targetNodeId);
        inDegree.set(connector.targetNodeId, (inDegree.get(connector.targetNodeId) || 0) + 1);
      }

      const queue = state.nodes
        .map(node => node.id)
        .filter(nodeId => (inDegree.get(nodeId) || 0) === 0);
      const orderedNodeIds = [];

      while (queue.length > 0) {
        const nodeId = queue.shift();
        if (!nodeId) {
          continue;
        }
        orderedNodeIds.push(nodeId);
        for (const nextNodeId of adjacency.get(nodeId) || []) {
          const nextInDegree = (inDegree.get(nextNodeId) || 0) - 1;
          inDegree.set(nextNodeId, nextInDegree);
          if (nextInDegree === 0) {
            queue.push(nextNodeId);
          }
        }
      }

      if (orderedNodeIds.length !== state.nodes.length) {
        return undefined;
      }

      const nodesById = new Map(state.nodes.map(node => [node.id, node]));
      return orderedNodeIds
        .map(nodeId => nodesById.get(nodeId))
        .filter(node => Boolean(node));
    }

    function renderExecutionSummary() {
      if (!(executionSummaryText instanceof HTMLElement) || !(executionSummaryList instanceof HTMLOListElement)) {
        return;
      }

      executionSummaryList.textContent = '';
      if (state.nodes.length === 0) {
        executionSummaryText.textContent = 'No tickets in the graph yet. Add tickets to view execution order.';
        return;
      }

      const orderedNodes = computeExecutionOrder();
      if (!orderedNodes) {
        executionSummaryText.textContent = 'Execution order unavailable: directed links contain a cycle.';
        return;
      }

      executionSummaryText.textContent = state.connectors.length === 0
        ? 'No directed links yet. Current ticket order is shown below.'
        : 'Execution sequence derived from directed links:';

      for (const node of orderedNodes) {
        const item = document.createElement('li');
        const key = document.createElement('span');
        key.className = 'execution-summary-item-key';
        key.textContent = node.issueKey;
        const summary = document.createElement('span');
        summary.className = 'execution-summary-item-summary';
        summary.textContent = ' — ' + (node.summary || '(no summary)');
        item.append(key, summary);
        executionSummaryList.append(item);
      }
    }

    function persistCanvasState() {
      vscodeApi.postMessage({
        type: 'persistCanvasState',
        state: {
          nodes: state.nodes.map(node => ({ ...node })),
          connectors: state.connectors.map(connector => ({ ...connector }))
        }
      });
    }

    function requestRecommendCanvasFlow() {
      if (recommendFlowButton instanceof HTMLButtonElement) {
        recommendFlowButton.disabled = true;
      }
      setFeedback('Requesting AI recommendation…', false);
      vscodeApi.postMessage({
        type: 'recommendCanvasFlow',
        state: {
          nodes: state.nodes.map(node => ({ ...node })),
          connectors: state.connectors.map(connector => ({ ...connector }))
        }
      });
    }

    function requestRecommendBoardFlow() {
      if (recommendBoardFlowButton instanceof HTMLButtonElement) {
        recommendBoardFlowButton.disabled = true;
      }
      setFeedback('Requesting AI recommendation from current board…', false);
      vscodeApi.postMessage({ type: 'recommendBoardFlow' });
    }

    function requestGenerateMasterPlan() {
      if (state.nodes.length === 0) {
        setFeedback('Add at least one ticket node before generating a master plan.', true);
        return;
      }
      setGeneratingMasterPlan(true);
      setFeedback('Generating master plan artifact…', false);
      vscodeApi.postMessage({
        type: 'generateMasterPlan',
        state: {
          nodes: state.nodes.map(node => ({ ...node })),
          connectors: state.connectors.map(connector => ({ ...connector }))
        }
      });
    }

    function buildPreviewNodes(rawNodes) {
      if (!Array.isArray(rawNodes)) {
        return [];
      }
      const nodes = [];
      for (let index = 0; index < rawNodes.length; index += 1) {
        const candidate = rawNodes[index];
        if (!candidate || typeof candidate !== 'object') {
          continue;
        }
        const issueKey = typeof candidate.issueKey === 'string' ? candidate.issueKey : '';
        if (!issueKey) {
          continue;
        }
        const fallbackColumn = index % 4;
        const fallbackRow = Math.floor(index / 4);
        nodes.push({
          id: typeof candidate.id === 'string' ? candidate.id : ('preview-' + issueKey + '-' + index),
          issueKey,
          summary: typeof candidate.summary === 'string' ? candidate.summary : '',
          issueType: typeof candidate.issueType === 'string' ? candidate.issueType : '',
          status: typeof candidate.status === 'string' ? candidate.status : '',
          assignee: typeof candidate.assignee === 'string' ? candidate.assignee : undefined,
          priority: typeof candidate.priority === 'string' ? candidate.priority : undefined,
          projectKey: typeof candidate.projectKey === 'string' ? candidate.projectKey : '',
          x: Number.isFinite(candidate.x) ? candidate.x : (24 + (fallbackColumn * 280)),
          y: Number.isFinite(candidate.y) ? candidate.y : (24 + (fallbackRow * 190))
        });
      }
      return nodes;
    }

    function updateRecommendationActionState() {
      const hasRecommendation = Boolean(state.recommendation);
      const isApplying = Boolean(uiState.applyingRecommendation);
      if (applyRecommendationButton instanceof HTMLButtonElement) {
        applyRecommendationButton.disabled = !hasRecommendation || isApplying;
      }
      if (rejectRecommendationButton instanceof HTMLButtonElement) {
        rejectRecommendationButton.disabled = !hasRecommendation || isApplying;
      }
    }

    function requestApplyRecommendation() {
      if (!state.recommendation) {
        setFeedback('No AI recommendation to apply.', true);
        return;
      }
      const recommendationNodes = buildPreviewNodes(state.recommendationNodes);
      if (recommendationNodes.length < 2) {
        setFeedback('Recommendation preview is missing ticket nodes.', true);
        return;
      }
      uiState.applyingRecommendation = true;
      updateRecommendationActionState();
      setFeedback('Applying AI recommendation…', false);
      vscodeApi.postMessage({
        type: 'applyRecommendation',
        recommendation: state.recommendation,
        nodes: recommendationNodes
      });
    }

    function clearRecommendation() {
      if (!state.recommendation) {
        updateRecommendationActionState();
        return;
      }
      state.recommendation = undefined;
      state.recommendationNodes = undefined;
      state.recommendationSource = undefined;
      renderRecommendationSummary();
      updateRecommendationActionState();
    }

    function renderRecommendationSummary() {
      if (!(recommendationSummaryText instanceof HTMLElement) || !(recommendationSummaryList instanceof HTMLOListElement)) {
        return;
      }

      recommendationSummaryList.textContent = '';
      if (!state.recommendation) {
        recommendationSummaryText.textContent = 'No AI recommendation yet.';
        return;
      }

      const previewNodes = Array.isArray(state.recommendationNodes) ? state.recommendationNodes : state.nodes;
      const nodeById = new Map(previewNodes.map(node => [node.id, node]));
      const orderedNodes = state.recommendation.orderedNodeIds
        .map(nodeId => nodeById.get(nodeId))
        .filter(node => Boolean(node));
      if (orderedNodes.length === 0) {
        recommendationSummaryText.textContent = 'AI recommendation returned no valid node order.';
        return;
      }

      recommendationSummaryText.textContent = state.recommendation.rationale
        ? ('Preview only: ' + state.recommendation.rationale)
        : (state.recommendationSource ? ('Preview only: proposed execution flow from ' + state.recommendationSource + '.') : 'Preview only: proposed execution flow.');
      for (const node of orderedNodes) {
        const item = document.createElement('li');
        const key = document.createElement('span');
        key.className = 'recommendation-summary-item-key';
        key.textContent = node.issueKey;
        const summary = document.createElement('span');
        summary.className = 'recommendation-summary-item-summary';
        summary.textContent = ' — ' + (node.summary || '(no summary)');
        item.append(key, summary);
        recommendationSummaryList.append(item);
      }
    }

    function hasNode(nodeId) {
      return state.nodes.some(node => node.id === nodeId);
    }

    function findNodeById(nodeId) {
      return state.nodes.find(node => node.id === nodeId);
    }

    function hasExistingConnector(sourceNodeId, targetNodeId) {
      return state.connectors.some(connector => connector.sourceNodeId === sourceNodeId && connector.targetNodeId === targetNodeId);
    }

    function hasDirectedPath(startNodeId, targetNodeId) {
      const stack = [startNodeId];
      const visited = new Set();
      while (stack.length > 0) {
        const nodeId = stack.pop();
        if (!nodeId || visited.has(nodeId)) {
          continue;
        }
        if (nodeId === targetNodeId) {
          return true;
        }
        visited.add(nodeId);
        for (const connector of state.connectors) {
          if (connector.sourceNodeId === nodeId && !visited.has(connector.targetNodeId)) {
            stack.push(connector.targetNodeId);
          }
        }
      }
      return false;
    }

    function wouldCreateCycle(sourceNodeId, targetNodeId) {
      return hasDirectedPath(targetNodeId, sourceNodeId);
    }

    function pruneDanglingConnectors() {
      const before = state.connectors.length;
      state.connectors = state.connectors.filter(connector => hasNode(connector.sourceNodeId) && hasNode(connector.targetNodeId));
      if (before !== state.connectors.length && uiState.selectedConnectorId && !state.connectors.some(connector => connector.id === uiState.selectedConnectorId)) {
        uiState.selectedConnectorId = undefined;
      }
    }

    function updateDeleteConnectorState() {
      const hasSelection = Boolean(
        uiState.selectedConnectorId && state.connectors.some(connector => connector.id === uiState.selectedConnectorId)
      );
      deleteConnectorButton.disabled = !hasSelection;
    }

    function setActiveTool(tool) {
      uiState.activeTool = tool;
      if (tool !== 'link') {
        uiState.linkSourceNodeId = undefined;
      }
      for (const button of document.querySelectorAll('button[data-action="select"], button[data-action="link"]')) {
        const action = button.getAttribute('data-action');
        button.classList.toggle('is-active', action === tool);
      }
    }

    function createConnectorId() {
      const id = 'connector-' + uiState.nextConnectorIndex;
      uiState.nextConnectorIndex += 1;
      return id;
    }

    function deleteSelectedConnector() {
      if (!uiState.selectedConnectorId) {
        return;
      }
      const connectorId = uiState.selectedConnectorId;
      const before = state.connectors.length;
      state.connectors = state.connectors.filter(connector => connector.id !== connectorId);
      uiState.selectedConnectorId = undefined;
      if (before !== state.connectors.length) {
        clearRecommendation();
        renderConnectors();
        persistCanvasState();
        setFeedback('Link deleted.', false);
      }
      updateDeleteConnectorState();
      renderExecutionSummary();
    }

    function nodeElementById(nodeId) {
      return nodesLayer.querySelector('[data-node-id="' + nodeId.replace(/"/g, '\\"') + '"]');
    }

    function renderConnectors() {
      for (const group of connectorsLayer.querySelectorAll('.connector-group')) {
        group.remove();
      }
      if (uiState.selectedConnectorId && !state.connectors.some(connector => connector.id === uiState.selectedConnectorId)) {
        uiState.selectedConnectorId = undefined;
      }

      const nodeLayerRect = nodesLayer.getBoundingClientRect();
      for (const connector of state.connectors) {
        const sourceEl = nodeElementById(connector.sourceNodeId);
        const targetEl = nodeElementById(connector.targetNodeId);
        if (!(sourceEl instanceof HTMLElement) || !(targetEl instanceof HTMLElement)) {
          continue;
        }

        const sourceRect = sourceEl.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        const x1 = sourceRect.left - nodeLayerRect.left + (sourceRect.width / 2);
        const y1 = sourceRect.top - nodeLayerRect.top + (sourceRect.height / 2);
        const x2 = targetRect.left - nodeLayerRect.left + (targetRect.width / 2);
        const y2 = targetRect.top - nodeLayerRect.top + (targetRect.height / 2);

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'connector-group' + (uiState.selectedConnectorId === connector.id ? ' is-selected' : ''));
        group.dataset.connectorId = connector.id;

        const visibleLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        visibleLine.setAttribute('class', 'connector-line');
        visibleLine.setAttribute('x1', String(x1));
        visibleLine.setAttribute('y1', String(y1));
        visibleLine.setAttribute('x2', String(x2));
        visibleLine.setAttribute('y2', String(y2));

        const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        hitArea.setAttribute('class', 'connector-hit-area');
        hitArea.setAttribute('x1', String(x1));
        hitArea.setAttribute('y1', String(y1));
        hitArea.setAttribute('x2', String(x2));
        hitArea.setAttribute('y2', String(y2));
        hitArea.addEventListener('click', event => {
          event.stopPropagation();
          uiState.selectedConnectorId = connector.id;
          updateDeleteConnectorState();
          renderConnectors();
        });

        group.append(visibleLine, hitArea);
        connectorsLayer.append(group);
      }
      updateDeleteConnectorState();
    }

    function handleLinkNodeSelection(node) {
      if (!uiState.linkSourceNodeId) {
        uiState.linkSourceNodeId = node.id;
        uiState.selectedConnectorId = undefined;
        setFeedback('Source selected (' + node.issueKey + '). Select a target node.', false);
        renderNodes();
        return;
      }

      if (uiState.linkSourceNodeId === node.id) {
        setFeedback('Select a different target node.', true);
        return;
      }

      const sourceNodeId = uiState.linkSourceNodeId;
      if (hasExistingConnector(sourceNodeId, node.id)) {
        const sourceNode = findNodeById(sourceNodeId);
        const sourceLabel = sourceNode ? sourceNode.issueKey : 'selected source node';
        setFeedback('Link already exists from ' + sourceLabel + ' to ' + node.issueKey + '.', true);
        return;
      }

      if (wouldCreateCycle(sourceNodeId, node.id)) {
        const sourceNode = findNodeById(sourceNodeId);
        const sourceLabel = sourceNode ? sourceNode.issueKey : 'selected source node';
        setFeedback('Cannot create link from ' + sourceLabel + ' to ' + node.issueKey + ': it introduces a cycle.', true);
        return;
      }

      state.connectors.push({
        id: createConnectorId(),
        sourceNodeId,
        targetNodeId: node.id
      });
      clearRecommendation();
      uiState.linkSourceNodeId = undefined;
      uiState.selectedConnectorId = state.connectors[state.connectors.length - 1]?.id;
      renderConnectors();
      persistCanvasState();
      setFeedback('Directed link created. Select another source node to continue linking.', false);
      updateDeleteConnectorState();
    }

    function renderNodes() {
      nodesLayer.textContent = '';
      if (surfaceHint) {
        surfaceHint.style.display = state.nodes.length > 0 ? 'none' : '';
      }
      for (const node of state.nodes) {
        const root = document.createElement('article');
        root.className = 'ticket-node';
        root.style.left = node.x + 'px';
        root.style.top = node.y + 'px';
        root.dataset.nodeId = node.id;
        root.classList.toggle('linking-source', uiState.linkSourceNodeId === node.id);

        const header = document.createElement('div');
        header.className = 'ticket-node-header';

        const key = document.createElement('div');
        key.className = 'ticket-node-key';
        key.textContent = node.issueKey;

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'ticket-node-delete';
        deleteButton.textContent = 'Delete';
        deleteButton.setAttribute('aria-label', 'Delete ' + node.issueKey + ' node');
        deleteButton.addEventListener('click', event => {
          event.stopPropagation();
          state.nodes = state.nodes.filter(item => item.id !== node.id);
          state.connectors = state.connectors.filter(connector =>
            connector.sourceNodeId !== node.id && connector.targetNodeId !== node.id
          );
          if (uiState.linkSourceNodeId === node.id) {
            uiState.linkSourceNodeId = undefined;
          }
          if (uiState.selectedConnectorId && !state.connectors.some(connector => connector.id === uiState.selectedConnectorId)) {
            uiState.selectedConnectorId = undefined;
          }
          clearRecommendation();
          renderNodes();
          persistCanvasState();
          setFeedback('Ticket node deleted.', false);
        });
        header.append(key, deleteButton);

        const summary = document.createElement('div');
        summary.className = 'ticket-node-summary';
        summary.textContent = node.summary || '(no summary)';

        const meta = document.createElement('div');
        meta.className = 'ticket-node-meta';
        meta.append(
          createMetaRow('Type', node.issueType),
          createMetaRow('Status', node.status),
          createMetaRow('Assignee', node.assignee),
          createMetaRow('Priority', node.priority)
        );

        let dragging = null;
        root.addEventListener('pointerdown', event => {
          if (event.button !== 0) {
            return;
          }
          if (uiState.activeTool === 'link') {
            return;
          }
          if (event.target instanceof HTMLElement && event.target.closest('button')) {
            return;
          }
          dragging = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startX: node.x,
            startY: node.y
          };
          root.classList.add('dragging');
          root.setPointerCapture(event.pointerId);
        });
        root.addEventListener('pointermove', event => {
          if (!dragging || dragging.pointerId !== event.pointerId) {
            return;
          }
          const deltaX = event.clientX - dragging.startClientX;
          const deltaY = event.clientY - dragging.startClientY;
          node.x = Math.round(dragging.startX + deltaX);
          node.y = Math.round(dragging.startY + deltaY);
          root.style.left = node.x + 'px';
          root.style.top = node.y + 'px';
          renderConnectors();
        });
        root.addEventListener('pointerup', event => {
          if (!dragging || dragging.pointerId !== event.pointerId) {
            return;
          }
          dragging = null;
          root.classList.remove('dragging');
          renderConnectors();
          persistCanvasState();
        });
        root.addEventListener('pointercancel', event => {
          if (!dragging || dragging.pointerId !== event.pointerId) {
            return;
          }
          dragging = null;
          root.classList.remove('dragging');
          renderConnectors();
          persistCanvasState();
        });

        root.addEventListener('click', event => {
          if (event.target instanceof HTMLElement && event.target.closest('button')) {
            return;
          }
          if (uiState.activeTool === 'link') {
            event.preventDefault();
            event.stopPropagation();
            handleLinkNodeSelection(node);
          }
        });

        root.append(header, summary, meta);
        nodesLayer.append(root);
      }
      connectorsLayer.setAttribute('width', String(canvasSurface.scrollWidth));
      connectorsLayer.setAttribute('height', String(canvasSurface.scrollHeight));
      pruneDanglingConnectors();
      renderConnectors();
      updateDeleteConnectorState();
    }

    function requestAddTicket() {
      const issueKey = ticketInput.value.trim();
      vscodeApi.postMessage({ type: 'addTicket', issueKey });
    }

    ticketAddButton.addEventListener('click', requestAddTicket);
    ticketInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        requestAddTicket();
      }
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message) {
        return;
      }

      if (message.type === 'addTicketResult') {
        if (!message.ok) {
          setFeedback(message.error || 'Unable to add ticket.', true);
          return;
        }

        setFeedback('Ticket node added.', false);
        if (message.node) {
          state.nodes.push(message.node);
          clearRecommendation();
          renderNodes();
          persistCanvasState();
        }
        ticketInput.value = '';
        ticketInput.focus();
        return;
      }

      if (message.type === 'persistCanvasStateResult' && !message.ok) {
        if (message.state) {
          state.nodes = Array.isArray(message.state.nodes) ? message.state.nodes.map(node => ({ ...node })) : [];
          state.connectors = Array.isArray(message.state.connectors)
            ? message.state.connectors.map(connector => ({ ...connector }))
            : [];
          syncNextConnectorIndex();
          pruneDanglingConnectors();
          renderNodes();
        }
        setFeedback(message.error || 'Unable to save canvas state.', true);
        return;
      }

        if (message.type === 'recommendCanvasFlowResult') {
        if (recommendFlowButton instanceof HTMLButtonElement) {
          recommendFlowButton.disabled = false;
        }
        if (!message.ok) {
          setFeedback(message.error || 'Unable to generate AI recommendation.', true);
          return;
        }
        state.recommendation = message.recommendation || undefined;
        state.recommendationNodes = state.nodes.map(node => ({ ...node }));
        state.recommendationSource = 'canvas tickets';
        renderRecommendationSummary();
        updateRecommendationActionState();
        setFeedback('AI recommendation ready for review.', false);
        return;
      }

      if (message.type === 'recommendBoardFlowResult') {
        if (recommendBoardFlowButton instanceof HTMLButtonElement) {
          recommendBoardFlowButton.disabled = false;
        }
        if (!message.ok) {
          setFeedback(message.error || 'Unable to generate AI recommendation from current board.', true);
          return;
        }
        state.recommendation = message.recommendation || undefined;
        state.recommendationNodes = buildPreviewNodes(message.nodes);
        state.recommendationSource = message.boardName ? ('board "' + message.boardName + '"') : 'current board';
        renderRecommendationSummary();
        updateRecommendationActionState();
        setFeedback('AI board recommendation ready for review.', false);
        return;
      }

      if (message.type === 'applyRecommendationResult') {
        uiState.applyingRecommendation = false;
        if (!message.ok) {
          updateRecommendationActionState();
          setFeedback(message.error || 'Unable to apply AI recommendation.', true);
          return;
        }
        if (message.state) {
          state.nodes = Array.isArray(message.state.nodes) ? message.state.nodes.map(node => ({ ...node })) : [];
          state.connectors = Array.isArray(message.state.connectors)
            ? message.state.connectors.map(connector => ({ ...connector }))
            : [];
          syncNextConnectorIndex();
        }
        clearRecommendation();
        renderNodes();
        renderExecutionSummary();
        setFeedback('AI recommendation applied.', false);
        return;
      }

      if (message.type === 'generateMasterPlanResult') {
        setGeneratingMasterPlan(false);
        if (!message.ok) {
          setFeedback(message.error || 'Unable to generate master plan artifact.', true);
          return;
        }
        const featureCount = typeof message.generatedFeatureCount === 'number' ? message.generatedFeatureCount : 0;
        const storyCount = typeof message.generatedStoryCount === 'number' ? message.generatedStoryCount : 0;
        setFeedback(
          'Master plan generated at ' + (message.outputPath || 'plans/master-plan.md') +
            '. Generated ' + featureCount + ' feature file set(s) and ' + storyCount + ' story file(s).',
          false
        );
      }
    });

    for (const button of document.querySelectorAll('button[data-action]')) {
      button.addEventListener('click', () => {
        const action = button.getAttribute('data-action');
        if (action === 'ticket') {
          ticketInput.focus();
          return;
        }
        if (action === 'select' || action === 'link') {
          setActiveTool(action);
          if (action === 'link') {
            setFeedback('Link mode active. Select source node, then target node.', false);
          } else {
            setFeedback('Select mode active.', false);
          }
          renderNodes();
          return;
        }
        if (action === 'deleteConnector') {
          deleteSelectedConnector();
          return;
        }
        if (action === 'recommendFlow') {
          requestRecommendCanvasFlow();
          return;
        }
        if (action === 'generateMasterPlan') {
          requestGenerateMasterPlan();
          return;
        }
        if (action === 'recommendBoardFlow') {
          requestRecommendBoardFlow();
          return;
        }
        if (action === 'applyRecommendation') {
          requestApplyRecommendation();
          return;
        }
        if (action === 'rejectRecommendation') {
          if (!state.recommendation) {
            setFeedback('No AI recommendation to discard.', true);
            return;
          }
          clearRecommendation();
          setFeedback('AI recommendation discarded.', false);
          return;
        }
        vscodeApi.postMessage({ type: 'toolbarAction', action });
      });
    }

    canvasSurface.addEventListener('click', event => {
      if (event.target !== canvasSurface && event.target !== connectorsLayer) {
        return;
      }
      if (uiState.selectedConnectorId) {
        uiState.selectedConnectorId = undefined;
        renderConnectors();
      }
    });

    syncNextConnectorIndex();
    pruneDanglingConnectors();
    setActiveTool('select');
    renderNodes();
    renderExecutionSummary();
    renderRecommendationSummary();
    updateRecommendationActionState();
    setGeneratingMasterPlan(false);
    if (initialWarning) {
      setFeedback(initialWarning, true);
    }
  </script>
</body>
</html>`;
  }
}

export const taskDesignerPanelManagerInternals = {
  normalizePersistedState,
  normalizeIssuePayload
};
