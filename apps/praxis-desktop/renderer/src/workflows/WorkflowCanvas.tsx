import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowDefinition, WorkflowNode, WorkflowNodeType } from '@praxis/core';
import {
  anchorPoint,
  buildConnectorCurvePath,
  resolveConnectorDirections,
  type CanvasBox
} from '../taskDesigner/taskDesignerState';
import { connectNodes, disconnect, moveNode, removeNode } from './workflowEdits';
import { Icon } from '../ui/Icon';

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
  onChange: (next: WorkflowDefinition) => void;
  onSelectNode: (nodeId: string | undefined) => void;
  onSelectEdge?: (edgeId: string | undefined) => void;
  /** Receives agents dropped onto the canvas and skills dropped onto a stage. */
  onPaletteDrop?: (item: WorkflowPaletteItem, targetNodeId: string | undefined, at: { x: number; y: number }) => void;
}

export function WorkflowCanvas({
  definition,
  selectedNodeId,
  selectedEdgeId: controlledSelectedEdgeId,
  issuesByNode,
  presentations = {},
  onChange,
  onSelectNode,
  onSelectEdge,
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
      const tag = (event.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
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
      setSelectedEdgeId(undefined);
      if (event.target !== surfaceRef.current) return;
      setDrag({ kind: 'pan', startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y });
      surfaceRef.current?.setPointerCapture(event.pointerId);
    },
    [view.x, view.y, setSelectedEdgeId]
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
    setView(current => {
      const zoom = Math.min(2, Math.max(0.4, current.zoom * (event.deltaY < 0 ? 1.1 : 0.9)));
      return { ...current, zoom: Math.round(zoom * 100) / 100 };
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
        const targetNodeId = (event.target as HTMLElement).closest('[data-node-id]')?.getAttribute('data-node-id') ?? undefined;
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

  return (
    <div className="wf-canvas">
      <div className="wf-canvas-bar">
        <span>Drag a card to move it, drag from its ▸ handle onto another to connect. Click a connection to delete it. Scroll to zoom.</span>
        <button type="button" className="btn btn-compact" onClick={() => setView({ x: 40, y: 40, zoom: 1 })}>
          Reset view
        </button>
        <span className="wf-canvas-zoom">{Math.round(view.zoom * 100)}%</span>
      </div>

      <p id="wf-canvas-help" className="sr-only">
        Each stage is a button. Press Tab to move between stages, Enter or Space to select one
        and open its inspector, and the arrow keys to nudge the selected stage (hold Shift for a
        larger step). Connections are made with a pointer from a stage's handle, or in the
        Connections panel. Select a connection and press Delete to remove it.
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
      </div>
    </div>
  );
}
