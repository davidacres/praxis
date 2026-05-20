import * as vscode from 'vscode';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { IssueDetails, IssueSummary } from '../types';
import type {
  TaskDesignerFlowRecommendation,
  TaskDesignerRecommendationConnector,
  TaskDesignerRecommendationNode
} from '../ai/aiReviewService';
import { issueTypeHex } from '../board/issueTypeColors';
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

type LinkHandleDirection = 'top' | 'right' | 'bottom' | 'left';

interface PersistedTaskDesignerState {
  nodes: CanvasNode[];
  connectors: DirectedConnector[];
  zoom: number;
  toolbarPosition: {
    x: number;
    y: number;
  };
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
const DEFAULT_TASK_DESIGNER_TICKET_HEX = '#2563eb';
const DEFAULT_TASK_DESIGNER_WEBSITE_HEX = '#58a6ff';

type RecommendTaskDesignerFlow = (
  nodes: readonly TaskDesignerRecommendationNode[],
  connectors: readonly TaskDesignerRecommendationConnector[]
) => Promise<TaskDesignerFlowRecommendation>;

interface TaskDesignerBoardRecommendationSeed {
  boardName: string;
  issues: readonly IssueSummary[];
}

type ResolveTaskDesignerBoardRecommendationSeed = () => Promise<TaskDesignerBoardRecommendationSeed | undefined>;

type TaskDesignerRelatedIssueRelation = 'dependsOn' | 'subTask';

interface ResolvedDroppedIssueRelation {
  relation: TaskDesignerRelatedIssueRelation;
  sourceIssueKey: string;
  targetIssueKey: string;
}

interface ResolvedDroppedIssuePayload {
  mainIssue: Omit<TicketNode, 'id' | 'x' | 'y' | 'type'>;
  relatedIssues: Array<
    Omit<TicketNode, 'id' | 'x' | 'y' | 'type'> & {
      relation: TaskDesignerRelatedIssueRelation;
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

function asLinkHandleDirection(value: unknown): LinkHandleDirection | undefined {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left'
    ? value
    : undefined;
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
    type: 'ticket',
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
  if (value.type === 'note' || value.type === 'website') {
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
    type: 'ticket',
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

function toNoteNode(value: unknown, fallbackIndex = 0): NoteNode | undefined {
  if (!isRecord(value) || value.type !== 'note') {
    return undefined;
  }

  const x = asNumber(value.x);
  const y = asNumber(value.y);
  const width = asNumber(value.width);
  const height = asNumber(value.height);
  const fallbackColumn = fallbackIndex % 4;
  const fallbackRow = Math.floor(fallbackIndex / 4);

  return {
    type: 'note',
    id: pickFirstString(value.id) ?? `note-${fallbackIndex}`,
    title: pickFirstString(value.title) ?? 'Notes',
    content: pickFirstString(value.content, value.summary) ?? '',
    x: x ?? (24 + (fallbackColumn * 280)),
    y: y ?? (72 + (fallbackRow * 150)),
    width: width ?? 280,
    height: height ?? 190
  };
}

function toWebsitePreviewNode(value: unknown, fallbackIndex = 0): WebsitePreviewNode | undefined {
  if (!isRecord(value) || value.type !== 'website') {
    return undefined;
  }

  const url = pickFirstString(value.url);
  if (!url) {
    return undefined;
  }

  const x = asNumber(value.x);
  const y = asNumber(value.y);
  const width = asNumber(value.width);
  const height = asNumber(value.height);
  const fallbackColumn = fallbackIndex % 4;
  const fallbackRow = Math.floor(fallbackIndex / 4);

  return {
    type: 'website',
    id: pickFirstString(value.id) ?? `website-${fallbackIndex}`,
    url,
    x: x ?? (24 + (fallbackColumn * 300)),
    y: y ?? (72 + (fallbackRow * 210)),
    width: width ?? 360,
    height: height ?? 260
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
    targetNodeId,
    sourceDirection: asLinkHandleDirection(value.sourceDirection),
    targetDirection: asLinkHandleDirection(value.targetDirection)
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

function isTicketNode(node: CanvasNode | undefined): node is TicketNode {
  return Boolean(node && node.type === 'ticket');
}

function isNoteNode(node: CanvasNode | undefined): node is NoteNode {
  return Boolean(node && node.type === 'note');
}

function isCustomCanvasNode(node: CanvasNode | undefined): node is NoteNode | WebsitePreviewNode {
  return Boolean(node && node.type !== 'ticket');
}

function normalizeWebsitePreviewUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
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

function websitePreviewTitle(url: string | undefined): string {
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

function getCanvasNodeTitle(node: CanvasNode | undefined): string {
  if (!node) {
    return 'selected node';
  }
  if (node.type === 'ticket') {
    return node.issueKey;
  }
  if (node.type === 'note') {
    return toSingleLineText(node.title) || 'note';
  }
  return websitePreviewTitle(node.url);
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

function clampColorChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
  const normalized = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!normalized) {
    return undefined;
  }
  const value = normalized[1];
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16)
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${clampColorChannel(r).toString(16).padStart(2, '0')}${clampColorChannel(g).toString(16).padStart(2, '0')}${clampColorChannel(b).toString(16).padStart(2, '0')}`;
}

function shiftHex(hex: string, delta: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return hex;
  }
  return rgbToHex(rgb.r + delta, rgb.g + delta, rgb.b + delta);
}

function taskDesignerTicketHeaderBackground(issueType: string | undefined): string {
  const trimmed = issueType?.trim();
  const base = trimmed ? issueTypeHex(trimmed) : DEFAULT_TASK_DESIGNER_TICKET_HEX;
  return `linear-gradient(135deg, ${shiftHex(base, 18)} 0%, ${shiftHex(base, -14)} 100%)`;
}

function taskDesignerWebsiteHeaderBackground(): string {
  return `linear-gradient(135deg, ${shiftHex(DEFAULT_TASK_DESIGNER_WEBSITE_HEX, 12)} 0%, ${shiftHex(DEFAULT_TASK_DESIGNER_WEBSITE_HEX, -18)} 100%)`;
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
    type: 'ticket',
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

type TaskDesignerToolbarIcon =
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
  | 'confirm'
  | 'dismiss'
  | 'reset';

function renderTaskDesignerToolbarIcon(icon: TaskDesignerToolbarIcon): string {
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

function renderTaskDesignerToolbarButton(
  id: string,
  action: string | undefined,
  label: string,
  icon: TaskDesignerToolbarIcon,
  options?: {
    disabled?: boolean;
    extraClass?: string;
    buttonType?: 'button' | 'submit';
  }
): string {
  const className = ['overlay-icon-button', options?.extraClass].filter(Boolean).join(' ');
  const actionAttribute = action ? ` data-action="${action}"` : '';
  const disabledAttribute = options?.disabled ? ' disabled' : '';
  const buttonType = options?.buttonType ?? 'button';
  return `<button id="${id}" class="${className}" type="${buttonType}" title="${label}" aria-label="${label}"${actionAttribute}${disabledAttribute}>
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${renderTaskDesignerToolbarIcon(icon)}</svg>
  </button>`;
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

  public open(boardName?: string): void {
    const panelTitle = this.buildPanelTitle(boardName);
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }

    const persistedState = this.getPersistedCanvasState();
    const initialState = persistedState.state;
    this.syncNextNodeIndex(initialState.nodes);
    const wasEmpty = initialState.nodes.length === 0;
    if (wasEmpty) {
      const now = new Date();
      const dateStr = now.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      const timeStr = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const traceNote = this.createNoteNode();
      traceNote.title = 'Session Log';
      traceNote.content = `Opened: ${dateStr} at ${timeStr}`;
      initialState.nodes.push(traceNote);
    }
    const nonce = createNonce();
    const panel = vscode.window.createWebviewPanel(
      'ticketManager.taskDesigner',
      panelTitle,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = this.getHtml(nonce, initialState, persistedState.warning, panelTitle);

    this.panel = panel;
    if (persistedState.repaired || wasEmpty) {
      void this.workspaceState.update(TASK_DESIGNER_STATE_KEY, initialState);
    }

    panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      undefined,
      []
    );

    panel.webview.onDidReceiveMessage(
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

    if (type === 'addNote') {
      await this.handleAddNoteMessage(message);
      return;
    }

    if (type === 'addWebsitePreview') {
      await this.handleAddWebsitePreviewMessage(message);
      return;
    }

    if (type === 'persistCanvasState') {
      await this.handlePersistCanvasStateMessage(message);
      return;
    }

    if (type === 'resolveDroppedIssue') {
      await this.handleResolveDroppedIssueMessage(message);
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

  private buildPanelTitle(boardName: string | undefined): string {
    return boardName?.trim() ? `Task Designer - ${boardName.trim()}` : 'Task Designer';
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
    const node = this.createNoteNode();
    if (x !== undefined) {
      node.x = Math.round(x);
    }
    if (y !== undefined) {
      node.y = Math.round(y);
    }
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
    const node = this.createWebsitePreviewNode(url);
    if (x !== undefined) {
      node.x = Math.round(x);
    }
    if (y !== undefined) {
      node.y = Math.round(y);
    }
    await this.panel?.webview.postMessage({
      type: 'addWebsitePreviewResult',
      ok: true,
      node
    });
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

      const relatedIssues: ResolvedDroppedIssuePayload['relatedIssues'] = [];
      const relations: ResolvedDroppedIssueRelation[] = [];
      for (const [relatedIssueKey, relation] of relatedIssueKeys.entries()) {
        try {
          const relatedIssue = await this.backendService.getIssue(relatedIssueKey);
          const normalizedRelatedIssue = normalizeIssuePayload(relatedIssue, relatedIssueKey);
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
          // Skip unresolved related issues but still allow the main drop to succeed.
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
    const ticketNodes = currentState.nodes.filter(isTicketNode);
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

    const nextState: PersistedTaskDesignerState = {
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
    await this.workspaceState.update(TASK_DESIGNER_STATE_KEY, nextState);
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

  private getPersistedCanvasState(): PersistedTaskDesignerRecoveryResult {
    const raw = this.workspaceState.get<unknown>(TASK_DESIGNER_STATE_KEY);
    return normalizePersistedStateWithRecovery(raw);
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

  private createTicketNode(issue: IssueDetails, requestedIssueKey?: string, x?: number, y?: number): TicketNode {
    const index = this.nextNodeIndex;
    this.nextNodeIndex += 1;
    const column = index % 4;
    const row = Math.floor(index / 4);
    const normalizedIssue = normalizeIssuePayload(issue, requestedIssueKey);
    if (!normalizedIssue) {
      throw new Error('Issue details are missing a valid issue key.');
    }

    return {
      type: 'ticket',
      id: `ticket-${normalizedIssue.issueKey}-${index}`,
      issueKey: normalizedIssue.issueKey,
      summary: normalizedIssue.summary,
      issueType: normalizedIssue.issueType,
      status: normalizedIssue.status,
      assignee: normalizedIssue.assignee,
      priority: normalizedIssue.priority,
      projectKey: normalizedIssue.projectKey,
      x: x !== undefined ? Math.round(x) : (24 + (column * 280)),
      y: y !== undefined ? Math.round(y) : (72 + (row * 150))
    };
  }

  private createNoteNode(): NoteNode {
    const index = this.nextNodeIndex;
    this.nextNodeIndex += 1;
    const column = index % 3;
    const row = Math.floor(index / 3);
    return {
      type: 'note',
      id: `note-${index}`,
      title: 'Notes',
      content: '',
      x: 24 + (column * 300),
      y: 72 + (row * 210),
      width: 280,
      height: 190
    };
  }

  private createWebsitePreviewNode(url: string): WebsitePreviewNode {
    const index = this.nextNodeIndex;
    this.nextNodeIndex += 1;
    const column = index % 3;
    const row = Math.floor(index / 3);
    return {
      type: 'website',
      id: `website-${index}`,
      url,
      x: 24 + (column * 320),
      y: 72 + (row * 240),
      width: 360,
      height: 260
    };
  }

  private getHtml(
    nonce: string,
    initialState: PersistedTaskDesignerState,
    initialWarning?: string,
    panelTitle = 'Task Designer'
  ): string {
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
  <title>${panelTitle.replace(/</g, '&lt;')}</title>
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
      height: 100%;
      width: 100%;
    }
    .toolbar-feedback {
      font-size: 12px;
      color: var(--vscode-editor-foreground);
      min-height: 0;
      padding: 10px 14px;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border) 86%, transparent);
      border-radius: 12px;
      background: color-mix(in oklab, var(--vscode-editorWidget-background) 84%, transparent);
      backdrop-filter: blur(12px);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
      opacity: 0;
      transform: translateY(-8px);
      pointer-events: none;
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .toolbar-feedback.error {
      color: var(--vscode-errorForeground);
      border-color: color-mix(in oklab, var(--vscode-errorForeground) 38%, var(--vscode-panel-border));
    }
    .toolbar-feedback.has-message {
      opacity: 1;
      transform: translateY(0);
    }
    .canvas-surface {
      height: 100%;
      background-color: var(--vscode-editor-background);
      background-image: radial-gradient(
        circle,
        var(--vscode-editorIndentGuide-background) 1px,
        transparent 1.5px
      );
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
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border) 88%, transparent);
      border-radius: 22px;
      background: color-mix(in oklab, var(--vscode-editorWidget-background) 86%, transparent);
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
      color: var(--vscode-descriptionForeground);
      cursor: grab;
      touch-action: none;
    }
    .canvas-toolbar-handle:active {
      cursor: grabbing;
    }
    .canvas-toolbar-grip {
      width: 18px;
      height: 4px;
      border-radius: 999px;
      background: color-mix(in oklab, var(--vscode-descriptionForeground) 72%, transparent);
      box-shadow: 0 6px 0 color-mix(in oklab, var(--vscode-descriptionForeground) 48%, transparent);
    }
    .canvas-toolbar-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .canvas-toolbar-separator {
      width: 100%;
      height: 1px;
      background: color-mix(in oklab, var(--vscode-panel-border) 72%, transparent);
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
      color: var(--vscode-icon-foreground, var(--vscode-editor-foreground));
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 140ms ease;
    }
    .overlay-icon-button:hover {
      background: color-mix(in oklab, var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)) 78%, transparent);
      border-color: color-mix(in oklab, var(--vscode-focusBorder) 24%, var(--vscode-panel-border));
      transform: translateY(-1px);
    }
    .overlay-icon-button.is-active {
      background: color-mix(in oklab, var(--vscode-focusBorder) 18%, var(--vscode-editorWidget-background));
      border-color: color-mix(in oklab, var(--vscode-focusBorder) 56%, var(--vscode-panel-border));
      color: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--vscode-focusBorder) 18%, transparent);
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
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .overlay-icon-button--accent:hover {
      background: var(--vscode-button-hoverBackground);
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
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border) 88%, transparent);
      border-radius: 18px;
      background: color-mix(in oklab, var(--vscode-editorWidget-background) 90%, transparent);
      backdrop-filter: blur(14px);
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.22);
    }
    .canvas-ticket-entry.is-open {
      display: flex;
    }
    .canvas-ticket-entry input {
      flex: 1;
      min-width: 0;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
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
    .connector-preview-line {
      fill: none;
      stroke: var(--vscode-focusBorder);
      stroke-width: 2.5;
      stroke-dasharray: 7 6;
      opacity: 0.9;
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
      overflow: hidden;
    }
    .ticket-node.dragging { cursor: grabbing; }
    .ticket-node.is-selected {
      border-color: color-mix(in oklab, var(--vscode-focusBorder) 82%, var(--vscode-panel-border));
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--vscode-focusBorder) 28%, transparent), 0 12px 24px rgba(0, 0, 0, 0.18);
    }
    .ticket-node.linking-source {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .ticket-node.is-resizing {
      cursor: nwse-resize;
    }
    .ticket-node--note,
    .ticket-node--website {
      display: flex;
      flex-direction: column;
    }
    .ticket-node-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin: -10px -10px 8px;
      padding: 6px 10px 5px;
      color: #eff6ff;
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
    .ticket-node-delete svg {
      width: 10px;
      height: 10px;
      display: block;
    }
    .ticket-node-key {
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: inherit;
      opacity: 0.9;
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
    }
    .note-node-title-input::placeholder {
      color: rgba(239, 246, 255, 0.78);
    }
    .ticket-node-handle {
      --handle-transform: translate(-50%, -50%);
      position: absolute;
      width: 14px;
      height: 14px;
      padding: 0;
      border: 2px solid var(--vscode-focusBorder);
      border-radius: 999px;
      background: var(--vscode-editorWidget-background);
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--vscode-panel-border) 72%, transparent);
      opacity: 0;
      pointer-events: none;
      z-index: 3;
      cursor: crosshair;
      transform: var(--handle-transform) scale(0.72);
      transition: opacity 120ms ease, transform 120ms ease, background 120ms ease, box-shadow 120ms ease;
    }
    .ticket-node-handle--top {
      top: 0;
      left: 50%;
      --handle-transform: translate(-50%, -50%);
    }
    .ticket-node-handle--right {
      top: 50%;
      right: 0;
      --handle-transform: translate(50%, -50%);
    }
    .ticket-node-handle--bottom {
      bottom: 0;
      left: 50%;
      --handle-transform: translate(-50%, 50%);
    }
    .ticket-node-handle--left {
      top: 50%;
      left: 0;
      --handle-transform: translate(-50%, -50%);
    }
    .ticket-node.is-selected .ticket-node-handle,
    .ticket-node.is-link-target .ticket-node-handle {
      opacity: 1;
      pointer-events: auto;
      transform: var(--handle-transform) scale(1);
    }
    .ticket-node-handle:hover {
      background: var(--vscode-focusBorder);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--vscode-focusBorder) 24%, transparent);
    }
    .ticket-node-summary {
      margin-top: 6px;
      font-weight: 600;
      line-height: 1.35;
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
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border) 82%, transparent);
      border-radius: 8px;
      background: color-mix(in oklab, var(--vscode-editor-background) 92%, transparent);
      color: var(--vscode-editor-foreground);
      padding: 10px 11px;
      font: inherit;
      line-height: 1.45;
      outline: none;
      box-sizing: border-box;
    }
    .note-node-textarea:focus {
      border-color: color-mix(in oklab, var(--vscode-focusBorder) 72%, var(--vscode-panel-border));
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--vscode-focusBorder) 18%, transparent);
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
      border-right: 2px solid color-mix(in oklab, var(--vscode-descriptionForeground) 86%, transparent);
      border-bottom: 2px solid color-mix(in oklab, var(--vscode-descriptionForeground) 86%, transparent);
      border-bottom-right-radius: 2px;
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
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border) 82%, transparent);
      border-radius: 8px;
      background: color-mix(in oklab, var(--vscode-editor-background) 92%, transparent);
      color: var(--vscode-input-foreground);
      padding: 8px 10px;
      font: inherit;
      outline: none;
    }
    .website-node-url-input:focus {
      border-color: color-mix(in oklab, var(--vscode-focusBorder) 72%, var(--vscode-panel-border));
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--vscode-focusBorder) 18%, transparent);
    }
    .website-node-frame-wrap {
      position: relative;
      flex: 1;
      min-height: 120px;
      border: 1px solid color-mix(in oklab, var(--vscode-panel-border) 82%, transparent);
      border-radius: 8px;
      overflow: hidden;
      background: color-mix(in oklab, var(--vscode-editor-background) 96%, transparent);
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
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.45;
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
      left: 88px;
      padding: 8px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
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
    @media (max-width: 960px) {
      .canvas-ticket-entry {
        width: min(300px, calc(100% - 128px));
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <main class="canvas-surface" aria-label="Task Designer canvas">
      <div class="canvas-toolbar" aria-label="Task Designer tools">
        <div id="canvas-toolbar-handle" class="canvas-toolbar-handle" title="Drag toolbar" aria-label="Drag toolbar">
          <span class="canvas-toolbar-grip" aria-hidden="true"></span>
        </div>
        <div class="canvas-toolbar-group">
          ${renderTaskDesignerToolbarButton('toolbar-select-button', 'select', 'Select', 'select')}
          ${renderTaskDesignerToolbarButton('toolbar-ticket-button', 'ticket', 'Add ticket', 'ticket')}
          ${renderTaskDesignerToolbarButton('toolbar-note-button', 'note', 'Add note', 'note')}
          ${renderTaskDesignerToolbarButton('toolbar-website-button', 'website', 'Add website preview', 'website')}
          ${renderTaskDesignerToolbarButton('toolbar-link-button', 'link', 'Link tickets', 'link')}
          ${renderTaskDesignerToolbarButton('toolbar-zoom-in-button', 'zoomIn', 'Zoom in', 'zoomIn')}
          ${renderTaskDesignerToolbarButton('toolbar-zoom-out-button', 'zoomOut', 'Zoom out', 'zoomOut')}
        </div>
        <div class="canvas-toolbar-separator"></div>
        <div class="canvas-toolbar-group">
          ${renderTaskDesignerToolbarButton('delete-connector-button', 'deleteConnector', 'Delete selected link', 'deleteConnector', { disabled: true })}
          ${renderTaskDesignerToolbarButton('generate-master-plan-button', 'generateMasterPlan', 'Generate master plan', 'generateMasterPlan')}
          ${renderTaskDesignerToolbarButton('recommend-flow-button', 'recommendFlow', 'AI recommend flow', 'recommendFlow')}
          ${renderTaskDesignerToolbarButton('recommend-board-flow-button', 'recommendBoardFlow', 'AI recommend from board', 'recommendBoardFlow')}
          ${renderTaskDesignerToolbarButton('apply-recommendation-button', 'applyRecommendation', 'Apply AI recommendation', 'confirm', { disabled: true, extraClass: 'is-hidden' })}
          ${renderTaskDesignerToolbarButton('reject-recommendation-button', 'rejectRecommendation', 'Discard AI recommendation', 'dismiss', { disabled: true, extraClass: 'is-hidden' })}
        </div>
        <div class="canvas-toolbar-separator"></div>
        <div class="canvas-toolbar-group">
          ${renderTaskDesignerToolbarButton('toolbar-reset-button', 'reset', 'Clear canvas', 'reset')}
        </div>
      </div>
      <form id="ticket-entry-panel" class="canvas-ticket-entry" autocomplete="off">
        <label class="sr-only" for="ticket-key-input">Ticket number</label>
        <input id="ticket-key-input" type="text" placeholder="Ticket number (e.g. APP-123)" aria-label="Ticket number" />
        ${renderTaskDesignerToolbarButton('ticket-add-button', undefined, 'Confirm add ticket', 'confirm', { extraClass: 'overlay-icon-button--accent' })}
        ${renderTaskDesignerToolbarButton('ticket-entry-close-button', undefined, 'Close ticket entry', 'dismiss')}
      </form>
      <div class="feedback-overlay">
        <div id="toolbar-feedback" class="toolbar-feedback" aria-live="polite"></div>
      </div>
      <svg id="connectors-layer" class="connectors-layer" aria-hidden="true">
        <defs>
          <marker id="task-designer-arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <polygon points="0 0, 8 3, 0 6" fill="var(--vscode-descriptionForeground)"></polygon>
          </marker>
          <marker id="task-designer-arrowhead-selected" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <polygon points="0 0, 8 3, 0 6" fill="var(--vscode-focusBorder)"></polygon>
          </marker>
          <marker id="task-designer-arrowhead-preview" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <polygon points="0 0, 8 3, 0 6" fill="var(--vscode-focusBorder)"></polygon>
          </marker>
        </defs>
      </svg>
      <div id="nodes-layer" class="nodes-layer"></div>
      <div class="surface-hint">Add tickets or notes to create nodes on the canvas.</div>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const ticketInput = document.getElementById('ticket-key-input');
    const ticketEntryPanel = document.getElementById('ticket-entry-panel');
    const ticketAddButton = document.getElementById('ticket-add-button');
    const ticketEntryCloseButton = document.getElementById('ticket-entry-close-button');
    const canvasToolbar = document.querySelector('.canvas-toolbar');
    const canvasToolbarHandle = document.getElementById('canvas-toolbar-handle');
    const deleteConnectorButton = document.getElementById('delete-connector-button');
    const generateMasterPlanButton = document.getElementById('generate-master-plan-button');
    const recommendFlowButton = document.getElementById('recommend-flow-button');
    const recommendBoardFlowButton = document.getElementById('recommend-board-flow-button');
    const applyRecommendationButton = document.getElementById('apply-recommendation-button');
    const rejectRecommendationButton = document.getElementById('reject-recommendation-button');
    const resetCanvasButton = document.getElementById('toolbar-reset-button');
    const feedback = document.getElementById('toolbar-feedback');
    const connectorsLayer = document.getElementById('connectors-layer');
    const nodesLayer = document.getElementById('nodes-layer');
    const canvasSurface = document.querySelector('.canvas-surface');
    const surfaceHint = document.querySelector('.surface-hint');
    const initialState = ${initialStateLiteral};
    const initialWarning = ${initialWarningLiteral};

    // Keep these helpers in webview script scope. They are used by renderNodes at runtime,
    // and host-scope TypeScript helpers are not callable from the browser context.

    const KNOWN_ISSUE_TYPE_HEX = {
      bug: '#e5534b',
      story: '#3fb950',
      task: '#58a6ff',
      epic: '#a371f7',
      feature: '#3fbccd',
      idea: '#f59e0b',
      subtask: '#8b949e',
      'sub-task': '#8b949e',
      improvement: '#79c0ff',
      spike: '#d29922'
    };
    const ISSUE_TYPE_FALLBACK_HEX = ['#58a6ff', '#a371f7', '#3fbccd', '#d29922', '#79c0ff', '#ff7b72', '#56d364', '#db61a2'];

    function clampColorChannel(value) {
      return Math.max(0, Math.min(255, Math.round(value)));
    }

    function hexToRgb(hex) {
      const normalized = /^#?([\da-f]{6})$/i.exec((hex || '').trim());
      if (!normalized) {
        return undefined;
      }
      const value = normalized[1];
      return {
        r: Number.parseInt(value.slice(0, 2), 16),
        g: Number.parseInt(value.slice(2, 4), 16),
        b: Number.parseInt(value.slice(4, 6), 16)
      };
    }

    function rgbToHex(r, g, b) {
      return '#' +
        clampColorChannel(r).toString(16).padStart(2, '0') +
        clampColorChannel(g).toString(16).padStart(2, '0') +
        clampColorChannel(b).toString(16).padStart(2, '0');
    }

    function shiftHex(hex, delta) {
      const rgb = hexToRgb(hex);
      if (!rgb) {
        return hex;
      }
      return rgbToHex(rgb.r + delta, rgb.g + delta, rgb.b + delta);
    }

    function hashPickIssueTypeHex(label) {
      let hash = 0;
      for (let index = 0; index < label.length; index += 1) {
        hash = (hash * 31 + label.charCodeAt(index)) >>> 0;
      }
      return ISSUE_TYPE_FALLBACK_HEX[hash % ISSUE_TYPE_FALLBACK_HEX.length];
    }

    function issueTypeHex(issueType) {
      const raw = typeof issueType === 'string' ? issueType : '';
      const key = raw.trim().toLowerCase();
      if (!key) {
        return '#2563eb';
      }
      return KNOWN_ISSUE_TYPE_HEX[key] || hashPickIssueTypeHex(raw);
    }

    function taskDesignerTicketHeaderBackground(issueType) {
      const base = issueTypeHex(issueType);
      return 'linear-gradient(135deg, ' + shiftHex(base, 18) + ' 0%, ' + shiftHex(base, -14) + ' 100%)';
    }

    function taskDesignerWebsiteHeaderBackground() {
      const base = '#58a6ff';
      return 'linear-gradient(135deg, ' + shiftHex(base, 12) + ' 0%, ' + shiftHex(base, -18) + ' 100%)';
    }

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
      selectedNodeId: undefined,
      selectedConnectorId: undefined,
      nextConnectorIndex: 0,
      applyingRecommendation: false,
      generatingMasterPlan: false,
      ticketEntryOpen: false,
      toolbarPosition: initialState.toolbarPosition && typeof initialState.toolbarPosition.x === 'number' && typeof initialState.toolbarPosition.y === 'number'
        ? { x: initialState.toolbarPosition.x, y: initialState.toolbarPosition.y }
        : { x: 16, y: 16 },
      zoom: typeof initialState.zoom === 'number' ? initialState.zoom : 1,
      linkPreview: undefined,
      hoveredLinkNodeId: undefined,
      persistCanvasStateTimer: undefined,
      feedbackDismissTimer: undefined,
      toolbarDrag: undefined
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
      if (!(feedback instanceof HTMLElement)) {
        return;
      }
      if (uiState.feedbackDismissTimer) {
        window.clearTimeout(uiState.feedbackDismissTimer);
        uiState.feedbackDismissTimer = undefined;
      }
      feedback.textContent = text || '';
      feedback.classList.toggle('error', Boolean(isError));
      feedback.classList.toggle('has-message', Boolean(text));
      if (text) {
        const dismissMs = Boolean(isError) ? 7000 : 4000;
        uiState.feedbackDismissTimer = window.setTimeout(() => {
          uiState.feedbackDismissTimer = undefined;
          feedback.textContent = '';
          feedback.classList.remove('error');
          feedback.classList.remove('has-message');
        }, dismissMs);
      }
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
    }

    function isLinkHandleDirection(value) {
      return value === 'top' || value === 'right' || value === 'bottom' || value === 'left';
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

    function syncNodeInteractionClasses() {
      for (const element of nodesLayer.querySelectorAll('.ticket-node[data-node-id]')) {
        if (!(element instanceof HTMLElement)) {
          continue;
        }
        const nodeId = element.dataset.nodeId;
        element.classList.toggle('is-selected', Boolean(nodeId && nodeId === uiState.selectedNodeId));
        element.classList.toggle('linking-source', Boolean(nodeId && nodeId === uiState.linkSourceNodeId));
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

    function syncToolbarState() {
      for (const button of document.querySelectorAll('button[data-action]')) {
        const action = button.getAttribute('data-action');
        const isActive =
          action === uiState.activeTool ||
          (action === 'ticket' && uiState.ticketEntryOpen);
        button.classList.toggle('is-active', Boolean(isActive));
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
        window.requestAnimationFrame(() => ticketInput.focus());
      }
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

    function persistCanvasState() {
      vscodeApi.postMessage({
        type: 'persistCanvasState',
        state: {
          nodes: state.nodes.map(node => ({ ...node })),
          connectors: state.connectors.map(connector => ({ ...connector })),
          zoom: uiState.zoom,
          toolbarPosition: {
            x: uiState.toolbarPosition.x,
            y: uiState.toolbarPosition.y
          }
        }
      });
    }

    function schedulePersistCanvasState() {
      if (uiState.persistCanvasStateTimer) {
        window.clearTimeout(uiState.persistCanvasStateTimer);
      }
      uiState.persistCanvasStateTimer = window.setTimeout(() => {
        uiState.persistCanvasStateTimer = undefined;
        persistCanvasState();
      }, 160);
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
      return node.issueKey || 'selected node';
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

    function clearCanvas() {
      if (state.nodes.length === 0 && state.connectors.length === 0) {
        setFeedback('Canvas is already empty.', false);
        return;
      }
      if (!window.confirm('Clear the canvas? This will remove all nodes and connections.')) {
        return;
      }
      state.nodes = [];
      state.connectors = [];
      uiState.selectedNodeId = undefined;
      uiState.selectedConnectorId = undefined;
      uiState.linkSourceNodeId = undefined;
      clearRecommendation();
      setActiveTool('select');
      renderNodes();
      persistCanvasState();
      setFeedback('Canvas cleared.', false);
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
          type: 'ticket',
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
        applyRecommendationButton.classList.toggle('is-hidden', !hasRecommendation && !isApplying);
        applyRecommendationButton.disabled = !hasRecommendation || isApplying;
      }
      if (rejectRecommendationButton instanceof HTMLButtonElement) {
        rejectRecommendationButton.classList.toggle('is-hidden', !hasRecommendation && !isApplying);
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
        nodes: recommendationNodes,
        state: {
          nodes: state.nodes.map(node => ({ ...node })),
          connectors: state.connectors.map(connector => ({ ...connector }))
        }
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
      updateRecommendationActionState();
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

    function findNodeByIssueKey(issueKey) {
      return state.nodes.find(node => node.type === 'ticket' && node.issueKey === issueKey);
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
      if (deleteConnectorButton instanceof HTMLButtonElement) {
        deleteConnectorButton.disabled = !hasSelection;
      }
    }

    function setActiveTool(tool) {
      uiState.activeTool = tool;
      if (tool !== 'link') {
        clearLinkPreview();
      }
      syncToolbarState();
    }

    function createConnectorId() {
      const id = 'connector-' + uiState.nextConnectorIndex;
      uiState.nextConnectorIndex += 1;
      return id;
    }

    function pushConnector(sourceNodeId, targetNodeId, sourceDirection, targetDirection) {
      if (sourceNodeId === targetNodeId) {
        return false;
      }
      if (hasExistingConnector(sourceNodeId, targetNodeId)) {
        return false;
      }
      if (wouldCreateCycle(sourceNodeId, targetNodeId)) {
        return false;
      }
      state.connectors.push({
        id: createConnectorId(),
        sourceNodeId,
        targetNodeId,
        sourceDirection,
        targetDirection
      });
      return true;
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
    }

    function createConnectorBetweenNodes(sourceNodeId, targetNodeId, sourceDirection, targetDirection) {
      if (sourceNodeId === targetNodeId) {
        setFeedback('Select a different target node.', true);
        return false;
      }

      if (hasExistingConnector(sourceNodeId, targetNodeId)) {
        const sourceNode = findNodeById(sourceNodeId);
        const targetNode = findNodeById(targetNodeId);
        const sourceLabel = getNodeLabel(sourceNode);
        const targetLabel = getNodeLabel(targetNode);
        setFeedback('Link already exists from ' + sourceLabel + ' to ' + targetLabel + '.', true);
        return false;
      }

      if (wouldCreateCycle(sourceNodeId, targetNodeId)) {
        const sourceNode = findNodeById(sourceNodeId);
        const targetNode = findNodeById(targetNodeId);
        const sourceLabel = getNodeLabel(sourceNode);
        const targetLabel = getNodeLabel(targetNode);
        setFeedback('Cannot create link from ' + sourceLabel + ' to ' + targetLabel + ': it introduces a cycle.', true);
        return false;
      }

      pushConnector(sourceNodeId, targetNodeId, sourceDirection, targetDirection);
      clearRecommendation();
      uiState.selectedConnectorId = state.connectors[state.connectors.length - 1] ? state.connectors[state.connectors.length - 1].id : undefined;
      uiState.selectedNodeId = targetNodeId;
      clearLinkPreview();
      renderNodes();
      persistCanvasState();
      setFeedback('Directed link created.', false);
      updateDeleteConnectorState();
      return true;
    }

    function nodeElementById(nodeId) {
      for (const element of nodesLayer.querySelectorAll('.ticket-node[data-node-id]')) {
        if (element instanceof HTMLElement && element.dataset.nodeId === nodeId) {
          return element;
        }
      }
      return undefined;
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
        const directions = resolveConnectorDirections(
          sourceRect,
          targetRect,
          connector.sourceDirection,
          connector.targetDirection
        );
        const sourcePoint = getAnchorPointFromRect(sourceRect, nodeLayerRect, directions.sourceDirection);
        const targetPoint = getAnchorPointFromRect(targetRect, nodeLayerRect, directions.targetDirection);
        const x1 = sourcePoint.x;
        const y1 = sourcePoint.y;
        const x2 = targetPoint.x;
        const y2 = targetPoint.y;
        const pathData = buildConnectorCurvePath(x1, y1, x2, y2, directions.sourceDirection, directions.targetDirection);

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'connector-group' + (uiState.selectedConnectorId === connector.id ? ' is-selected' : ''));
        group.dataset.connectorId = connector.id;

        const visibleLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        visibleLine.setAttribute('class', 'connector-line');
        visibleLine.setAttribute('d', pathData);
        visibleLine.setAttribute(
          'marker-end',
          uiState.selectedConnectorId === connector.id
            ? 'url(#task-designer-arrowhead-selected)'
            : 'url(#task-designer-arrowhead)'
        );

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
        previewLine.setAttribute('marker-end', 'url(#task-designer-arrowhead-preview)');
        connectorsLayer.append(previewLine);
      }
      updateDeleteConnectorState();
    }

    function renderNodes() {
      if (!(nodesLayer instanceof HTMLElement) || !(canvasSurface instanceof HTMLElement)) {
        return;
      }
      console.log('[TaskDesigner] renderNodes begin', { stateNodeCount: state.nodes.length, lastNode: state.nodes[state.nodes.length - 1], nodesLayerExists: nodesLayer instanceof HTMLElement, zoom: uiState.zoom });
      nodesLayer.textContent = '';
      if (surfaceHint) {
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
        root.classList.toggle('linking-source', uiState.linkSourceNodeId === node.id);
        root.classList.toggle('is-selected', uiState.selectedNodeId === node.id);
        root.classList.toggle('is-link-target', uiState.hoveredLinkNodeId === node.id);

        const header = document.createElement('div');
        header.className = 'ticket-node-header ticket-node-header--' + node.type;
        if (node.type === 'ticket') {
          header.style.background = taskDesignerTicketHeaderBackground(node.issueType);
        } else if (node.type === 'website') {
          header.style.background = taskDesignerWebsiteHeaderBackground();
        }

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
        deleteButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.5 4.5 11.5 11.5M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        deleteButton.setAttribute('aria-label', 'Delete ' + getNodeLabel(node) + ' node');
        deleteButton.addEventListener('pointerdown', event => {
          event.preventDefault();
          event.stopPropagation();
        });
        deleteButton.addEventListener('click', event => {
          event.stopPropagation();
          state.nodes = state.nodes.filter(item => item.id !== node.id);
          state.connectors = state.connectors.filter(connector =>
            connector.sourceNodeId !== node.id && connector.targetNodeId !== node.id
          );
          if (uiState.linkSourceNodeId === node.id) {
            clearLinkPreview();
          }
          if (uiState.selectedNodeId === node.id) {
            uiState.selectedNodeId = undefined;
          }
          if (uiState.selectedConnectorId && !state.connectors.some(connector => connector.id === uiState.selectedConnectorId)) {
            uiState.selectedConnectorId = undefined;
          }
          clearRecommendation();
          renderNodes();
          persistCanvasState();
          setFeedback((node.type === 'note' ? 'Note' : (node.type === 'website' ? 'Website preview' : 'Ticket node')) + ' deleted.', false);
        });
        header.append(titleWrap, deleteButton);

        let resizeHandle = null;
        if (node.type === 'note') {
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
        } else if (node.type === 'website') {
          const body = document.createElement('div');
          body.className = 'website-node-body';

          const urlInput = document.createElement('input');
          urlInput.type = 'url';
          urlInput.className = 'website-node-url-input';
          urlInput.value = node.url || '';
          urlInput.placeholder = 'https://example.com';
          urlInput.setAttribute('aria-label', 'Website preview URL');
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
        } else {
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
        }

        for (const direction of ['top', 'right', 'bottom', 'left']) {
          const handle = document.createElement('button');
          handle.type = 'button';
          handle.className = 'ticket-node-handle ticket-node-handle--' + direction;
          handle.dataset.nodeId = node.id;
          handle.dataset.direction = direction;
          handle.setAttribute('aria-label', 'Create link from ' + getNodeLabel(node) + ' ' + direction + ' connector');
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
            setFeedback('Drag to a connector on another component to create a link.', false);
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
              renderConnectors();
              setFeedback('Link cancelled. Drop on a connector to create a link.', false);
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
            renderConnectors();
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

        root.addEventListener('click', event => {
          if (event.target instanceof HTMLElement && event.target.closest('button')) {
            return;
          }
          if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
            return;
          }
          uiState.selectedNodeId = node.id;
          uiState.selectedConnectorId = undefined;
          if (uiState.activeTool === 'link') {
            setFeedback('Drag from a connector on the selected component to another component connector.', false);
          }
          renderNodes();
        });

        nodesLayer.append(root);
      }
      if (connectorsLayer instanceof SVGElement) {
        connectorsLayer.setAttribute('width', String(clientDistanceToCanvas(canvasSurface.scrollWidth)));
        connectorsLayer.setAttribute('height', String(clientDistanceToCanvas(canvasSurface.scrollHeight)));
      }
      const renderedEls = nodesLayer.querySelectorAll('.ticket-node');
      const lastEl = renderedEls[renderedEls.length - 1];
      const lastRect = lastEl instanceof HTMLElement ? lastEl.getBoundingClientRect() : null;
      const nodesLayerRect = nodesLayer instanceof HTMLElement ? nodesLayer.getBoundingClientRect() : null;
      console.log('[TaskDesigner] renderNodes end', { renderedElementCount: renderedEls.length, lastElementRect: lastRect && { x: lastRect.x, y: lastRect.y, w: lastRect.width, h: lastRect.height }, nodesLayerRect: nodesLayerRect && { x: nodesLayerRect.x, y: nodesLayerRect.y, w: nodesLayerRect.width, h: nodesLayerRect.height }, nodesLayerTransform: nodesLayer instanceof HTMLElement ? nodesLayer.style.transform : null });
      pruneDanglingConnectors();
      renderConnectors();
      updateDeleteConnectorState();
      syncFloatingLayout();
    }

    function createLocalTicketNode(issue, x, y) {
      return {
        type: 'ticket',
        id: 'ticket-' + issue.issueKey + '-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
        issueKey: issue.issueKey,
        summary: issue.summary || issue.issueKey,
        issueType: issue.issueType || 'Unknown',
        status: issue.status || 'Unknown',
        assignee: issue.assignee,
        priority: issue.priority,
        projectKey: issue.projectKey || 'UNKNOWN',
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

      clearRecommendation();
      renderNodes();
      persistCanvasState();
      setFeedback(
        includeRelated
          ? 'Dropped ticket added with related tickets and links.'
          : 'Dropped ticket added to the designer.',
        false
      );
    }

    function requestResolveDroppedIssue(issueKey, dropPoint) {
      vscodeApi.postMessage({
        type: 'resolveDroppedIssue',
        issueKey,
        dropPoint
      });
    }

    function requestAddTicket() {
      const issueKey = ticketInput instanceof HTMLInputElement ? ticketInput.value.trim() : '';
      if (!issueKey) {
        setFeedback('Enter a ticket number before adding.', true);
        setTicketEntryOpen(true, { focus: true });
        return;
      }
      if (!(canvasSurface instanceof HTMLElement)) {
        console.warn('[TaskDesigner] requestAddTicket aborted: canvasSurface is not HTMLElement', canvasSurface);
        return;
      }
      const point = visibleCanvasPoint(Math.min(180, Math.max(96, canvasSurface.clientWidth / 3)), 96);
      console.log('[TaskDesigner] requestAddTicket', { issueKey, point, zoom: uiState.zoom, surface: { clientWidth: canvasSurface.clientWidth, clientHeight: canvasSurface.clientHeight, scrollLeft: canvasSurface.scrollLeft, scrollTop: canvasSurface.scrollTop } });
      vscodeApi.postMessage({ type: 'addTicket', issueKey, x: point.x, y: point.y });
    }

    function revealNode(nodeId) {
      window.requestAnimationFrame(() => {
        const element = nodeElementById(nodeId);
        if (element instanceof HTMLElement) {
          element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      });
    }

    function requestAddNote(options) {
      if (!(canvasSurface instanceof HTMLElement)) {
        setFeedback('Unable to add note: canvas surface not ready.', true);
        console.warn('[TaskDesigner] requestAddNote aborted: canvasSurface is not HTMLElement', canvasSurface);
        return;
      }
      const point = visibleCanvasPoint(Math.min(180, Math.max(96, canvasSurface.clientWidth / 3)), 96);
      console.log('[TaskDesigner] requestAddNote', { point, zoom: uiState.zoom, surface: { clientWidth: canvasSurface.clientWidth, clientHeight: canvasSurface.clientHeight } });
      const noteId = (options && options.id) || ('note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
      const node = {
        type: 'note',
        id: noteId,
        title: (options && typeof options.title === 'string') ? options.title : 'Notes',
        content: (options && typeof options.content === 'string') ? options.content : '',
        x: Math.round((options && typeof options.x === 'number') ? options.x : point.x),
        y: Math.round((options && typeof options.y === 'number') ? options.y : point.y),
        width: 280,
        height: 190
      };
      state.nodes.push(node);
      uiState.selectedNodeId = node.id;
      uiState.selectedConnectorId = undefined;
      clearRecommendation();
      renderNodes();
      persistCanvasState();
      revealNode(node.id);
      setFeedback('Note added.', false);
    }

    function requestAddWebsitePreview() {
      if (!(canvasSurface instanceof HTMLElement)) {
        return;
      }
      const rawUrl = window.prompt('Enter a website URL for the preview component', 'https://');
      if (rawUrl === null) {
        return;
      }
      const normalized = normalizeWebsitePreviewUrl(rawUrl);
      if (!normalized) {
        setFeedback('Enter a valid http or https URL for the website preview.', true);
        return;
      }
      const point = visibleCanvasPoint(Math.min(180, Math.max(96, canvasSurface.clientWidth / 3)), 96);
      console.log('[TaskDesigner] requestAddWebsitePreview', { url: normalized, point, zoom: uiState.zoom });
      vscodeApi.postMessage({ type: 'addWebsitePreview', url: normalized, x: point.x, y: point.y });
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
      });
    }
    if (ticketInput instanceof HTMLInputElement) {
      ticketInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          requestAddTicket();
        }
      });
    }

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
      schedulePersistCanvasState();
    });

    window.addEventListener('pointerup', event => {
      if (!uiState.toolbarDrag || event.pointerId !== uiState.toolbarDrag.pointerId) {
        return;
      }
      uiState.toolbarDrag = undefined;
    });

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
        requestResolveDroppedIssue(issueKey, {
          x: clientDistanceToCanvas(canvasSurface.scrollLeft + event.clientX - surfaceRect.left),
          y: clientDistanceToCanvas(canvasSurface.scrollTop + event.clientY - surfaceRect.top)
        });
      });

      canvasSurface.addEventListener('scroll', syncFloatingLayout);
    }
    window.addEventListener('resize', syncFloatingLayout);

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message) {
        return;
      }

      if (message.type === 'addTicketResult') {
        console.log('[TaskDesigner] addTicketResult received', { ok: message.ok, error: message.error, node: message.node });
        if (!message.ok) {
          setFeedback(message.error || 'Unable to add ticket.', true);
          return;
        }

        if (!message.node) {
          setFeedback('Ticket details were loaded, but no designer node was returned.', true);
          return;
        }
        state.nodes.push(message.node);
        uiState.selectedNodeId = message.node.id;
        uiState.selectedConnectorId = undefined;
        clearRecommendation();
        renderNodes();
        persistCanvasState();
        revealNode(message.node.id);
        setFeedback('Ticket node added.', false);
        if (ticketInput instanceof HTMLInputElement) {
          ticketInput.value = '';
        }
        setTicketEntryOpen(false);
        return;
      }

      if (message.type === 'addNoteResult') {
        console.log('[TaskDesigner] addNoteResult received', { ok: message.ok, error: message.error, node: message.node });
        if (!message.ok) {
          setFeedback(message.error || 'Unable to add note.', true);
          return;
        }
        if (!message.node) {
          setFeedback('Note was created but no node data was returned.', true);
          return;
        }
        state.nodes.push(message.node);
        uiState.selectedNodeId = message.node.id;
        uiState.selectedConnectorId = undefined;
        clearRecommendation();
        renderNodes();
        persistCanvasState();
        revealNode(message.node.id);
        setFeedback('Note added.', false);
        return;
      }

      if (message.type === 'addWebsitePreviewResult') {
        console.log('[TaskDesigner] addWebsitePreviewResult received', { ok: message.ok, error: message.error, node: message.node });
        if (!message.ok) {
          setFeedback(message.error || 'Unable to add website preview.', true);
          return;
        }

        if (message.node) {
          state.nodes.push(message.node);
          uiState.selectedNodeId = message.node.id;
          uiState.selectedConnectorId = undefined;
          renderNodes();
          persistCanvasState();
          setFeedback('Website preview added.', false);
        }
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

      if (message.type === 'persistCanvasStateResult') {
        console.log('[TaskDesigner] persistCanvasStateResult', { ok: message.ok, error: message.error, stateNodeCount: message.state && Array.isArray(message.state.nodes) ? message.state.nodes.length : undefined });
        if (!message.ok) {
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
        }
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
        updateRecommendationActionState();
        setFeedback('AI recommendation ready. Use the check or x actions in the toolbar to apply or discard it.', false);
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
        setFeedback('AI board recommendation ready. Use the check or x actions in the toolbar to apply or discard it.', false);
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
          setTicketEntryOpen(true, { focus: true });
          return;
        }
        if (action === 'note') {
          setTicketEntryOpen(false);
          requestAddNote();
          return;
        }
        if (action === 'website') {
          setTicketEntryOpen(false);
          requestAddWebsitePreview();
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
        if (action === 'select' || action === 'link') {
          setTicketEntryOpen(false);
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
        if (action === 'reset') {
          clearCanvas();
          return;
        }
        vscodeApi.postMessage({ type: 'toolbarAction', action });
      });
    }

    if (resetCanvasButton instanceof HTMLButtonElement) {
      resetCanvasButton.addEventListener('click', event => {
        event.preventDefault();
        clearCanvas();
      });
    }

    canvasSurface.addEventListener('click', event => {
      if (event.target !== canvasSurface && event.target !== connectorsLayer) {
        return;
      }
      if (uiState.ticketEntryOpen) {
        setTicketEntryOpen(false);
      }
      if (uiState.selectedConnectorId) {
        uiState.selectedConnectorId = undefined;
        renderConnectors();
      }
    });

    window.addEventListener('keydown', event => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        if (event.key === 'Escape' && uiState.ticketEntryOpen) {
          setTicketEntryOpen(false);
        }
        return;
      }
      if (event.key === 'Delete' && uiState.selectedConnectorId) {
        event.preventDefault();
        deleteSelectedConnector();
        return;
      }
      if (event.key === 'Escape' && uiState.ticketEntryOpen) {
        setTicketEntryOpen(false);
      }
    });

    syncNextConnectorIndex();
    pruneDanglingConnectors();
    setActiveTool('select');
    setTicketEntryOpen(false);
    renderNodes();
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
