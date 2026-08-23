import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import type {
  Board,
  TaskDesignerCanvasNode,
  TaskDesignerDirectedConnector,
  TaskDesignerFlowRecommendation,
  TaskDesignerLinkHandleDirection,
  TaskDesignerNoteNode,
  TaskDesignerPersistedState,
  TaskDesignerResolvedDroppedIssue,
  TaskDesignerTicketNode,
  TaskDesignerWebsitePreviewNode
} from '@ticket-manager/core';
import { Icon, type IconName } from './Icon';
import {
  anchorPoint,
  applyRecommendationToState,
  buildConnectorCurvePath,
  buildRecommendationPreview,
  computeNextConnectorIndex,
  computeNextNodeIndex,
  hasExistingConnector,
  normalizeWebsitePreviewUrl,
  resolveConnectorDirections,
  ticketHeaderStyle,
  websiteHeaderBackground,
  websitePreviewTitle,
  wouldCreateCycle,
  type CanvasBox
} from './taskDesignerState';

interface TaskDesignerPageProps {
  board: Board;
  onClose: () => void;
}

type ActiveTool = 'select' | 'link';
type EntryMode = 'ticket' | 'website';

interface Feedback {
  text: string;
  isError: boolean;
}

interface RecommendationState {
  recommendation: TaskDesignerFlowRecommendation;
  /** Preview ticket nodes (canvas snapshot for canvas flow, board seed for board flow). */
  nodes: TaskDesignerTicketNode[];
  sourceLabel: string;
}

interface LinkPreview {
  pointerId: number;
  sourceNodeId: string;
  sourceDirection: TaskDesignerLinkHandleDirection;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Mutable pointer-interaction state; window-level listeners read it by pointerId. */
type Interaction =
  | { kind: 'drag'; pointerId: number; nodeId: string; startClientX: number; startClientY: number; startX: number; startY: number; moved: boolean }
  | { kind: 'resize'; pointerId: number; nodeId: string; startClientX: number; startClientY: number; startWidth: number; startHeight: number }
  | { kind: 'toolbar'; pointerId: number; offsetX: number; offsetY: number };

const TICKET_NODE_WIDTH = 250;
const DEFAULT_TICKET_NODE_HEIGHT = 140;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const MIN_NOTE_WIDTH = 220;
const MIN_NOTE_HEIGHT = 150;
const HANDLE_DIRECTIONS: TaskDesignerLinkHandleDirection[] = ['top', 'right', 'bottom', 'left'];

function emptyCanvasState(): TaskDesignerPersistedState {
  return { nodes: [], connectors: [], zoom: 1, toolbarPosition: { x: 16, y: 16 } };
}

function clampZoom(value: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(value * 100) / 100));
}

function nodeLabel(node: TaskDesignerCanvasNode | undefined): string {
  if (!node) {
    return 'selected node';
  }
  if (node.type === 'ticket') {
    return node.issueKey;
  }
  if (node.type === 'note') {
    return node.title.replace(/\s+/g, ' ').trim() || 'note';
  }
  return websitePreviewTitle(node.url);
}

/**
 * Task Designer — the desktop port of the extension's `taskDesignerPanelManager`
 * webview. Same canvas model (ticket/note/website nodes, directed bezier
 * connectors, zoom, draggable toolbar), same persisted payload, same AI
 * recommendation + master-plan flows — as a React route instead of a webview.
 *
 * Canvas state is the source of truth in `stateRef` (event handlers always see
 * the latest, even inside the 160ms debounce window); React state mirrors it
 * for rendering.
 */
export function TaskDesignerPage({ board, onClose }: TaskDesignerPageProps) {
  const [canvas, setCanvas] = useState<TaskDesignerPersistedState>(emptyCanvasState);
  const [loaded, setLoaded] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | undefined>();
  const [activeTool, setActiveTool] = useState<ActiveTool>('select');
  const [linkPreview, setLinkPreview] = useState<LinkPreview | undefined>();
  const [entry, setEntry] = useState<{ open: boolean; mode: EntryMode }>({ open: false, mode: 'ticket' });
  const [entryValue, setEntryValue] = useState('');
  const [feedback, setFeedbackState] = useState<Feedback | undefined>();
  const [recommendation, setRecommendation] = useState<RecommendationState | undefined>();
  const [busy, setBusy] = useState<'recommend' | 'recommendBoard' | 'apply' | 'masterPlan' | undefined>();
  /** Measured node boxes (layout px = canvas coords; CSS transform doesn't affect offset*). */
  const [sizes, setSizes] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map());

  const canvasRef = useRef<TaskDesignerPersistedState>(canvas);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const nodesLayerRef = useRef<HTMLDivElement | null>(null);
  const connectorsLayerRef = useRef<SVGSVGElement | null>(null);
  const interactionRef = useRef<Interaction | undefined>(undefined);
  const linkPreviewRef = useRef<LinkPreview | undefined>(undefined);
  const persistTimerRef = useRef<number | undefined>(undefined);
  const feedbackTimerRef = useRef<number | undefined>(undefined);
  const selectedConnectorRef = useRef<string | undefined>(undefined);
  const entryRef = useRef(entry);
  selectedConnectorRef.current = selectedConnectorId;
  entryRef.current = entry;

  const applyCanvas = useCallback((next: TaskDesignerPersistedState) => {
    canvasRef.current = next;
    setCanvas(next);
  }, []);

  const setFeedback = useCallback((text: string, isError = false) => {
    window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = undefined;
    setFeedbackState(text ? { text, isError } : undefined);
    if (text) {
      feedbackTimerRef.current = window.setTimeout(() => {
        feedbackTimerRef.current = undefined;
        setFeedbackState(undefined);
      }, isError ? 7000 : 4000);
    }
  }, []);

  // ── Persistence (160ms debounce, envelope carries corrective state) ────────

  const persistNow = useCallback(async () => {
    try {
      const result = await window.ticketManager.taskDesigner.setState(
        board.id,
        board.connectionId,
        canvasRef.current
      );
      if (!result.ok) {
        applyCanvas(result.state);
        setFeedback(result.warning ?? 'Unable to save canvas state.', true);
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error), true);
    }
  }, [board.id, board.connectionId, applyCanvas, setFeedback]);

  const schedulePersist = useCallback(() => {
    window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = undefined;
      void persistNow();
    }, 160);
  }, [persistNow]);

  // ── Load + Session Log seeding (mirrors the extension's open()) ────────────

  useEffect(() => {
    let cancelled = false;
    void window.ticketManager.taskDesigner
      .getState(board.id, board.connectionId)
      .then(loadedState => {
        if (cancelled) {
          return;
        }
        let initial = loadedState;
        if (loadedState.nodes.length === 0) {
          const now = new Date();
          const dateStr = now.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
          const timeStr = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
          const note: TaskDesignerNoteNode = {
            type: 'note',
            id: 'note-0',
            title: 'Session Log',
            content: `Opened: ${dateStr} at ${timeStr}`,
            x: 24,
            y: 72,
            width: 280,
            height: 190
          };
          initial = { ...loadedState, nodes: [note] };
          void window.ticketManager.taskDesigner.setState(board.id, board.connectionId, initial);
        }
        canvasRef.current = initial;
        setCanvas(initial);
        setLoaded(true);
      })
      .catch(error => setFeedback(error instanceof Error ? error.message : String(error), true));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id, board.connectionId]);

  // Flush any pending persist when leaving the designer.
  useEffect(() => {
    return () => {
      window.clearTimeout(persistTimerRef.current);
      window.clearTimeout(feedbackTimerRef.current);
      void window.ticketManager.taskDesigner.setState(board.id, board.connectionId, canvasRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id, board.connectionId]);

  // ── Node measurement (connector anchors need real boxes) ──────────────────

  const observeNode = useCallback((nodeId: string, element: HTMLElement | null) => {
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      setSizes(current => {
        const existing = current.get(nodeId);
        if (existing && existing.width === width && existing.height === height) {
          return current;
        }
        const next = new Map(current);
        next.set(nodeId, { width, height });
        return next;
      });
    });
    observer.observe(element);
    nodeObserversRef.current.set(nodeId, observer);
  }, []);
  const nodeObserversRef = useRef(new Map<string, ResizeObserver>());

  const nodeRefCallback = useCallback(
    (nodeId: string) => (element: HTMLElement | null) => {
      nodeObserversRef.current.get(nodeId)?.disconnect();
      nodeObserversRef.current.delete(nodeId);
      if (element) {
        observeNode(nodeId, element);
      }
    },
    [observeNode]
  );

  useEffect(() => {
    const observers = nodeObserversRef.current;
    return () => {
      for (const observer of observers.values()) {
        observer.disconnect();
      }
      observers.clear();
    };
  }, []);

  const boxForNode = useCallback(
    (node: TaskDesignerCanvasNode, rendered?: { x: number; y: number }): CanvasBox => {
      const measured = sizes.get(node.id);
      const position = rendered ?? node;
      if (node.type === 'ticket') {
        return {
          x: position.x,
          y: position.y,
          width: TICKET_NODE_WIDTH,
          height: measured?.height ?? DEFAULT_TICKET_NODE_HEIGHT
        };
      }
      return { x: position.x, y: position.y, width: node.width, height: node.height };
    },
    [sizes]
  );

  // ── Coordinate conversion (identical math to the webview script) ───────────

  const clientToCanvas = useCallback((clientX: number, clientY: number) => {
    const layer = nodesLayerRef.current;
    const zoom = canvasRef.current.zoom || 1;
    if (!layer) {
      return { x: clientX / zoom, y: clientY / zoom };
    }
    const rect = layer.getBoundingClientRect();
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  }, []);

  const visibleCanvasPoint = useCallback((offsetX: number, offsetY: number) => {
    const surface = surfaceRef.current;
    const zoom = canvasRef.current.zoom || 1;
    if (!surface) {
      return { x: offsetX / zoom, y: offsetY / zoom };
    }
    return { x: (surface.scrollLeft + offsetX) / zoom, y: (surface.scrollTop + offsetY) / zoom };
  }, []);

  const canvasViewport = useCallback(() => {
    const surface = surfaceRef.current;
    const zoom = canvasRef.current.zoom || 1;
    if (!surface) {
      return { left: 0, top: 0, width: TICKET_NODE_WIDTH + 56 };
    }
    return {
      left: surface.scrollLeft / zoom,
      top: surface.scrollTop / zoom,
      width: surface.clientWidth / zoom
    };
  }, []);

  // ── Canvas mutations ───────────────────────────────────────────────────────

  const mutateCanvas = useCallback(
    (mutate: (current: TaskDesignerPersistedState) => TaskDesignerPersistedState, persist: 'now' | 'debounced' = 'debounced') => {
      applyCanvas(mutate(canvasRef.current));
      if (persist === 'now') {
        void persistNow();
      } else {
        schedulePersist();
      }
    },
    [applyCanvas, persistNow, schedulePersist]
  );

  const addTicketNode = useCallback(
    async (issueKey: string, point: { x: number; y: number }) => {
      const resolved = await window.ticketManager.taskDesigner.resolveIssue(issueKey, board.connectionId);
      const index = computeNextNodeIndex(canvasRef.current.nodes);
      const node: TaskDesignerTicketNode = {
        type: 'ticket',
        id: `ticket-${resolved.mainIssue.issueKey}-${index}`,
        ...resolved.mainIssue,
        x: Math.round(point.x),
        y: Math.round(point.y)
      };
      setRecommendation(undefined);
      mutateCanvas(current => ({ ...current, nodes: [...current.nodes, node] }), 'now');
      setSelectedNodeId(node.id);
      setSelectedConnectorId(undefined);
      return node;
    },
    [board.connectionId, mutateCanvas]
  );

  const addNoteNode = useCallback(() => {
    const surface = surfaceRef.current;
    const point = visibleCanvasPoint(
      surface ? Math.min(180, Math.max(96, surface.clientWidth / 3)) : 180,
      96
    );
    const index = computeNextNodeIndex(canvasRef.current.nodes);
    const node: TaskDesignerNoteNode = {
      type: 'note',
      id: `note-${index}`,
      title: 'Notes',
      content: '',
      x: Math.round(point.x),
      y: Math.round(point.y),
      width: 280,
      height: 190
    };
    setRecommendation(undefined);
    mutateCanvas(current => ({ ...current, nodes: [...current.nodes, node] }), 'now');
    setSelectedNodeId(node.id);
    setSelectedConnectorId(undefined);
    setFeedback('Note added.');
  }, [mutateCanvas, visibleCanvasPoint, setFeedback]);

  const addWebsiteNode = useCallback(
    (url: string) => {
      const surface = surfaceRef.current;
      const point = visibleCanvasPoint(
        surface ? Math.min(180, Math.max(96, surface.clientWidth / 3)) : 180,
        96
      );
      const index = computeNextNodeIndex(canvasRef.current.nodes);
      const node: TaskDesignerWebsitePreviewNode = {
        type: 'website',
        id: `website-${index}`,
        url,
        x: Math.round(point.x),
        y: Math.round(point.y),
        width: 360,
        height: 260
      };
      setRecommendation(undefined);
      mutateCanvas(current => ({ ...current, nodes: [...current.nodes, node] }), 'now');
      setSelectedNodeId(node.id);
      setSelectedConnectorId(undefined);
      setFeedback('Website preview added.');
    },
    [mutateCanvas, visibleCanvasPoint, setFeedback]
  );

  const deleteNode = useCallback(
    (node: TaskDesignerCanvasNode) => {
      setRecommendation(undefined);
      mutateCanvas(
        current => ({
          ...current,
          nodes: current.nodes.filter(item => item.id !== node.id),
          connectors: current.connectors.filter(
            connector => connector.sourceNodeId !== node.id && connector.targetNodeId !== node.id
          )
        }),
        'now'
      );
      setSelectedNodeId(current => (current === node.id ? undefined : current));
      setSelectedConnectorId(undefined);
      setLinkPreview(current => (current?.sourceNodeId === node.id ? undefined : current));
      setFeedback(
        `${node.type === 'note' ? 'Note' : node.type === 'website' ? 'Website preview' : 'Ticket node'} deleted.`
      );
    },
    [mutateCanvas, setFeedback]
  );

  const createConnector = useCallback(
    (sourceNodeId: string, targetNodeId: string, sourceDirection?: TaskDesignerLinkHandleDirection, targetDirection?: TaskDesignerLinkHandleDirection) => {
      const current = canvasRef.current;
      if (sourceNodeId === targetNodeId) {
        setFeedback('Select a different target node.', true);
        return false;
      }
      const sourceNode = current.nodes.find(node => node.id === sourceNodeId);
      const targetNode = current.nodes.find(node => node.id === targetNodeId);
      if (hasExistingConnector(current.connectors, sourceNodeId, targetNodeId)) {
        setFeedback(`Link already exists from ${nodeLabel(sourceNode)} to ${nodeLabel(targetNode)}.`, true);
        return false;
      }
      if (wouldCreateCycle(current.connectors, sourceNodeId, targetNodeId)) {
        setFeedback(
          `Cannot create link from ${nodeLabel(sourceNode)} to ${nodeLabel(targetNode)}: it introduces a cycle.`,
          true
        );
        return false;
      }
      const connector: TaskDesignerDirectedConnector = {
        id: `connector-${computeNextConnectorIndex(current.connectors)}`,
        sourceNodeId,
        targetNodeId,
        ...(sourceDirection ? { sourceDirection } : {}),
        ...(targetDirection ? { targetDirection } : {})
      };
      setRecommendation(undefined);
      mutateCanvas(
        state => ({ ...state, connectors: [...state.connectors, connector] }),
        'now'
      );
      setSelectedConnectorId(connector.id);
      setSelectedNodeId(targetNodeId);
      setFeedback('Directed link created.');
      return true;
    },
    [mutateCanvas, setFeedback]
  );

  const deleteSelectedConnector = useCallback(() => {
    const connectorId = selectedConnectorRef.current;
    if (!connectorId) {
      return;
    }
    setRecommendation(undefined);
    mutateCanvas(
      current => ({ ...current, connectors: current.connectors.filter(connector => connector.id !== connectorId) }),
      'now'
    );
    setSelectedConnectorId(undefined);
    setFeedback('Link deleted.');
  }, [mutateCanvas, setFeedback]);

  const clearCanvas = useCallback(() => {
    const current = canvasRef.current;
    if (current.nodes.length === 0 && current.connectors.length === 0) {
      setFeedback('Canvas is already empty.');
      return;
    }
    setRecommendation(undefined);
    setSelectedNodeId(undefined);
    setSelectedConnectorId(undefined);
    setLinkPreview(undefined);
    setActiveTool('select');
    mutateCanvas(state => ({ ...state, nodes: [], connectors: [] }), 'now');
    setFeedback('Canvas cleared.');
  }, [mutateCanvas, setFeedback]);

  const setZoom = useCallback(
    (nextZoom: number) => {
      mutateCanvas(current => ({ ...current, zoom: clampZoom(nextZoom) }));
    },
    [mutateCanvas]
  );

  // ── Ticket/website entry ───────────────────────────────────────────────────

  const openEntry = useCallback((mode: EntryMode) => {
    setEntry({ open: true, mode });
    setEntryValue(mode === 'website' ? 'https://' : '');
  }, []);

  const closeEntry = useCallback(() => {
    setEntry(current => ({ ...current, open: false }));
  }, []);

  const submitEntry = useCallback(async () => {
    const mode = entryRef.current.mode;
    const value = entryValue.trim();
    if (mode === 'website') {
      if (!value) {
        setFeedback('Enter a website URL before adding the preview.', true);
        return;
      }
      const normalized = normalizeWebsitePreviewUrl(value);
      if (!normalized) {
        setFeedback('Enter a valid http or https URL for the website preview.', true);
        return;
      }
      addWebsiteNode(normalized);
      setEntryValue('');
      closeEntry();
      return;
    }
    if (!value) {
      setFeedback('Enter a ticket number before adding.', true);
      return;
    }
    try {
      const surface = surfaceRef.current;
      const point = visibleCanvasPoint(
        surface ? Math.min(180, Math.max(96, surface.clientWidth / 3)) : 180,
        96
      );
      await addTicketNode(value, point);
      setFeedback('Ticket node added.');
      setEntryValue('');
      closeEntry();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error), true);
    }
  }, [entryValue, addTicketNode, addWebsiteNode, closeEntry, setFeedback, visibleCanvasPoint]);

  // ── Drop (board cards drag text/plain = issue key) ─────────────────────────

  const applyDroppedIssue = useCallback(
    (payload: TaskDesignerResolvedDroppedIssue, dropPoint: { x: number; y: number }) => {
      const relatedIssues = payload.relatedIssues.filter(issue => typeof issue.issueKey === 'string');
      const relations = payload.relations.filter(
        relation => typeof relation.sourceIssueKey === 'string' && typeof relation.targetIssueKey === 'string'
      );
      const includeRelated =
        relatedIssues.length > 0
          ? window.confirm(
              `Add ${relatedIssues.length} related ticket${relatedIssues.length === 1 ? '' : 's'} and connect them to the dropped ticket?`
            )
          : false;

      const ensureIssueNode = (
        nodes: TaskDesignerCanvasNode[],
        issue: TaskDesignerResolvedDroppedIssue['mainIssue'],
        x: number,
        y: number
      ): { nodes: TaskDesignerCanvasNode[]; node: TaskDesignerTicketNode } => {
        const existing = nodes.find(
          (node): node is TaskDesignerTicketNode => node.type === 'ticket' && node.issueKey === issue.issueKey
        );
        if (existing) {
          return { nodes, node: existing };
        }
        const index = computeNextNodeIndex(nodes);
        const node: TaskDesignerTicketNode = {
          type: 'ticket',
          id: `ticket-${issue.issueKey}-${index}`,
          ...issue,
          x: Math.round(x),
          y: Math.round(y)
        };
        return { nodes: [...nodes, node], node };
      };

      let next = canvasRef.current;
      let ensured = ensureIssueNode(next.nodes, payload.mainIssue, dropPoint.x - 125, dropPoint.y - 56);
      let nodes = ensured.nodes;
      const mainNode = ensured.node;
      let connectors = [...next.connectors];

      if (includeRelated) {
        let dependencyIndex = 0;
        let childIndex = 0;
        for (const relatedIssue of relatedIssues) {
          const isDependency = relatedIssue.relation === 'dependsOn';
          const slot = isDependency ? dependencyIndex++ : childIndex++;
          const x = isDependency ? mainNode.x - 320 : mainNode.x + 320;
          const y = mainNode.y + slot * 148 - 72;
          ensured = ensureIssueNode(nodes, relatedIssue, x, y);
          nodes = ensured.nodes;
        }
        for (const relation of relations) {
          const sourceNode = nodes.find(
            (node): node is TaskDesignerTicketNode => node.type === 'ticket' && node.issueKey === relation.sourceIssueKey
          );
          const targetNode = nodes.find(
            (node): node is TaskDesignerTicketNode => node.type === 'ticket' && node.issueKey === relation.targetIssueKey
          );
          if (!sourceNode || !targetNode) {
            continue;
          }
          if (
            sourceNode.id === targetNode.id ||
            hasExistingConnector(connectors, sourceNode.id, targetNode.id) ||
            wouldCreateCycle(connectors, sourceNode.id, targetNode.id)
          ) {
            continue;
          }
          connectors.push({
            id: `connector-${computeNextConnectorIndex(connectors)}`,
            sourceNodeId: sourceNode.id,
            targetNodeId: targetNode.id
          });
        }
      }

      setRecommendation(undefined);
      applyCanvas({ ...next, nodes, connectors });
      void persistNow();
      setSelectedNodeId(mainNode.id);
      setSelectedConnectorId(undefined);
      setFeedback(
        includeRelated ? 'Dropped ticket added with related tickets and links.' : 'Dropped ticket added to the designer.'
      );
    },
    [applyCanvas, persistNow, setFeedback]
  );

  const onCanvasDragOver = useCallback((event: ReactDragEvent) => {
    const types = event.dataTransfer?.types ?? [];
    if (types.includes('application/x-ticket-manager-issue') || types.includes('text/plain')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onCanvasDrop = useCallback(
    (event: ReactDragEvent) => {
      const issueKey = (
        event.dataTransfer?.getData('application/x-ticket-manager-issue') ||
        event.dataTransfer?.getData('text/plain') ||
        ''
      ).trim();
      if (!issueKey) {
        return;
      }
      event.preventDefault();
      const point = clientToCanvas(event.clientX, event.clientY);
      void window.ticketManager.taskDesigner
        .resolveIssue(issueKey, board.connectionId)
        .then(payload => applyDroppedIssue(payload, point))
        .catch(error => setFeedback(error instanceof Error ? error.message : String(error), true));
    },
    [board.connectionId, clientToCanvas, applyDroppedIssue, setFeedback]
  );

  // ── Recommendation flows ───────────────────────────────────────────────────

  const requestRecommendFlow = useCallback(async () => {
    const current = canvasRef.current;
    const ticketNodes = current.nodes.filter((node): node is TaskDesignerTicketNode => node.type === 'ticket');
    const ticketNodeIds = new Set(ticketNodes.map(node => node.id));
    if (ticketNodes.length < 2) {
      setFeedback('Add at least two ticket nodes before requesting an AI recommendation.', true);
      return;
    }
    setBusy('recommend');
    try {
      const result = await window.ticketManager.taskDesigner.recommendFlow(
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
        current.connectors
          .filter(connector => ticketNodeIds.has(connector.sourceNodeId) && ticketNodeIds.has(connector.targetNodeId))
          .map(connector => ({ sourceNodeId: connector.sourceNodeId, targetNodeId: connector.targetNodeId }))
      );
      setRecommendation({
        recommendation: result,
        nodes: ticketNodes.map(node => ({ ...node })),
        sourceLabel: 'canvas tickets'
      });
      setFeedback('AI recommendation ready. Use the check or x actions in the toolbar to apply or discard it.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to generate AI recommendation.', true);
    } finally {
      setBusy(undefined);
    }
  }, [setFeedback]);

  const requestRecommendBoardFlow = useCallback(async () => {
    setBusy('recommendBoard');
    try {
      const result = await window.ticketManager.taskDesigner.recommendBoardFlow(board);
      const previewNodes: TaskDesignerTicketNode[] = result.nodes.map((node, index) => ({
        type: 'ticket',
        id: node.id,
        issueKey: node.issueKey,
        summary: node.summary,
        issueType: node.issueType,
        status: node.status,
        assignee: node.assignee,
        priority: node.priority,
        projectKey: node.projectKey,
        x: 24 + (index % 4) * 280,
        y: 24 + Math.floor(index / 4) * 190
      }));
      setRecommendation({
        recommendation: result.recommendation,
        nodes: previewNodes,
        sourceLabel: `board "${result.boardName}"`
      });
      setFeedback('AI board recommendation ready. Use the check or x actions in the toolbar to apply or discard it.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to generate AI recommendation from current board.', true);
    } finally {
      setBusy(undefined);
    }
  }, [board, setFeedback]);

  const preview = recommendation
    ? buildRecommendationPreview(canvas.nodes, recommendation.nodes, recommendation.recommendation, canvasViewport())
    : undefined;

  const requestApplyRecommendation = useCallback(async () => {
    if (!recommendation) {
      setFeedback('No AI recommendation to apply.', true);
      return;
    }
    const currentPreview = buildRecommendationPreview(
      canvasRef.current.nodes,
      recommendation.nodes,
      recommendation.recommendation,
      canvasViewport()
    );
    if (!currentPreview || currentPreview.nodes.length < 2) {
      setFeedback('Recommendation preview is missing ticket nodes.', true);
      return;
    }
    setBusy('apply');
    try {
      const nextState = applyRecommendationToState(
        canvasRef.current,
        currentPreview.nodes,
        recommendation.recommendation
      );
      applyCanvas(nextState);
      setRecommendation(undefined);
      setSelectedNodeId(undefined);
      setSelectedConnectorId(undefined);
      const result = await window.ticketManager.taskDesigner.setState(board.id, board.connectionId, nextState);
      if (!result.ok) {
        applyCanvas(result.state);
        setFeedback(result.warning ?? 'Unable to apply AI recommendation.', true);
        return;
      }
      setFeedback('AI recommendation applied.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to apply AI recommendation.', true);
    } finally {
      setBusy(undefined);
    }
  }, [recommendation, board.id, board.connectionId, applyCanvas, canvasViewport, setFeedback]);

  const requestDiscardRecommendation = useCallback(() => {
    if (!recommendation) {
      setFeedback('No AI recommendation to discard.', true);
      return;
    }
    setRecommendation(undefined);
    setFeedback('AI recommendation discarded.');
  }, [recommendation, setFeedback]);

  const requestGenerateMasterPlan = useCallback(async () => {
    setBusy('masterPlan');
    try {
      const result = await window.ticketManager.taskDesigner.generateMasterPlan(
        board.id,
        board.connectionId,
        canvasRef.current
      );
      setFeedback(
        `Master plan generated at ${result.outputPath}. Generated ${result.generatedFeatureCount} feature file set(s) and ${result.generatedStoryCount} story file(s).`
      );
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to generate master plan artifact.', true);
    } finally {
      setBusy(undefined);
    }
  }, [board.id, board.connectionId, setFeedback]);

  // ── Pointer interactions (window-level, keyed by pointerId) ────────────────

  const updateLinkPreviewFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const current = linkPreviewRef.current;
      if (!current) {
        return;
      }
      const point = clientToCanvas(clientX, clientY);
      const next = { ...current, x2: point.x, y2: point.y };
      linkPreviewRef.current = next;
      setLinkPreview(next);
    },
    [clientToCanvas]
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      const zoom = canvasRef.current.zoom || 1;
      if (linkPreviewRef.current && linkPreviewRef.current.pointerId === event.pointerId) {
        updateLinkPreviewFromPointer(event.clientX, event.clientY);
        return;
      }
      if (!interaction || interaction.pointerId !== event.pointerId) {
        return;
      }
      if (interaction.kind === 'drag') {
        const deltaX = (event.clientX - interaction.startClientX) / zoom;
        const deltaY = (event.clientY - interaction.startClientY) / zoom;
        const nextX = Math.round(interaction.startX + deltaX);
        const nextY = Math.round(interaction.startY + deltaY);
        interaction.moved = true;
        applyCanvas({
          ...canvasRef.current,
          nodes: canvasRef.current.nodes.map(node =>
            node.id === interaction.nodeId ? ({ ...node, x: nextX, y: nextY } as TaskDesignerCanvasNode) : node
          )
        });
        return;
      }
      if (interaction.kind === 'resize') {
        const deltaX = (event.clientX - interaction.startClientX) / zoom;
        const deltaY = (event.clientY - interaction.startClientY) / zoom;
        const width = Math.max(MIN_NOTE_WIDTH, Math.round(interaction.startWidth + deltaX));
        const height = Math.max(MIN_NOTE_HEIGHT, Math.round(interaction.startHeight + deltaY));
        applyCanvas({
          ...canvasRef.current,
          nodes: canvasRef.current.nodes.map(node =>
            node.id === interaction.nodeId && (node.type === 'note' || node.type === 'website')
              ? ({ ...node, width, height } as TaskDesignerCanvasNode)
              : node
          )
        });
        return;
      }
      // toolbar drag
      const surface = surfaceRef.current;
      if (!surface) {
        return;
      }
      const surfaceRect = surface.getBoundingClientRect();
      const nextPosition = {
        x: surface.scrollLeft + event.clientX - surfaceRect.left - interaction.offsetX,
        y: surface.scrollTop + event.clientY - surfaceRect.top - interaction.offsetY
      };
      applyCanvas({ ...canvasRef.current, toolbarPosition: nextPosition });
      schedulePersist();
    };

    const finishInteraction = (event: PointerEvent, cancelled: boolean) => {
      const link = linkPreviewRef.current;
      if (link && link.pointerId === event.pointerId) {
        linkPreviewRef.current = undefined;
        setLinkPreview(undefined);
        if (!cancelled) {
          const targetHandle = document
            .elementsFromPoint(event.clientX, event.clientY)
            .find(element => element.classList.contains('designer-node-handle'));
          const targetNodeId = targetHandle?.getAttribute('data-node-id') ?? undefined;
          const targetDirection = targetHandle?.getAttribute('data-direction') as TaskDesignerLinkHandleDirection | null;
          if (targetHandle && targetNodeId && targetNodeId !== link.sourceNodeId) {
            createConnector(link.sourceNodeId, targetNodeId, link.sourceDirection, targetDirection ?? undefined);
          } else {
            setFeedback('Link cancelled. Drop on a connector to create a link.');
          }
        }
        return;
      }
      const interaction = interactionRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId) {
        return;
      }
      interactionRef.current = undefined;
      if (interaction.kind === 'toolbar') {
        schedulePersist();
        return;
      }
      if (cancelled) {
        schedulePersist();
        return;
      }
      void persistNow();
    };

    const onPointerUp = (event: PointerEvent) => finishInteraction(event, false);
    const onPointerCancel = (event: PointerEvent) => finishInteraction(event, true);

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (inEditable) {
        if (event.key === 'Escape' && entryRef.current.open) {
          closeEntry();
        }
        return;
      }
      if (event.key === 'Delete' && selectedConnectorRef.current) {
        event.preventDefault();
        deleteSelectedConnector();
        return;
      }
      if (event.key === 'Escape' && entryRef.current.open) {
        closeEntry();
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    applyCanvas,
    schedulePersist,
    persistNow,
    updateLinkPreviewFromPointer,
    createConnector,
    deleteSelectedConnector,
    closeEntry,
    setFeedback
  ]);

  // Keep the connectors svg covering the scrollable canvas (like the webview).
  useEffect(() => {
    const svg = connectorsLayerRef.current;
    const surface = surfaceRef.current;
    if (!svg || !surface) {
      return;
    }
    const zoom = canvas.zoom || 1;
    svg.setAttribute('width', String(surface.scrollWidth / zoom));
    svg.setAttribute('height', String(surface.scrollHeight / zoom));
  }, [canvas, sizes, loaded]);

  // ── Node-level pointer handlers ────────────────────────────────────────────

  const onNodePointerDown = useCallback(
    (node: TaskDesignerCanvasNode, event: ReactPointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest('button') || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      interactionRef.current = {
        kind: 'drag',
        pointerId: event.pointerId,
        nodeId: node.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: node.x,
        startY: node.y,
        moved: false
      };
      event.preventDefault();
    },
    []
  );

  const onNodeClick = useCallback((node: TaskDesignerCanvasNode, event: ReactMouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('button') || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return;
    }
    setSelectedNodeId(node.id);
    setSelectedConnectorId(undefined);
  }, []);

  const onResizePointerDown = useCallback(
    (node: TaskDesignerNoteNode | TaskDesignerWebsitePreviewNode, event: ReactPointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSelectedNodeId(node.id);
      setSelectedConnectorId(undefined);
      interactionRef.current = {
        kind: 'resize',
        pointerId: event.pointerId,
        nodeId: node.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startWidth: node.width,
        startHeight: node.height
      };
    },
    []
  );

  const onHandlePointerDown = useCallback(
    (node: TaskDesignerCanvasNode, direction: TaskDesignerLinkHandleDirection, event: ReactPointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSelectedNodeId(node.id);
      setSelectedConnectorId(undefined);
      const box = boxForNode(node);
      const anchor = anchorPoint(box, direction);
      const previewState: LinkPreview = {
        pointerId: event.pointerId,
        sourceNodeId: node.id,
        sourceDirection: direction,
        x1: anchor.x,
        y1: anchor.y,
        x2: anchor.x,
        y2: anchor.y
      };
      linkPreviewRef.current = previewState;
      setLinkPreview(previewState);
      setFeedback('Drag to a connector on another component to create a link.');
    },
    [boxForNode, setFeedback]
  );

  const onToolbarGripPointerDown = useCallback((event: ReactPointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    const toolbar = (event.currentTarget as HTMLElement).closest('.designer-toolbar');
    if (!toolbar) {
      return;
    }
    const rect = toolbar.getBoundingClientRect();
    interactionRef.current = {
      kind: 'toolbar',
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    event.preventDefault();
  }, []);

  const onSurfaceClick = useCallback(
    (event: ReactMouseEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest(
          '.designer-node, .designer-connector-hit, .designer-toolbar, .designer-entry, .designer-ghost-node'
        )
      ) {
        return;
      }
      if (entryRef.current.open) {
        closeEntry();
      }
      setSelectedConnectorId(undefined);
      setSelectedNodeId(undefined);
    },
    [closeEntry]
  );

  // ── Toolbar ────────────────────────────────────────────────────────────────

  const toolButton = (
    action: string,
    icon: IconName,
    title: string,
    options?: { disabled?: boolean; hidden?: boolean; active?: boolean; busy?: boolean; onClick?: () => void }
  ) => (
    <button
      key={action}
      type="button"
      className={`designer-tool-btn${options?.active ? ' is-active' : ''}${options?.hidden ? ' is-hidden' : ''}`}
      title={title}
      aria-label={title}
      data-testid={`designer-tool-${action}`}
      disabled={options?.disabled || options?.busy}
      onClick={options?.onClick}
    >
      <Icon name={icon} size={15} />
    </button>
  );

  const hasRecommendation = Boolean(recommendation);
  const applying = busy === 'apply';

  // ── Render ─────────────────────────────────────────────────────────────────

  const zoom = canvas.zoom || 1;

  const connectorPaths = canvas.connectors
    .map(connector => {
      const sourceNode = canvas.nodes.find(node => node.id === connector.sourceNodeId);
      const targetNode = canvas.nodes.find(node => node.id === connector.targetNodeId);
      if (!sourceNode || !targetNode) {
        return undefined;
      }
      const sourcePreview = preview?.nodeById.get(sourceNode.id);
      const targetPreview = preview?.nodeById.get(targetNode.id);
      const sourceBox = boxForNode(sourceNode, sourcePreview);
      const targetBox = boxForNode(targetNode, targetPreview);
      const directions = resolveConnectorDirections(
        sourceBox,
        targetBox,
        connector.sourceDirection,
        connector.targetDirection
      );
      const sourcePoint = anchorPoint(sourceBox, directions.sourceDirection);
      const targetPoint = anchorPoint(targetBox, directions.targetDirection);
      return {
        connector,
        selected: selectedConnectorId === connector.id,
        d: buildConnectorCurvePath(
          sourcePoint.x,
          sourcePoint.y,
          targetPoint.x,
          targetPoint.y,
          directions.sourceDirection,
          directions.targetDirection
        )
      };
    })
    .filter((entryItem): entryItem is NonNullable<typeof entryItem> => Boolean(entryItem));

  const previewConnectorPaths = (preview?.connectors ?? [])
    .map(connector => {
      const sourceNode = preview?.nodeById.get(connector.sourceNodeId) ?? canvas.nodes.find(node => node.id === connector.sourceNodeId);
      const targetNode = preview?.nodeById.get(connector.targetNodeId) ?? canvas.nodes.find(node => node.id === connector.targetNodeId);
      if (!sourceNode || !targetNode) {
        return undefined;
      }
      const sourceBox = boxForNode(sourceNode, preview?.nodeById.get(sourceNode.id));
      const targetBox = boxForNode(targetNode, preview?.nodeById.get(targetNode.id));
      const directions = resolveConnectorDirections(sourceBox, targetBox);
      const sourcePoint = anchorPoint(sourceBox, directions.sourceDirection);
      const targetPoint = anchorPoint(targetBox, directions.targetDirection);
      return {
        id: connector.id,
        d: buildConnectorCurvePath(
          sourcePoint.x,
          sourcePoint.y,
          targetPoint.x,
          targetPoint.y,
          directions.sourceDirection,
          directions.targetDirection
        )
      };
    })
    .filter((entryItem): entryItem is NonNullable<typeof entryItem> => Boolean(entryItem));

  let linkPreviewPath: string | undefined;
  if (linkPreview) {
    const deltaX = linkPreview.x2 - linkPreview.x1;
    const deltaY = linkPreview.y2 - linkPreview.y1;
    const previewTargetDirection: TaskDesignerLinkHandleDirection =
      Math.abs(deltaX) >= Math.abs(deltaY) ? (deltaX >= 0 ? 'left' : 'right') : deltaY >= 0 ? 'top' : 'bottom';
    linkPreviewPath = buildConnectorCurvePath(
      linkPreview.x1,
      linkPreview.y1,
      linkPreview.x2,
      linkPreview.y2,
      linkPreview.sourceDirection,
      previewTargetDirection
    );
  }

  const renderNode = (node: TaskDesignerCanvasNode) => {
    const previewNode = preview?.nodeById.get(node.id);
    const rendered = previewNode ?? node;
    const order = preview?.orderById.get(node.id);
    const classes = [
      'designer-node',
      `designer-node--${node.type}`,
      selectedNodeId === node.id ? 'is-selected' : '',
      linkPreview?.sourceNodeId === node.id ? 'linking-source' : '',
      order !== undefined ? 'is-recommendation-preview' : ''
    ]
      .filter(Boolean)
      .join(' ');
    const style: CSSProperties = {
      left: rendered.x,
      top: rendered.y,
      ...(node.type !== 'ticket' ? { width: node.width, height: node.height } : {})
    };

    return (
      <article
        key={node.id}
        ref={nodeRefCallback(node.id)}
        className={classes}
        style={style}
        data-node-id={node.id}
        data-testid="designer-node"
        onPointerDown={event => onNodePointerDown(node, event)}
        onClick={event => onNodeClick(node, event)}
      >
        <div
          className={`designer-node-header designer-node-header--${node.type}${order !== undefined ? ' has-order-badge' : ''}`}
          style={
            node.type === 'ticket'
              ? ticketHeaderStyle(node.issueType)
              : node.type === 'website'
                ? { background: websiteHeaderBackground() }
                : undefined
          }
        >
          {node.type === 'ticket' && order !== undefined && (
            <span className="designer-order-badge" data-testid="designer-order-badge" aria-label={`AI execution order ${order}`}>
              {order}
            </span>
          )}
          <div className="designer-node-title-wrap">
            {node.type === 'note' ? (
              <input
                type="text"
                className="designer-note-title-input"
                value={node.title}
                placeholder="Notes"
                aria-label="Note title"
                onClick={event => event.stopPropagation()}
                onFocus={() => {
                  setSelectedNodeId(node.id);
                  setSelectedConnectorId(undefined);
                }}
                onChange={event => {
                  const title = event.target.value;
                  mutateCanvas(current => ({
                    ...current,
                    nodes: current.nodes.map(item =>
                      item.id === node.id && item.type === 'note' ? { ...item, title } : item
                    )
                  }));
                }}
              />
            ) : (
              <div className="designer-node-key">
                {node.type === 'website' ? websitePreviewTitle(node.url) : node.issueKey}
              </div>
            )}
          </div>
          <button
            type="button"
            className="designer-node-delete"
            aria-label={`Delete ${nodeLabel(node)} node`}
            onPointerDown={event => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={event => {
              event.stopPropagation();
              deleteNode(node);
            }}
          >
            <Icon name="close" size={10} strokeWidth={1.8} />
          </button>
        </div>

        {node.type === 'note' && (
          <div className="designer-note-body">
            <textarea
              className="designer-note-textarea"
              placeholder="Add notes, context, or reminders..."
              aria-label="Note content"
              value={node.content}
              onClick={event => event.stopPropagation()}
              onFocus={() => {
                setSelectedNodeId(node.id);
                setSelectedConnectorId(undefined);
              }}
              onChange={event => {
                const content = event.target.value;
                mutateCanvas(current => ({
                  ...current,
                  nodes: current.nodes.map(item =>
                    item.id === node.id && item.type === 'note' ? { ...item, content } : item
                  )
                }));
              }}
            />
          </div>
        )}

        {node.type === 'website' && (
          <div className="designer-website-body">
            <input
              type="url"
              className="designer-website-url-input"
              defaultValue={node.url}
              placeholder="https://example.com"
              aria-label="Website preview URL"
              onClick={event => event.stopPropagation()}
              onFocus={() => {
                setSelectedNodeId(node.id);
                setSelectedConnectorId(undefined);
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              onBlur={event => {
                const normalized = normalizeWebsitePreviewUrl(event.target.value);
                if (!normalized || normalized === node.url) {
                  return;
                }
                mutateCanvas(current => ({
                  ...current,
                  nodes: current.nodes.map(item =>
                    item.id === node.id && item.type === 'website' ? { ...item, url: normalized } : item
                  )
                }));
              }}
            />
            <div className="designer-website-frame-wrap">
              {normalizeWebsitePreviewUrl(node.url) ? (
                <iframe
                  className="designer-website-frame"
                  src={normalizeWebsitePreviewUrl(node.url)}
                  title={websitePreviewTitle(node.url)}
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                />
              ) : (
                <div className="designer-website-empty">Enter a valid http or https URL to load a preview.</div>
              )}
            </div>
          </div>
        )}

        {node.type === 'ticket' && (
          <>
            <div className="designer-node-summary">{node.summary || '(no summary)'}</div>
            <div className="designer-node-meta">
              <div className="designer-node-meta-row">
                <span>Type</span>
                <span>{node.issueType}</span>
              </div>
              <div className="designer-node-meta-row">
                <span>Status</span>
                <span>{node.status}</span>
              </div>
              {node.assignee && (
                <div className="designer-node-meta-row">
                  <span>Assignee</span>
                  <span>{node.assignee}</span>
                </div>
              )}
              {node.priority && (
                <div className="designer-node-meta-row">
                  <span>Priority</span>
                  <span>{node.priority}</span>
                </div>
              )}
            </div>
          </>
        )}

        {(node.type === 'note' || node.type === 'website') && (
          <button
            type="button"
            className="designer-node-resize"
            aria-label={`Resize ${node.type === 'note' ? 'note' : 'website preview'}`}
            onPointerDown={event => onResizePointerDown(node, event)}
          />
        )}

        {HANDLE_DIRECTIONS.map(direction => (
          <button
            key={direction}
            type="button"
            className={`designer-node-handle designer-node-handle--${direction}`}
            data-node-id={node.id}
            data-direction={direction}
            aria-label={`Create link from ${nodeLabel(node)} ${direction} connector`}
            onPointerDown={event => onHandlePointerDown(node, direction, event)}
          />
        ))}
      </article>
    );
  };

  return (
    <div className="designer-page" data-testid="designer-page">
      <div className="ai-tool-header">
        <Icon name="graph" size={14} />
        <h3>Task Designer — {board.name}</h3>
        {recommendation && <span className="designer-source-pill">previewing {recommendation.sourceLabel}</span>}
        <span style={{ flex: 1 }} />
        <button className="icon-btn icon-btn-sm" aria-label="Close designer" data-testid="designer-close" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>

      <div
        className={`designer-canvas${linkPreview ? ' is-linking' : ''}`}
        data-testid="designer-canvas"
        ref={element => {
          surfaceRef.current = element;
        }}
        onDragOver={onCanvasDragOver}
        onDrop={onCanvasDrop}
        onClick={onSurfaceClick}
      >
        <svg
          className="designer-connectors-layer"
          ref={connectorsLayerRef}
          aria-hidden="true"
          style={{ transform: `scale(${zoom})` }}
        >
          <defs>
            <marker id="designer-arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
              <polygon points="0 0, 8 3, 0 6" className="designer-arrowhead" />
            </marker>
            <marker id="designer-arrowhead-selected" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
              <polygon points="0 0, 8 3, 0 6" className="designer-arrowhead-selected" />
            </marker>
          </defs>
          {connectorPaths.map(({ connector, selected, d }) => (
            <g key={connector.id} className={`designer-connector-group${selected ? ' is-selected' : ''}`}>
              <path
                className="designer-connector-line"
                d={d}
                markerEnd={selected ? 'url(#designer-arrowhead-selected)' : 'url(#designer-arrowhead)'}
              />
              <path
                className="designer-connector-hit"
                data-testid="designer-connector-hit"
                data-connector-id={connector.id}
                d={d}
                onClick={event => {
                  event.stopPropagation();
                  setSelectedConnectorId(connector.id);
                  setSelectedNodeId(undefined);
                }}
              />
            </g>
          ))}
          {previewConnectorPaths.map(({ id, d }) => (
            <path key={id} className="designer-connector-preview" d={d} markerEnd="url(#designer-arrowhead-selected)" />
          ))}
          {linkPreviewPath && <path className="designer-connector-link-preview" d={linkPreviewPath} markerEnd="url(#designer-arrowhead-selected)" />}
        </svg>

        <div className="designer-nodes-layer" ref={nodesLayerRef} style={{ transform: `scale(${zoom})` }}>
          {preview && (
            <div
              className="designer-lane"
              data-testid="designer-lane"
              style={{
                left: preview.lane.x,
                top: preview.lane.y,
                width: preview.lane.width,
                height: preview.lane.height
              }}
            >
              <div className="designer-lane-label">Recommended flow</div>
            </div>
          )}
          {loaded && canvas.nodes.map(renderNode)}
          {preview?.ghostNodes.map(node => {
            const order = preview.orderById.get(node.id);
            return (
              <article
                key={`ghost-${node.id}`}
                className="designer-node designer-node--ticket designer-ghost-node"
                data-testid="designer-ghost-node"
                style={{ left: node.x, top: node.y }}
              >
                <div
                  className={`designer-node-header designer-node-header--ticket${order !== undefined ? ' has-order-badge' : ''}`}
                  style={ticketHeaderStyle(node.issueType)}
                >
                  {order !== undefined && (
                    <span className="designer-order-badge" aria-label={`AI execution order ${order}`}>
                      {order}
                    </span>
                  )}
                  <div className="designer-node-title-wrap">
                    <div className="designer-node-key">{node.issueKey}</div>
                  </div>
                </div>
                <div className="designer-node-summary">{node.summary || '(no summary)'}</div>
              </article>
            );
          })}
        </div>

        <div
          className="designer-toolbar"
          style={{ left: canvas.toolbarPosition.x, top: canvas.toolbarPosition.y }}
          aria-label="Task Designer tools"
        >
          <div
            className="designer-toolbar-handle"
            title="Drag toolbar"
            aria-label="Drag toolbar"
            onPointerDown={onToolbarGripPointerDown}
          >
            <span className="designer-toolbar-grip" aria-hidden="true" />
          </div>
          <div className="designer-toolbar-group">
            {toolButton('select', 'cursor', 'Select', {
              active: activeTool === 'select',
              onClick: () => {
                setActiveTool('select');
                setLinkPreview(undefined);
                linkPreviewRef.current = undefined;
                closeEntry();
                setFeedback('Select mode active.');
              }
            })}
            {toolButton('ticket', 'ticket', 'Add ticket', { onClick: () => openEntry('ticket') })}
            {toolButton('note', 'note', 'Add note', {
              onClick: () => {
                closeEntry();
                addNoteNode();
              }
            })}
            {toolButton('website', 'globe', 'Add website preview', { onClick: () => openEntry('website') })}
            {toolButton('link', 'link', 'Link tickets', {
              active: activeTool === 'link',
              onClick: () => {
                setActiveTool('link');
                closeEntry();
                setFeedback('Link mode active. Select source node, then target node.');
              }
            })}
            {toolButton('zoom-in', 'zoom-in', 'Zoom in', { onClick: () => setZoom(zoom + ZOOM_STEP) })}
            {toolButton('zoom-out', 'zoom-out', 'Zoom out', { onClick: () => setZoom(zoom - ZOOM_STEP) })}
          </div>
          <div className="designer-toolbar-separator" />
          <div className="designer-toolbar-group">
            {toolButton('delete-connector', 'trash', 'Delete selected link', {
              disabled: !selectedConnectorId,
              onClick: deleteSelectedConnector
            })}
            {toolButton('master-plan', 'file', 'Generate master plan', {
              busy: busy === 'masterPlan',
              onClick: () => void requestGenerateMasterPlan()
            })}
            {toolButton('recommend-flow', 'sparkles', 'AI recommend flow', {
              busy: busy === 'recommend',
              onClick: () => void requestRecommendFlow()
            })}
            {toolButton('recommend-board', 'graph', 'AI recommend from board', {
              busy: busy === 'recommendBoard',
              onClick: () => void requestRecommendBoardFlow()
            })}
            {toolButton('apply-recommendation', 'check', 'Apply AI recommendation', {
              hidden: !hasRecommendation && !applying,
              disabled: !hasRecommendation || applying,
              onClick: () => void requestApplyRecommendation()
            })}
            {toolButton('discard-recommendation', 'close', 'Discard AI recommendation', {
              hidden: !hasRecommendation && !applying,
              disabled: !hasRecommendation || applying,
              onClick: requestDiscardRecommendation
            })}
          </div>
          <div className="designer-toolbar-separator" />
          <div className="designer-toolbar-group">
            {toolButton('reset', 'refresh', 'Clear canvas', { onClick: clearCanvas })}
          </div>
        </div>

        {entry.open && (
          <form
            className="designer-entry"
            data-testid="designer-entry"
            style={{ left: canvas.toolbarPosition.x + 72, top: canvas.toolbarPosition.y }}
            autoComplete="off"
            onSubmit={event => {
              event.preventDefault();
              void submitEntry();
            }}
          >
            <label className="sr-only" htmlFor="designer-entry-input">
              {entry.mode === 'website' ? 'Website URL' : 'Ticket number'}
            </label>
            <input
              id="designer-entry-input"
              data-testid="designer-entry-input"
              type="text"
              autoFocus
              placeholder={entry.mode === 'website' ? 'https://example.com' : 'Ticket number (e.g. APP-123)'}
              aria-label={entry.mode === 'website' ? 'Website URL' : 'Ticket number'}
              value={entryValue}
              onChange={event => setEntryValue(event.target.value)}
            />
            <button
              type="submit"
              className="designer-tool-btn designer-tool-btn--accent"
              title={entry.mode === 'website' ? 'Confirm add website preview' : 'Confirm add ticket'}
              aria-label={entry.mode === 'website' ? 'Confirm add website preview' : 'Confirm add ticket'}
              data-testid="designer-entry-confirm"
            >
              <Icon name="check" size={15} />
            </button>
            <button
              type="button"
              className="designer-tool-btn"
              title="Close ticket entry"
              aria-label="Close ticket entry"
              data-testid="designer-entry-close"
              onClick={closeEntry}
            >
              <Icon name="close" size={15} />
            </button>
          </form>
        )}

        <div className="designer-feedback-overlay">
          <div
            className={`designer-feedback${feedback?.isError ? ' error' : ''}${feedback ? ' has-message' : ''}`}
            data-testid="designer-feedback"
            aria-live="polite"
          >
            {feedback?.text ?? ''}
          </div>
        </div>
      </div>
    </div>
  );
}
