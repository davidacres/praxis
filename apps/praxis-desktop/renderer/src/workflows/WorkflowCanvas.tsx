import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiscoveredAgentProfile, DiscoveredSkill, WorkflowDefinition, WorkflowNode, WorkflowNodeType } from '@praxis/core';
import {
  anchorPoint,
  buildConnectorCurvePath,
  resolveConnectorDirections,
  type CanvasBox
} from '../taskDesigner/taskDesignerState';
import { addNode, autoArrange, connectNodes, disconnect, moveNode, newNode, removeNode } from './workflowEdits';
import { Icon, type IconName } from '../ui/Icon';
import { skillTitle } from '../agents/agentCatalog';

export const NODE_KINDS: Array<{ type: WorkflowNodeType; label: string; icon: IconName; description: string }> = [
  { type: 'agent-task', label: 'Agent stage', icon: 'robot', description: 'Autonomous agent task stage' },
  { type: 'check', label: 'Check', icon: 'shield', description: 'Verification, test, or security gate' },
  { type: 'approval', label: 'Approval', icon: 'check-square', description: 'Manual human sign-off gate' },
  { type: 'deployment', label: 'Deployment', icon: 'rocket', description: 'Deployment or release step' },
  { type: 'join', label: 'Join', icon: 'split-horizontal', description: 'Parallel branches synchronizer' }
];

/**
 * Pan/zoom canvas for the workflow designer (FX-BE-023 / TASK-110).
 *
 * Nodes are cards positioned by their stored x/y; edges are curves drawn with
 * the Task Designer connector geometry. Dragging a card persists its position;
 * dragging from a card's handle onto another card creates an edge. Selecting a
 * card raises the shared inspector — the canvas only edits shape and layout.
 *
 * The structured list stays available as an alternative view in the parent.
 */

const NODE_W = 190;
const NODE_H = 92;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;

export interface WorkflowNodePresentation {
  agent?: string;
  skills?: string[];
}

export type WorkflowPaletteItem =
  | { kind: 'agent'; profileId: string }
  | { kind: 'skill'; skillName: string }
  | { kind: 'stage'; nodeType: WorkflowNodeType };


export interface WorkflowCanvasProps {
  definition: WorkflowDefinition;
  selectedNodeId: string | undefined;
  selectedEdgeId?: string | undefined;
  issuesByNode: Record<string, number>;
  presentations?: Record<string, WorkflowNodePresentation>;
  agents?: DiscoveredAgentProfile[];
  skills?: DiscoveredSkill[];
  selectedAgentStageName?: string;
  onChange: (next: WorkflowDefinition) => void;
  onSelectNode: (nodeId: string | undefined) => void;
  onSelectEdge?: (edgeId: string | undefined) => void;
  onAddAgentStage?: (profileId: string) => void;
  onUseSkill?: (skillName: string) => void;
  /** Receives agents dropped onto the canvas and skills dropped onto a stage. */
  onPaletteDrop?: (item: WorkflowPaletteItem, targetNodeId: string | undefined, at: { x: number; y: number }) => void;
}

export function WorkflowCanvas({
  definition,
  selectedNodeId,
  selectedEdgeId: controlledSelectedEdgeId,
  issuesByNode,
  presentations = {},
  agents = [],
  skills = [],
  selectedAgentStageName,
  onChange,
  onSelectNode,
  onSelectEdge,
  onAddAgentStage,
  onUseSkill,
  onPaletteDrop
}: WorkflowCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 40, y: 40, zoom: 1 });
  const [localSelectedEdgeId, setLocalSelectedEdgeId] = useState<string | undefined>();
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | undefined>();
  const selectedEdgeId = controlledSelectedEdgeId !== undefined ? controlledSelectedEdgeId : localSelectedEdgeId;

  const setSelectedEdgeId = useCallback(
    (edgeId: string | undefined) => {
      setLocalSelectedEdgeId(edgeId);
      onSelectEdge?.(edgeId);
    },
    [onSelectEdge]
  );

  useEffect(() => {
    if (!selectedEdgeId && !selectedNodeId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Only keys aimed at the canvas itself: a Backspace in the inspector, a picker, or a
      // dialog must never delete the selected stage behind it.
      const target = event.target as HTMLElement | null;
      if (target && target !== document.body && !surfaceRef.current?.contains(target)) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        if (selectedEdgeId) {
          onChange(disconnect(definition, selectedEdgeId));
          setSelectedEdgeId(undefined);
        } else if (selectedNodeId) {
          onChange(removeNode(definition, selectedNodeId));
          onSelectNode(undefined);
        }
      } else if (event.key === 'Escape') {
        if (selectedEdgeId) setSelectedEdgeId(undefined);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedEdgeId, selectedNodeId, definition, onChange, setSelectedEdgeId, onSelectNode]);

  const [activeTool, setActiveTool] = useState<'select'>('select');
  const [activeSubmenu, setActiveSubmenu] = useState<'agents' | 'skills' | undefined>();
  const [agentQuery, setAgentQuery] = useState('');
  const [skillQuery, setSkillQuery] = useState('');
  const [toolbarPosition, setToolbarPosition] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = localStorage.getItem('praxis-workflow-toolbar-pos');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
          return parsed;
        }
      }
    } catch {}
    return { x: 16, y: 16 };
  });

  useEffect(() => {
    if (!activeSubmenu) {
      setAgentQuery('');
      setSkillQuery('');
    }
  }, [activeSubmenu]);

  const filteredAgents = useMemo(() => {
    if (agents.length <= 10 || !agentQuery.trim()) return agents;
    const q = agentQuery.trim().toLowerCase();
    return agents.filter(
      profile =>
        profile.profile.name.toLowerCase().includes(q) ||
        (profile.profile.description && profile.profile.description.toLowerCase().includes(q))
    );
  }, [agents, agentQuery]);

  const filteredSkills = useMemo(() => {
    if (skills.length <= 10 || !skillQuery.trim()) return skills;
    const q = skillQuery.trim().toLowerCase();
    return skills.filter(
      skill =>
        skillTitle(skill.metadata).toLowerCase().includes(q) ||
        skill.metadata.name.toLowerCase().includes(q) ||
        (skill.metadata.description && skill.metadata.description.toLowerCase().includes(q))
    );
  }, [skills, skillQuery]);

  useEffect(() => {
    if (!activeSubmenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.designer-tool-submenu-wrap')) return;
      setActiveSubmenu(undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveSubmenu(undefined);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeSubmenu]);

  const toolbarDragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  const onToolbarHandlePointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    setActiveSubmenu(undefined);
    const toolbar = (event.currentTarget as HTMLElement).closest('.designer-toolbar');
    if (!toolbar) return;
    const rect = toolbar.getBoundingClientRect();
    toolbarDragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.stopPropagation();
    event.preventDefault();
  }, []);

  const onToolbarHandlePointerMove = useCallback((event: React.PointerEvent) => {
    const dragInfo = toolbarDragRef.current;
    if (!dragInfo || dragInfo.pointerId !== event.pointerId) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const surfaceRect = surface.getBoundingClientRect();
    const nextX = Math.max(8, Math.min(surfaceRect.width - 50, event.clientX - surfaceRect.left - dragInfo.offsetX));
    const nextY = Math.max(8, Math.min(surfaceRect.height - 120, event.clientY - surfaceRect.top - dragInfo.offsetY));
    const nextPos = { x: nextX, y: nextY };
    setToolbarPosition(nextPos);
    try {
      localStorage.setItem('praxis-workflow-toolbar-pos', JSON.stringify(nextPos));
    } catch {}
  }, []);

  const onToolbarHandlePointerUp = useCallback((event: React.PointerEvent) => {
    if (toolbarDragRef.current?.pointerId === event.pointerId) {
      toolbarDragRef.current = null;
      try {
        (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
      } catch {}
    }
  }, []);

  const onAddStage = useCallback(
    (type: WorkflowNodeType) => {
      const node = newNode(type, {
        x: Math.max(40, Math.round(-view.x / view.zoom + 120)),
        y: Math.max(40, Math.round(-view.y / view.zoom + 120 + definition.nodes.length * 30))
      });
      onChange(addNode(definition, node));
      onSelectNode(node.id);
    },
    [view.x, view.y, view.zoom, definition, onChange, onSelectNode]
  );

  const onDeleteSelected = useCallback(() => {
    if (selectedEdgeId) {
      onChange(disconnect(definition, selectedEdgeId));
      setSelectedEdgeId(undefined);
    } else if (selectedNodeId) {
      onChange(removeNode(definition, selectedNodeId));
      onSelectNode(undefined);
    }
  }, [selectedEdgeId, selectedNodeId, definition, onChange, setSelectedEdgeId, onSelectNode]);

  const [drag, setDrag] = useState<
    | { kind: 'pan'; startX: number; startY: number; originX: number; originY: number }
    | { kind: 'node'; nodeId: string; offsetX: number; offsetY: number }
    | { kind: 'link'; from: string; x: number; y: number }
    | undefined
  >();

  const boxes = useMemo<Record<string, CanvasBox>>(() => {
    const map: Record<string, CanvasBox> = {};
    for (const node of definition.nodes) map[node.id] = { x: node.x, y: node.y, width: NODE_W, height: NODE_H };
    return map;
  }, [definition.nodes]);

  const toCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      const left = rect?.left ?? 0;
      const top = rect?.top ?? 0;
      return {
        x: (clientX - left - view.x) / view.zoom,
        y: (clientY - top - view.y) / view.zoom
      };
    },
    [view]
  );

  const onSurfacePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      const target = event.target as HTMLElement | SVGElement | null;
      if (
        target?.closest('[data-node-id]') ||
        target?.closest('.wf-canvas-edge-group') ||
        target?.closest('.designer-toolbar') ||
        target?.closest('button') ||
        target?.closest('input')
      ) {
        return;
      }
      setSelectedEdgeId(undefined);
      onSelectNode(undefined);
      setDrag({ kind: 'pan', startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y });
      surfaceRef.current?.setPointerCapture(event.pointerId);
    },
    [view.x, view.y, setSelectedEdgeId, onSelectNode]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!drag) return;
      if (drag.kind === 'pan') {
        setView(current => ({
          ...current,
          x: drag.originX + (event.clientX - drag.startX),
          y: drag.originY + (event.clientY - drag.startY)
        }));
        return;
      }
      const point = toCanvas(event.clientX, event.clientY);
      if (drag.kind === 'node') {
        onChange(moveNode(definition, drag.nodeId, { x: point.x - drag.offsetX, y: point.y - drag.offsetY }));
      } else if (drag.kind === 'link') {
        setDrag({ ...drag, x: point.x, y: point.y });
      }
    },
    [drag, definition, onChange, toCanvas]
  );

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      if (drag?.kind === 'pan') {
        try {
          surfaceRef.current?.releasePointerCapture(event.pointerId);
        } catch {}
      }
      if (drag?.kind === 'link') {
        const target = (event.target as HTMLElement).closest('[data-node-id]')?.getAttribute('data-node-id');
        if (target && target !== drag.from) onChange(connectNodes(definition, { from: drag.from, to: target }));
      }
      setDrag(undefined);
    },
    [drag, definition, onChange]
  );

  const onWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      // Pinch to zoom or Ctrl+wheel: zoom centered at pointer
      const rect = surfaceRef.current?.getBoundingClientRect();
      const clientX = event.clientX;
      const clientY = event.clientY;
      const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
      setView(current => {
        const zoom = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor)) * 100) / 100;
        if (!rect) return { ...current, zoom };
        const pointerX = clientX - rect.left;
        const pointerY = clientY - rect.top;
        const scale = zoom / current.zoom;
        return {
          x: pointerX - (pointerX - current.x) * scale,
          y: pointerY - (pointerY - current.y) * scale,
          zoom
        };
      });
    } else {
      // Normal trackpad drag or scroll wheel: pan the canvas
      setView(current => ({
        ...current,
        x: Math.round(current.x - event.deltaX),
        y: Math.round(current.y - event.deltaY)
      }));
    }
  }, []);

  /** Toolbar zoom — keeps the centre of the visible surface where it is. */
  const zoomBy = useCallback((factor: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    setView(current => {
      const zoom = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor)) * 100) / 100;
      if (!rect) return { ...current, zoom };
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const scale = zoom / current.zoom;
      return { x: cx - (cx - current.x) * scale, y: cy - (cy - current.y) * scale, zoom };
    });
  }, []);

  const onPaletteDragOver = useCallback((event: React.DragEvent) => {
    if (event.dataTransfer.types.includes('application/x-praxis-workflow-palette')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handlePaletteDrop = useCallback(
    (event: React.DragEvent) => {
      const raw = event.dataTransfer.getData('application/x-praxis-workflow-palette');
      if (!raw || !onPaletteDrop) return;
      try {
        const item = JSON.parse(raw) as WorkflowPaletteItem;
        if (item.kind !== 'agent' && item.kind !== 'skill' && item.kind !== 'stage') return;
        event.preventDefault();
        // Use elementsFromPoint to find the node even when the submenu overlays the canvas.
        const elements = document.elementsFromPoint(event.clientX, event.clientY);
        const nodeEl = elements.find(el => el instanceof HTMLElement && el.dataset.nodeId) as HTMLElement | undefined;
        const targetNodeId = nodeEl?.dataset.nodeId;
        onPaletteDrop(item, targetNodeId, toCanvas(event.clientX, event.clientY));
      } catch {
        // Ignore a malformed external drag; only the local palette writes this MIME type.
      }
    },
    [onPaletteDrop, toCanvas]
  );

  const edgePaths = definition.edges.map(edge => {
    const source = boxes[edge.from];
    const target = boxes[edge.to];
    if (!source || !target) return null;
    const dirs = resolveConnectorDirections(source, target);
    const from = anchorPoint(source, dirs.sourceDirection);
    const to = anchorPoint(target, dirs.targetDirection);
    const fromNode = definition.nodes.find(n => n.id === edge.from);
    const toNode = definition.nodes.find(n => n.id === edge.to);
    return {
      id: edge.id,
      d: buildConnectorCurvePath(from.x, from.y, to.x, to.y, dirs.sourceDirection, dirs.targetDirection),
      midX: (from.x + to.x) / 2,
      midY: (from.y + to.y) / 2,
      dead: edge.on === 'failure',
      fromName: fromNode?.name ?? edge.from,
      toName: toNode?.name ?? edge.to
    };
  });

  const linkPreview =
    drag?.kind === 'link' && boxes[drag.from]
      ? buildConnectorCurvePath(
          anchorPoint(boxes[drag.from], 'right').x,
          anchorPoint(boxes[drag.from], 'right').y,
          drag.x,
          drag.y,
          'right',
          'left'
        )
      : undefined;

  const containerWidth = surfaceRef.current?.clientWidth ?? 0;
  const spaceLeft = toolbarPosition.x;
  const spaceRight = Math.max(0, containerWidth - (toolbarPosition.x + 47));
  const isSubmenuLeft = containerWidth > 0 && spaceLeft > spaceRight;

  return (
    <div className="wf-canvas" onDragOver={onPaletteDragOver} onDrop={handlePaletteDrop}>
      <p id="wf-canvas-help" className="sr-only">
        Each stage is a button. Press Tab to move between stages, Enter or Space to select one
        and open its inspector, and the arrow keys to nudge the selected stage (hold Shift for a
        larger step). Connections are made with a pointer from a stage's handle. Select a
        connection to set its outcome in the inspector, or press Delete to remove it.
      </p>
      <div
        ref={surfaceRef}
        role="application"
        aria-label="Workflow canvas"
        aria-describedby="wf-canvas-help"
        className={`designer-canvas wf-canvas-surface${drag?.kind === 'pan' ? ' is-panning' : ''}`}
        onPointerDown={onSurfacePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onWheel={onWheel}
        onDragOver={onPaletteDragOver}
        onDrop={handlePaletteDrop}
      >
        <div
          className="wf-canvas-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
        >
          <svg width={4000} height={4000} className="wf-canvas-edges-layer">
            <defs>
              <marker
                id="wf-arrowhead"
                markerWidth={7}
                markerHeight={5}
                refX={6.5}
                refY={2.5}
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <polygon points="0 0, 7 2.5, 0 5" fill="var(--text-tertiary)" />
              </marker>
              <marker
                id="wf-arrowhead-selected"
                markerWidth={7}
                markerHeight={5}
                refX={6.5}
                refY={2.5}
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <polygon points="0 0, 7 2.5, 0 5" fill="var(--accent)" />
              </marker>
              <marker
                id="wf-arrowhead-danger"
                markerWidth={7}
                markerHeight={5}
                refX={6.5}
                refY={2.5}
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <polygon points="0 0, 7 2.5, 0 5" fill="var(--danger)" />
              </marker>
            </defs>

            {edgePaths.filter(Boolean).map(edge => {
              const isSelected = selectedEdgeId === edge!.id;
              const isHovered = hoveredEdgeId === edge!.id;
              const stroke = isSelected
                ? 'var(--accent)'
                : edge!.dead
                  ? 'var(--danger)'
                  : isHovered
                    ? 'var(--accent)'
                    : 'var(--border-strong, var(--text-dim))';
              const marker = isSelected
                ? 'url(#wf-arrowhead-selected)'
                : edge!.dead
                  ? 'url(#wf-arrowhead-danger)'
                  : 'url(#wf-arrowhead)';
              return (
                <g
                  key={edge!.id}
                  className={`wf-canvas-edge-group${isSelected ? ' is-selected' : ''}${isHovered ? ' is-hovered' : ''}`}
                  data-testid={`wf-canvas-edge-${edge!.id}`}
                >
                  <path
                    d={edge!.d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={isSelected || isHovered ? 2.5 : 1.5}
                    strokeDasharray={edge!.dead ? '4 3' : undefined}
                    markerEnd={marker}
                    className="wf-canvas-edge-line"
                    data-testid={`wf-canvas-edge-line-${edge!.id}`}
                    aria-label={`Connection from ${edge!.fromName} to ${edge!.toName}`}
                    style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                    onPointerEnter={() => setHoveredEdgeId(edge!.id)}
                    onPointerLeave={() => setHoveredEdgeId(current => (current === edge!.id ? undefined : current))}
                    onClick={event => {
                      event.stopPropagation();
                      setSelectedEdgeId(edge!.id);
                    }}
                  />
                  <path
                    d={edge!.d}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={16}
                    opacity={0.001}
                    className="wf-canvas-edge-hit"
                    style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                    data-testid={`wf-canvas-edge-hit-${edge!.id}`}
                    aria-label={`Hit area for connection from ${edge!.fromName} to ${edge!.toName}`}
                    onPointerEnter={() => setHoveredEdgeId(edge!.id)}
                    onPointerLeave={() => setHoveredEdgeId(current => (current === edge!.id ? undefined : current))}
                    onClick={event => {
                      event.stopPropagation();
                      setSelectedEdgeId(edge!.id);
                    }}
                  />
                </g>
              );
            })}
            {linkPreview && (
              <path d={linkPreview} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="4 3" markerEnd="url(#wf-arrowhead-selected)" />
            )}
          </svg>

          {/* Edge delete action button overlay */}
          {edgePaths.filter(Boolean).map(edge => {
            const isSelected = selectedEdgeId === edge!.id;
            const isHovered = hoveredEdgeId === edge!.id;
            if (!isSelected && !isHovered) return null;
            return (
              <div
                key={`action-${edge!.id}`}
                className={`wf-edge-action${isSelected ? ' is-selected' : ''}`}
                style={{
                  position: 'absolute',
                  left: edge!.midX,
                  top: edge!.midY,
                  transform: 'translate(-50%, -50%)',
                  zIndex: 20
                }}
                onPointerEnter={() => setHoveredEdgeId(edge!.id)}
                onPointerLeave={() => setHoveredEdgeId(current => (current === edge!.id ? undefined : current))}
              >
                <button
                  type="button"
                  className="wf-edge-delete-btn"
                  title={`Delete connection from ${edge!.fromName} to ${edge!.toName}`}
                  aria-label={`Delete connection from ${edge!.fromName} to ${edge!.toName}`}
                  data-testid={`wf-edge-delete-${edge!.id}`}
                  onClick={event => {
                    event.stopPropagation();
                    onChange(disconnect(definition, edge!.id));
                    setSelectedEdgeId(undefined);
                    setHoveredEdgeId(undefined);
                  }}
                >
                  <Icon name="trash" size={11} />
                  <span>Delete</span>
                </button>
              </div>
            );
          })}

          {definition.nodes.map(node => {
            const selected = node.id === selectedNodeId;
            const isEntry = node.id === definition.entryNodeId;
            const issues = issuesByNode[node.id] ?? 0;
            const presentation = presentations[node.id];
            const specialistSummary = presentation?.agent
              ? `, agent ${presentation.agent}${presentation.skills?.length ? `, skills ${presentation.skills.join(', ')}` : ''}`
              : '';
            return (
              <div
                key={node.id}
                data-node-id={node.id}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                className={`wf-node wf-node--${node.type}${selected ? ' is-selected' : ''}`}
                aria-label={`${node.name} (${node.type})${isEntry ? ', entry stage' : ''}${
                  issues > 0 ? `, ${issues} issue${issues === 1 ? '' : 's'}` : ''
                }${specialistSummary}`}
                onPointerDown={event => {
                  event.stopPropagation();
                  setSelectedEdgeId(undefined);
                  const point = toCanvas(event.clientX, event.clientY);
                  setDrag({ kind: 'node', nodeId: node.id, offsetX: point.x - node.x, offsetY: point.y - node.y });
                  onSelectNode(node.id);
                }}
                onKeyDown={event => {
                  if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault();
                    onChange(removeNode(definition, node.id));
                    if (selectedNodeId === node.id) onSelectNode(undefined);
                    return;
                  }
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectNode(node.id);
                  }
                  const step = event.shiftKey ? 20 : 4;
                  const nudge: Record<string, [number, number]> = {
                    ArrowLeft: [-step, 0],
                    ArrowRight: [step, 0],
                    ArrowUp: [0, -step],
                    ArrowDown: [0, step]
                  };
                  if (nudge[event.key]) {
                    event.preventDefault();
                    onChange(moveNode(definition, node.id, { x: node.x + nudge[event.key][0], y: node.y + nudge[event.key][1] }));
                  }
                }}
                style={{ left: node.x, top: node.y, width: NODE_W, minHeight: NODE_H }}
              >
                <div className="wf-node-header">
                  <div className="wf-node-name" title={node.name}>{node.name}</div>
                  <button
                    type="button"
                    className="wf-node-delete"
                    title={`Delete stage ${node.name}`}
                    aria-label={`Delete stage ${node.name}`}
                    data-testid={`wf-node-delete-${node.id}`}
                    onClick={event => {
                      event.stopPropagation();
                      onChange(removeNode(definition, node.id));
                      if (selectedNodeId === node.id) onSelectNode(undefined);
                    }}
                  >
                    <Icon name="trash" size={11} />
                  </button>
                </div>
                <div className="wf-node-meta">
                  <span>{node.type}</span>
                  {isEntry && <span className="wf-node-entry">entry</span>}
                  {issues > 0 && <span className="wf-node-issue">⚠ {issues}</span>}
                </div>
                {presentation?.agent && (
                  <div className="wf-node-specialist" title={`Agent: ${presentation.agent}`}>
                    <span>{presentation.agent}</span>
                    {presentation.skills?.length ? <span>{presentation.skills.join(' · ')}</span> : <span>no skills</span>}
                  </div>
                )}
                <button
                  type="button"
                  className="wf-node-handle"
                  aria-label={`Connect from ${node.name}`}
                  onPointerDown={event => {
                    event.stopPropagation();
                    const point = toCanvas(event.clientX, event.clientY);
                    setDrag({ kind: 'link', from: node.id, x: point.x, y: point.y });
                  }}
                >
                  ▸
                </button>
              </div>
            );
          })}
        </div>

        <div
          className="designer-toolbar"
          style={{ left: toolbarPosition.x, top: toolbarPosition.y }}
          aria-label="Workflow designer tools"
          data-testid="wf-designer-toolbar"
          onPointerDown={e => e.stopPropagation()}
          onWheel={e => e.stopPropagation()}
        >
          <div
            className="designer-toolbar-handle"
            title="Drag toolbar"
            aria-label="Drag toolbar"
            onPointerDown={onToolbarHandlePointerDown}
            onPointerMove={onToolbarHandlePointerMove}
            onPointerUp={onToolbarHandlePointerUp}
          >
            <span className="designer-toolbar-grip" aria-hidden="true" />
          </div>

          <div className="designer-toolbar-group" role="group" aria-label="Stages and tools">
            <button
              type="button"
              className={`designer-tool-btn${activeTool === 'select' ? ' is-active' : ''}`}
              title="Select (click or drag stages on canvas)"
              aria-label="Select"
              data-testid="wf-tool-select"
              onClick={() => {
                setActiveTool('select');
                onSelectNode(undefined);
                setSelectedEdgeId(undefined);
              }}
            >
              <Icon name="cursor" size={17} />
            </button>
            {NODE_KINDS.map(kind => (
              <button
                key={kind.type}
                type="button"
                className="designer-tool-btn"
                title={`Add ${kind.label}: ${kind.description} (click or drag to canvas)`}
                aria-label={`Add ${kind.label}`}
                data-testid={`wf-tool-${kind.type}`}
                draggable
                onDragStart={event => {
                  event.dataTransfer.effectAllowed = 'copy';
                  event.dataTransfer.setData(
                    'application/x-praxis-workflow-palette',
                    JSON.stringify({ kind: 'stage', nodeType: kind.type } satisfies WorkflowPaletteItem)
                  );
                }}
                onClick={() => onAddStage(kind.type)}
              >
                <Icon name={kind.icon} size={17} />
              </button>
            ))}
          </div>

          <div className="designer-toolbar-separator" />

          <div className="designer-toolbar-group" role="group" aria-label="Library">
            <div className="designer-tool-submenu-wrap">
              <button
                type="button"
                className={`designer-tool-btn designer-tool-btn--has-submenu${
                  activeSubmenu === 'agents' ? ' is-active' : ''
                }`}
                title="Agents (browse and add agent stages)"
                aria-label="Agents"
                aria-haspopup="true"
                aria-expanded={activeSubmenu === 'agents'}
                data-testid="wf-tool-agents"
                onClick={() => setActiveSubmenu(prev => (prev === 'agents' ? undefined : 'agents'))}
              >
                <span
                  className="designer-tool-btn-indicator-line"
                  aria-hidden="true"
                  data-testid="wf-tool-indicator-line-agents"
                />
                <Icon name="robot" size={17} />
              </button>
              {activeSubmenu === 'agents' && (
                <div
                  className={`designer-submenu${isSubmenuLeft ? ' designer-submenu--left' : ''}`}
                  role="menu"
                  aria-label="Agents"
                  data-testid="wf-submenu-agents"
                  onWheel={e => e.stopPropagation()}
                  onPointerDown={e => e.stopPropagation()}
                >
                  <div className="designer-submenu-header">
                    <span>Agents</span>
                    <span className="designer-submenu-count">
                      {agentQuery.trim() ? `${filteredAgents.length}/${agents.length}` : agents.length}
                    </span>
                  </div>
                  {agents.length > 10 && (
                    <div className="designer-submenu-search">
                      <Icon name="search" size={12} />
                      <input
                        type="search"
                        value={agentQuery}
                        onChange={e => setAgentQuery(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Escape') {
                            if (agentQuery) {
                              e.stopPropagation();
                              e.preventDefault();
                              setAgentQuery('');
                            } else {
                              setActiveSubmenu(undefined);
                            }
                            return;
                          }
                          e.stopPropagation();
                        }}
                        placeholder="Search agents…"
                        aria-label="Search agents"
                        data-testid="wf-submenu-agents-search"
                        autoFocus
                      />
                      {agentQuery && (
                        <button
                          type="button"
                          className="designer-submenu-search-clear"
                          aria-label="Clear search"
                          onClick={() => setAgentQuery('')}
                        >
                          <Icon name="close" size={10} />
                        </button>
                      )}
                    </div>
                  )}
                  <div className="designer-submenu-list">
                    {filteredAgents.length > 0 ? (
                      filteredAgents.map(profile => {
                        const blocked = profile.error || !profile.trusted;
                        const title = profile.error
                          ? `Cannot use ${profile.profile.name}: ${profile.error}`
                          : !profile.trusted
                            ? `${profile.profile.name} needs trust before it can run.`
                            : `Add ${profile.profile.name} as an agent stage${
                                profile.profile.description ? ` — ${profile.profile.description}` : ''
                              } (click or drag to canvas)`;
                        return (
                          <button
                            key={profile.profile.id}
                            type="button"
                            className="designer-submenu-item"
                            draggable={!blocked}
                            disabled={Boolean(blocked)}
                            title={title}
                            data-testid={`wf-tool-agent-${profile.profile.id}`}
                            onDragStart={event => {
                              event.dataTransfer.effectAllowed = 'copy';
                              event.dataTransfer.setData(
                                'application/x-praxis-workflow-palette',
                                JSON.stringify({ kind: 'agent', profileId: profile.profile.id } satisfies WorkflowPaletteItem)
                              );
                            }}
                            onClick={() => {
                              onAddAgentStage?.(profile.profile.id);
                              setActiveSubmenu(undefined);
                            }}
                          >
                            <span className="designer-submenu-item-icon">
                              <Icon name="robot" size={14} />
                            </span>
                            <span className="designer-submenu-item-text">{profile.profile.name}</span>
                            {blocked && (
                              <span className="designer-submenu-item-badge">
                                {profile.error ? 'error' : 'untrusted'}
                              </span>
                            )}
                          </button>
                        );
                      })
                    ) : agents.length === 0 ? (
                      <div className="designer-submenu-empty">No agent profiles found</div>
                    ) : (
                      <div className="designer-submenu-empty">No matching agents</div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="designer-tool-submenu-wrap">
              <button
                type="button"
                className={`designer-tool-btn designer-tool-btn--has-submenu${
                  activeSubmenu === 'skills' ? ' is-active' : ''
                }`}
                title="Skills (browse and attach skills)"
                aria-label="Skills"
                aria-haspopup="true"
                aria-expanded={activeSubmenu === 'skills'}
                data-testid="wf-tool-skills"
                onClick={() => setActiveSubmenu(prev => (prev === 'skills' ? undefined : 'skills'))}
              >
                <span
                  className="designer-tool-btn-indicator-line"
                  aria-hidden="true"
                  data-testid="wf-tool-indicator-line-skills"
                />
                <Icon name="sparkles" size={17} />
              </button>
              {activeSubmenu === 'skills' && (
                <div
                  className={`designer-submenu${isSubmenuLeft ? ' designer-submenu--left' : ''}`}
                  role="menu"
                  aria-label="Skills"
                  data-testid="wf-submenu-skills"
                  onWheel={e => e.stopPropagation()}
                  onPointerDown={e => e.stopPropagation()}
                >
                  <div className="designer-submenu-header">
                    <span>Skills</span>
                    <span className="designer-submenu-count">
                      {skillQuery.trim() ? `${filteredSkills.length}/${skills.length}` : skills.length}
                    </span>
                  </div>
                  {skills.length > 10 && (
                    <div className="designer-submenu-search">
                      <Icon name="search" size={12} />
                      <input
                        type="search"
                        value={skillQuery}
                        onChange={e => setSkillQuery(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Escape') {
                            if (skillQuery) {
                              e.stopPropagation();
                              e.preventDefault();
                              setSkillQuery('');
                            } else {
                              setActiveSubmenu(undefined);
                            }
                            return;
                          }
                          e.stopPropagation();
                        }}
                        placeholder="Search skills…"
                        aria-label="Search skills"
                        data-testid="wf-submenu-skills-search"
                        autoFocus
                      />
                      {skillQuery && (
                        <button
                          type="button"
                          className="designer-submenu-search-clear"
                          aria-label="Clear search"
                          onClick={() => setSkillQuery('')}
                        >
                          <Icon name="close" size={10} />
                        </button>
                      )}
                    </div>
                  )}
                  <div className="designer-submenu-list">
                    {filteredSkills.length > 0 ? (
                      filteredSkills.map(skill => {
                        const blocked = skill.error || !skill.trusted;
                        const title = blocked
                          ? `Cannot use ${skillTitle(skill.metadata)}: ${skill.error ?? 'needs trust before it can run.'}`
                          : selectedAgentStageName
                            ? `Add ${skillTitle(skill.metadata)} to ${selectedAgentStageName}${
                                skill.metadata.description ? ` — ${skill.metadata.description}` : ''
                              }`
                            : `Attach ${skillTitle(skill.metadata)} to an agent stage${
                                skill.metadata.description ? ` — ${skill.metadata.description}` : ''
                              } (click or drag to stage)`;
                        return (
                          <button
                            key={skill.metadata.name}
                            type="button"
                            className="designer-submenu-item"
                            draggable={!blocked}
                            disabled={Boolean(blocked)}
                            title={title}
                            data-testid={`wf-tool-skill-${skill.metadata.name}`}
                            onDragStart={event => {
                              event.dataTransfer.effectAllowed = 'copy';
                              event.dataTransfer.setData(
                                'application/x-praxis-workflow-palette',
                                JSON.stringify({ kind: 'skill', skillName: skill.metadata.name } satisfies WorkflowPaletteItem)
                              );
                            }}
                            onClick={() => {
                              onUseSkill?.(skill.metadata.name);
                              setActiveSubmenu(undefined);
                            }}
                          >
                            <span className="designer-submenu-item-icon">
                              <Icon name="sparkles" size={14} />
                            </span>
                            <span className="designer-submenu-item-text">{skillTitle(skill.metadata)}</span>
                            {blocked && (
                              <span className="designer-submenu-item-badge">
                                {skill.error ? 'error' : 'untrusted'}
                              </span>
                            )}
                          </button>
                        );
                      })
                    ) : skills.length === 0 ? (
                      <div className="designer-submenu-empty">No skills found</div>
                    ) : (
                      <div className="designer-submenu-empty">No matching skills</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="designer-toolbar-separator" />

          <div className="designer-toolbar-group" role="group" aria-label="Canvas controls">
            <button
              type="button"
              className="designer-tool-btn"
              data-testid="wf-auto-arrange"
              title="Auto arrange — lay stages out in dependency order without overlap"
              aria-label="Auto arrange"
              disabled={definition.nodes.length < 2}
              onClick={() => onChange(autoArrange(definition))}
            >
              <Icon name="columns" size={17} />
            </button>
            <button
              type="button"
              className="designer-tool-btn"
              data-testid="wf-tool-zoom-in"
              title="Zoom in"
              aria-label="Zoom in"
              disabled={view.zoom >= MAX_ZOOM}
              onClick={() => zoomBy(1.2)}
            >
              <Icon name="zoom-in" size={17} />
            </button>
            <button
              type="button"
              className="designer-tool-btn"
              data-testid="wf-tool-zoom-out"
              title="Zoom out"
              aria-label="Zoom out"
              disabled={view.zoom <= MIN_ZOOM}
              onClick={() => zoomBy(1 / 1.2)}
            >
              <Icon name="zoom-out" size={17} />
            </button>
            <button
              type="button"
              className="designer-tool-btn"
              data-testid="wf-tool-reset-view"
              title="Reset view (100%, back to origin)"
              aria-label="Reset view"
              onClick={() => setView({ x: 40, y: 40, zoom: 1 })}
            >
              <Icon name="refresh" size={17} />
            </button>
          </div>

          <div className="designer-toolbar-separator" />

          <div className="designer-toolbar-group" role="group" aria-label="Stage actions">
            <button
              type="button"
              className="designer-tool-btn"
              title={
                selectedEdgeId
                  ? 'Delete selected connection'
                  : selectedNodeId
                    ? 'Delete selected stage'
                    : 'Delete selected stage or connection'
              }
              aria-label={
                selectedEdgeId
                  ? 'Delete selected connection'
                  : selectedNodeId
                    ? 'Delete selected stage'
                    : 'Delete selected stage or connection'
              }
              data-testid="wf-delete-selected"
              disabled={!selectedNodeId && !selectedEdgeId}
              onClick={onDeleteSelected}
            >
              <Icon name="trash" size={17} />
            </button>
            <button
              type="button"
              className="designer-tool-btn"
              data-testid="wf-tool-help"
              title="Canvas help: Drag a card to move it; drag from its handle onto another card to connect. Click a connection to select or delete it. Drag empty space to pan. Zoom with the toolbar or pinch."
              aria-label="Canvas help"
            >
              <Icon name="info" size={17} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
