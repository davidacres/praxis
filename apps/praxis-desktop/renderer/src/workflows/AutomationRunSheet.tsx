import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentSessionRecord, ProjectRecord, WorkflowRunSummary } from '@praxis/core';
import { Icon, type IconName } from '../ui/Icon';
import { formatElapsed, formatTokens } from '../ai/sessionNav';
import { providerLabel } from '../ai/modelProviders';

export const RUN_STATUS_TONE: Record<WorkflowRunSummary['status'], string> = {
  running: 'lane--running',
  'awaiting-approval': 'lane--awaiting',
  succeeded: 'lane--done',
  failed: 'lane--failed',
  cancelled: 'lane--skipped'
};

export const RUN_STATUS_LABEL: Record<WorkflowRunSummary['status'], string> = {
  running: 'Running',
  'awaiting-approval': 'Awaiting approval',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled'
};

export function stageLaneLabel(lane: WorkflowRunSummary['stages'][number]['lane']): string {
  return lane === 'done'
    ? 'Complete'
    : lane === 'running'
      ? 'Running'
      : lane === 'awaiting'
        ? 'Awaiting approval'
        : lane === 'failed'
          ? 'Failed'
          : lane === 'paused'
            ? 'Paused'
            : lane === 'skipped'
              ? 'Skipped'
              : lane === 'ready'
                ? 'Ready'
                : 'Pending';
}

export function stageLaneIcon(lane: WorkflowRunSummary['stages'][number]['lane']): IconName {
  return lane === 'done'
    ? 'check-square'
    : lane === 'failed'
      ? 'warning'
      : lane === 'running'
        ? 'play'
        : lane === 'awaiting' || lane === 'paused'
          ? 'clock'
          : lane === 'skipped'
            ? 'close'
          : 'dot';
}

export function activeAutomationStageIndex(run: WorkflowRunSummary): number {
  const active = run.stages.findIndex(stage => ['running', 'awaiting', 'paused', 'failed', 'ready'].includes(stage.lane));
  if (active >= 0) return active;
  const completed = run.stages.reduce((latest, stage, index) => stage.lane === 'done' ? index : latest, -1);
  return Math.max(0, completed);
}

export function automationStageSession(stage: WorkflowRunSummary['stages'][number], sessions: AgentSessionRecord[]): AgentSessionRecord | undefined {
  return stage.sessionKey ? sessions.find(session => session.issueKey === stage.sessionKey) : undefined;
}

export function automationStageMeta(stage: WorkflowRunSummary['stages'][number], sessions: AgentSessionRecord[]): string {
  const session = automationStageSession(stage, sessions);
  const agent = session?.agentId || (session?.provider ? providerLabel(session.provider) : undefined) || (stage.provider ? providerLabel(stage.provider) : undefined) || 'AI agent';
  const model = session?.model || stage.chosenModel;
  const duration = session ? formatElapsed(session.startedAt, session.completedAt) : (stage.durationMs !== undefined ? `${Math.round(stage.durationMs / 1000)}s` : undefined);
  const tokens = session ? formatTokens(session.tokenUsage) : undefined;
  return [agent, model, duration, tokens].filter(Boolean).join(' · ') || 'No telemetry reported';
}

export function AutomationRunSheet({
  project,
  run,
  sessions,
  initialStageId,
  onClose,
  onOpenRun,
  onCancel,
  onArchive,
  onDelete
}
: {
  project: ProjectRecord;
  run: WorkflowRunSummary;
  sessions: AgentSessionRecord[];
  initialStageId?: string;
  onClose: () => void;
  onOpenRun: () => void;
  onCancel?: () => void | Promise<void>;
  onArchive?: () => void | Promise<void>;
  onDelete?: () => void;
}) {
  const fallbackStage = run.stages[activeAutomationStageIndex(run)];
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(initialStageId ?? fallbackStage?.nodeId);
  const sheetRef = useRef<HTMLElement>(null);
  const completed = run.stages.filter(stage => stage.lane === 'done' || stage.lane === 'skipped').length;
  const progress = run.stages.length > 0 ? Math.round((completed / run.stages.length) * 100) : 0;
  const live = run.status === 'running' || run.status === 'awaiting-approval';
  const statusLabel = run.needsDecision ? 'Needs a decision' : run.paused ? 'Paused' : RUN_STATUS_LABEL[run.status];
  const statusTone = run.needsDecision || run.paused ? 'lane--awaiting' : RUN_STATUS_TONE[run.status];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab' && sheetRef.current) {
        const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])')]
          .filter(element => element.offsetParent !== null);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (first && last && event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (first && last && !event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="automation-sheet-backdrop" data-testid="automation-sheet-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside ref={sheetRef} className="automation-sheet" role="dialog" aria-modal="true" aria-labelledby={`automation-sheet-title-${run.runId}`} data-testid="automation-sheet">
        <header className="automation-sheet-header">
          <div className="automation-sheet-heading">
            <span className={`automation-state-mark ${statusTone}`} aria-label={statusLabel} title={statusLabel} />
            <div>
              <h2 id={`automation-sheet-title-${run.runId}`}>{run.workflowName}</h2>
              <p>{project.name} · {formatElapsed(run.startedAt, run.endedAt) ?? 'Just started'}</p>
            </div>
          </div>
          <button type="button" className="icon-btn" aria-label="Close run details" autoFocus onClick={onClose}><Icon name="close" size={13} /></button>
        </header>
        <div className="automation-sheet-summary">
          <div><strong>{completed} of {run.stages.length}</strong><span> steps complete</span></div>
          <span>{statusLabel}</span>
          <div className="automation-sheet-progress" role="progressbar" aria-valuemin={0} aria-valuemax={run.stages.length} aria-valuenow={completed} aria-label={`${completed} of ${run.stages.length} steps complete`}>
            <i style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="automation-sheet-stages" data-testid="automation-sheet-stages">
          {run.stages.map(stage => {
            const selected = selectedStageId === stage.nodeId;
            return <div className={`automation-sheet-stage${selected ? ' is-selected' : ''}`} key={stage.nodeId} data-lane={stage.lane}>
              <button type="button" className="automation-sheet-stage-main" aria-expanded={selected} onClick={() => setSelectedStageId(selected ? undefined : stage.nodeId)}>
                <span className={`automation-step-mark automation-step-mark--${stage.lane}`} aria-hidden><Icon name={stageLaneIcon(stage.lane)} size={11} /></span>
                <span className="automation-sheet-stage-copy">
                  <strong>{stage.name}</strong>
                  <small>{stageLaneLabel(stage.lane)}{stage.durationMs !== undefined ? ` · ${Math.round(stage.durationMs / 1000)}s` : ''}</small>
                </span>
                <Icon name={selected ? 'chevron-up' : 'chevron-down'} size={11} />
              </button>
              {selected && <div className="automation-sheet-stage-details" data-testid={`automation-sheet-stage-${stage.nodeId}`}>
                <span>{automationStageMeta(stage, sessions)}</span>
                {stage.attempts > 0 && <span>{stage.attempts} attempt{stage.attempts === 1 ? '' : 's'}</span>}
                {stage.lastError && <p>{stage.lastError}</p>}
              </div>}
            </div>;
          })}
        </div>
        <footer className="automation-sheet-footer">
          <button type="button" className="btn" data-testid="automation-sheet-open-run" onClick={onOpenRun}>Open full run</button>
          <span className="automation-sheet-footer-spacer" />
          {live && onCancel && <button type="button" className="btn" onClick={() => void onCancel()}>Cancel run</button>}
          {!live && onArchive && <button type="button" className="btn" onClick={() => void onArchive()}>Archive</button>}
          {onDelete && <button type="button" className="btn automation-sheet-delete" onClick={onDelete}>Delete</button>}
        </footer>
      </aside>
    </div>,
    document.body
  );
}

