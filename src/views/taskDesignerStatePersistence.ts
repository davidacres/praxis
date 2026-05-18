export interface TaskDesignerTicketNode {
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

export interface TaskDesignerDirectedConnector {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
}

export interface TaskDesignerPersistedState {
  nodes: TaskDesignerTicketNode[];
  connectors: TaskDesignerDirectedConnector[];
}

export interface TaskDesignerPersistedStateRecoveryResult {
  state: TaskDesignerPersistedState;
  repaired: boolean;
  warning?: string;
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

  return {
    id,
    sourceNodeId,
    targetNodeId
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
    return { state: { nodes: [], connectors: [] }, repaired: false };
  }

  if (!isRecord(value)) {
    return {
      state: { nodes: [], connectors: [] },
      repaired: true,
      warning: 'Recovered Task Designer state: persisted payload was invalid and was reset.'
    };
  }

  const nodes: TaskDesignerTicketNode[] = [];
  const seenNodeIds = new Set<string>();
  let droppedNodes = 0;
  let dedupedNodeIds = 0;
  let repairedCoordinates = 0;

  const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
  for (const [index, candidateNode] of rawNodes.entries()) {
    const node = toTicketNode(candidateNode, index);
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
    const edgeKey = `${connector.sourceNodeId}\u0000${connector.targetNodeId}`;
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
    warningPart(droppedConnectors, 'invalid connector', 'invalid connectors'),
    warningPart(staleConnectors, 'stale connector', 'stale connectors'),
    warningPart(selfLoopConnectors, 'self-loop connector', 'self-loop connectors'),
    warningPart(duplicateConnectorIds, 'duplicate connector id', 'duplicate connector ids'),
    warningPart(duplicateEdges, 'duplicate edge', 'duplicate edges')
  ].filter((part): part is string => Boolean(part));

  const repaired = repairedParts.length > 0;
  return {
    state: { nodes, connectors },
    repaired,
    warning: repaired ? `Recovered Task Designer state: removed ${repairedParts.join(', ')}.` : undefined
  };
}
