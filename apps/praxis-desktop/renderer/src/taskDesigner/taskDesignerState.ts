/**
 * Task Designer runtime helpers — renderer mirror.
 *
 * The desktop frontend imports core type-only, so the small pieces of runtime
 * logic the canvas needs (URL normalization, issue-type colors, connector
 * geometry, recommendation preview building, the apply-recommendation merge)
 * are mirrored here, ported from the extension's taskDesignerPanelManager
 * webview script. Normalization/validation of persisted state happens in main
 * (`taskDesignerIpc`), so the renderer trusts what `getState` returns.
 */
import type {
  TaskDesignerCanvasNode,
  TaskDesignerDirectedConnector,
  TaskDesignerFlowRecommendation,
  TaskDesignerLinkHandleDirection,
  TaskDesignerPersistedState,
  TaskDesignerTicketNode
} from '@praxis/core';

// ── Website preview URLs ─────────────────────────────────────────────────────

export function normalizeWebsitePreviewUrl(raw: string | undefined): string | undefined {
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

export function websitePreviewTitle(url: string | undefined): string {
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

// ── Issue-type colors (mirrors core's board/issueTypeColors + panel header styling) ──

const KNOWN_ISSUE_TYPE_HEX: Record<string, string> = {
  bug: '#e5534b',
  story: '#3fb950',
  task: '#db61a2',
  epic: '#a371f7',
  feature: '#3fbccd',
  idea: '#f59e0b',
  subtask: '#db61a2',
  'sub-task': '#db61a2',
  improvement: '#79c0ff',
  spike: '#d29922'
};
const ISSUE_TYPE_FALLBACK_HEX = ['#58a6ff', '#a371f7', '#3fbccd', '#d29922', '#79c0ff', '#ff7b72', '#56d364', '#db61a2'];

function clampColorChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
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

function rgbToHex(r: number, g: number, b: number): string {
  return `#${clampColorChannel(r).toString(16).padStart(2, '0')}${clampColorChannel(g).toString(16).padStart(2, '0')}${clampColorChannel(b).toString(16).padStart(2, '0')}`;
}

export function shiftHex(hex: string, delta: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return hex;
  }
  return rgbToHex(rgb.r + delta, rgb.g + delta, rgb.b + delta);
}

function hashPickIssueTypeHex(label: string): string {
  let hash = 0;
  for (let index = 0; index < label.length; index += 1) {
    hash = (hash * 31 + label.charCodeAt(index)) >>> 0;
  }
  return ISSUE_TYPE_FALLBACK_HEX[hash % ISSUE_TYPE_FALLBACK_HEX.length];
}

export function issueTypeHex(issueType: string, configured?: Record<string, string>): string {
  const raw = typeof issueType === 'string' ? issueType : '';
  const key = raw.trim().toLowerCase();
  const canonicalKey = key === 'sub-task' ? 'subtask' : key;
  if (!key) {
    return '#2563eb';
  }
  const configuredValue = configured?.[raw.trim()] ?? configured?.[canonicalKey];
  return configuredValue ?? KNOWN_ISSUE_TYPE_HEX[canonicalKey] ?? hashPickIssueTypeHex(raw);
}

export function ticketHeaderForeground(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return '#eff6ff';
  }
  const brightness = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
  return brightness >= 160 ? '#111827' : '#eff6ff';
}

/** Inline style for a ticket node's colored header (issue-type tinted). */
export function ticketHeaderStyle(issueType: string, configured?: Record<string, string>): {
  background: string;
  color: string;
  borderBottom: string;
} {
  const base = issueTypeHex(issueType, configured);
  return {
    background: base,
    color: ticketHeaderForeground(base),
    borderBottom: `1px solid color-mix(in srgb, ${base} 72%, black)`
  };
}

export function websiteHeaderBackground(): string {
  const base = '#58a6ff';
  return `linear-gradient(135deg, ${shiftHex(base, 12)} 0%, ${shiftHex(base, -18)} 100%)`;
}

// ── Connector geometry ───────────────────────────────────────────────────────

/** A node's canvas-space box (after zoom is divided out). */
export interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function anchorPoint(box: CanvasBox, direction: TaskDesignerLinkHandleDirection): { x: number; y: number } {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  switch (direction) {
    case 'top':
      return { x: centerX, y: box.y };
    case 'right':
      return { x: box.x + box.width, y: centerY };
    case 'bottom':
      return { x: centerX, y: box.y + box.height };
    case 'left':
    default:
      return { x: box.x, y: centerY };
  }
}

export function resolveConnectorDirections(
  sourceBox: CanvasBox,
  targetBox: CanvasBox,
  sourceDirection?: TaskDesignerLinkHandleDirection,
  targetDirection?: TaskDesignerLinkHandleDirection
): { sourceDirection: TaskDesignerLinkHandleDirection; targetDirection: TaskDesignerLinkHandleDirection } {
  if (sourceDirection && targetDirection) {
    return { sourceDirection, targetDirection };
  }
  const sourceCenterX = sourceBox.x + sourceBox.width / 2;
  const sourceCenterY = sourceBox.y + sourceBox.height / 2;
  const targetCenterX = targetBox.x + targetBox.width / 2;
  const targetCenterY = targetBox.y + targetBox.height / 2;
  const deltaX = targetCenterX - sourceCenterX;
  const deltaY = targetCenterY - sourceCenterY;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return {
      sourceDirection: sourceDirection ?? (deltaX >= 0 ? 'right' : 'left'),
      targetDirection: targetDirection ?? (deltaX >= 0 ? 'left' : 'right')
    };
  }
  return {
    sourceDirection: sourceDirection ?? (deltaY >= 0 ? 'bottom' : 'top'),
    targetDirection: targetDirection ?? (deltaY >= 0 ? 'top' : 'bottom')
  };
}

export function buildConnectorCurvePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  sourceDirection: TaskDesignerLinkHandleDirection,
  targetDirection: TaskDesignerLinkHandleDirection
): string {
  const horizontalDelta = Math.abs(x2 - x1);
  const verticalDelta = Math.abs(y2 - y1);
  const controlOffset = Math.max(42, Math.min(Math.max(horizontalDelta, verticalDelta) * 0.42, 164));
  const controlPointFromDirection = (x: number, y: number, direction: TaskDesignerLinkHandleDirection) => {
    switch (direction) {
      case 'top':
        return { x, y: y - controlOffset };
      case 'right':
        return { x: x + controlOffset, y };
      case 'bottom':
        return { x, y: y + controlOffset };
      case 'left':
      default:
        return { x: x - controlOffset, y };
    }
  };
  const control1 = controlPointFromDirection(x1, y1, sourceDirection);
  const control2 = controlPointFromDirection(x2, y2, targetDirection);
  return `M ${x1} ${y1} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${x2} ${y2}`;
}

// ── Connector graph guards (link creation) ───────────────────────────────────

export function hasExistingConnector(
  connectors: readonly TaskDesignerDirectedConnector[],
  sourceNodeId: string,
  targetNodeId: string
): boolean {
  return connectors.some(
    connector => connector.sourceNodeId === sourceNodeId && connector.targetNodeId === targetNodeId
  );
}

function hasDirectedPath(
  connectors: readonly TaskDesignerDirectedConnector[],
  startNodeId: string,
  targetNodeId: string
): boolean {
  const stack = [startNodeId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId || visited.has(nodeId)) {
      continue;
    }
    if (nodeId === targetNodeId) {
      return true;
    }
    visited.add(nodeId);
    for (const connector of connectors) {
      if (connector.sourceNodeId === nodeId && !visited.has(connector.targetNodeId)) {
        stack.push(connector.targetNodeId);
      }
    }
  }
  return false;
}

export function wouldCreateCycle(
  connectors: readonly TaskDesignerDirectedConnector[],
  sourceNodeId: string,
  targetNodeId: string
): boolean {
  return hasDirectedPath(connectors, targetNodeId, sourceNodeId);
}

// ── Id allocation (trailing `-N` suffix, matching the extension) ─────────────

export function computeNextNodeIndex(nodes: readonly TaskDesignerCanvasNode[]): number {
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
  return maxIndex + 1;
}

export function computeNextConnectorIndex(connectors: readonly TaskDesignerDirectedConnector[]): number {
  let maxIndex = -1;
  for (const connector of connectors) {
    const match = /-(\d+)$/.exec(connector.id);
    const parsed = match ? Number.parseInt(match[1], 10) : Number.NaN;
    if (Number.isFinite(parsed)) {
      maxIndex = Math.max(maxIndex, parsed);
    }
  }
  if (maxIndex < 0 && connectors.length > 0) {
    maxIndex = connectors.length - 1;
  }
  return maxIndex + 1;
}

// ── Recommendation preview ───────────────────────────────────────────────────

export interface TaskDesignerRecommendationLane {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TaskDesignerRecommendationPreview {
  /** Ticket nodes repositioned into the vertical lane layout. */
  nodes: TaskDesignerTicketNode[];
  nodeById: ReadonlyMap<string, TaskDesignerTicketNode>;
  /** 1-based execution order per node id (drives the header badges). */
  orderById: ReadonlyMap<string, number>;
  /** Preview nodes that don't exist on the canvas yet (rendered dashed). */
  ghostNodes: TaskDesignerTicketNode[];
  connectors: TaskDesignerDirectedConnector[];
  lane: TaskDesignerRecommendationLane;
}

/** Canvas-space viewport of the scroll surface, for centering the lane. */
export interface TaskDesignerViewport {
  left: number;
  top: number;
  width: number;
}

export function buildRecommendationPreview(
  canvasNodes: readonly TaskDesignerCanvasNode[],
  recommendationNodes: readonly TaskDesignerTicketNode[],
  recommendation: TaskDesignerFlowRecommendation,
  viewport: TaskDesignerViewport
): TaskDesignerRecommendationPreview | undefined {
  if (recommendationNodes.length < 2) {
    return undefined;
  }

  const byId = new Map(recommendationNodes.map(node => [node.id, node]));
  const orderedNodeIds: string[] = [];
  const seenNodeIds = new Set<string>();
  for (const nodeId of recommendation.orderedNodeIds) {
    if (!byId.has(nodeId) || seenNodeIds.has(nodeId)) {
      continue;
    }
    seenNodeIds.add(nodeId);
    orderedNodeIds.push(nodeId);
  }
  for (const node of recommendationNodes) {
    if (seenNodeIds.has(node.id)) {
      continue;
    }
    seenNodeIds.add(node.id);
    orderedNodeIds.push(node.id);
  }
  if (orderedNodeIds.length < 2) {
    return undefined;
  }

  // Vertical lane layout centered in the current viewport.
  const layoutWidth = 250;
  const layoutMarginX = 28;
  const layoutTopOffset = 48;
  const layoutStepY = 188;
  const layoutX = viewport.left + Math.max(layoutMarginX, (viewport.width - layoutWidth) / 2);
  const layoutStartY = viewport.top + layoutTopOffset;
  const positionedNodes = orderedNodeIds
    .map((nodeId, index) => {
      const node = byId.get(nodeId);
      if (!node) {
        return undefined;
      }
      return { ...node, x: layoutX, y: layoutStartY + index * layoutStepY };
    })
    .filter((node): node is TaskDesignerTicketNode => Boolean(node));
  const positionedById = new Map(positionedNodes.map(node => [node.id, node]));

  const orderIndex = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index]));
  const connectors: TaskDesignerDirectedConnector[] = [];
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
    const connectorKey = `${connector.sourceNodeId} ${connector.targetNodeId}`;
    if (seenConnectors.has(connectorKey)) {
      continue;
    }
    seenConnectors.add(connectorKey);
    connectors.push({
      id: `recommendation-${connectors.length}`,
      sourceNodeId: connector.sourceNodeId,
      targetNodeId: connector.targetNodeId
    });
  }
  if (connectors.length === 0) {
    for (let index = 0; index < orderedNodeIds.length - 1; index += 1) {
      connectors.push({
        id: `recommendation-${connectors.length}`,
        sourceNodeId: orderedNodeIds[index],
        targetNodeId: orderedNodeIds[index + 1]
      });
    }
  }

  const canvasNodeIds = new Set(canvasNodes.map(node => node.id));
  return {
    nodes: positionedNodes,
    nodeById: positionedById,
    orderById: new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index + 1])),
    ghostNodes: positionedNodes.filter(node => !canvasNodeIds.has(node.id)),
    connectors,
    lane: {
      x: positionedNodes.length > 0 ? Math.max(0, positionedNodes[0].x - 22) : 0,
      y: positionedNodes.length > 0 ? Math.max(0, positionedNodes[0].y - 18) : 0,
      width: 294,
      height: Math.max(164, 150 + Math.max(0, positionedNodes.length - 1) * 188)
    }
  };
}

/**
 * Apply a recommendation to the canvas: ordered preview tickets (in lane
 * positions) + preserved note/website nodes + preserved connectors that touch
 * a custom node, connectors renumbered. Throws with the same messages the
 * extension host replied with.
 */
export function applyRecommendationToState(
  currentState: TaskDesignerPersistedState,
  previewNodes: readonly TaskDesignerTicketNode[],
  recommendation: TaskDesignerFlowRecommendation
): TaskDesignerPersistedState {
  const preservedNodes = currentState.nodes
    .filter(node => node.type !== 'ticket')
    .map(node => ({ ...node }));
  const preservedNodeIds = new Set(preservedNodes.map(node => node.id));
  const preservedConnectors = currentState.connectors.filter(
    connector => preservedNodeIds.has(connector.sourceNodeId) || preservedNodeIds.has(connector.targetNodeId)
  );
  if (previewNodes.length < 2) {
    throw new Error('Recommendation preview is missing ticket nodes.');
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
    throw new Error('Recommendation must include at least two ticket nodes.');
  }

  const orderIndex = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index]));
  const connectors: TaskDesignerDirectedConnector[] = [];
  const seenConnectors = new Set<string>();
  for (const connector of recommendation.connectors) {
    const sourceOrder = orderIndex.get(connector.sourceNodeId) ?? -1;
    const targetOrder = orderIndex.get(connector.targetNodeId) ?? -1;
    if (sourceOrder < 0 || targetOrder < 0 || sourceOrder >= targetOrder) {
      continue;
    }
    const connectorKey = `${connector.sourceNodeId} ${connector.targetNodeId}`;
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

  return {
    nodes: [
      ...orderedNodeIds
        .map(nodeId => byId.get(nodeId))
        .filter((node): node is TaskDesignerTicketNode => Boolean(node))
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
}
