import { useEffect, useRef, useState } from 'react';
import type {
  AiProvider,
  AiProviderStatus,
  Connection,
  IssueFilters,
  ModelOptions,
  ProjectRecord,
  RunEstimate,
  RunParameterIssue,
  WorkflowPlanInput,
  WorkflowRunParameter,
  WorkflowRunSummary
} from '@praxis/core';
import { isIssueDone } from '../board/boardMeta';
import { Icon } from '../ui/Icon';
import { ChipSelect } from '../ui/ChipSelect';
import { assertRunBaseOrThrow, UncommittedBaseError, UncommittedBaseNotice, type UncommittedChoice } from './UncommittedBaseNotice';
import { fetchModelOptions, hasModelCatalog, providerIconName, providerLabel } from '../ai/modelProviders';
import { isProviderUsableForSessions } from '../ai/providerAvailability';

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
  const [uncommittedFiles, setUncommittedFiles] = useState<UncommittedBaseError | undefined>();
  const [startWorkflowId, setStartWorkflowId] = useState(initialWorkflowId ?? '');
  const [issueOptions, setIssueOptions] = useState<IssueOption[]>([]);
  const [issueKeyDraft, setIssueKeyDraft] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Asking is the default every time: auto-approve is a deliberate, per-run choice.
  const [permissionMode, setPermissionMode] = useState<'ask' | 'auto'>('ask');
  const [providerLimitPolicy, setProviderLimitPolicy] = useState<'ask' | 'switch' | 'stop'>('ask');
  const [providerStatuses, setProviderStatuses] = useState<AiProviderStatus[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<AiProvider | undefined>();
  const [modelOptions, setModelOptions] = useState<ModelOptions | undefined>();
  const [selectedModel, setSelectedModel] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  // What the chosen workflow asks for, and what it could cost at worst (FX-BE-166 / FX-BE-167).
  const [prepared, setPrepared] = useState<{ parameters: WorkflowRunParameter[]; requiresMeasurableGoal: boolean; estimate: RunEstimate; issues: RunParameterIssue[] }>();
  const [parameterDrafts, setParameterDrafts] = useState<Record<string, string>>({});
  const [confirmLarge, setConfirmLarge] = useState(false);

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
          if (current && statuses.some(s => s.provider === current && isProviderUsableForSessions(s))) {
            return current;
          }
          const active = statuses.find(s => s.provider === settings.ai.activeProvider && isProviderUsableForSessions(s));
          return active?.provider ?? statuses.find(isProviderUsableForSessions)?.provider ?? settings.ai.activeProvider;
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
    if (!selectedProvider || !hasModelCatalog(selectedProvider)) {
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

  // Name the run after its workflow until the person types their own title, so a run that needs
  // no description (a security review, an audit) starts in one click. A picked ticket still wins.
  const autoTitle = useRef('');
  useEffect(() => {
    const name = runnableWorkflows.find(workflow => workflow.id === startWorkflowId)?.name ?? '';
    setTaskTitle(current => {
      if (current.trim() && current !== autoTitle.current) return current;
      autoTitle.current = name;
      return name;
    });
  }, [runnableWorkflows, startWorkflowId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // An open chip picker takes its own Escape and stops it before it gets here.
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

  // A parameter's value as the run receives it: numbers as numbers, blanks left out.
  const parameterValues = (): Record<string, string | number> => {
    const values: Record<string, string | number> = {};
    for (const parameter of prepared?.parameters ?? []) {
      const draft = (parameterDrafts[parameter.id] ?? '').trim();
      if (!draft) continue;
      values[parameter.id] = parameter.kind === 'text' ? draft : Number(draft);
    }
    return values;
  };

  // Re-reads the workflow's parameters and worst case whenever the workflow or a value changes.
  const parameterKey = JSON.stringify(parameterDrafts);
  useEffect(() => {
    if (!startWorkflowId) {
      setPrepared(undefined);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.praxis.workflows
        .prepareRun(project.id, startWorkflowId, parameterValues())
        .then(result => {
          if (!cancelled) setPrepared(result);
        })
        .catch(() => {
          if (!cancelled) setPrepared(undefined);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // parameterValues reads parameterDrafts, which parameterKey stands for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, startWorkflowId, parameterKey]);

  useEffect(() => {
    setParameterDrafts({});
    setConfirmLarge(false);
  }, [startWorkflowId]);

  // Seed defaults once the parameters are known, without overwriting what was typed.
  useEffect(() => {
    if (!prepared) return;
    setParameterDrafts(current => {
      const next = { ...current };
      let changed = false;
      for (const parameter of prepared.parameters) {
        if (next[parameter.id] === undefined && parameter.default !== undefined) {
          next[parameter.id] = String(parameter.default);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [prepared]);

  const needsConfirm = prepared?.estimate.needsConfirm === true;

  const submit = async (uncommittedChanges?: UncommittedChoice) => {
    if (!startWorkflowId || !taskTitle.trim() || busy) return;
    if (needsConfirm && !confirmLarge) {
      setError(`This run could start up to ${prepared?.estimate.worstCaseAgentLaunches} agent sessions. Confirm that below to start it.`);
      return;
    }
    const issueKey = extractIssueKey(issueKeyDraft);
    const matchedIssue = issueKey ? issueOptions.find(option => option.key === issueKey) : undefined;
    setBusy(true);
    setError(undefined);
    setUncommittedFiles(undefined);
    try {
      await assertRunBaseOrThrow(project.id, uncommittedChanges);
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
          providerLimitPolicy,
          aiProvider: selectedProvider,
          aiModel: selectedModel.trim() || undefined,
          ...(uncommittedChanges ? { uncommittedChanges } : {}),
          ...(prepared?.parameters.length ? { parameters: parameterValues() } : {})
        }
      );
      onStarted(run);
    } catch (cause) {
      if (cause instanceof UncommittedBaseError) setUncommittedFiles(cause);
      else setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const usableStatuses = providerStatuses.filter(isProviderUsableForSessions);
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
            <div className="wf-runstart-title">
              <h3>
                <Icon name="play" size={15} />
                Start workflow run
              </h3>
              <p>{project.name}</p>
            </div>
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Close" onClick={onClose}>
              <Icon name="close" size={13} />
            </button>
          </div>
          {(planInput || !project.workspaceFolder || runnableWorkflows.length === 0) && (
            <div className="wf-runstart-notices">
              {planInput && (
                <p data-testid="workflow-plan-input">
                  <Icon name="check" size={13} />
                  Master plan attached · {planInput.generatedFeatureCount} feature{planInput.generatedFeatureCount === 1 ? '' : 's'} · {planInput.generatedStoryCount} stor{planInput.generatedStoryCount === 1 ? 'y' : 'ies'}
                </p>
              )}
              {!project.workspaceFolder && (
                <p className="is-warn">
                  <Icon name="warning" size={13} />
                  No project folder. Agent and check stages will need manual completion.
                </p>
              )}
              {runnableWorkflows.length === 0 && <p>Save a workflow in the designer before starting a run.</p>}
            </div>
          )}
          <section className="wf-runstart-section">
            <div className="wf-runstart-section-head">
              <h4>Run details</h4>
              <p>Choose the work this run should complete.</p>
            </div>
            <div className="wf-runstart-details-grid">
          {runnableWorkflows.length > 1 && (
            <label className="wf-runstart-workflow-field">
              <span>Workflow</span>
              <ChipSelect
                block
                className="wf-runstart-select-chip"
                ariaLabel="Run workflow"
                icon="play"
                value={startWorkflowId}
                placeholder="Choose a workflow"
                onChange={setStartWorkflowId}
                options={[{ value: '', label: 'Choose a workflow' }, ...runnableWorkflows.map(w => ({ value: w.id, label: w.name }))]}
              />
            </label>
          )}
          <label className="wf-runstart-task-field">
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
            <label className="wf-runstart-ticket-field">
              <span>Ticket (optional)</span>
              <ChipSelect
                block
                className="wf-runstart-select-chip"
                ariaLabel="Run ticket"
                data-testid="wf-runstart-issue"
                icon="ticket"
                value={extractIssueKey(issueKeyDraft)}
                placeholder="No ticket"
                searchable
                onChange={key => {
                  setIssueKeyDraft(key);
                  const matched = issueOptions.find(option => option.key === key);
                  if (matched && (!taskTitle.trim() || taskTitle === autoTitle.current)) setTaskTitle(matched.summary);
                }}
                options={[
                  { value: '', label: 'No ticket', description: 'The outcome is not written back anywhere' },
                  ...issueOptions.map(option => ({ value: option.key, label: `${option.key} · ${option.summary}` }))
                ]}
              />
            </label>
          )}
            </div>
          </section>
          {prepared && prepared.parameters.length > 0 && (
            <section className="wf-runstart-section" data-testid="wf-runstart-parameters">
              <div className="wf-runstart-section-head">
                <h4>What to aim for</h4>
                <p>
                  {prepared.requiresMeasurableGoal
                    ? 'Give a target or a rubric — without one the run cannot tell an improvement from churn.'
                    : 'This workflow asks for these when it starts.'}
                </p>
              </div>
              <div className="wf-runstart-parameters">
                {prepared.parameters.map(parameter => {
                  const issue = (parameterDrafts[parameter.id] ?? '').trim()
                    ? prepared.issues.find(candidate => candidate.parameterId === parameter.id)
                    : undefined;
                  const label = `${parameter.label}${parameter.required ? '' : ' (optional)'}`;
                  return (
                    <label key={parameter.id} className={`wf-runstart-parameter${parameter.kind === 'text' ? ' is-text' : ''}`}>
                      <span title={parameter.description}>{label}</span>
                      {parameter.kind === 'text' ? (
                        <textarea
                          rows={2}
                          aria-label={parameter.label}
                          data-testid={`wf-runstart-param-${parameter.id}`}
                          value={parameterDrafts[parameter.id] ?? ''}
                          placeholder={parameter.description}
                          onChange={event => setParameterDrafts(current => ({ ...current, [parameter.id]: event.target.value }))}
                        />
                      ) : (
                        <input
                          type="number"
                          aria-label={parameter.label}
                          data-testid={`wf-runstart-param-${parameter.id}`}
                          value={parameterDrafts[parameter.id] ?? ''}
                          min={parameter.min}
                          max={parameter.max}
                          step={parameter.kind === 'integer' ? 1 : 'any'}
                          onChange={event => setParameterDrafts(current => ({ ...current, [parameter.id]: event.target.value }))}
                        />
                      )}
                      {parameter.kind !== 'text' && parameter.description && <span className="wf-runstart-parameter-hint">{parameter.description}</span>}
                      {issue && <span className="wf-runstart-parameter-issue" role="alert">{issue.message}</span>}
                    </label>
                  );
                })}
              </div>
            </section>
          )}
          {prepared && <RunEstimatePanel estimate={prepared.estimate} confirmed={confirmLarge} onConfirm={setConfirmLarge} />}
          {availableProviderOptions.length > 0 && (
            <section className="wf-runstart-section">
              <div className="wf-runstart-section-head">
                <h4>AI runtime</h4>
                <p>Used when a stage does not specify its own model.</p>
              </div>
              <div className="wf-runstart-runtime-grid">
              <label>
                <span>AI Provider</span>
                <ChipSelect
                  block
                  className="wf-runstart-select-chip"
                  ariaLabel="Run AI provider"
                  data-testid="wf-runstart-provider"
                  icon="robot"
                  value={selectedProvider ?? ''}
                  placeholder="Choose a provider"
                  onChange={value => setSelectedProvider(value as AiProvider)}
                  options={availableProviderOptions.map(status => ({
                    value: status.provider,
                    label: providerLabel(status.provider) ?? status.provider,
                    icon: providerIconName(status.provider)
                  }))}
                />
              </label>
              {modelOptions && modelOptions.options.length > 0 && (
                <label>
                  <span>Model</span>
                  <ChipSelect
                    block
                    className="wf-runstart-select-chip"
                    ariaLabel="Run AI model"
                    data-testid="wf-runstart-model"
                    icon="sparkles"
                    value={selectedModel}
                    placeholder="Choose a model"
                    disabled={modelsLoading}
                    onChange={setSelectedModel}
                    options={modelOptions.options.map(opt => ({ value: opt.value, label: opt.name || opt.value, description: opt.description }))}
                  />
                </label>
              )}
              </div>
            </section>
          )}
          <div className="wf-runstart-policy-grid">
          <fieldset className="wf-runstart-mode" data-testid="wf-runstart-limit">
            <legend>If an AI runs out of budget</legend>
            <label className={`composer-chip wf-runstart-mode-option${providerLimitPolicy === 'ask' ? ' active' : ''}`}>
              <input
                type="radio"
                name="wf-provider-limit"
                value="ask"
                checked={providerLimitPolicy === 'ask'}
                onChange={() => setProviderLimitPolicy('ask')}
                data-testid="wf-runstart-limit-ask"
              />
              <span>
                <strong>Ask me</strong>
              </span>
            </label>
            <label className={`composer-chip wf-runstart-mode-option${providerLimitPolicy === 'switch' ? ' active' : ''}`}>
              <input
                type="radio"
                name="wf-provider-limit"
                value="switch"
                checked={providerLimitPolicy === 'switch'}
                onChange={() => setProviderLimitPolicy('switch')}
                data-testid="wf-runstart-limit-switch"
              />
              <span>
                <strong>Auto-switch</strong>
              </span>
            </label>
            <label className={`composer-chip wf-runstart-mode-option${providerLimitPolicy === 'stop' ? ' active' : ''}`}>
              <input
                type="radio"
                name="wf-provider-limit"
                value="stop"
                checked={providerLimitPolicy === 'stop'}
                onChange={() => setProviderLimitPolicy('stop')}
                data-testid="wf-runstart-limit-stop"
              />
              <span>
                <strong>Stop the run</strong>
              </span>
            </label>
            <p className="wf-runstart-policy-help">
              {providerLimitPolicy === 'ask' && 'Pause and ask whether to switch AI, retry, or stop.'}
              {providerLimitPolicy === 'switch' && 'Continue with the next configured AI without asking.'}
              {providerLimitPolicy === 'stop' && 'End the run and report where the limit was reached.'}
            </p>
          </fieldset>
          <fieldset className="wf-runstart-mode" data-testid="wf-runstart-mode">
            <legend>Tool permissions</legend>
            <label className={`composer-chip wf-runstart-mode-option${permissionMode === 'ask' ? ' active' : ''}`}>
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
              </span>
            </label>
            <label className={`composer-chip wf-runstart-mode-option${permissionMode === 'auto' ? ' active' : ''}`}>
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
              </span>
            </label>
            <p className="wf-runstart-policy-help">
              {permissionMode === 'ask'
                ? 'Pause for Allow or Deny before edits and commands.'
                : 'Approve stage tool requests automatically. Stage access limits and human gates still apply.'}
            </p>
          </fieldset>
          </div>
          {uncommittedFiles && (
            <UncommittedBaseNotice
              files={uncommittedFiles.files}
              projectId={uncommittedFiles.projectId}
              busy={busy}
              onChoose={choice => void submit(choice)}
              onCommitted={() => void submit()}
              onDismiss={() => setUncommittedFiles(undefined)}
            />
          )}
          {error && (
            <p role="alert" className="error-banner">
              {error}
            </p>
          )}
          <div className="wf-runstart-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!startWorkflowId || !taskTitle.trim() || busy || (needsConfirm && !confirmLarge)}>
              {busy ? 'Starting…' : 'Start'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

/**
 * The run's ceiling before it starts: agent sessions on the first pass and at worst
 * (every loop spent, every retry used, every map item run). Tokens and spend appear only
 * when this machine has measured enough earlier stage sessions — otherwise it says so.
 */
function RunEstimatePanel({
  estimate,
  confirmed,
  onConfirm
}: {
  estimate: RunEstimate;
  confirmed: boolean;
  onConfirm: (value: boolean) => void;
}) {
  const loops = estimate.loops.length;
  return (
    <section className="wf-runstart-section wf-runstart-estimate" data-testid="wf-runstart-estimate">
      <div className="wf-runstart-section-head">
        <h4>Cost at worst</h4>
        <p>An estimate of the ceiling, not of what this run will use.</p>
      </div>
      <p data-testid="wf-runstart-estimate-launches">
        {estimate.firstPassAgentLaunches} agent session{estimate.firstPassAgentLaunches === 1 ? '' : 's'} on the first pass · up to{' '}
        <strong>{estimate.worstCaseAgentLaunches}</strong> at worst
        {loops > 0 ? ' (every loop spent, every retry used)' : ' (every retry used)'}, plus up to {estimate.worstCaseCheckLaunches} check
        {estimate.worstCaseCheckLaunches === 1 ? '' : 's'}.
      </p>
      {estimate.tokens ? (
        <p data-testid="wf-runstart-estimate-tokens">
          About {formatTokens(estimate.tokens.low)}–{formatTokens(estimate.tokens.high)} tokens
          {estimate.spend ? ` · ${estimate.spend.currency} ${estimate.spend.low.toFixed(2)}–${estimate.spend.high.toFixed(2)}` : ''}, from{' '}
          {estimate.basedOnSessions} earlier stage sessions on this machine.
        </p>
      ) : (
        <p className="rail-sub" data-testid="wf-runstart-estimate-tokens">
          Tokens and spend: not estimable yet — too few earlier workflow stage sessions have reported usage here.
        </p>
      )}
      {estimate.needsConfirm && (
        <label className="form-check" data-testid="wf-runstart-confirm-large">
          <input type="checkbox" checked={confirmed} onChange={event => onConfirm(event.target.checked)} />
          I understand this run could start up to {estimate.worstCaseAgentLaunches} agent sessions
        </label>
      )}
    </section>
  );
}
