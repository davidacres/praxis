import { useEffect, useState } from 'react';
import type {
  AiProvider,
  AiProviderStatus,
  Connection,
  IssueFilters,
  ModelOptions,
  ProjectRecord,
  WorkflowPlanInput,
  WorkflowRunSummary
} from '@praxis/core';
import { isIssueDone } from '../board/boardMeta';
import { Icon } from '../ui/Icon';
import { fetchModelOptions, MODEL_PROVIDERS, PROVIDER_LABELS } from '../ai/modelProviders';
import { isProviderUsable } from '../ai/providerAvailability';

/** "KEY — Summary", the same picker convention IssueDetail's parent-issue field uses. */
const ISSUE_OPTION_SEPARATOR = '—';

interface IssueOption {
  key: string;
  summary: string;
  connectionId?: string;
}

/** Parses "KEY — Summary" (or a bare key typed past the datalist) back to just the key. */
function extractIssueKey(raw: string): string {
  const value = raw.trim();
  const separator = ` ${ISSUE_OPTION_SEPARATOR} `;
  const separatorIndex = value.indexOf(separator);
  return separatorIndex === -1 ? value : value.slice(0, separatorIndex).trim();
}

export interface StartRunDialogProps {
  project: ProjectRecord;
  /** For resolving the project's own board connection — see `issueOptions` below. */
  connections: Connection[];
  runnableWorkflows: Array<{ id: string; name: string }>;
  /** Preselects a workflow, e.g. when opened from a workflow row's Run button. */
  initialWorkflowId?: string;
  /** A Task Designer plan handed off to this run. */
  planInput?: WorkflowPlanInput;
  onClose: () => void;
  /** Called once the run exists; the shell navigates to its workspace. */
  onStarted: (run: WorkflowRunSummary) => void;
}

/**
 * Start a standalone run. Day-to-day workflow work still starts from a session,
 * which becomes the run's controller; this is the path for a run with no
 * conversation behind it (a ticket, a Task Designer plan, or just a task).
 */
export function StartRunDialog({
  project,
  connections,
  runnableWorkflows,
  initialWorkflowId,
  planInput,
  onClose,
  onStarted
}: StartRunDialogProps) {
  const [taskTitle, setTaskTitle] = useState('');
  const [startWorkflowId, setStartWorkflowId] = useState(initialWorkflowId ?? '');
  const [issueOptions, setIssueOptions] = useState<IssueOption[]>([]);
  const [issueKeyDraft, setIssueKeyDraft] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Asking is the default every time: auto-approve is a deliberate, per-run choice.
  const [permissionMode, setPermissionMode] = useState<'ask' | 'auto'>('ask');
  const [providerStatuses, setProviderStatuses] = useState<AiProviderStatus[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<AiProvider | undefined>();
  const [modelOptions, setModelOptions] = useState<ModelOptions | undefined>();
  const [selectedModel, setSelectedModel] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);

  // Load provider statuses and default to active provider
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.praxis.ai.listProviderStatuses(),
      window.praxis.settings.get()
    ])
      .then(([statuses, settings]) => {
        if (cancelled) return;
        setProviderStatuses(statuses);
        setSelectedProvider(current => {
          if (current && statuses.some(s => s.provider === current && isProviderUsable(s))) {
            return current;
          }
          const active = statuses.find(s => s.provider === settings.ai.activeProvider && isProviderUsable(s));
          return active?.provider ?? statuses.find(isProviderUsable)?.provider ?? settings.ai.activeProvider;
        });
      })
      .catch(() => {
        if (!cancelled) setProviderStatuses([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Update model options when selectedProvider changes
  useEffect(() => {
    setModelOptions(undefined);
    setSelectedModel('');
    if (!selectedProvider || !MODEL_PROVIDERS.has(selectedProvider)) {
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    Promise.all([
      fetchModelOptions(selectedProvider, false),
      window.praxis.settings.get()
    ])
      .then(([options, settings]) => {
        if (cancelled || !options) return;
        const enabled = settings.ai.providers[selectedProvider]?.enabledModelIds;
        const filtered = enabled
          ? { ...options, options: options.options.filter(option => enabled.includes(option.value)) }
          : options;
        setModelOptions(filtered);
        const defaultChoice =
          filtered.currentValue && filtered.options.some(option => option.value === filtered.currentValue)
            ? filtered.currentValue
            : (filtered.options[0]?.value ?? '');
        setSelectedModel(defaultChoice);
      })
      .catch(() => {
        if (!cancelled) setModelOptions(undefined);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProvider]);

  // Preselect the only workflow, so a project with one goes straight to "Task".
  useEffect(() => {
    if (!startWorkflowId && runnableWorkflows.length === 1) setStartWorkflowId(runnableWorkflows[0].id);
  }, [runnableWorkflows, startWorkflowId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Tickets this run can link — the project's own board plus any boards linked
  // to it, mirroring exactly what its sidebar shows under this project.
  // Own-board ownership is read from the connection record (never inferred from
  // its id — see App.tsx's projectIdForConnection), so this holds even for a
  // project whose own connection predates a storage change. The own board's
  // *id* is likewise never assumed to be `project.defaultBoardId` — a
  // folder-mode project's board id follows the folder backend's own convention
  // instead, so it's resolved from `board.list` the same way the sidebar and
  // the command palette's issue search do.
  useEffect(() => {
    let cancelled = false;
    const ownConnectionId = connections.find(connection => connection.settings.projectId === project.id)?.id;
    (async () => {
      const ownBoard = ownConnectionId
        ? (await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' })).find(
            candidate => candidate.connectionId === ownConnectionId
          )
        : undefined;
      const boards: Array<{ connectionId?: string; boardId: string }> = [
        ...(ownBoard ? [{ connectionId: ownConnectionId, boardId: ownBoard.id }] : []),
        ...project.linkedBoards.map(link => ({ connectionId: link.connectionId, boardId: link.boardId }))
      ];
      const results = await Promise.allSettled(
        boards.map(board => {
          const filters: IssueFilters = {
            projectKeys: [],
            statuses: [],
            issueTypes: [],
            searchText: '',
            assigneeMode: 'all',
            boardId: board.boardId,
            grouping: 'none'
          };
          return window.praxis.issue
            .list(filters, 0, 50, board.connectionId)
            .then(page =>
              page.issues
                // Only open tickets are worth starting a run against — a done/closed
                // one has nothing left to deliver.
                .filter(issue => !isIssueDone(issue))
                .map(issue => ({ key: issue.key, summary: issue.summary, connectionId: board.connectionId }))
            );
        })
      );
      if (cancelled) return;
      setIssueOptions(results.flatMap(result => (result.status === 'fulfilled' ? result.value : [])));
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id, project.linkedBoards, connections]);

  const submit = async () => {
    if (!startWorkflowId || !taskTitle.trim() || busy) return;
    const issueKey = extractIssueKey(issueKeyDraft);
    const matchedIssue = issueKey ? issueOptions.find(option => option.key === issueKey) : undefined;
    setBusy(true);
    setError(undefined);
    try {
      // A key that doesn't match any fetched option (typo, or a ticket outside
      // this project's boards) starts an ordinary run rather than guessing at
      // a connection to write back to — same "no invented attribution"
      // discipline as the AI settings spend report.
      const run = await window.praxis.workflows.startRun(
        project.id,
        startWorkflowId,
        taskTitle.trim(),
        matchedIssue ? { issueKey: matchedIssue.key, connectionId: matchedIssue.connectionId } : undefined,
        undefined,
        planInput,
        {
          permissionMode,
          aiProvider: selectedProvider,
          aiModel: selectedModel.trim() || undefined
        }
      );
      onStarted(run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const usableStatuses = providerStatuses.filter(isProviderUsable);
  const baseStatuses = usableStatuses.length > 0 ? usableStatuses : providerStatuses;
  const availableProviderOptions: Array<{ provider: AiProvider }> = baseStatuses.map(s => ({ provider: s.provider }));
  if (selectedProvider && !availableProviderOptions.some(s => s.provider === selectedProvider)) {
    availableProviderOptions.unshift({
      provider: selectedProvider
    });
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-card wf-runstart-card" role="dialog" aria-modal="true" aria-label="Start a run" data-testid="wf-runstart-dialog">
        <form
          className="wf-runstart"
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="wf-runstart-head">
            <h3>
              <Icon name="play" size={14} />
              Start a run
            </h3>
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Close" onClick={onClose}>
              <Icon name="close" size={13} />
            </button>
          </div>
          <p className="hint">
            {project.name} — for day-to-day work, add a workflow from a session so the session becomes its controller.
          </p>
          {planInput && (
            <p className="hint" data-testid="workflow-plan-input">
              Plan input attached: master plan ({planInput.generatedFeatureCount} feature(s), {planInput.generatedStoryCount} stor{planInput.generatedStoryCount === 1 ? 'y' : 'ies'}).
            </p>
          )}
          {!project.workspaceFolder && (
            <p className="hint is-warn">
              No folder is attached — agent and check stages will need to be advanced by hand.
            </p>
          )}
          {runnableWorkflows.length === 0 && <p className="hint">Save a workflow in the designer first.</p>}
          {runnableWorkflows.length > 1 && (
            <label>
              <span>Workflow</span>
              <select aria-label="Run workflow" value={startWorkflowId} onChange={e => setStartWorkflowId(e.target.value)}>
                <option value="">—</option>
                {runnableWorkflows.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>Task</span>
            <input
              aria-label="Run task"
              value={taskTitle}
              onChange={e => setTaskTitle(e.target.value)}
              placeholder="What is this run for?"
              autoFocus
            />
          </label>
          {issueOptions.length > 0 && (
            <label>
              <span>Ticket (optional)</span>
              <input
                aria-label="Run ticket"
                list="wf-runstart-issue-options"
                value={issueKeyDraft}
                onChange={e => {
                  const val = e.target.value;
                  setIssueKeyDraft(val);
                  const key = extractIssueKey(val);
                  const matched = issueOptions.find(option => option.key === key);
                  if (matched && !taskTitle.trim()) {
                    setTaskTitle(matched.summary);
                  }
                }}
                placeholder="Write the outcome back as a comment"
                data-testid="wf-runstart-issue"
              />
              <datalist id="wf-runstart-issue-options">
                {issueOptions.map(option => (
                  <option key={option.key} value={`${option.key} ${ISSUE_OPTION_SEPARATOR} ${option.summary}`} />
                ))}
              </datalist>
            </label>
          )}
          {availableProviderOptions.length > 0 && (
            <div
              className="wf-runstart-row"
              style={{
                display: 'grid',
                gridTemplateColumns: modelOptions && modelOptions.options.length > 0 ? '1fr 1fr' : '1fr',
                gap: 'var(--space-2)'
              }}
            >
              <label>
                <span>AI Provider</span>
                <select
                  aria-label="Run AI provider"
                  value={selectedProvider ?? ''}
                  onChange={e => setSelectedProvider(e.target.value as AiProvider)}
                  data-testid="wf-runstart-provider"
                >
                  {availableProviderOptions.map(status => (
                    <option key={status.provider} value={status.provider}>
                      {PROVIDER_LABELS[status.provider] ?? status.provider}
                    </option>
                  ))}
                </select>
              </label>
              {modelOptions && modelOptions.options.length > 0 && (
                <label>
                  <span>Model</span>
                  <select
                    aria-label="Run AI model"
                    value={selectedModel}
                    onChange={e => setSelectedModel(e.target.value)}
                    data-testid="wf-runstart-model"
                    disabled={modelsLoading}
                  >
                    {modelOptions.options.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.name || opt.value}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          <fieldset className="wf-runstart-mode" data-testid="wf-runstart-mode">
            <legend>Tool permissions</legend>
            <label className="wf-runstart-mode-option">
              <input
                type="radio"
                name="wf-permission-mode"
                value="ask"
                checked={permissionMode === 'ask'}
                onChange={() => setPermissionMode('ask')}
                data-testid="wf-runstart-mode-ask"
              />
              <span>
                <strong>Ask</strong>
                <em>A stage stops for Allow / Deny before each edit or command.</em>
              </span>
            </label>
            <label className="wf-runstart-mode-option">
              <input
                type="radio"
                name="wf-permission-mode"
                value="auto"
                checked={permissionMode === 'auto'}
                onChange={() => setPermissionMode('auto')}
                data-testid="wf-runstart-mode-auto"
              />
              <span>
                <strong>Auto-approve</strong>
                <em>
                  Stages allow their own tool requests without stopping. Each stage&rsquo;s tool access still applies — a
                  read-only stage stays read-only — and the final approval still needs a person.
                </em>
              </span>
            </label>
          </fieldset>
          {error && (
            <p role="alert" className="error-banner">
              {error}
            </p>
          )}
          <div className="wf-runstart-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!startWorkflowId || !taskTitle.trim() || busy}>
              {busy ? 'Starting…' : 'Start'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
