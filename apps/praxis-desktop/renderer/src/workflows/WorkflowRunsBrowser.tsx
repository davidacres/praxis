import { useMemo, useState } from 'react';
import type { WorkflowRunSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';

const RUN_STATUS_TONE: Record<WorkflowRunSummary['status'], string> = {
  running: 'lane--running',
  'awaiting-approval': 'lane--awaiting',
  succeeded: 'lane--done',
  failed: 'lane--failed',
  cancelled: 'lane--skipped'
};

export interface WorkflowRunsBrowserProps {
  runs: WorkflowRunSummary[];
  selectedRunId?: string;
  onSelectRun: (runId: string) => void;
  onStartRun?: () => void;
  onArchiveRun?: (runId: string, archived: boolean) => Promise<void>;
  onCancelRun?: (runId: string) => Promise<void>;
  onDeleteRun?: (run: WorkflowRunSummary) => void;
}

export function WorkflowRunsBrowser({
  runs,
  selectedRunId,
  onSelectRun,
  onStartRun,
  onArchiveRun,
  onCancelRun,
  onDeleteRun
}: WorkflowRunsBrowserProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'succeeded' | 'failed' | 'paused'>('all');
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);
  const [busyRunId, setBusyRunId] = useState<string>();
  const [error, setError] = useState<string>();

  const allActive = useMemo(() => runs.filter(run => !run.archived), [runs]);
  const allArchived = useMemo(() => runs.filter(run => run.archived), [runs]);

  const matchesFilter = (run: WorkflowRunSummary): boolean => {
    if (statusFilter === 'running') {
      if (run.status !== 'running' && run.status !== 'awaiting-approval') return false;
    } else if (statusFilter === 'succeeded') {
      if (run.status !== 'succeeded') return false;
    } else if (statusFilter === 'failed') {
      if (run.status !== 'failed' && run.status !== 'cancelled') return false;
    } else if (statusFilter === 'paused') {
      if (!run.paused) return false;
    }
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (
      run.workflowName.toLowerCase().includes(q) ||
      Boolean(run.explanation?.toLowerCase().includes(q)) ||
      Boolean(run.issueKey?.toLowerCase().includes(q))
    );
  };

  const filteredActive = useMemo(() => allActive.filter(matchesFilter), [allActive, statusFilter, query]);
  const filteredArchived = useMemo(() => allArchived.filter(matchesFilter), [allArchived, statusFilter, query]);

  const handleArchive = async (run: WorkflowRunSummary, archived: boolean) => {
    if (!onArchiveRun) return;
    setBusyRunId(run.runId);
    setError(undefined);
    try {
      await onArchiveRun(run.runId, archived);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyRunId(undefined);
    }
  };

  return (
    <div className="wf-runs-browser view-scroll" data-testid="wf-runs-browser">
      <div className="wf-runs-browser-header">
        <div>
          <h2 className="wf-runs-browser-title">Workflow runs</h2>
          <p className="wf-runs-browser-summary">
            {allActive.length} active run{allActive.length === 1 ? '' : 's'} · {allArchived.length} archived
          </p>
        </div>
        {onStartRun && (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="wf-runs-browser-new-run"
            onClick={onStartRun}
          >
            <Icon name="plus" size={13} />
            <span>New run</span>
          </button>
        )}
      </div>

      <div className="wf-runs-browser-controls">
        <div className="wf-runs-browser-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            className="input"
            placeholder="Filter runs…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Filter workflow runs"
            data-testid="wf-runs-browser-search-input"
          />
        </div>
        <div className="wf-runs-browser-filters" role="radiogroup" aria-label="Status filter">
          {(['all', 'running', 'succeeded', 'failed', 'paused'] as const).map(filter => (
            <button
              key={filter}
              type="button"
              className={`chip${statusFilter === filter ? ' chip-active' : ''}`}
              role="radio"
              aria-checked={statusFilter === filter}
              onClick={() => setStatusFilter(filter)}
            >
              {filter.charAt(0).toUpperCase() + filter.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="hint is-danger" data-testid="wf-runs-browser-error">{error}</p>}

      {/* ── Active runs ── */}
      <div className="wf-runs-group" data-testid="wf-runs-group-active">
        <div className="wf-runs-group-heading">
          <span>Active</span>
          <span className="wf-runs-count">{filteredActive.length}</span>
        </div>
        {filteredActive.length === 0 && (
          <div className="placeholder-text" data-testid="wf-runs-active-empty">
            {allActive.length === 0 ? 'No runs yet for this project.' : 'No active runs match the filter.'}
          </div>
        )}
        <div className="wf-runs-list">
          {filteredActive.map(run => (
            <RunBrowserCard
              key={run.runId}
              run={run}
              active={run.runId === selectedRunId}
              busy={busyRunId === run.runId}
              onSelect={() => onSelectRun(run.runId)}
              onArchive={onArchiveRun ? () => void handleArchive(run, true) : undefined}
              onCancel={onCancelRun ? () => void onCancelRun(run.runId) : undefined}
              onDelete={onDeleteRun ? () => onDeleteRun(run) : undefined}
            />
          ))}
        </div>
      </div>

      {/* ── Archived runs ── */}
      <div className="wf-runs-group" data-testid="wf-runs-group-archived">
        <button
          type="button"
          className="wf-runs-group-heading wf-runs-group-toggle"
          aria-expanded={!archivedCollapsed}
          data-testid="wf-runs-archived-toggle"
          onClick={() => setArchivedCollapsed(collapsed => !collapsed)}
        >
          <span className="tree-section-icon">
            <Icon name={archivedCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
          </span>
          <span>Archived</span>
          <span className="wf-runs-count">{allArchived.length}</span>
        </button>
        {!archivedCollapsed && (
          <>
            {filteredArchived.length === 0 && (
              <div className="placeholder-text" data-testid="wf-runs-archived-empty">
                {allArchived.length === 0
                  ? 'Archived runs are kept here — archive completed runs from their row to tidy the list.'
                  : 'No archived runs match the filter.'}
              </div>
            )}
            <div className="wf-runs-list">
              {filteredArchived.map(run => (
                <RunBrowserCard
                  key={run.runId}
                  run={run}
                  active={run.runId === selectedRunId}
                  busy={busyRunId === run.runId}
                  onSelect={() => onSelectRun(run.runId)}
                  onArchive={onArchiveRun ? () => void handleArchive(run, false) : undefined}
                  onDelete={onDeleteRun ? () => onDeleteRun(run) : undefined}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RunBrowserCard({
  run,
  active,
  busy,
  onSelect,
  onArchive,
  onCancel,
  onDelete
}: {
  run: WorkflowRunSummary;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onArchive?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
}) {
  const live = run.status === 'running' || run.status === 'awaiting-approval';
  const started = run.startedAt ? new Date(run.startedAt).toLocaleString() : '';

  return (
    <div
      className={`wf-run-card${active ? ' active' : ''}${run.archived ? ' is-archived' : ''}`}
      data-testid={`wf-run-card-${run.runId}`}
      data-run-id={run.runId}
    >
      <button
        type="button"
        className="wf-run-card-main"
        onClick={onSelect}
        aria-label={`${run.workflowName}, ${run.status}`}
      >
        <div className="wf-run-card-header">
          <span className={`lane ${run.paused ? 'lane--awaiting' : RUN_STATUS_TONE[run.status]}`} aria-hidden>
            ●
          </span>
          <strong className="wf-run-card-name">{run.workflowName}</strong>
          {run.issueKey && <span className="chip wf-run-ticket">{run.issueKey}</span>}
          {run.archived && <span className="tree-badge">Archived</span>}
          <span className="wf-run-card-status">
            {run.paused ? 'Paused' : run.status}
          </span>
        </div>
        <div className="wf-run-card-meta">
          <span>Started {started}</span>
          {run.explanation && <span className="wf-run-card-explanation">{run.explanation}</span>}
        </div>
      </button>

      <div className="wf-run-card-actions">
        {live && onCancel && (
          <button
            type="button"
            className="btn btn-compact btn-quiet"
            title="Cancel this run"
            aria-label={`Cancel run ${run.workflowName}`}
            data-testid={`wf-run-cancel-${run.runId}`}
            onClick={e => {
              e.stopPropagation();
              onCancel();
            }}
          >
            <Icon name="close" size={12} />
            <span>Cancel</span>
          </button>
        )}
        {!live && onArchive && (
          <button
            type="button"
            className="btn btn-compact btn-quiet"
            title={run.archived ? 'Restore this run' : 'Archive this run'}
            aria-label={`${run.archived ? 'Restore' : 'Archive'} run ${run.workflowName}`}
            data-testid={run.archived ? `wf-run-restore-${run.runId}` : `wf-run-archive-${run.runId}`}
            disabled={busy}
            onClick={e => {
              e.stopPropagation();
              onArchive();
            }}
          >
            <Icon name={run.archived ? 'refresh' : 'archive'} size={12} />
            <span>{run.archived ? 'Restore' : 'Archive'}</span>
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            className="btn btn-compact btn-quiet"
            title="Delete this run"
            aria-label={`Delete run ${run.workflowName}`}
            data-testid={`wf-run-delete-${run.runId}`}
            onClick={e => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Icon name="trash" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
