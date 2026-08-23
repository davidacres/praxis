/**
 * Task Designer canvas state model — host-agnostic.
 *
 * Ported from the VS Code extension's `views/taskDesignerStatePersistence.ts`
 * plus the pure graph helpers that lived in `taskDesignerPanelManager.ts`
 * (duplicate/cycle validation, topological ordering). Both hosts persist the
 * same payload shape (the extension in a workspace memento, the desktop app in
 * a JSON file under userData), so the normalizer and its repair warnings live
 * here exactly once.
 */

export interface TaskDesignerTicketNode {
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

export interface TaskDesignerNoteNode {
  type: 'note';
  id: string;
  title: string;
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TaskDesignerWebsitePreviewNode {
  type: 'website';
  id: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TaskDesignerCanvasNode = TaskDesignerTicketNode | TaskDesignerNoteNode | TaskDesignerWebsitePreviewNode;

export type TaskDesignerLinkHandleDirection = 'top' | 'right' | 'bottom' | 'left';

export interface TaskDesignerDirectedConnector {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceDirection?: TaskDesignerLinkHandleDirection;
  targetDirection?: TaskDesignerLinkHandleDirection;
}

export interface TaskDesignerPersistedState {
  nodes: TaskDesignerCanvasNode[];
  connectors: TaskDesignerDirectedConnector[];
  zoom: number;
  toolbarPosition: {
    x: number;
    y: number;
  };
}

export interface TaskDesignerPersistedStateRecoveryResult {
  state: TaskDesignerPersistedState;
  repaired: boolean;
  warning?: string;
}

export function emptyTaskDesignerState(): TaskDesignerPersistedState {
  return {
    nodes: [],
    connectors: [],
    zoom: 1,
    toolbarPosition: { x: 16, y: 16 }
  };
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

function asLinkHandleDirection(value: unknown): TaskDesignerLinkHandleDirection | undefined {
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

function toTicketNode(value: unknown, fallbackIndex = 0): TaskDesignerTicketNode | undefined {
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

function toNoteNode(value: unknown, fallbackIndex = 0): TaskDesignerNoteNode | undefined {
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

function toWebsitePreviewNode(value: unknown, fallbackIndex = 0): TaskDesignerWebsitePreviewNode | undefined {
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

function toDirectedConnector(value: unknown): TaskDesignerDirectedConnector | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = asString(value.id);
  const sourceNodeId = asString(value.sourceNodeId);
  const targetNodeId = asString(value.targetNodeId);

  if (!id || !sourceNodeId || !targetNodeId) {
    return undefined;
  }

  const sourceDirection = asLinkHandleDirection(value.sourceDirection);
  const targetDirection = asLinkHandleDirection(value.targetDirection);

  return {
    id,
    sourceNodeId,
    targetNodeId,
    ...(sourceDirection ? { sourceDirection } : {}),
    ...(targetDirection ? { targetDirection } : {})
  };
}

function warningPart(count: number, singular: string, plural: string): string | undefined {
  if (count <= 0) {
    return undefined;
  }
  return `${count} ${count === 1 ? singular : plural}`;
}

export function normalizeTaskDesignerPersistedState(value: unknown): TaskDesignerPersistedStateRecoveryResult {
  if (value === undefined) {
    return {
      state: emptyTaskDesignerState(),
      repaired: false
    };
  }

  if (!isRecord(value)) {
    return {
      state: emptyTaskDesignerState(),
      repaired: true,
      warning: 'Recovered Task Designer state: persisted payload was invalid and was reset.'
    };
  }

  const nodes: TaskDesignerCanvasNode[] = [];
  const seenNodeIds = new Set<string>();
  let droppedNodes = 0;
  let dedupedNodeIds = 0;
  let repairedCoordinates = 0;
  let repairedNoteDimensions = 0;
  let repairedWebsiteDimensions = 0;

  const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
  for (const [index, candidateNode] of rawNodes.entries()) {
    const node = toWebsitePreviewNode(candidateNode, index) ?? toNoteNode(candidateNode, index) ?? toTicketNode(candidateNode, index);
    if (!node) {
      droppedNodes += 1;
      continue;
    }
    if (seenNodeIds.has(node.id)) {
      dedupedNodeIds += 1;
      continue;
    }
    if (isRecord(candidateNode) && (asNumber(candidateNode.x) === undefined || asNumber(candidateNode.y) === undefined)) {
      repairedCoordinates += 1;
    }
    if (node.type === 'note' && isRecord(candidateNode) && (asNumber(candidateNode.width) === undefined || asNumber(candidateNode.height) === undefined)) {
      repairedNoteDimensions += 1;
    }
    if (node.type === 'website' && isRecord(candidateNode) && (asNumber(candidateNode.width) === undefined || asNumber(candidateNode.height) === undefined)) {
      repairedWebsiteDimensions += 1;
    }
    seenNodeIds.add(node.id);
    nodes.push(node);
  }

  const connectors: TaskDesignerDirectedConnector[] = [];
  const seenConnectorIds = new Set<string>();
  const seenEdges = new Set<string>();
  let droppedConnectors = 0;
  let staleConnectors = 0;
  let selfLoopConnectors = 0;
  let duplicateConnectorIds = 0;
  let duplicateEdges = 0;
  const zoom = asNumber(value.zoom);
  const rawToolbarPosition = isRecord(value.toolbarPosition) ? value.toolbarPosition : undefined;
  const toolbarX = rawToolbarPosition ? asNumber(rawToolbarPosition.x) : undefined;
  const toolbarY = rawToolbarPosition ? asNumber(rawToolbarPosition.y) : undefined;
  const normalizedZoom = zoom !== undefined ? Math.max(0.5, Math.min(2, Math.round(zoom * 100) / 100)) : 1;
  const toolbarPosition = {
    x: toolbarX ?? 16,
    y: toolbarY ?? 16
  };

  const rawConnectors = Array.isArray(value.connectors) ? value.connectors : [];
  for (const candidateConnector of rawConnectors) {
    const connector = toDirectedConnector(candidateConnector);
    if (!connector) {
      droppedConnectors += 1;
      continue;
    }
    if (connector.sourceNodeId === connector.targetNodeId) {
      selfLoopConnectors += 1;
      continue;
    }
    if (!seenNodeIds.has(connector.sourceNodeId) || !seenNodeIds.has(connector.targetNodeId)) {
      staleConnectors += 1;
      continue;
    }
    if (seenConnectorIds.has(connector.id)) {
      duplicateConnectorIds += 1;
      continue;
    }
    const edgeKey = `${connector.sourceNodeId} ${connector.targetNodeId}`;
    if (seenEdges.has(edgeKey)) {
      duplicateEdges += 1;
      continue;
    }
    seenConnectorIds.add(connector.id);
    seenEdges.add(edgeKey);
    connectors.push(connector);
  }

  const repairedParts = [
    warningPart(droppedNodes, 'invalid node', 'invalid nodes'),
    warningPart(dedupedNodeIds, 'duplicate node id', 'duplicate node ids'),
    warningPart(repairedCoordinates, 'node with invalid coordinates', 'nodes with invalid coordinates'),
    warningPart(repairedNoteDimensions, 'note with invalid dimensions', 'notes with invalid dimensions'),
    warningPart(repairedWebsiteDimensions, 'website preview with invalid dimensions', 'website previews with invalid dimensions'),
    warningPart(droppedConnectors, 'invalid connector', 'invalid connectors'),
    warningPart(staleConnectors, 'stale connector', 'stale connectors'),
    warningPart(selfLoopConnectors, 'self-loop connector', 'self-loop connectors'),
    warningPart(duplicateConnectorIds, 'duplicate connector id', 'duplicate connector ids'),
    warningPart(duplicateEdges, 'duplicate edge', 'duplicate edges')
  ].filter((part): part is string => Boolean(part));

  const repaired = repairedParts.length > 0;
  return {
    state: { nodes, connectors, zoom: normalizedZoom, toolbarPosition },
    repaired,
    warning: repaired ? `Recovered Task Designer state: removed ${repairedParts.join(', ')}.` : undefined
  };
}

// ── Connector graph validation ───────────────────────────────────────────────

export type TaskDesignerConnectorGraphValidationCode = 'duplicate-edge' | 'cycle';

export interface TaskDesignerConnectorGraphValidationError {
  code: TaskDesignerConnectorGraphValidationCode;
  sourceNodeId: string;
  targetNodeId: string;
  message: string;
}

function detectDuplicateConnector(
  connectors: readonly Pick<TaskDesignerDirectedConnector, 'sourceNodeId' | 'targetNodeId'>[]
): Pick<TaskDesignerDirectedConnector, 'sourceNodeId' | 'targetNodeId'> | undefined {
  const seen = new Set<string>();
  for (const connector of connectors) {
    const key = `${connector.sourceNodeId} ${connector.targetNodeId}`;
    if (seen.has(key)) {
      return connector;
    }
    seen.add(key);
  }
  return undefined;
}

function detectCycleConnector(
  connectors: readonly Pick<TaskDesignerDirectedConnector, 'sourceNodeId' | 'targetNodeId'>[]
): Pick<TaskDesignerDirectedConnector, 'sourceNodeId' | 'targetNodeId'> | undefined {
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
  let cycleConnector: Pick<TaskDesignerDirectedConnector, 'sourceNodeId' | 'targetNodeId'> | undefined;

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
        cycleConnector = { sourceNodeId: nodeId, targetNodeId: nextNodeId };
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

export function validateTaskDesignerConnectorGraph(
  connectors: readonly Pick<TaskDesignerDirectedConnector, 'id' | 'sourceNodeId' | 'targetNodeId'>[]
): TaskDesignerConnectorGraphValidationError | undefined {
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

// ── Topological ordering (master plan + recommendation layouts) ─────────────

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

/**
 * Kahn's algorithm over the directed connector graph; ties break by the input
 * node order. Returns undefined when the graph has a cycle (no full ordering).
 */
export function computeTaskDesignerTopologicalOrder(
  nodes: readonly Pick<TaskDesignerCanvasNode, 'id'>[],
  connectors: readonly Pick<TaskDesignerDirectedConnector, 'id' | 'sourceNodeId' | 'targetNodeId'>[]
): string[] | undefined {
  if (nodes.length === 0) {
    return [];
  }

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

  return orderedNodeIds;
}
