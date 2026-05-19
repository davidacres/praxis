import * as vscode from 'vscode';
import type { IssueDetails, IssueSummary } from '../types';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type {
  TaskDesignerFlowRecommendation,
  TaskDesignerRecommendationConnector,
  TaskDesignerRecommendationNode
} from '../ai/aiReviewService';
import { normalizeTaskDesignerPersistedState } from './taskDesignerStatePersistence';

const NOTE_TEST_STATE_KEY = 'ticketManager.noteTest.state';
const MASTER_PLAN_DIRECTORY_NAME = 'plans';
const MASTER_PLAN_FILE_NAME = 'master-plan.md';
const GENERATED_FEATURES_ROOT_SEGMENT = 'features';
const GENERATED_FEATURES_DIRECTORY_NAME = 'generated-from-designer';
const GENERATED_STORIES_PER_FEATURE = 3;

type LinkHandleDirection = 'top' | 'right' | 'bottom' | 'left';

interface TicketNode {
  type: 'ticket';
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

interface NoteNode {
  type: 'note';
  id: string;
  title: string;
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WebsitePreviewNode {
  type: 'website';
  id: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

type CanvasNode = TicketNode | NoteNode | WebsitePreviewNode;

interface DirectedConnector {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceDirection?: LinkHandleDirection;
  targetDirection?: LinkHandleDirection;
}

interface NoteTestState {
  nodes: CanvasNode[];
  connectors: DirectedConnector[];
  zoom: number;
  toolbarPosition: {
    x: number;
    y: number;
  };
}

interface NoteTestStateRecoveryResult {
  state: NoteTestState;
  repaired: boolean;
  warning?: string;
}

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

type DroppedIssueRelation = 'dependsOn' | 'subTask';

interface ResolvedDroppedIssueRelation {
  relation: DroppedIssueRelation;
  sourceIssueKey: string;
  targetIssueKey: string;
}

interface ResolvedDroppedIssuePayload {
  mainIssue: Omit<TicketNode, 'id' | 'x' | 'y' | 'type'>;
  relatedIssues: Array<
    Omit<TicketNode, 'id' | 'x' | 'y' | 'type'> & {
      relation: DroppedIssueRelation;
    }
  >;
  relations: ResolvedDroppedIssueRelation[];
}

type ConnectorGraphValidationCode = 'duplicate-edge' | 'cycle';

interface ConnectorGraphValidationError {
  code: ConnectorGraphValidationCode;
  sourceNodeId: string;
  targetNodeId: string;
  message: string;
}

type RecommendTaskDesignerFlow = (
  nodes: readonly TaskDesignerRecommendationNode[],
  connectors: readonly TaskDesignerRecommendationConnector[]
) => Promise<TaskDesignerFlowRecommendation>;

interface TaskDesignerBoardRecommendationSeed {
  boardName: string;
  issues: readonly IssueSummary[];
}

type ResolveTaskDesignerBoardRecommendationSeed = () => Promise<TaskDesignerBoardRecommendationSeed | undefined>;

const DEFAULT_ARTIFACT_PRIORITY = 'P2';
const DEFAULT_ARTIFACT_COMPLEXITY = 'Low';
const DEFAULT_ARTIFACT_RISK = 'Low';
const DEFAULT_ARTIFACT_CONFIDENCE = 'High';

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asLinkHandleDirection(value: unknown): LinkHandleDirection | undefined {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left'
    ? value
    : undefined;
}

function normalizeWebsitePreviewUrl(raw: unknown): string | undefined {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return undefined;
  }
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function toTicketNode(value: unknown, fallbackIndex = 0): TicketNode | undefined {
  if (!isRecord(value) || value.type === 'note' || value.type === 'website') {
    return undefined;
  }

  const issueKey = asString(value.issueKey) ?? asString(value.key);
  if (!issueKey) {
    return undefined;
  }

  const fallbackColumn = fallbackIndex % 4;
  const fallbackRow = Math.floor(fallbackIndex / 4);

  return {
    type: 'ticket',
    id: asString(value.id) ?? `ticket-${issueKey}-${fallbackIndex}`,
    issueKey,
    summary: asString(value.summary) ?? issueKey,
    issueType: asString(value.issueType) ?? 'Unknown',
    status: asString(value.status) ?? 'Unknown',
    assignee: asString(value.assignee),
    priority: asString(value.priority),
    projectKey: asString(value.projectKey) ?? (/^([A-Za-z]\w+)-\d+$/.exec(issueKey)?.[1] ?? 'UNKNOWN'),
    x: asNumber(value.x) ?? (24 + (fallbackColumn * 280)),
    y: asNumber(value.y) ?? (72 + (fallbackRow * 160))
  };
}

function toNoteNode(value: unknown, fallbackIndex = 0): NoteNode | undefined {
  if (!isRecord(value) || value.type !== 'note') {
    return undefined;
  }

  const fallbackColumn = fallbackIndex % 3;
  const fallbackRow = Math.floor(fallbackIndex / 3);

  return {
    type: 'note',
    id: asString(value.id) ?? `note-${fallbackIndex}`,
    title: asString(value.title) ?? 'Notes',
    content: asString(value.content) ?? '',
    x: asNumber(value.x) ?? (24 + (fallbackColumn * 300)),
    y: asNumber(value.y) ?? (72 + (fallbackRow * 220)),
    width: Math.max(220, asNumber(value.width) ?? 280),
    height: Math.max(150, asNumber(value.height) ?? 190)
  };
}

function toWebsitePreviewNode(value: unknown, fallbackIndex = 0): WebsitePreviewNode | undefined {
  if (!isRecord(value) || value.type !== 'website') {
    return undefined;
  }

  const url = asString(value.url);
  if (!url) {
    return undefined;
  }

  const fallbackColumn = fallbackIndex % 3;
  const fallbackRow = Math.floor(fallbackIndex / 3);

  return {
    type: 'website',
    id: asString(value.id) ?? `website-${fallbackIndex}`,
    url,
    x: asNumber(value.x) ?? (24 + (fallbackColumn * 320)),
    y: asNumber(value.y) ?? (72 + (fallbackRow * 240)),
    width: Math.max(240, asNumber(value.width) ?? 360),
    height: Math.max(180, asNumber(value.height) ?? 260)
  };
}

function toDirectedConnector(value: unknown): DirectedConnector | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sourceNodeId = asString(value.sourceNodeId);
  const targetNodeId = asString(value.targetNodeId);
  if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
    return undefined;
  }

  return {
    id: asString(value.id) ?? `connector-${sourceNodeId}-${targetNodeId}`,
    sourceNodeId,
    targetNodeId,
    sourceDirection: asLinkHandleDirection(value.sourceDirection),
    targetDirection: asLinkHandleDirection(value.targetDirection)
  };
}

function normalizePersistedState(rawState: unknown): NoteTestState {
  return normalizePersistedStateWithRecovery(rawState).state;
}

function isTicketNode(node: CanvasNode | undefined): node is TicketNode {
  return Boolean(node && node.type === 'ticket');
}

function isCustomCanvasNode(node: CanvasNode | undefined): node is NoteNode | WebsitePreviewNode {
  return Boolean(node && node.type !== 'ticket');
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

  const description = `Generated from the Note Test graph with ${orderedNodes.length} ticket node${orderedNodes.length === 1 ? '' : 's'} and ${dependencyRows.length} dependency link${dependencyRows.length === 1 ? '' : 's'}.`;
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
      lines.push(`${index + 1}. **Phase ${index + 1} - ${node.issueKey}:** ${toSingleLineText(node.summary) || '(no summary)'}`);
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
      lines.push(`${index + 1}. ${source.issueKey} -> ${target.issueKey}`);
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
  const rank = new Map<string, number>([
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
      const title = `Execution Slice ${toTwoDigitNumber(featureNumber)} - ${toSingleLineText(firstStory.node.summary) || firstStory.node.issueKey}`;
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

function normalizePersistedStateWithRecovery(rawState: unknown): NoteTestStateRecoveryResult {
  const recovered = normalizeTaskDesignerPersistedState(rawState);
  return {
    state: {
      nodes: recovered.state.nodes as CanvasNode[],
      connectors: recovered.state.connectors as DirectedConnector[],
      zoom: recovered.state.zoom,
      toolbarPosition: {
        x: recovered.state.toolbarPosition.x,
        y: recovered.state.toolbarPosition.y
      }
    },
    repaired: recovered.repaired,
    warning: recovered.warning?.replace('Task Designer', 'Note Test')
  };
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
    const sourceList = adjacency.get(connector.sourceNodeId);
    if (sourceList) {
      sourceList.push(connector.targetNodeId);
    } else {
      adjacency.set(connector.sourceNodeId, [connector.targetNodeId]);
    }
    if (!adjacency.has(connector.targetNodeId)) {
      adjacency.set(connector.targetNodeId, []);
    }
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  let cycleConnector: DirectedConnector | undefined;

  const visit = (nodeId: string): boolean => {
    visited.add(nodeId);
    active.add(nodeId);
    const nextNodeIds = adjacency.get(nodeId) ?? [];
    for (const nextNodeId of nextNodeIds) {
      if (!visited.has(nextNodeId)) {
        if (visit(nextNodeId)) {
          if (!cycleConnector) {
            cycleConnector = {
              id: '',
              sourceNodeId: nodeId,
              targetNodeId: nextNodeId
            };
          }
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

type NoteTestToolbarIcon =
  | 'select'
  | 'ticket'
  | 'note'
  | 'website'
  | 'link'
  | 'zoomIn'
  | 'zoomOut'
  | 'deleteConnector'
  | 'generateMasterPlan'
  | 'recommendFlow'
  | 'recommendBoardFlow'
  | 'reset'
  | 'confirm'
  | 'dismiss';

function renderToolbarIcon(icon: NoteTestToolbarIcon): string {
  switch (icon) {
    case 'select':
      return '<path d="M4 3.5l8 3.6-3.6 1.3L7 12 4 3.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="currentColor" />';
    case 'ticket':
      return '<path d="M5 3.5h5l2 2V12.5H5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none" /><path d="M10 3.5v2h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M8.5 7v3M7 8.5h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />';
    case 'note':
      return '<path d="M4 3.25h6l2 2v7.5H4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none" /><path d="M10 3.25v2h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /><path d="M6 7h4M6 9.25h4M6 11.5h2.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />';
    case 'website':
      return '<rect x="2.7" y="3" width="10.6" height="10" rx="1.8" stroke="currentColor" stroke-width="1.3" fill="none" /><path d="M2.7 5.8h10.6" stroke="currentColor" stroke-width="1.3" /><circle cx="4.6" cy="4.4" r="0.55" fill="currentColor" /><circle cx="6.5" cy="4.4" r="0.55" fill="currentColor" /><circle cx="8.4" cy="4.4" r="0.55" fill="currentColor" /><path d="M5.2 9.6c.9-1.4 2.2-2 3.9-1.9M5.7 11.1c1.1-1.1 2.2-1.5 3.7-1.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />';
    case 'link':
      return '<path d="M6.2 9.8 4.9 11a2 2 0 1 1-2.9-2.8l1.4-1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" /><path d="M9.8 6.2 11.1 5a2 2 0 1 1 2.9 2.8l-1.4 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none" /><path d="M6 10l4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />';
    case 'zoomIn':
      return '<circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.3" fill="none" /><path d="M11.5 11.5 14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /><path d="M8 6.2v3.6M6.2 8h3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />';
    case 'zoomOut':
      return '<circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.3" fill="none" /><path d="M11.5 11.5 14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /><path d="M6.2 8h3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />';
    case 'deleteConnector':
      return '<path d="M3.5 4.5h9M6 4.5V3.4c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.1M5 6.5v5m3-5v5m3-5v5M4.5 4.5l.5 8.1c0 .5.4.9.9.9h4.2c.5 0 .9-.4.9-.9l.5-8.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none" />';
    case 'generateMasterPlan':
      return '<path d="M4 3.5h5l2 2v7H4z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" fill="none" /><path d="M9 3.5v2h2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" /><path d="M8 7.5v3.5M6.5 9.5 8 11l1.5-1.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />';
    case 'recommendFlow':
      return '<path d="M8 2.5 9.3 5l2.7.4-2 2 .5 2.8L8 9 5.5 10.2 6 7.4 4 5.4 6.7 5 8 2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none" /><path d="M11.8 10.5l.6 1.2 1.3.2-.9.9.2 1.3-1.2-.6-1.1.6.2-1.3-.9-.9 1.3-.2.5-1.2z" fill="currentColor" />';
    case 'recommendBoardFlow':
      return '<rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none" /><path d="M6.2 3v10" stroke="currentColor" stroke-width="1.3" /><path d="M2.5 6.3h11" stroke="currentColor" stroke-width="1.3" /><path d="M11.2 2.4l.6 1.1 1.2.2-.8.9.2 1.2-1.2-.6-1.1.6.2-1.2-.8-.9 1.2-.2.5-1.1z" fill="currentColor" />';
    case 'confirm':
      return '<path d="M3.5 8.5 6.5 11.5 12.5 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" />';
    case 'dismiss':
      return '<path d="M4.5 4.5 11.5 11.5M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />';
    case 'reset':
      return '<path d="M3.2 8A4.8 4.8 0 1 1 8 12.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/><path d="M3.2 4.8v3.2H6.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
  }
}

function renderToolbarButton(
  id: string,
  action: string | undefined,
  label: string,
  icon: NoteTestToolbarIcon,
  options?: {
    disabled?: boolean;
    extraClass?: string;
  }
): string {
  const className = ['overlay-icon-button', options?.extraClass].filter(Boolean).join(' ');
  const actionAttribute = action ? ` data-action="${action}"` : '';
  const disabledAttribute = options?.disabled ? ' disabled' : '';
  return `<button id="${id}" class="${className}" type="button" title="${label}" aria-label="${label}"${actionAttribute}${disabledAttribute}>
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${renderToolbarIcon(icon)}</svg>
  </button>`;
}

export class NoteTestPanelManager {
  private panel: vscode.WebviewPanel | undefined;
  private nextNodeIndex = 0;

  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly backendService: IssueTrackerService,
    private readonly recommendTaskDesignerFlow?: RecommendTaskDesignerFlow,
    private readonly resolveBoardRecommendationSeed?: ResolveTaskDesignerBoardRecommendationSeed
  ) {}

  public open(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }

    const recoveredState = this.getPersistedCanvasState();
    const state = recoveredState.state;
    this.syncNextNodeIndex(state.nodes);

    const nonce = createNonce();
    const panel = vscode.window.createWebviewPanel(
      'ticketManager.noteTest',
      'Note Test',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = this.getHtml(nonce, state);

    this.panel = panel;
    if (recoveredState.repaired) {
      void this.workspaceState.update(NOTE_TEST_STATE_KEY, state);
    }

    panel.onDidDispose(() => {
      this.panel = undefined;
    });

    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    if (message.type === 'persist' || message.type === 'persistCanvasState') {
      const recoveredState = normalizePersistedStateWithRecovery(message.state ?? message);
      const graphError = validateConnectorGraph(recoveredState.state.connectors);
      if (recoveredState.repaired) {
        this.syncNextNodeIndex(recoveredState.state.nodes);
        await this.workspaceState.update(NOTE_TEST_STATE_KEY, recoveredState.state);
        await this.panel?.webview.postMessage({
          type: 'persistCanvasStateResult',
          ok: false,
          error: recoveredState.warning ?? 'Recovered invalid canvas state while saving.',
          state: recoveredState.state
        });
        return;
      }
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
      await this.workspaceState.update(NOTE_TEST_STATE_KEY, recoveredState.state);
      this.syncNextNodeIndex(recoveredState.state.nodes);
      await this.panel?.webview.postMessage({
        type: 'persistCanvasStateResult',
        ok: true
      });
      return;
    }

    if (message.type === 'addTicket') {
      await this.handleAddTicketMessage(message);
      return;
    }

    if (message.type === 'addNote') {
      await this.handleAddNoteMessage(message);
      return;
    }

    if (message.type === 'addWebsitePreview') {
      await this.handleAddWebsitePreviewMessage(message);
      return;
    }

    if (message.type === 'resolveDroppedIssue') {
      await this.handleResolveDroppedIssueMessage(message);
      return;
    }

    if (message.type === 'recommendCanvasFlow') {
      await this.handleRecommendCanvasFlowMessage(message);
      return;
    }

    if (message.type === 'recommendBoardFlow') {
      await this.handleRecommendBoardFlowMessage();
      return;
    }

    if (message.type === 'applyRecommendation') {
      await this.handleApplyRecommendationMessage(message);
      return;
    }

    if (message.type === 'generateMasterPlan') {
      await this.handleGenerateMasterPlanMessage(message);
    }
  }

  private syncNextNodeIndex(nodes: readonly CanvasNode[]): void {
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

  private getPersistedCanvasState(): NoteTestStateRecoveryResult {
    const rawState = this.workspaceState.get<unknown>(NOTE_TEST_STATE_KEY);
    return normalizePersistedStateWithRecovery(rawState);
  }

  private createTicketNode(issue: IssueDetails, requestedIssueKey?: string, x?: number, y?: number): TicketNode {
    const index = this.nextNodeIndex;
    this.nextNodeIndex += 1;
    const column = index % 4;
    const row = Math.floor(index / 4);
    const issueKey = (issue.key || requestedIssueKey || '').trim();
    if (!issueKey) {
      throw new Error('Issue details are missing a valid issue key.');
    }

    return {
      type: 'ticket',
      id: `ticket-${issueKey}-${index}`,
      issueKey,
      summary: issue.summary || issueKey,
      issueType: issue.issueType || 'Unknown',
      status: issue.status || 'Unknown',
      assignee: issue.assignee,
      priority: issue.priority,
      projectKey: issue.projectKey || (/^([A-Za-z]\w+)-\d+$/.exec(issueKey)?.[1] ?? 'UNKNOWN'),
      x: x === undefined ? (24 + (column * 280)) : Math.round(x),
      y: y === undefined ? (72 + (row * 160)) : Math.round(y)
    };
  }

  private createNoteNode(x?: number, y?: number): NoteNode {
    const index = this.nextNodeIndex;
    this.nextNodeIndex += 1;
    const column = index % 3;
    const row = Math.floor(index / 3);
    return {
      type: 'note',
      id: `note-${index}`,
      title: 'Notes',
      content: '',
      x: x === undefined ? (24 + (column * 300)) : Math.round(x),
      y: y === undefined ? (72 + (row * 220)) : Math.round(y),
      width: 280,
      height: 190
    };
  }

  private async handleAddTicketMessage(message: Record<string, unknown>): Promise<void> {
    const issueKey = asString(message.issueKey)?.trim();
    const x = asNumber(message.x);
    const y = asNumber(message.y);

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
        node: this.createTicketNode(issue, issueKey, x, y)
      });
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: 'addTicketResult',
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleAddNoteMessage(message: Record<string, unknown>): Promise<void> {
    const x = asNumber(message.x);
    const y = asNumber(message.y);
    const node = this.createNoteNode(x, y);
    const title = asString(message.title);
    const content = asString(message.content);
    if (title !== undefined) {
      node.title = title;
    }
    if (content !== undefined) {
      node.content = content;
    }
    await this.panel?.webview.postMessage({
      type: 'addNoteResult',
      ok: true,
      node
    });
  }

  private async handleAddWebsitePreviewMessage(message: Record<string, unknown>): Promise<void> {
    const url = normalizeWebsitePreviewUrl(asString(message.url));
    if (!url) {
      await this.panel?.webview.postMessage({
        type: 'addWebsitePreviewResult',
        ok: false,
        error: 'Enter a valid http or https URL before adding the website preview.'
      });
      return;
    }

    const x = asNumber(message.x);
    const y = asNumber(message.y);
    const node: WebsitePreviewNode = {
      type: 'website',
      id: `website-${this.nextNodeIndex}`,
      url,
      x: x === undefined ? 180 : Math.round(x),
      y: y === undefined ? 90 : Math.round(y),
      width: 360,
      height: 260
    };
    this.nextNodeIndex += 1;

    await this.panel?.webview.postMessage({
      type: 'addWebsitePreviewResult',
      ok: true,
      node
    });
  }

  private normalizeIssuePayload(issue: Partial<IssueDetails>, requestedIssueKey?: string): Omit<TicketNode, 'id' | 'x' | 'y' | 'type'> | undefined {
    const issueKey = pickFirstString(issue.key, requestedIssueKey);
    if (!issueKey) {
      return undefined;
    }

    const summary = pickFirstString(issue.summary) ?? issueKey;
    const issueType = pickFirstString(issue.issueType) ?? 'Unknown';
    const status = pickFirstString(issue.status) ?? 'Unknown';
    const projectKey = pickFirstString(issue.projectKey) ?? (/^([A-Za-z]\w+)-\d+$/.exec(issueKey)?.[1] ?? 'UNKNOWN');

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

  private async handleResolveDroppedIssueMessage(message: Record<string, unknown>): Promise<void> {
    const issueKey = asString(message.issueKey)?.trim();
    const dropPoint = isRecord(message.dropPoint)
      ? {
          x: asNumber(message.dropPoint.x) ?? 200,
          y: asNumber(message.dropPoint.y) ?? 120
        }
      : { x: 200, y: 120 };

    if (!issueKey) {
      await this.panel?.webview.postMessage({
        type: 'resolveDroppedIssueResult',
        ok: false,
        error: 'Dropped issue key is missing.'
      });
      return;
    }

    try {
      const issue = await this.backendService.getIssue(issueKey);
      const mainIssue = this.normalizeIssuePayload(issue, issueKey);
      if (!mainIssue) {
        throw new Error(`Unable to resolve ${issueKey}.`);
      }

      const relatedIssueKeys = new Map<string, DroppedIssueRelation>();
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

      const relatedIssues: ResolvedDroppedIssuePayload['relatedIssues'] = [];
      const relations: ResolvedDroppedIssueRelation[] = [];
      for (const [relatedIssueKey, relation] of relatedIssueKeys.entries()) {
        try {
          const relatedIssue = await this.backendService.getIssue(relatedIssueKey);
          const normalizedRelatedIssue = this.normalizeIssuePayload(relatedIssue, relatedIssueKey);
          if (!normalizedRelatedIssue) {
            continue;
          }
          relatedIssues.push({
            ...normalizedRelatedIssue,
            relation
          });
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
          // Skip unresolved related issues and still return the main issue.
        }
      }

      await this.panel?.webview.postMessage({
        type: 'resolveDroppedIssueResult',
        ok: true,
        dropPoint,
        payload: {
          mainIssue,
          relatedIssues,
          relations
        } satisfies ResolvedDroppedIssuePayload
      });
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: 'resolveDroppedIssueResult',
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleRecommendCanvasFlowMessage(message: Record<string, unknown>): Promise<void> {
    const currentState = normalizePersistedState(message.state);
    const ticketNodes = currentState.nodes.filter((node): node is TicketNode => node.type === 'ticket');
    const ticketNodeIds = new Set(ticketNodes.map(node => node.id));
    const ticketConnectors = currentState.connectors.filter(
      connector => ticketNodeIds.has(connector.sourceNodeId) && ticketNodeIds.has(connector.targetNodeId)
    );

    if (ticketNodes.length < 2) {
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
        ticketNodes.map(node => ({
          id: node.id,
          issueKey: node.issueKey,
          summary: node.summary,
          issueType: node.issueType,
          status: node.status,
          assignee: node.assignee,
          priority: node.priority,
          projectKey: node.projectKey
        })),
        ticketConnectors.map(connector => ({
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
    const currentState = normalizePersistedState(message.state);
    const preservedNodes = currentState.nodes
      .filter(isCustomCanvasNode)
      .map(node => ({ ...node }));
    const preservedNodeIds = new Set(preservedNodes.map(node => node.id));
    const preservedConnectors = currentState.connectors.filter(
      connector => preservedNodeIds.has(connector.sourceNodeId) || preservedNodeIds.has(connector.targetNodeId)
    );

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

    const nextState: NoteTestState = {
      nodes: [
        ...orderedNodeIds
          .map(nodeId => byId.get(nodeId))
          .filter((node): node is TicketNode => Boolean(node))
          .map(node => ({ ...node })),
        ...preservedNodes
      ],
      connectors: [...connectors, ...preservedConnectors].map((connector, index) => ({
        ...connector,
        id: `connector-${index}`
      })),
      zoom: currentState.zoom,
      toolbarPosition: { ...currentState.toolbarPosition }
    };

    this.syncNextNodeIndex(nextState.nodes);
    await this.workspaceState.update(NOTE_TEST_STATE_KEY, nextState);
    await this.panel?.webview.postMessage({
      type: 'applyRecommendationResult',
      ok: true,
      state: nextState
    });
  }

  private async handleGenerateMasterPlanMessage(message: Record<string, unknown>): Promise<void> {
    const state = normalizePersistedState(message.state);
    const ticketNodes = state.nodes.filter(isTicketNode);
    const ticketNodeIds = new Set(ticketNodes.map(node => node.id));
    const ticketConnectors = state.connectors.filter(
      connector => ticketNodeIds.has(connector.sourceNodeId) && ticketNodeIds.has(connector.targetNodeId)
    );

    if (ticketNodes.length === 0) {
      await this.panel?.webview.postMessage({
        type: 'generateMasterPlanResult',
        ok: false,
        error: 'Add at least one ticket node before generating a master plan.'
      });
      return;
    }

    const graphError = validateConnectorGraph(ticketConnectors);
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
    const markdown = buildMasterPlanMarkdown(ticketNodes, ticketConnectors);
    const featureArtifacts = buildGeneratedFeatureArtifacts(ticketNodes, ticketConnectors);

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

  private getHtml(nonce: string, initialState: NoteTestState): string {
    const initialStateLiteral = JSON.stringify(initialState)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Note Test</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
      height: 100vh;
      overflow: hidden;
    }
    .shell {
      height: 100%;
      width: 100%;
    }
    .toolbar-feedback {
      font-size: 12px;
      color: var(--vscode-editor-foreground, #ccc);
      min-height: 0;
      padding: 10px 14px;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border, #333) 86%, transparent);
      border-radius: 12px;
      background: color-mix(in oklab, var(--vscode-editorWidget-background, #252526) 84%, transparent);
      backdrop-filter: blur(12px);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
      opacity: 0;
      transform: translateY(-8px);
      pointer-events: none;
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .toolbar-feedback.error {
      color: var(--vscode-errorForeground, #f44);
      border-color: color-mix(in oklab, var(--vscode-errorForeground, #f44) 38%, var(--vscode-panel-border, #333));
    }
    .toolbar-feedback.has-message {
      opacity: 1;
      transform: translateY(0);
    }

    .canvas-surface {
      height: 100%;
      background-color: var(--vscode-editor-background, #1e1e1e);
      background-image: radial-gradient(circle, var(--vscode-editorIndentGuide-background, #3b3b3b) 1px, transparent 1.5px);
      background-size: 20px 20px;
      position: relative;
      overflow: auto;
      isolation: isolate;
    }

    .canvas-toolbar {
      position: absolute;
      top: 16px;
      left: 16px;
      z-index: 4;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 10px 8px;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border, #333) 88%, transparent);
      border-radius: 22px;
      background: color-mix(in oklab, var(--vscode-editorWidget-background, #252526) 86%, transparent);
      backdrop-filter: blur(14px);
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.24);
    }
    .canvas-toolbar-handle {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 42px;
      height: 22px;
      margin: 0 auto 2px;
      border-radius: 999px;
      color: var(--vscode-descriptionForeground, #999);
      cursor: grab;
      touch-action: none;
    }
    .canvas-toolbar-handle:active { cursor: grabbing; }
    .canvas-toolbar-grip {
      width: 18px;
      height: 4px;
      border-radius: 999px;
      background: color-mix(in oklab, var(--vscode-descriptionForeground, #999) 72%, transparent);
      box-shadow: 0 6px 0 color-mix(in oklab, var(--vscode-descriptionForeground, #999) 48%, transparent);
    }
    .canvas-toolbar-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .canvas-toolbar-separator {
      width: 100%;
      height: 1px;
      background: color-mix(in oklab, var(--vscode-panel-border, #333) 72%, transparent);
    }
    .overlay-icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 42px;
      height: 42px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 14px;
      background: transparent;
      color: var(--vscode-icon-foreground, var(--vscode-editor-foreground, #ccc));
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 140ms ease;
    }
    .overlay-icon-button:hover {
      background: color-mix(in oklab, var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, #2a2d2e)) 78%, transparent);
      border-color: color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 24%, var(--vscode-panel-border, #333));
      transform: translateY(-1px);
    }
    .overlay-icon-button.is-active {
      background: color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 18%, var(--vscode-editorWidget-background, #252526));
      border-color: color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 56%, var(--vscode-panel-border, #333));
      color: var(--vscode-textLink-foreground, var(--vscode-focusBorder, #007fd4));
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 18%, transparent);
    }
    .overlay-icon-button:disabled {
      opacity: 0.45;
      cursor: default;
      transform: none;
    }
    .overlay-icon-button.is-hidden {
      display: none;
    }
    .overlay-icon-button svg {
      width: 18px;
      height: 18px;
      display: block;
      color: inherit;
    }
    .overlay-icon-button--accent {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    .overlay-icon-button--accent:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
      border-color: transparent;
    }

    .canvas-ticket-entry {
      position: absolute;
      top: 16px;
      left: 88px;
      z-index: 4;
      display: none;
      align-items: center;
      gap: 8px;
      width: min(336px, calc(100% - 136px));
      padding: 10px;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border, #333) 88%, transparent);
      border-radius: 18px;
      background: color-mix(in oklab, var(--vscode-editorWidget-background, #252526) 90%, transparent);
      backdrop-filter: blur(14px);
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.22);
    }
    .canvas-ticket-entry.is-open {
      display: flex;
    }
    .canvas-ticket-entry input {
      flex: 1;
      min-width: 0;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #333));
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border-radius: 12px;
      padding: 9px 12px;
      font-size: 12px;
    }

    .feedback-overlay {
      position: absolute;
      top: 16px;
      left: 50%;
      z-index: 5;
      width: min(420px, calc(100% - 180px));
      transform: translateX(-50%);
    }

    .nodes-layer {
      position: absolute;
      inset: 0;
      z-index: 1;
      transform-origin: top left;
    }
    .connectors-layer {
      position: absolute;
      inset: 0;
      z-index: 0;
      overflow: visible;
      pointer-events: none;
      transform-origin: top left;
    }
    .connector-group {
      pointer-events: auto;
    }
    .connector-line {
      fill: none;
      stroke: var(--vscode-descriptionForeground, #888);
      stroke-width: 2;
      marker-end: url(#note-test-arrowhead);
      pointer-events: none;
    }
    .connector-hit-area {
      fill: none;
      stroke: transparent;
      stroke-width: 12;
      cursor: pointer;
      pointer-events: stroke;
    }
    .connector-preview-line {
      fill: none;
      stroke: var(--vscode-focusBorder, #007fd4);
      stroke-width: 2.5;
      stroke-dasharray: 7 6;
      opacity: 0.9;
      pointer-events: none;
      marker-end: url(#note-test-arrowhead-preview);
    }
    .connector-group.is-selected .connector-line {
      stroke: var(--vscode-focusBorder, #007fd4);
      stroke-width: 3;
      marker-end: url(#note-test-arrowhead-selected);
    }

    .surface-hint {
      position: absolute;
      top: 16px;
      left: 88px;
      z-index: 2;
      padding: 8px 10px;
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, #252526);
      color: var(--vscode-descriptionForeground, #999);
      font-size: 12px;
      pointer-events: none;
    }

    .ticket-node {
      position: absolute;
      min-width: 220px;
      max-width: 420px;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid var(--vscode-panel-border, #444);
      background: var(--vscode-editorWidget-background, #252526);
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.24);
      user-select: none;
      cursor: grab;
      overflow: hidden;
      color: var(--vscode-editor-foreground, #ccc);
    }
    .ticket-node.dragging { cursor: grabbing; }
    .ticket-node.is-resizing { cursor: nwse-resize; }
    .ticket-node.is-selected {
      border-color: color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 82%, var(--vscode-panel-border, #444));
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 28%, transparent), 0 12px 24px rgba(0, 0, 0, 0.18);
    }

    .ticket-node-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin: -10px -10px 8px;
      padding: 6px 10px 5px;
      color: #eff6ff;
      cursor: move;
    }
    .ticket-node-header--ticket {
      background: linear-gradient(135deg, #2b7cd3 0%, #1f5ea3 100%);
    }
    .ticket-node-header--note {
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
    }
    .ticket-node-header--website {
      background: linear-gradient(135deg, #6eb2ff 0%, #367fdd 100%);
    }
    .ticket-node-title-wrap {
      min-width: 0;
      display: grid;
      gap: 1px;
    }
    .ticket-node-key {
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: inherit;
      opacity: 0.9;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ticket-node-delete {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.1);
      color: #eff6ff;
      border-radius: 6px;
      cursor: pointer;
    }
    .ticket-node-delete:hover {
      background: rgba(255, 255, 255, 0.18);
    }

    .ticket-node-summary {
      margin-top: 6px;
      font-weight: 600;
      line-height: 1.35;
      font-size: 12px;
    }
    .ticket-node-meta {
      margin-top: 8px;
      display: grid;
      gap: 4px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #999);
    }
    .ticket-node-meta-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .note-node-title-input {
      width: 100%;
      min-width: 0;
      border: none;
      background: transparent;
      color: inherit;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.03em;
      outline: none;
      padding: 0;
      cursor: text;
    }
    .note-node-body {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      margin-top: 6px;
    }
    .note-node-textarea {
      width: 100%;
      min-height: 0;
      height: 100%;
      flex: 1;
      resize: none;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border, #333) 82%, transparent);
      border-radius: 8px;
      background: color-mix(in oklab, var(--vscode-editor-background, #1e1e1e) 92%, transparent);
      color: var(--vscode-editor-foreground, #ccc);
      padding: 10px 11px;
      font: inherit;
      line-height: 1.45;
      outline: none;
      cursor: text;
      box-sizing: border-box;
    }

    .website-node-body {
      display: flex;
      flex-direction: column;
      min-height: 150px;
      height: calc(100% - 34px);
      gap: 8px;
      margin-top: 6px;
    }
    .website-node-url-input {
      width: 100%;
      min-width: 0;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border, #333) 82%, transparent);
      border-radius: 8px;
      background: color-mix(in oklab, var(--vscode-editor-background, #1e1e1e) 92%, transparent);
      color: var(--vscode-input-foreground, #ccc);
      padding: 8px 10px;
      font: inherit;
      outline: none;
      cursor: text;
    }
    .website-node-frame-wrap {
      position: relative;
      flex: 1;
      min-height: 120px;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border, #333) 82%, transparent);
      border-radius: 8px;
      overflow: hidden;
      background: color-mix(in oklab, var(--vscode-editor-background, #1e1e1e) 96%, transparent);
    }
    .website-node-frame {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: white;
    }
    .website-node-empty {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
      text-align: center;
      color: var(--vscode-descriptionForeground, #999);
      font-size: 12px;
      line-height: 1.45;
    }

    .note-node-resize-handle {
      position: absolute;
      right: 6px;
      bottom: 6px;
      width: 16px;
      height: 16px;
      padding: 0;
      border: none;
      background: transparent;
      cursor: nwse-resize;
      z-index: 2;
    }
    .note-node-resize-handle::before {
      content: '';
      position: absolute;
      inset: 3px;
      border-right: 2px solid color-mix(in oklab, var(--vscode-descriptionForeground, #999) 86%, transparent);
      border-bottom: 2px solid color-mix(in oklab, var(--vscode-descriptionForeground, #999) 86%, transparent);
      border-bottom-right-radius: 2px;
    }

    .ticket-node-handle {
      --handle-transform: translate(-50%, -50%);
      position: absolute;
      width: 14px;
      height: 14px;
      padding: 0;
      border: 2px solid var(--vscode-focusBorder, #007fd4);
      border-radius: 999px;
      background: var(--vscode-editorWidget-background, #252526);
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--vscode-panel-border, #333) 72%, transparent);
      opacity: 0;
      pointer-events: none;
      z-index: 3;
      cursor: crosshair;
      transform: var(--handle-transform) scale(0.72);
      transition: opacity 120ms ease, transform 120ms ease, background 120ms ease, box-shadow 120ms ease;
    }
    .ticket-node-handle--top { top: 0; left: 50%; --handle-transform: translate(-50%, -50%); }
    .ticket-node-handle--right { top: 50%; right: 0; --handle-transform: translate(50%, -50%); }
    .ticket-node-handle--bottom { bottom: 0; left: 50%; --handle-transform: translate(-50%, 50%); }
    .ticket-node-handle--left { top: 50%; left: 0; --handle-transform: translate(-50%, -50%); }
    .ticket-node.is-selected .ticket-node-handle,
    .ticket-node.is-link-target .ticket-node-handle {
      opacity: 1;
      pointer-events: auto;
      transform: var(--handle-transform) scale(1);
    }
    .ticket-node-handle:hover {
      background: var(--vscode-focusBorder, #007fd4);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--vscode-focusBorder, #007fd4) 24%, transparent);
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  </style>
</head>
<body>
  <div class="shell">
    <main id="canvas-surface" class="canvas-surface" aria-label="Note Test canvas">
      <div class="canvas-toolbar" aria-label="Note Test tools">
        <div id="canvas-toolbar-handle" class="canvas-toolbar-handle" title="Drag toolbar" aria-label="Drag toolbar">
          <span class="canvas-toolbar-grip" aria-hidden="true"></span>
        </div>
        <div class="canvas-toolbar-group">
          ${renderToolbarButton('toolbar-select-button', 'select', 'Select', 'select')}
          ${renderToolbarButton('toolbar-ticket-button', 'ticket', 'Add ticket', 'ticket')}
          ${renderToolbarButton('toolbar-note-button', 'note', 'Add note', 'note')}
          ${renderToolbarButton('toolbar-website-button', 'website', 'Add website preview', 'website')}
          ${renderToolbarButton('toolbar-link-button', 'link', 'Link components', 'link')}
          ${renderToolbarButton('toolbar-zoom-in-button', 'zoomIn', 'Zoom in', 'zoomIn')}
          ${renderToolbarButton('toolbar-zoom-out-button', 'zoomOut', 'Zoom out', 'zoomOut')}
        </div>
        <div class="canvas-toolbar-separator"></div>
        <div class="canvas-toolbar-group">
          ${renderToolbarButton('delete-connector-button', 'deleteConnector', 'Delete selected link', 'deleteConnector', { disabled: true })}
          ${renderToolbarButton('generate-master-plan-button', 'generateMasterPlan', 'Generate master plan', 'generateMasterPlan')}
          ${renderToolbarButton('recommend-flow-button', 'recommendFlow', 'AI recommend flow', 'recommendFlow')}
          ${renderToolbarButton('recommend-board-flow-button', 'recommendBoardFlow', 'AI recommend from board', 'recommendBoardFlow')}
          ${renderToolbarButton('apply-recommendation-button', 'applyRecommendation', 'Apply AI recommendation', 'confirm', { disabled: true, extraClass: 'is-hidden' })}
          ${renderToolbarButton('reject-recommendation-button', 'rejectRecommendation', 'Discard AI recommendation', 'dismiss', { disabled: true, extraClass: 'is-hidden' })}
        </div>
        <div class="canvas-toolbar-separator"></div>
        <div class="canvas-toolbar-group">
          ${renderToolbarButton('toolbar-reset-button', 'reset', 'Clear canvas', 'reset')}
        </div>
      </div>

      <form id="ticket-entry-panel" class="canvas-ticket-entry" autocomplete="off">
        <label class="sr-only" for="ticket-key-input">Ticket number</label>
        <input id="ticket-key-input" type="text" placeholder="Ticket number (e.g. APP-123)" aria-label="Ticket number" />
        ${renderToolbarButton('ticket-add-button', undefined, 'Confirm add ticket', 'confirm', { extraClass: 'overlay-icon-button--accent' })}
        ${renderToolbarButton('ticket-entry-close-button', undefined, 'Close ticket entry', 'dismiss')}
      </form>

      <div class="feedback-overlay">
        <div id="toolbar-feedback" class="toolbar-feedback" aria-live="polite"></div>
      </div>

      <svg id="connectors-layer" class="connectors-layer" aria-hidden="true">
        <defs>
          <marker id="note-test-arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <polygon points="0 0, 8 3, 0 6" fill="var(--vscode-descriptionForeground, #888)"></polygon>
          </marker>
          <marker id="note-test-arrowhead-selected" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <polygon points="0 0, 8 3, 0 6" fill="var(--vscode-focusBorder, #007fd4)"></polygon>
          </marker>
          <marker id="note-test-arrowhead-preview" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <polygon points="0 0, 8 3, 0 6" fill="var(--vscode-focusBorder, #007fd4)"></polygon>
          </marker>
        </defs>
      </svg>

      <div id="nodes-layer" class="nodes-layer"></div>
      <div id="surface-hint" class="surface-hint">Add tickets, notes, or website previews to start building.</div>
    </main>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const initialState = ${initialStateLiteral};

    const canvasSurface = document.getElementById('canvas-surface');
    const nodesLayer = document.getElementById('nodes-layer');
    const connectorsLayer = document.getElementById('connectors-layer');
    const canvasToolbar = document.querySelector('.canvas-toolbar');
    const canvasToolbarHandle = document.getElementById('canvas-toolbar-handle');
    const surfaceHint = document.getElementById('surface-hint');
    const feedback = document.getElementById('toolbar-feedback');

    const ticketInput = document.getElementById('ticket-key-input');
    const ticketEntryPanel = document.getElementById('ticket-entry-panel');
    const ticketAddButton = document.getElementById('ticket-add-button');
    const ticketEntryCloseButton = document.getElementById('ticket-entry-close-button');
    const deleteConnectorButton = document.getElementById('delete-connector-button');
    const generateMasterPlanButton = document.getElementById('generate-master-plan-button');
    const recommendFlowButton = document.getElementById('recommend-flow-button');
    const recommendBoardFlowButton = document.getElementById('recommend-board-flow-button');
    const applyRecommendationButton = document.getElementById('apply-recommendation-button');
    const rejectRecommendationButton = document.getElementById('reject-recommendation-button');

    const state = {
      nodes: Array.isArray(initialState.nodes) ? initialState.nodes : [],
      connectors: Array.isArray(initialState.connectors) ? initialState.connectors : [],
      recommendation: undefined,
      recommendationNodes: [],
      recommendationSource: undefined
    };

    const uiState = {
      activeTool: 'select',
      linkSourceNodeId: undefined,
      selectedNodeId: undefined,
      selectedConnectorId: undefined,
      nextConnectorIndex: state.connectors.length,
      ticketEntryOpen: false,
      toolbarPosition: {
        x: typeof initialState.toolbarPosition?.x === 'number' ? initialState.toolbarPosition.x : 16,
        y: typeof initialState.toolbarPosition?.y === 'number' ? initialState.toolbarPosition.y : 16
      },
      zoom: typeof initialState.zoom === 'number' ? initialState.zoom : 1,
      linkPreview: undefined,
      hoveredLinkNodeId: undefined,
      persistCanvasStateTimer: undefined,
      toolbarDrag: undefined,
      generatingMasterPlan: false,
      applyingRecommendation: false
    };

    function setGeneratingMasterPlan(isGenerating) {
      uiState.generatingMasterPlan = Boolean(isGenerating);
      if (generateMasterPlanButton instanceof HTMLButtonElement) {
        generateMasterPlanButton.disabled = uiState.generatingMasterPlan;
      }
    }

    function setFeedback(text, isError) {
      if (!(feedback instanceof HTMLElement)) {
        return;
      }
      feedback.textContent = text || '';
      feedback.classList.toggle('error', Boolean(isError));
      feedback.classList.toggle('has-message', Boolean(text));
    }

    function normalizeWebsitePreviewUrl(raw) {
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      if (!trimmed) {
        return undefined;
      }
      const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : ('https://' + trimmed);
      try {
        const url = new URL(candidate);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return undefined;
        }
        return url.toString();
      } catch {
        return undefined;
      }
    }

    function websitePreviewTitle(url) {
      const normalized = normalizeWebsitePreviewUrl(url);
      if (!normalized) {
        return 'Website Preview';
      }
      try {
        const parsed = new URL(normalized);
        return parsed.hostname || 'Website Preview';
      } catch {
        return 'Website Preview';
      }
    }

    function getNodeLabel(node) {
      if (!node) {
        return 'selected node';
      }
      if (node.type === 'note') {
        return (typeof node.title === 'string' && node.title.trim()) ? node.title.trim() : 'note';
      }
      if (node.type === 'website') {
        return websitePreviewTitle(node.url);
      }
      return node.issueKey || 'ticket';
    }

    function persistCanvasState() {
      vscodeApi.postMessage({
        type: 'persistCanvasState',
        state: {
          nodes: state.nodes.map(node => ({ ...node })),
          connectors: state.connectors.map(connector => ({ ...connector })),
          zoom: uiState.zoom,
          toolbarPosition: { x: uiState.toolbarPosition.x, y: uiState.toolbarPosition.y }
        }
      });
    }

    function schedulePersistCanvasState() {
      if (uiState.persistCanvasStateTimer) {
        clearTimeout(uiState.persistCanvasStateTimer);
      }
      uiState.persistCanvasStateTimer = setTimeout(() => {
        uiState.persistCanvasStateTimer = undefined;
        persistCanvasState();
      }, 160);
    }

    function clampToolbarPosition(position) {
      if (!(canvasSurface instanceof HTMLElement) || !(canvasToolbar instanceof HTMLElement)) {
        return position;
      }
      const minX = canvasSurface.scrollLeft + 8;
      const minY = canvasSurface.scrollTop + 8;
      const maxX = canvasSurface.scrollLeft + canvasSurface.clientWidth - canvasToolbar.offsetWidth - 8;
      const maxY = canvasSurface.scrollTop + canvasSurface.clientHeight - canvasToolbar.offsetHeight - 8;
      return {
        x: Math.max(minX, Math.min(position.x, Math.max(minX, maxX))),
        y: Math.max(minY, Math.min(position.y, Math.max(minY, maxY)))
      };
    }

    function syncFloatingLayout() {
      if (canvasToolbar instanceof HTMLElement) {
        const position = clampToolbarPosition(uiState.toolbarPosition);
        uiState.toolbarPosition = position;
        canvasToolbar.style.left = position.x + 'px';
        canvasToolbar.style.top = position.y + 'px';
      }
      if (ticketEntryPanel instanceof HTMLElement) {
        ticketEntryPanel.style.left = (uiState.toolbarPosition.x + 72) + 'px';
        ticketEntryPanel.style.top = uiState.toolbarPosition.y + 'px';
      }
      if (surfaceHint instanceof HTMLElement) {
        surfaceHint.style.left = (uiState.toolbarPosition.x + 72) + 'px';
        surfaceHint.style.top = uiState.toolbarPosition.y + 'px';
      }
      if (nodesLayer instanceof HTMLElement) {
        nodesLayer.style.transformOrigin = 'top left';
        nodesLayer.style.transform = 'scale(' + uiState.zoom + ')';
      }
      if (connectorsLayer instanceof SVGElement) {
        connectorsLayer.style.transformOrigin = 'top left';
        connectorsLayer.style.transform = 'scale(' + uiState.zoom + ')';
      }
    }

    function clientDistanceToCanvas(distance) {
      return distance / uiState.zoom;
    }

    function clientPointToCanvas(clientX, clientY) {
      const nodeLayerRect = nodesLayer.getBoundingClientRect();
      return {
        x: clientDistanceToCanvas(clientX - nodeLayerRect.left),
        y: clientDistanceToCanvas(clientY - nodeLayerRect.top)
      };
    }

    function visibleCanvasPoint(offsetX, offsetY) {
      if (!(canvasSurface instanceof HTMLElement)) {
        return { x: offsetX, y: offsetY };
      }
      return {
        x: clientDistanceToCanvas(canvasSurface.scrollLeft + offsetX),
        y: clientDistanceToCanvas(canvasSurface.scrollTop + offsetY)
      };
    }

    function setZoom(nextZoom) {
      uiState.zoom = Math.max(0.5, Math.min(2, Math.round(nextZoom * 100) / 100));
      syncFloatingLayout();
      renderConnectors();
      schedulePersistCanvasState();
      setFeedback('Zoom ' + Math.round(uiState.zoom * 100) + '%.');
    }

    function syncToolbarState() {
      for (const button of document.querySelectorAll('button[data-action]')) {
        const action = button.getAttribute('data-action');
        const isActive = action === uiState.activeTool || (action === 'ticket' && uiState.ticketEntryOpen);
        button.classList.toggle('is-active', Boolean(isActive));
      }
    }

    function updateRecommendationActionState() {
      const hasRecommendation = Boolean(state.recommendation);
      const isApplying = Boolean(uiState.applyingRecommendation);
      if (applyRecommendationButton instanceof HTMLButtonElement) {
        applyRecommendationButton.disabled = !hasRecommendation || isApplying;
        applyRecommendationButton.classList.toggle('is-hidden', !hasRecommendation && !isApplying);
      }
      if (rejectRecommendationButton instanceof HTMLButtonElement) {
        rejectRecommendationButton.disabled = !hasRecommendation || isApplying;
        rejectRecommendationButton.classList.toggle('is-hidden', !hasRecommendation && !isApplying);
      }
    }

    function setTicketEntryOpen(isOpen, options) {
      uiState.ticketEntryOpen = Boolean(isOpen);
      if (ticketEntryPanel instanceof HTMLElement) {
        ticketEntryPanel.hidden = !uiState.ticketEntryOpen;
        ticketEntryPanel.classList.toggle('is-open', uiState.ticketEntryOpen);
      }
      syncToolbarState();
      syncFloatingLayout();
      if (uiState.ticketEntryOpen && options && options.focus && ticketInput instanceof HTMLInputElement) {
        requestAnimationFrame(() => ticketInput.focus());
      }
    }

    function isLinkHandleDirection(value) {
      return value === 'top' || value === 'right' || value === 'bottom' || value === 'left';
    }

    function findNodeById(nodeId) {
      return state.nodes.find(node => node.id === nodeId);
    }

    function hasNode(nodeId) {
      return state.nodes.some(node => node.id === nodeId);
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

    function setActiveTool(tool) {
      uiState.activeTool = tool;
      if (tool !== 'link') {
        clearLinkPreview();
      }
      syncToolbarState();
    }

    function syncNodeInteractionClasses() {
      for (const element of nodesLayer.querySelectorAll('.ticket-node[data-node-id]')) {
        if (!(element instanceof HTMLElement)) {
          continue;
        }
        const nodeId = element.dataset.nodeId;
        element.classList.toggle('is-selected', Boolean(nodeId && nodeId === uiState.selectedNodeId));
        element.classList.toggle('is-link-target', Boolean(nodeId && nodeId === uiState.hoveredLinkNodeId));
      }
    }

    function setHoveredLinkNode(nodeId) {
      const nextNodeId = typeof nodeId === 'string' && nodeId ? nodeId : undefined;
      if (uiState.hoveredLinkNodeId === nextNodeId) {
        return;
      }
      uiState.hoveredLinkNodeId = nextNodeId;
      syncNodeInteractionClasses();
    }

    function clearLinkPreview() {
      uiState.linkPreview = undefined;
      uiState.linkSourceNodeId = undefined;
      setHoveredLinkNode(undefined);
      renderConnectors();
    }

    function createConnectorId() {
      const id = 'connector-' + uiState.nextConnectorIndex;
      uiState.nextConnectorIndex += 1;
      return id;
    }

    function createConnectorBetweenNodes(sourceNodeId, targetNodeId, sourceDirection, targetDirection) {
      if (sourceNodeId === targetNodeId) {
        setFeedback('Select a different target component.', true);
        return false;
      }
      if (hasExistingConnector(sourceNodeId, targetNodeId)) {
        setFeedback('Link already exists.', true);
        return false;
      }
      if (wouldCreateCycle(sourceNodeId, targetNodeId)) {
        setFeedback('Cannot create link: this introduces a cycle.', true);
        return false;
      }

      state.connectors.push({
        id: createConnectorId(),
        sourceNodeId,
        targetNodeId,
        sourceDirection,
        targetDirection
      });
      uiState.selectedConnectorId = state.connectors[state.connectors.length - 1]?.id;
      uiState.selectedNodeId = targetNodeId;
      clearLinkPreview();
      renderNodes();
      persistCanvasState();
      setFeedback('Directed link created.');
      updateDeleteConnectorState();
      return true;
    }

    function getAnchorPointFromRect(nodeRect, nodeLayerRect, direction) {
      const centerX = clientDistanceToCanvas(nodeRect.left - nodeLayerRect.left + (nodeRect.width / 2));
      const centerY = clientDistanceToCanvas(nodeRect.top - nodeLayerRect.top + (nodeRect.height / 2));
      switch (direction) {
        case 'top':
          return { x: centerX, y: clientDistanceToCanvas(nodeRect.top - nodeLayerRect.top) };
        case 'right':
          return { x: clientDistanceToCanvas(nodeRect.right - nodeLayerRect.left), y: centerY };
        case 'bottom':
          return { x: centerX, y: clientDistanceToCanvas(nodeRect.bottom - nodeLayerRect.top) };
        case 'left':
        default:
          return { x: clientDistanceToCanvas(nodeRect.left - nodeLayerRect.left), y: centerY };
      }
    }

    function resolveConnectorDirections(sourceRect, targetRect, sourceDirection, targetDirection) {
      if (isLinkHandleDirection(sourceDirection) && isLinkHandleDirection(targetDirection)) {
        return { sourceDirection, targetDirection };
      }
      const sourceCenterX = sourceRect.left + (sourceRect.width / 2);
      const sourceCenterY = sourceRect.top + (sourceRect.height / 2);
      const targetCenterX = targetRect.left + (targetRect.width / 2);
      const targetCenterY = targetRect.top + (targetRect.height / 2);
      const deltaX = targetCenterX - sourceCenterX;
      const deltaY = targetCenterY - sourceCenterY;
      if (Math.abs(deltaX) >= Math.abs(deltaY)) {
        return {
          sourceDirection: isLinkHandleDirection(sourceDirection) ? sourceDirection : (deltaX >= 0 ? 'right' : 'left'),
          targetDirection: isLinkHandleDirection(targetDirection) ? targetDirection : (deltaX >= 0 ? 'left' : 'right')
        };
      }
      return {
        sourceDirection: isLinkHandleDirection(sourceDirection) ? sourceDirection : (deltaY >= 0 ? 'bottom' : 'top'),
        targetDirection: isLinkHandleDirection(targetDirection) ? targetDirection : (deltaY >= 0 ? 'top' : 'bottom')
      };
    }

    function buildConnectorCurvePath(x1, y1, x2, y2, sourceDirection, targetDirection) {
      const horizontalDelta = Math.abs(x2 - x1);
      const verticalDelta = Math.abs(y2 - y1);
      const controlOffset = Math.max(42, Math.min(Math.max(horizontalDelta, verticalDelta) * 0.42, 164));
      const controlPointFromDirection = (x, y, direction) => {
        switch (direction) {
          case 'top':
            return { x, y: y - controlOffset };
          case 'right':
            return { x: x + controlOffset, y };
          case 'bottom':
            return { x, y: y + controlOffset };
          case 'left':
            return { x: x - controlOffset, y };
          default:
            return { x: x + controlOffset, y };
        }
      };
      const control1 = controlPointFromDirection(x1, y1, sourceDirection);
      const control2 = controlPointFromDirection(x2, y2, targetDirection);
      return 'M ' + x1 + ' ' + y1 + ' C ' + control1.x + ' ' + control1.y + ', ' + control2.x + ' ' + control2.y + ', ' + x2 + ' ' + y2;
    }

    function nodeElementById(nodeId) {
      for (const element of nodesLayer.querySelectorAll('.ticket-node[data-node-id]')) {
        if (element instanceof HTMLElement && element.dataset.nodeId === nodeId) {
          return element;
        }
      }
      return undefined;
    }

    function renderConnectors() {
      for (const element of connectorsLayer.querySelectorAll('.connector-group, .connector-preview-line')) {
        element.remove();
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
        const directions = resolveConnectorDirections(sourceRect, targetRect, connector.sourceDirection, connector.targetDirection);
        const sourcePoint = getAnchorPointFromRect(sourceRect, nodeLayerRect, directions.sourceDirection);
        const targetPoint = getAnchorPointFromRect(targetRect, nodeLayerRect, directions.targetDirection);
        const pathData = buildConnectorCurvePath(sourcePoint.x, sourcePoint.y, targetPoint.x, targetPoint.y, directions.sourceDirection, directions.targetDirection);

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'connector-group' + (uiState.selectedConnectorId === connector.id ? ' is-selected' : ''));
        group.dataset.connectorId = connector.id;

        const visibleLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        visibleLine.setAttribute('class', 'connector-line');
        visibleLine.setAttribute('d', pathData);

        const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hitArea.setAttribute('class', 'connector-hit-area');
        hitArea.setAttribute('d', pathData);
        hitArea.addEventListener('click', event => {
          event.stopPropagation();
          uiState.selectedConnectorId = connector.id;
          updateDeleteConnectorState();
          renderConnectors();
        });

        group.append(visibleLine, hitArea);
        connectorsLayer.append(group);
      }

      if (uiState.linkPreview) {
        const previewLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        previewLine.setAttribute('class', 'connector-preview-line');
        const previewTargetDirection = isLinkHandleDirection(uiState.linkPreview.targetDirection)
          ? uiState.linkPreview.targetDirection
          : (() => {
            const deltaX = uiState.linkPreview.x2 - uiState.linkPreview.x1;
            const deltaY = uiState.linkPreview.y2 - uiState.linkPreview.y1;
            return Math.abs(deltaX) >= Math.abs(deltaY)
              ? (deltaX >= 0 ? 'left' : 'right')
              : (deltaY >= 0 ? 'top' : 'bottom');
          })();

        previewLine.setAttribute(
          'd',
          buildConnectorCurvePath(
            uiState.linkPreview.x1,
            uiState.linkPreview.y1,
            uiState.linkPreview.x2,
            uiState.linkPreview.y2,
            uiState.linkPreview.sourceDirection,
            previewTargetDirection
          )
        );
        connectorsLayer.append(previewLine);
      }

      updateDeleteConnectorState();
    }

    function createMetaRow(label, value) {
      const row = document.createElement('div');
      row.className = 'ticket-node-meta-row';
      const left = document.createElement('span');
      left.textContent = label;
      const right = document.createElement('span');
      right.textContent = value || '-';
      row.append(left, right);
      return row;
    }

    function findHandleTargetAtPoint(clientX, clientY) {
      const targetElement = document.elementFromPoint(clientX, clientY);
      if (!(targetElement instanceof Element)) {
        return undefined;
      }
      const handleElement = targetElement.closest('.ticket-node-handle');
      if (!(handleElement instanceof HTMLElement)) {
        return undefined;
      }
      const nodeId = handleElement.dataset.nodeId;
      const direction = handleElement.dataset.direction;
      if (!nodeId || !isLinkHandleDirection(direction)) {
        return undefined;
      }
      return { nodeId, direction };
    }

    function findNodeIdAtPoint(clientX, clientY) {
      const targetElement = document.elementFromPoint(clientX, clientY);
      if (!(targetElement instanceof Element)) {
        return undefined;
      }
      const nodeElement = targetElement.closest('[data-node-id]');
      return nodeElement instanceof HTMLElement ? nodeElement.dataset.nodeId : undefined;
    }

    function updateLinkPreviewFromPointer(event) {
      if (!uiState.linkPreview) {
        return;
      }
      const sourceElement = nodeElementById(uiState.linkPreview.sourceNodeId);
      if (!(sourceElement instanceof HTMLElement)) {
        clearLinkPreview();
        return;
      }
      const nodeLayerRect = nodesLayer.getBoundingClientRect();
      const sourceRect = sourceElement.getBoundingClientRect();
      const sourcePoint = getAnchorPointFromRect(sourceRect, nodeLayerRect, uiState.linkPreview.sourceDirection);
      const targetHandle = findHandleTargetAtPoint(event.clientX, event.clientY);
      const hoveredNodeId = targetHandle && targetHandle.nodeId !== uiState.linkPreview.sourceNodeId
        ? targetHandle.nodeId
        : (() => {
          const nodeId = findNodeIdAtPoint(event.clientX, event.clientY);
          return nodeId && nodeId !== uiState.linkPreview.sourceNodeId ? nodeId : undefined;
        })();

      uiState.linkPreview.x1 = sourcePoint.x;
      uiState.linkPreview.y1 = sourcePoint.y;
      if (targetHandle && targetHandle.nodeId !== uiState.linkPreview.sourceNodeId) {
        const targetElement = nodeElementById(targetHandle.nodeId);
        if (targetElement instanceof HTMLElement) {
          const targetRect = targetElement.getBoundingClientRect();
          const targetPoint = getAnchorPointFromRect(targetRect, nodeLayerRect, targetHandle.direction);
          uiState.linkPreview.x2 = targetPoint.x;
          uiState.linkPreview.y2 = targetPoint.y;
          uiState.linkPreview.targetDirection = targetHandle.direction;
        }
      } else {
        const previewPoint = clientPointToCanvas(event.clientX, event.clientY);
        uiState.linkPreview.x2 = previewPoint.x;
        uiState.linkPreview.y2 = previewPoint.y;
        uiState.linkPreview.targetDirection = undefined;
      }
      setHoveredLinkNode(hoveredNodeId);
    }

    function renderNodes() {
      if (!(nodesLayer instanceof HTMLElement)) {
        return;
      }
      nodesLayer.textContent = '';
      if (surfaceHint instanceof HTMLElement) {
        surfaceHint.style.display = state.nodes.length > 0 ? 'none' : '';
      }

      for (const node of state.nodes) {
        const root = document.createElement('article');
        root.className = 'ticket-node ticket-node--' + node.type;
        root.style.left = node.x + 'px';
        root.style.top = node.y + 'px';
        if (node.type === 'note' || node.type === 'website') {
          root.style.width = node.width + 'px';
          root.style.height = node.height + 'px';
        }
        root.dataset.nodeId = node.id;
        root.classList.toggle('is-selected', uiState.selectedNodeId === node.id);
        root.classList.toggle('is-link-target', uiState.hoveredLinkNodeId === node.id);

        const header = document.createElement('div');
        header.className = 'ticket-node-header ticket-node-header--' + node.type;

        const titleWrap = document.createElement('div');
        titleWrap.className = 'ticket-node-title-wrap';

        if (node.type === 'note') {
          const titleInput = document.createElement('input');
          titleInput.type = 'text';
          titleInput.className = 'note-node-title-input';
          titleInput.value = node.title || '';
          titleInput.placeholder = 'Notes';
          titleInput.setAttribute('aria-label', 'Note title');
          titleInput.addEventListener('focus', () => {
            uiState.selectedNodeId = node.id;
            uiState.selectedConnectorId = undefined;
            syncNodeInteractionClasses();
            renderConnectors();
          });
          titleInput.addEventListener('click', event => {
            event.stopPropagation();
          });
          titleInput.addEventListener('input', () => {
            node.title = titleInput.value;
            schedulePersistCanvasState();
          });
          titleWrap.append(titleInput);
        } else if (node.type === 'website') {
          const key = document.createElement('div');
          key.className = 'ticket-node-key';
          key.textContent = websitePreviewTitle(node.url);
          titleWrap.append(key);
        } else {
          const key = document.createElement('div');
          key.className = 'ticket-node-key';
          key.textContent = node.issueKey;
          titleWrap.append(key);
        }

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'ticket-node-delete';
        deleteButton.setAttribute('aria-label', 'Delete ' + getNodeLabel(node) + ' node');
        deleteButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.5 4.5 11.5 11.5M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        deleteButton.addEventListener('click', event => {
          event.stopPropagation();
          state.nodes = state.nodes.filter(item => item.id !== node.id);
          state.connectors = state.connectors.filter(connector => connector.sourceNodeId !== node.id && connector.targetNodeId !== node.id);
          if (uiState.selectedNodeId === node.id) {
            uiState.selectedNodeId = undefined;
          }
          if (uiState.linkSourceNodeId === node.id) {
            clearLinkPreview();
          }
          renderNodes();
          persistCanvasState();
          setFeedback((node.type === 'note' ? 'Note' : (node.type === 'website' ? 'Website preview' : 'Ticket node')) + ' deleted.', false);
        });

        header.append(titleWrap, deleteButton);

        let resizeHandle = null;
        if (node.type === 'ticket') {
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

          root.append(header, summary, meta);
        } else if (node.type === 'note') {
          const body = document.createElement('div');
          body.className = 'note-node-body';

          const textarea = document.createElement('textarea');
          textarea.className = 'note-node-textarea';
          textarea.placeholder = 'Add notes, context, or reminders...';
          textarea.value = node.content || '';
          textarea.setAttribute('aria-label', 'Note content');
          textarea.addEventListener('focus', () => {
            uiState.selectedNodeId = node.id;
            uiState.selectedConnectorId = undefined;
            syncNodeInteractionClasses();
            renderConnectors();
          });
          textarea.addEventListener('click', event => {
            event.stopPropagation();
          });
          textarea.addEventListener('input', () => {
            node.content = textarea.value;
            schedulePersistCanvasState();
          });

          body.append(textarea);

          resizeHandle = document.createElement('button');
          resizeHandle.type = 'button';
          resizeHandle.className = 'note-node-resize-handle';
          resizeHandle.setAttribute('aria-label', 'Resize note');

          root.append(header, body, resizeHandle);
        } else {
          const body = document.createElement('div');
          body.className = 'website-node-body';

          const urlInput = document.createElement('input');
          urlInput.type = 'url';
          urlInput.className = 'website-node-url-input';
          urlInput.value = node.url || '';
          urlInput.placeholder = 'https://example.com';
          urlInput.setAttribute('aria-label', 'Website URL');
          urlInput.addEventListener('focus', () => {
            uiState.selectedNodeId = node.id;
            uiState.selectedConnectorId = undefined;
            syncNodeInteractionClasses();
            renderConnectors();
          });
          urlInput.addEventListener('click', event => {
            event.stopPropagation();
          });

          const frameWrap = document.createElement('div');
          frameWrap.className = 'website-node-frame-wrap';

          const updateWebsitePreview = () => {
            const normalized = normalizeWebsitePreviewUrl(urlInput.value);
            if (!normalized) {
              frameWrap.innerHTML = '<div class="website-node-empty">Enter a valid http or https URL to load a preview.</div>';
              return;
            }
            node.url = normalized;
            const iframe = document.createElement('iframe');
            iframe.className = 'website-node-frame';
            iframe.src = normalized;
            iframe.setAttribute('title', websitePreviewTitle(normalized));
            iframe.setAttribute('referrerpolicy', 'no-referrer');
            iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
            frameWrap.replaceChildren(iframe);
            titleWrap.textContent = '';
            const key = document.createElement('div');
            key.className = 'ticket-node-key';
            key.textContent = websitePreviewTitle(normalized);
            titleWrap.append(key);
            schedulePersistCanvasState();
          };

          urlInput.addEventListener('change', updateWebsitePreview);
          urlInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              updateWebsitePreview();
            }
          });
          updateWebsitePreview();

          body.append(urlInput, frameWrap);

          resizeHandle = document.createElement('button');
          resizeHandle.type = 'button';
          resizeHandle.className = 'note-node-resize-handle';
          resizeHandle.setAttribute('aria-label', 'Resize website preview');

          root.append(header, body, resizeHandle);
        }

        for (const direction of ['top', 'right', 'bottom', 'left']) {
          const handle = document.createElement('button');
          handle.type = 'button';
          handle.className = 'ticket-node-handle ticket-node-handle--' + direction;
          handle.dataset.nodeId = node.id;
          handle.dataset.direction = direction;
          handle.setAttribute('aria-label', 'Create link from ' + getNodeLabel(node) + ' ' + direction);
          handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            uiState.selectedNodeId = node.id;
            uiState.selectedConnectorId = undefined;
            uiState.linkSourceNodeId = node.id;
            uiState.linkPreview = {
              sourceNodeId: node.id,
              sourceDirection: direction,
              targetDirection: undefined,
              pointerId: event.pointerId,
              x1: 0,
              y1: 0,
              x2: 0,
              y2: 0
            };
            root.setPointerCapture(event.pointerId);
            updateLinkPreviewFromPointer(event);
            syncNodeInteractionClasses();
            renderConnectors();
            updateDeleteConnectorState();
            setFeedback('Drag to another connector to create a directed link.');
          });
          root.append(handle);
        }

        let dragging = null;
        let resizing = null;

        if (resizeHandle) {
          resizeHandle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || (node.type !== 'note' && node.type !== 'website')) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            uiState.selectedNodeId = node.id;
            uiState.selectedConnectorId = undefined;
            resizing = {
              pointerId: event.pointerId,
              startClientX: event.clientX,
              startClientY: event.clientY,
              startWidth: node.width,
              startHeight: node.height
            };
            root.classList.add('is-resizing');
            root.setPointerCapture(event.pointerId);
            syncNodeInteractionClasses();
            renderConnectors();
          });
        }

        root.addEventListener('pointerdown', event => {
          if (event.button !== 0) {
            return;
          }
          if (event.target instanceof HTMLElement && event.target.closest('button')) {
            return;
          }
          if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
            return;
          }
          uiState.selectedNodeId = node.id;
          uiState.selectedConnectorId = undefined;
          dragging = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startX: node.x,
            startY: node.y
          };
          root.classList.add('dragging');
          root.setPointerCapture(event.pointerId);
          syncNodeInteractionClasses();
          renderConnectors();
        });

        root.addEventListener('pointermove', event => {
          if (uiState.linkPreview && uiState.linkPreview.pointerId === event.pointerId) {
            updateLinkPreviewFromPointer(event);
            renderConnectors();
            return;
          }
          if (resizing && resizing.pointerId === event.pointerId && (node.type === 'note' || node.type === 'website')) {
            const deltaX = clientDistanceToCanvas(event.clientX - resizing.startClientX);
            const deltaY = clientDistanceToCanvas(event.clientY - resizing.startClientY);
            node.width = Math.max(220, Math.round(resizing.startWidth + deltaX));
            node.height = Math.max(150, Math.round(resizing.startHeight + deltaY));
            root.style.width = node.width + 'px';
            root.style.height = node.height + 'px';
            renderConnectors();
            return;
          }
          if (!dragging || dragging.pointerId !== event.pointerId) {
            return;
          }
          const deltaX = clientDistanceToCanvas(event.clientX - dragging.startClientX);
          const deltaY = clientDistanceToCanvas(event.clientY - dragging.startClientY);
          node.x = Math.round(dragging.startX + deltaX);
          node.y = Math.round(dragging.startY + deltaY);
          root.style.left = node.x + 'px';
          root.style.top = node.y + 'px';
          renderConnectors();
        });

        root.addEventListener('pointerup', event => {
          if (uiState.linkPreview && uiState.linkPreview.pointerId === event.pointerId) {
            root.releasePointerCapture(event.pointerId);
            const targetHandle = findHandleTargetAtPoint(event.clientX, event.clientY);
            if (targetHandle && targetHandle.nodeId !== uiState.linkPreview.sourceNodeId) {
              createConnectorBetweenNodes(
                uiState.linkPreview.sourceNodeId,
                targetHandle.nodeId,
                uiState.linkPreview.sourceDirection,
                targetHandle.direction
              );
            } else {
              clearLinkPreview();
              setFeedback('Link cancelled. Drop on another connector to create it.');
            }
            return;
          }

          if (resizing && resizing.pointerId === event.pointerId) {
            resizing = null;
            root.classList.remove('is-resizing');
            renderConnectors();
            schedulePersistCanvasState();
            return;
          }

          if (!dragging || dragging.pointerId !== event.pointerId) {
            return;
          }
          dragging = null;
          root.classList.remove('dragging');
          renderConnectors();
          persistCanvasState();
        });

        root.addEventListener('pointercancel', event => {
          if (uiState.linkPreview && uiState.linkPreview.pointerId === event.pointerId) {
            clearLinkPreview();
          }
          if (resizing && resizing.pointerId === event.pointerId) {
            resizing = null;
            root.classList.remove('is-resizing');
            schedulePersistCanvasState();
          }
          if (dragging && dragging.pointerId === event.pointerId) {
            dragging = null;
            root.classList.remove('dragging');
            persistCanvasState();
          }
        });

        nodesLayer.append(root);
      }

      renderConnectors();
      syncNodeInteractionClasses();
    }

    function updateDeleteConnectorState() {
      const hasSelection = Boolean(uiState.selectedConnectorId && state.connectors.some(connector => connector.id === uiState.selectedConnectorId));
      if (deleteConnectorButton instanceof HTMLButtonElement) {
        deleteConnectorButton.disabled = !hasSelection;
      }
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
        renderConnectors();
        persistCanvasState();
        setFeedback('Link deleted.');
      }
      updateDeleteConnectorState();
    }

    function addNote() {
      const viewW = canvasSurface instanceof HTMLElement ? canvasSurface.clientWidth : 400;
      const point = visibleCanvasPoint(Math.min(180, viewW / 3), 80);
      vscodeApi.postMessage({
        type: 'addNote',
        x: Math.round(point.x),
        y: Math.round(point.y)
      });
      setFeedback('Adding note...');
    }

    function addWebsitePreview() {
      const viewW = canvasSurface instanceof HTMLElement ? canvasSurface.clientWidth : 400;
      const point = visibleCanvasPoint(Math.min(180, viewW / 3), 80);
      vscodeApi.postMessage({
        type: 'addWebsitePreview',
        url: 'https://example.com',
        x: Math.round(point.x),
        y: Math.round(point.y)
      });
      setFeedback('Adding website preview...');
    }

    function requestAddTicket() {
      const issueKey = ticketInput instanceof HTMLInputElement ? ticketInput.value.trim() : '';
      if (!issueKey) {
        setFeedback('Issue key is required to add a ticket.', true);
        return;
      }
      const viewW = canvasSurface instanceof HTMLElement ? canvasSurface.clientWidth : 400;
      const point = visibleCanvasPoint(Math.min(180, viewW / 3), 80);
      vscodeApi.postMessage({ type: 'addTicket', issueKey, x: Math.round(point.x), y: Math.round(point.y) });
      setFeedback('Adding ticket ' + issueKey + '...');
    }

    function requestAddTicketFromDrop(issueKey, dropPoint) {
      const normalizedIssueKey = typeof issueKey === 'string' ? issueKey.trim() : '';
      if (!normalizedIssueKey) {
        setFeedback('Dropped issue key was empty.', true);
        return;
      }
      requestResolveDroppedIssue(normalizedIssueKey, dropPoint);
      setFeedback('Resolving dropped ticket ' + normalizedIssueKey + '...');
    }

    function requestRecommendCanvasFlow() {
      if (recommendFlowButton instanceof HTMLButtonElement) {
        recommendFlowButton.disabled = true;
      }
      setFeedback('Requesting AI recommendation...');
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
      setFeedback('Requesting AI recommendation from current board...');
      vscodeApi.postMessage({ type: 'recommendBoardFlow' });
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

        nodes.push({
          type: 'ticket',
          id: typeof candidate.id === 'string' ? candidate.id : ('board-' + issueKey + '-' + index),
          issueKey,
          summary: typeof candidate.summary === 'string' ? candidate.summary : issueKey,
          issueType: typeof candidate.issueType === 'string' ? candidate.issueType : 'Unknown',
          status: typeof candidate.status === 'string' ? candidate.status : 'Unknown',
          assignee: typeof candidate.assignee === 'string' ? candidate.assignee : undefined,
          priority: typeof candidate.priority === 'string' ? candidate.priority : undefined,
          projectKey: typeof candidate.projectKey === 'string' ? candidate.projectKey : 'UNKNOWN',
          x: 24 + ((index % 4) * 280),
          y: 72 + (Math.floor(index / 4) * 150)
        });
      }
      return nodes;
    }

    function requestApplyRecommendation() {
      if (!state.recommendation) {
        setFeedback('No recommendation to apply yet.', true);
        return;
      }
      uiState.applyingRecommendation = true;
      updateRecommendationActionState();
      vscodeApi.postMessage({
        type: 'applyRecommendation',
        recommendation: state.recommendation,
        nodes: state.recommendationNodes,
        state: {
          nodes: state.nodes.map(node => ({ ...node })),
          connectors: state.connectors.map(connector => ({ ...connector })),
          zoom: uiState.zoom,
          toolbarPosition: { x: uiState.toolbarPosition.x, y: uiState.toolbarPosition.y }
        }
      });
      setFeedback('Applying AI recommendation...');
    }

    function requestGenerateMasterPlan() {
      if (!state.nodes.some(node => node.type === 'ticket')) {
        setFeedback('Add at least one ticket node before generating a master plan.', true);
        return;
      }
      setGeneratingMasterPlan(true);
      setFeedback('Generating master plan artifact...');
      vscodeApi.postMessage({
        type: 'generateMasterPlan',
        state: {
          nodes: state.nodes.map(node => ({ ...node })),
          connectors: state.connectors.map(connector => ({ ...connector })),
          zoom: uiState.zoom,
          toolbarPosition: { x: uiState.toolbarPosition.x, y: uiState.toolbarPosition.y }
        }
      });
    }

    function clearRecommendation() {
      state.recommendation = undefined;
      state.recommendationNodes = [];
      state.recommendationSource = undefined;
      updateRecommendationActionState();
    }

    function rejectRecommendation() {
      clearRecommendation();
      setFeedback('AI recommendation discarded.');
    }

    function findNodeByIssueKey(issueKey) {
      if (typeof issueKey !== 'string' || !issueKey.trim()) {
        return undefined;
      }
      return state.nodes.find(node => node.type === 'ticket' && node.issueKey === issueKey);
    }

    function createLocalTicketNode(issue, x, y) {
      uiState.nextConnectorIndex = Math.max(uiState.nextConnectorIndex, state.connectors.length);
      const nodeIndex = state.nodes.length;
      const issueKey = typeof issue.issueKey === 'string' && issue.issueKey.trim()
        ? issue.issueKey.trim()
        : ('TICKET-' + (nodeIndex + 1));
      return {
        type: 'ticket',
        id: 'ticket-' + issueKey + '-' + nodeIndex,
        issueKey,
        summary: (typeof issue.summary === 'string' && issue.summary.trim()) ? issue.summary.trim() : issueKey,
        issueType: typeof issue.issueType === 'string' ? issue.issueType : 'Unknown',
        status: typeof issue.status === 'string' ? issue.status : 'Unknown',
        assignee: typeof issue.assignee === 'string' ? issue.assignee : undefined,
        priority: typeof issue.priority === 'string' ? issue.priority : undefined,
        projectKey: (typeof issue.projectKey === 'string' && issue.projectKey.trim()) ? issue.projectKey.trim() : 'UNKNOWN',
        x: Math.round(x),
        y: Math.round(y)
      };
    }

    function ensureIssueNode(issue, x, y) {
      const existing = findNodeByIssueKey(issue.issueKey);
      if (existing) {
        return existing;
      }
      const node = createLocalTicketNode(issue, x, y);
      state.nodes.push(node);
      return node;
    }

    function pushConnector(sourceNodeId, targetNodeId) {
      if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
        return;
      }
      if (hasExistingConnector(sourceNodeId, targetNodeId)) {
        return;
      }
      if (wouldCreateCycle(sourceNodeId, targetNodeId)) {
        return;
      }
      state.connectors.push({
        id: createConnectorId(),
        sourceNodeId,
        targetNodeId
      });
    }

    function applyDroppedIssuePayload(payload, dropPoint) {
      if (!payload || typeof payload !== 'object' || !payload.mainIssue || typeof payload.mainIssue.issueKey !== 'string') {
        setFeedback('Unable to add the dropped ticket.', true);
        return;
      }

      const relatedIssues = Array.isArray(payload.relatedIssues)
        ? payload.relatedIssues.filter(issue => issue && typeof issue.issueKey === 'string')
        : [];
      const relations = Array.isArray(payload.relations)
        ? payload.relations.filter(relation => relation && typeof relation.sourceIssueKey === 'string' && typeof relation.targetIssueKey === 'string')
        : [];

      const includeRelated = relatedIssues.length > 0
        ? window.confirm('Add ' + relatedIssues.length + ' related ticket' + (relatedIssues.length === 1 ? '' : 's') + ' and connect them to the dropped ticket?')
        : false;

      const mainNode = ensureIssueNode(payload.mainIssue, dropPoint.x - 125, dropPoint.y - 56);
      uiState.selectedNodeId = mainNode.id;
      uiState.selectedConnectorId = undefined;

      if (includeRelated) {
        let dependencyIndex = 0;
        let childIndex = 0;

        for (const relatedIssue of relatedIssues) {
          const isDependency = relatedIssue.relation === 'dependsOn';
          const slot = isDependency ? dependencyIndex++ : childIndex++;
          const x = isDependency ? (mainNode.x - 320) : (mainNode.x + 320);
          const y = mainNode.y + (slot * 148) - 72;
          ensureIssueNode(relatedIssue, x, y);
        }

        for (const relation of relations) {
          const sourceNode = findNodeByIssueKey(relation.sourceIssueKey);
          const targetNode = findNodeByIssueKey(relation.targetIssueKey);
          if (!sourceNode || !targetNode) {
            continue;
          }
          pushConnector(sourceNode.id, targetNode.id);
        }
      }

      renderNodes();
      persistCanvasState();
      setFeedback(
        includeRelated
          ? 'Dropped ticket added with related tickets and links.'
          : 'Dropped ticket added to the canvas.'
      );
    }

    function requestResolveDroppedIssue(issueKey, dropPoint) {
      vscodeApi.postMessage({
        type: 'resolveDroppedIssue',
        issueKey,
        dropPoint
      });
    }

    function clearCanvas() {
      if (state.nodes.length === 0 && state.connectors.length === 0) {
        setFeedback('Nothing to clear.');
        return;
      }
      state.nodes = [];
      state.connectors = [];
      uiState.selectedNodeId = undefined;
      uiState.selectedConnectorId = undefined;
      clearLinkPreview();
      renderNodes();
      persistCanvasState();
      setFeedback('Canvas cleared.');
    }

    for (const button of document.querySelectorAll('button[data-action]')) {
      button.addEventListener('click', () => {
        const action = button.getAttribute('data-action');
        if (action === 'select') {
          setActiveTool('select');
          return;
        }
        if (action === 'ticket') {
          setTicketEntryOpen(true, { focus: true });
          return;
        }
        if (action === 'note') {
          addNote();
          return;
        }
        if (action === 'website') {
          addWebsitePreview();
          return;
        }
        if (action === 'link') {
          setActiveTool('link');
          setFeedback('Link mode enabled. Drag from a connector handle to another one.');
          return;
        }
        if (action === 'zoomIn') {
          setZoom(uiState.zoom + 0.1);
          return;
        }
        if (action === 'zoomOut') {
          setZoom(uiState.zoom - 0.1);
          return;
        }
        if (action === 'deleteConnector') {
          deleteSelectedConnector();
          return;
        }
        if (action === 'generateMasterPlan') {
          requestGenerateMasterPlan();
          return;
        }
        if (action === 'recommendFlow') {
          requestRecommendCanvasFlow();
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
          rejectRecommendation();
          return;
        }
        if (action === 'reset') {
          clearCanvas();
          return;
        }
      });
    }

    if (ticketAddButton instanceof HTMLElement) {
      ticketAddButton.addEventListener('click', requestAddTicket);
    }
    if (ticketEntryPanel instanceof HTMLFormElement) {
      ticketEntryPanel.addEventListener('submit', event => {
        event.preventDefault();
        requestAddTicket();
      });
    }
    if (ticketEntryCloseButton instanceof HTMLElement) {
      ticketEntryCloseButton.addEventListener('click', () => {
        setTicketEntryOpen(false);
        setFeedback('Ticket add cancelled.');
      });
    }
    if (ticketInput instanceof HTMLInputElement) {
      ticketInput.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setTicketEntryOpen(false);
          setFeedback('Ticket add cancelled.');
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          requestAddTicket();
        }
      });
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || typeof message !== 'object') {
        return;
      }
      if (message.type === 'addTicketResult') {
        if (!message.ok) {
          setFeedback(message.error || 'Unable to add ticket.', true);
          return;
        }
        if (!message.node || typeof message.node !== 'object') {
          setFeedback('Ticket payload was invalid.', true);
          return;
        }

        state.nodes.push(message.node);
        uiState.selectedNodeId = message.node.id;
        uiState.selectedConnectorId = undefined;
        if (ticketInput instanceof HTMLInputElement) {
          ticketInput.value = '';
        }
        setTicketEntryOpen(false);
        renderNodes();
        persistCanvasState();
        setFeedback('Ticket ' + (message.node.issueKey || 'node') + ' added.');
        return;
      }

      if (message.type === 'addNoteResult') {
        if (!message.ok) {
          setFeedback(message.error || 'Unable to add note.', true);
          return;
        }
        if (!message.node || typeof message.node !== 'object') {
          setFeedback('Note payload was invalid.', true);
          return;
        }
        state.nodes.push(message.node);
        uiState.selectedNodeId = message.node.id;
        uiState.selectedConnectorId = undefined;
        renderNodes();
        persistCanvasState();
        setFeedback('Note added.');
        return;
      }

      if (message.type === 'addWebsitePreviewResult') {
        if (!message.ok) {
          setFeedback(message.error || 'Unable to add website preview.', true);
          return;
        }
        if (!message.node || typeof message.node !== 'object') {
          setFeedback('Website preview payload was invalid.', true);
          return;
        }
        state.nodes.push(message.node);
        uiState.selectedNodeId = message.node.id;
        uiState.selectedConnectorId = undefined;
        renderNodes();
        persistCanvasState();
        setFeedback('Website preview added.');
        return;
      }

      if (message.type === 'resolveDroppedIssueResult') {
        if (!message.ok) {
          setFeedback(message.error || 'Unable to resolve dropped issue.', true);
          return;
        }
        applyDroppedIssuePayload(message.payload, message.dropPoint || { x: 200, y: 120 });
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
        state.recommendationNodes = state.nodes
          .filter(node => node.type === 'ticket')
          .map(node => ({ ...node }));
        state.recommendationSource = 'canvas tickets';
        updateRecommendationActionState();
        setFeedback('AI recommendation ready. Use the check or x actions in the toolbar to apply or discard it.');
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
        updateRecommendationActionState();
        setFeedback('AI board recommendation ready. Use the check or x actions in the toolbar to apply or discard it.');
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
          state.nodes = Array.isArray(message.state.nodes)
            ? message.state.nodes.map(node => ({ ...node }))
            : [];
          state.connectors = Array.isArray(message.state.connectors)
            ? message.state.connectors.map(connector => ({ ...connector }))
            : [];
          uiState.nextConnectorIndex = state.connectors.length;
          uiState.selectedNodeId = undefined;
          uiState.selectedConnectorId = undefined;
          clearLinkPreview();
          renderNodes();
        }
        clearRecommendation();
        setFeedback('AI recommendation applied.');
        return;
      }

      if (message.type === 'generateMasterPlanResult') {
        setGeneratingMasterPlan(false);
        if (!message.ok) {
          setFeedback(message.error || 'Unable to generate master plan.', true);
          return;
        }
        const featureCount = typeof message.generatedFeatureCount === 'number' ? message.generatedFeatureCount : 0;
        const storyCount = typeof message.generatedStoryCount === 'number' ? message.generatedStoryCount : 0;
        setFeedback(
          'Master plan generated at ' + (message.outputPath || 'plans/master-plan.md') +
            '. Generated ' + featureCount + ' feature file set(s) and ' + storyCount + ' story file(s).'
        );
        return;
      }

      if (message.type === 'persistCanvasStateResult') {
        if (!message.ok) {
          if (message.state) {
            state.nodes = Array.isArray(message.state.nodes)
              ? message.state.nodes.map(node => ({ ...node }))
              : [];
            state.connectors = Array.isArray(message.state.connectors)
              ? message.state.connectors.map(connector => ({ ...connector }))
              : [];
            uiState.nextConnectorIndex = state.connectors.length;
            uiState.selectedNodeId = undefined;
            uiState.selectedConnectorId = undefined;
            renderNodes();
          }
          setFeedback(message.error || 'Unable to save canvas state.', true);
        }
      }
    });

    canvasToolbarHandle?.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !(canvasToolbar instanceof HTMLElement) || !(canvasSurface instanceof HTMLElement)) {
        return;
      }
      const toolbarRect = canvasToolbar.getBoundingClientRect();
      uiState.toolbarDrag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - toolbarRect.left,
        offsetY: event.clientY - toolbarRect.top
      };
      canvasToolbarHandle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    window.addEventListener('pointermove', event => {
      if (!uiState.toolbarDrag || !(canvasSurface instanceof HTMLElement)) {
        return;
      }
      if (event.pointerId !== uiState.toolbarDrag.pointerId) {
        return;
      }
      const surfaceRect = canvasSurface.getBoundingClientRect();
      uiState.toolbarPosition = {
        x: canvasSurface.scrollLeft + event.clientX - surfaceRect.left - uiState.toolbarDrag.offsetX,
        y: canvasSurface.scrollTop + event.clientY - surfaceRect.top - uiState.toolbarDrag.offsetY
      };
      syncFloatingLayout();
    });

    window.addEventListener('pointerup', event => {
      if (!uiState.toolbarDrag || event.pointerId !== uiState.toolbarDrag.pointerId) {
        return;
      }
      uiState.toolbarDrag = undefined;
      schedulePersistCanvasState();
    });

    canvasSurface.addEventListener('scroll', syncFloatingLayout);
    window.addEventListener('resize', syncFloatingLayout);

    if (canvasSurface instanceof HTMLElement) {
      canvasSurface.addEventListener('dragover', event => {
        const types = event.dataTransfer?.types ?? [];
        const hasIssueData = types.includes('application/x-ticket-manager-issue') || types.includes('text/plain');
        if (!hasIssueData) {
          return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy';
        }
      });

      canvasSurface.addEventListener('drop', event => {
        const issueKey = (event.dataTransfer?.getData('application/x-ticket-manager-issue') || event.dataTransfer?.getData('text/plain') || '').trim();
        if (!issueKey || !(canvasSurface instanceof HTMLElement)) {
          return;
        }
        event.preventDefault();
        const surfaceRect = canvasSurface.getBoundingClientRect();
        requestAddTicketFromDrop(issueKey, {
          x: clientDistanceToCanvas(canvasSurface.scrollLeft + event.clientX - surfaceRect.left),
          y: clientDistanceToCanvas(canvasSurface.scrollTop + event.clientY - surfaceRect.top)
        });
      });
    }

    canvasSurface.addEventListener('mousedown', event => {
      if (event.target === canvasSurface || event.target === nodesLayer || event.target === connectorsLayer) {
        uiState.selectedNodeId = undefined;
        uiState.selectedConnectorId = undefined;
        renderNodes();
      }
    });

    syncToolbarState();
    syncFloatingLayout();
    setTicketEntryOpen(false);
    updateRecommendationActionState();
    renderNodes();
    updateDeleteConnectorState();

    setFeedback(
      state.nodes.length === 0
        ? 'Use ticket, note, or website tools to create components.'
        : state.nodes.length + ' component(s) loaded.'
    );
  </script>
</body>
</html>`;
  }
}
