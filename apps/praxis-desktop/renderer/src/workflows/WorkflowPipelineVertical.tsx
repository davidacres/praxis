import { useMemo } from 'react';
import type { WorkflowRunSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';

/**
 * A run's pipeline, top to bottom, in the shell's right pane.
 *
 * Progress reads down the list: each step carries its lane (done, running,
 * awaiting, failed…), its sub-phase while it runs, and how many attempts it has
 * used. Steps that can run side by side sit in one bracketed cluster. Choosing a
 * step shows that step's session (when it has one) in the centre pane.
 */

type Stage = WorkflowRunSummary['stages'][number];

const LANE_GLYPH: Record<Stage['lane'], string> = {
  idle: '○',
  ready: '◔',
  running: '◑',
  done: '●',
  failed: '✕',
  skipped: '–',
  awaiting: '◆',
  paused: '‖'
};

const LANE_LABEL: Record<Stage['lane'], string> = {
  idle: 'waiting',
  ready: 'ready',
  running: 'running',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
  awaiting: 'awaiting approval',
  paused: 'paused'
};

const TYPE_ICON: Record<Stage['type'], Parameters<typeof Icon>[0]['name']> = {
  'agent-task': 'robot',
  check: 'terminal',
  deployment: 'rocket',
  approval: 'shield',
  join: 'graph'
};

/** A paused step says why: the AI provider's limit, or its tooling not being able to run. */
function pausedLabel(stage: Pick<Stage, 'lane' | 'pause'>): string | undefined {
  if (stage.lane !== 'paused') return undefined;
  return stage.pause === 'environment' ? 'paused — could not run' : 'paused — AI limit reached';
}

/**
 * A running deployment stage's own sub-phase — renderer-local mirror of core's
 * `deploymentNodeDisplayPhase` (the renderer may import only types from
 * `@praxis/core` at runtime).
 */
function phaseLabel(stage: Pick<Stage, 'type' | 'outcome' | 'phase'>): string | undefined {
  if (stage.type !== 'deployment' || stage.outcome !== 'running') return undefined;
  return stage.phase === 'verifying' ? 'verifying' : 'deploying';
}

/**
 * Groups stages into levels — each level is what can run once the one above has
 * finished. Failure edges are ignored: they loop back to earlier stages for
 * rework, and following them would drag every loop member to the bottom.
 */
export function pipelineLevels(summary: Pick<WorkflowRunSummary, 'stages' | 'graph'>): Stage[][] {
  const ids = summary.stages.map(stage => stage.nodeId);
  const level: Record<string, number> = Object.fromEntries(ids.map(id => [id, 0]));
  const forward = summary.graph.edges.filter(edge => edge.on !== 'failure');
  for (let pass = 0; pass < ids.length; pass += 1) {
    let changed = false;
    for (const edge of forward) {
      if (level[edge.from] === undefined || level[edge.to] === undefined) continue;
      if (level[edge.to] < level[edge.from] + 1 && level[edge.from] + 1 < ids.length) {
        level[edge.to] = level[edge.from] + 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // A stage reachable only through a failure edge (a cleanup or diagnosis
  // stage) has no forward parent; place it just below whatever routes to it.
  const hasForwardParent = new Set(forward.map(edge => edge.to));
  for (const edge of summary.graph.edges) {
    if (edge.on === 'failure' && !hasForwardParent.has(edge.to) && edge.to !== summary.graph.entryNodeId) {
      level[edge.to] = Math.max(level[edge.to], (level[edge.from] ?? 0) + 1);
    }
  }
  const byLevel = new Map<number, Stage[]>();
  for (const stage of summary.stages) {
    const list = byLevel.get(level[stage.nodeId]) ?? [];
    list.push(stage);
    byLevel.set(level[stage.nodeId], list);
  }
  return [...byLevel.entries()].sort(([a], [b]) => a - b).map(([, stages]) => stages);
}

export interface WorkflowPipelineVerticalProps {
  summary: WorkflowRunSummary;
  selectedNodeId?: string;
  /** The stage currently doing the work, marked so a viewer can find it at a glance. */
  activeNodeId?: string;
  onSelectNode: (nodeId: string) => void;
}

export function WorkflowPipelineVertical({ summary, selectedNodeId, activeNodeId, onSelectNode }: WorkflowPipelineVerticalProps) {
  const levels = useMemo(() => pipelineLevels(summary), [summary]);
  const done = summary.stages.filter(stage => stage.lane === 'done' || stage.lane === 'skipped').length;

  return (
    <div className="wf-vpipe" data-testid="wf-vpipe">
      <div className="wf-vpipe-head">
        <span>Pipeline</span>
        <span className="wf-vpipe-count" data-testid="wf-vpipe-count">
          {done}/{summary.stages.length}
        </span>
      </div>
      <ol className="wf-vpipe-list" aria-label="Pipeline steps">
        {levels.map((stages, index) => (
          <li key={index} className={`wf-vpipe-level${stages.length > 1 ? ' is-parallel' : ''}`}>
            {stages.length > 1 && <span className="wf-vpipe-parallel-tag">in parallel</span>}
            <ul>
              {stages.map(stage => {
                const phase = phaseLabel(stage);
                return (
                  <li key={stage.nodeId}>
                    <button
                      type="button"
                      className={`wf-vpipe-step is-${stage.lane}${stage.nodeId === selectedNodeId ? ' is-selected' : ''}${stage.nodeId === activeNodeId ? ' is-active' : ''}`}
                      aria-label={`${stage.name} (${stage.type}): ${phase ?? stage.lane}${stage.gate ? `, ${stage.gate} gate` : ''}`}
                      aria-pressed={stage.nodeId === selectedNodeId}
                      aria-current={stage.nodeId === activeNodeId ? 'step' : undefined}
                      data-testid={`wf-vpipe-step-${stage.nodeId}`}
                      data-lane={stage.lane}
                      onClick={() => onSelectNode(stage.nodeId)}
                    >
                      <span className="wf-vpipe-glyph" aria-hidden>
                        {LANE_GLYPH[stage.lane]}
                      </span>
                      <span className="wf-vpipe-main">
                        <span className="wf-vpipe-name">{stage.name}</span>
                        <span className="wf-vpipe-sub">
                          {stage.type}
                          {stage.gate ? ` · ${stage.gate} gate` : ''} · {phase ?? pausedLabel(stage) ?? LANE_LABEL[stage.lane]}
                          {stage.maxAttempts && stage.attempts > 0 ? ` (${stage.attempts}/${stage.maxAttempts})` : ''}
                        </span>
                      </span>
                      <span className="wf-vpipe-type" aria-hidden>
                        <Icon name={stage.sessionKey ? 'robot' : TYPE_ICON[stage.type]} size={13} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
