import { useMemo, useState } from 'react';
import type { WorkflowRunSummary } from '@praxis/core';
import {
  anchorPoint,
  buildConnectorCurvePath,
  resolveConnectorDirections,
  type CanvasBox
} from '../taskDesigner/taskDesignerState';

/**
 * Read-only pipeline diagram for the run monitor (FX-BE-029).
 *
 * Draws the workflow graph left-to-right using the stored node positions and
 * the shared Task Designer connector geometry — the same visual language as the
 * editor canvas, minus every interaction. Each node is tinted by its run lane;
 * clicking one raises its detail in the stage panel.
 */

const W = 150;
const H = 56;
const LANE_GLYPH: Record<WorkflowRunSummary['stages'][number]['lane'], string> = {
  idle: '○',
  ready: '◔',
  running: '◑',
  done: '●',
  failed: '✕',
  skipped: '–',
  awaiting: '◆'
};

/**
 * A running deployment stage's own sub-phase, for the screen-reader-only
 * stage list — so "deploying" and "verifying" are heard as distinct states
 * rather than both collapsing into "running". Renderer-local mirror of
 * core's `deploymentNodeDisplayPhase`; see `WorkflowRunMonitor.tsx`'s copy
 * of the same helper for why it is not imported as a value.
 */
function deploymentPhaseLabel(stage: Pick<WorkflowRunSummary['stages'][number], 'type' | 'outcome' | 'phase'>): string | undefined {
  if (stage.type !== 'deployment' || stage.outcome !== 'running') return undefined;
  return stage.phase === 'verifying' ? 'verifying' : 'deploying';
}

export interface WorkflowPipelineProps {
  summary: WorkflowRunSummary;
  selectedNodeId: string | undefined;
  onSelectNode: (nodeId: string) => void;
}

export function WorkflowPipeline({ summary, selectedNodeId, onSelectNode }: WorkflowPipelineProps) {
  const stageByNode = useMemo(
    () => Object.fromEntries(summary.stages.map(stage => [stage.nodeId, stage])),
    [summary.stages]
  );

  // Stored positions are relative to whichever node the designer happened to
  // place first, so a branch drawn above or left of it (two approval nodes
  // fanned out symmetrically, say) can have a negative x or y. Shifting every
  // node by the graph's own minimum keeps the diagram's origin at (0, 0) —
  // without it, a negative-positioned node renders above/left of this
  // container's edge and is clipped, effectively invisible.
  const { boxes, bounds } = useMemo(() => {
    const xs = summary.graph.nodes.map(n => n.x);
    const ys = summary.graph.nodes.map(n => n.y);
    const minX = Math.min(0, ...xs);
    const minY = Math.min(0, ...ys);
    const map: Record<string, CanvasBox> = {};
    for (const node of summary.graph.nodes) {
      map[node.id] = { x: node.x - minX, y: node.y - minY, width: W, height: H };
    }
    const maxX = Math.max(0, ...xs.map(x => x - minX));
    const maxY = Math.max(0, ...ys.map(y => y - minY));
    return {
      boxes: map,
      bounds: { w: maxX + W + 24, h: maxY + H + 24 }
    };
  }, [summary.graph.nodes]);

  const [zoom, setZoom] = useState(1);
  const fit = Math.min(1, 900 / bounds.w);
  const scale = zoom * fit;

  const edges = summary.graph.edges
    .map(edge => {
      const s = boxes[edge.from];
      const t = boxes[edge.to];
      if (!s || !t) return null;
      const dirs = resolveConnectorDirections(s, t);
      const from = anchorPoint(s, dirs.sourceDirection);
      const to = anchorPoint(t, dirs.targetDirection);
      return {
        id: edge.id,
        d: buildConnectorCurvePath(from.x, from.y, to.x, to.y, dirs.sourceDirection, dirs.targetDirection),
        failure: edge.on === 'failure'
      };
    })
    .filter((edge): edge is NonNullable<typeof edge> => !!edge);

  return (
    <div className="wf-pipeline">
      <div className="wf-pipeline-bar">
        <span>Pipeline</span>
        <button type="button" className="btn btn-compact" onClick={() => setZoom(z => Math.min(1.6, z + 0.2))} aria-label="Zoom in">
          +
        </button>
        <button type="button" className="btn btn-compact" onClick={() => setZoom(z => Math.max(0.5, z - 0.2))} aria-label="Zoom out">
          −
        </button>
      </div>
      <ol className="sr-only">
        {summary.stages.map(row => (
          <li key={row.nodeId}>
            {row.name} ({row.type}): {deploymentPhaseLabel(row) ?? row.lane}
            {row.gate ? `, ${row.gate} gate` : ''}
          </li>
        ))}
      </ol>
      <div className="designer-canvas wf-pipeline-surface">
        <div
          className="wf-pipeline-world"
          style={{ width: bounds.w * scale, height: bounds.h * scale }}
        >
          <svg
            width={bounds.w}
            height={bounds.h}
            style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }}
          >
            {edges.map(edge => (
              <path
                key={edge.id}
                d={edge.d}
                fill="none"
                stroke={edge.failure ? 'var(--danger)' : 'var(--border-strong)'}
                strokeWidth={1.5}
                strokeDasharray={edge.failure ? '4 3' : undefined}
              />
            ))}
          </svg>
          {summary.graph.nodes.map(node => {
            const stage = stageByNode[node.id];
            const lane = stage?.lane ?? 'idle';
            const box = boxes[node.id];
            return (
              <button
                key={node.id}
                type="button"
                aria-pressed={node.id === selectedNodeId}
                aria-label={`${stage?.name ?? node.id} (${node.type}), ${lane}`}
                className={`wf-node wf-node--${node.type} wf-pipeline-node lane--${lane}${
                  node.id === selectedNodeId ? ' is-selected' : ''
                }`}
                style={{
                  left: box.x * scale,
                  top: box.y * scale,
                  width: W * scale,
                  minHeight: H * scale
                }}
                onClick={() => onSelectNode(node.id)}
              >
                <span className="wf-pipeline-node-name">
                  <span aria-hidden className="wf-pipeline-glyph">
                    {LANE_GLYPH[lane]}
                  </span>
                  {stage?.name ?? node.id}
                </span>
                <span className="wf-node-meta">
                  <span>{node.type}</span>
                  {stage?.gate && <span className="wf-node-entry">{stage.gate}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
