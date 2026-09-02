import { useCallback, useMemo, useRef, useState } from 'react';
import type { WorkflowDefinition, WorkflowNode } from '@praxis/core';
import {
  anchorPoint,
  buildConnectorCurvePath,
  resolveConnectorDirections,
  type CanvasBox
} from '../taskDesigner/taskDesignerState';
import { connectNodes, moveNode } from './workflowEdits';

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

const NODE_W = 160;
const NODE_H = 64;

const laneColor: Record<WorkflowNode['type'], string> = {
  'agent-task': 'var(--accent)',
  check: 'var(--info, var(--accent))',
  approval: 'var(--warning, var(--accent))',
  join: 'var(--text-dim)'
};

export interface WorkflowCanvasProps {
  definition: WorkflowDefinition;
  selectedNodeId: string | undefined;
  issuesByNode: Record<string, number>;
  onChange: (next: WorkflowDefinition) => void;
  onSelectNode: (nodeId: string) => void;
}

export function WorkflowCanvas({
  definition,
  selectedNodeId,
  issuesByNode,
  onChange,
  onSelectNode
}: WorkflowCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 40, y: 40, zoom: 1 });
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
      if (event.target !== surfaceRef.current) return;
      setDrag({ kind: 'pan', startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y });
      surfaceRef.current?.setPointerCapture(event.pointerId);
    },
    [view.x, view.y]
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

  const edgePaths = definition.edges.map(edge => {
    const source = boxes[edge.from];
    const target = boxes[edge.to];
    if (!source || !target) return null;
    const dirs = resolveConnectorDirections(source, target);
    const from = anchorPoint(source, dirs.sourceDirection);
    const to = anchorPoint(target, dirs.targetDirection);
    return {
      id: edge.id,
      d: buildConnectorCurvePath(from.x, from.y, to.x, to.y, dirs.sourceDirection, dirs.targetDirection),
      dead: edge.on === 'failure'
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
        <span>Drag a card to move it, drag from its ▸ handle onto another card to connect. Scroll to zoom.</span>
        <button type="button" className="ghost-button" onClick={() => setView({ x: 40, y: 40, zoom: 1 })}>
          Reset view
        </button>
        <span>{Math.round(view.zoom * 100)}%</span>
      </div>

      <div
        ref={surfaceRef}
        role="application"
        aria-label="Workflow canvas"
        onPointerDown={onSurfacePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onWheel={onWheel}
        style={{
          position: 'relative',
          height: 520,
          overflow: 'hidden',
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg)',
          cursor: drag?.kind === 'pan' ? 'grabbing' : 'default',
          touchAction: 'none'
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            transformOrigin: '0 0'
          }}
        >
          <svg
            width={4000}
            height={4000}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
          >
            {edgePaths.filter(Boolean).map(edge => (
              <path
                key={edge!.id}
                d={edge!.d}
                fill="none"
                stroke={edge!.dead ? 'var(--danger)' : 'var(--border-strong, var(--text-dim))'}
                strokeWidth={1.5}
                strokeDasharray={edge!.dead ? '4 3' : undefined}
              />
            ))}
            {linkPreview && (
              <path d={linkPreview} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="4 3" />
            )}
          </svg>

          {definition.nodes.map(node => {
            const selected = node.id === selectedNodeId;
            const isEntry = node.id === definition.entryNodeId;
            const issues = issuesByNode[node.id] ?? 0;
            return (
              <div
                key={node.id}
                data-node-id={node.id}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`${node.name} (${node.type})${isEntry ? ', entry stage' : ''}${
                  issues > 0 ? `, ${issues} issue${issues === 1 ? '' : 's'}` : ''
                }`}
                onPointerDown={event => {
                  event.stopPropagation();
                  const point = toCanvas(event.clientX, event.clientY);
                  setDrag({ kind: 'node', nodeId: node.id, offsetX: point.x - node.x, offsetY: point.y - node.y });
                  onSelectNode(node.id);
                }}
                onKeyDown={event => {
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
                style={{
                  position: 'absolute',
                  left: node.x,
                  top: node.y,
                  width: NODE_W,
                  minHeight: NODE_H,
                  boxSizing: 'border-box',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                  borderLeft: `3px solid ${laneColor[node.type]}`,
                  background: 'var(--bg-elevated, var(--bg))',
                  color: 'var(--text)',
                  cursor: 'grab',
                  userSelect: 'none'
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {node.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', gap: 6, alignItems: 'center' }}>
                  {node.type}
                  {isEntry && <span style={{ color: 'var(--accent)' }}>entry</span>}
                  {issues > 0 && <span style={{ color: 'var(--danger)' }}>⚠ {issues}</span>}
                </div>
                <button
                  type="button"
                  aria-label={`Connect from ${node.name}`}
                  onPointerDown={event => {
                    event.stopPropagation();
                    const point = toCanvas(event.clientX, event.clientY);
                    setDrag({ kind: 'link', from: node.id, x: point.x, y: point.y });
                  }}
                  style={{
                    position: 'absolute',
                    right: -10,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    border: '1px solid var(--border)',
                    background: 'var(--bg)',
                    color: 'var(--text-dim)',
                    fontSize: 10,
                    lineHeight: 1,
                    cursor: 'crosshair'
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
