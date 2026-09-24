import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDialogs } from '../ui/dialogs';
import type {
  AgentSessionRecord,
  AgentTaskDefinition,
  AgentWorkflowReference,
  AiProvider,
  AiProviderStatus,
  BackendMode,
  GitLabMergeRequest,
  IssueDetails,
  IssueSummary,
  IssueWorkflowAssignment,
  ModelOptions,
  UpdateIssueInput
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import { WorkflowPicker } from '../ai/WorkflowPicker';
import type { SessionWorkflowOption } from '../ai/NewSession';
import {
  agentStateBadgeClass,
  agentStateLabel,
  isTerminalAgentState
} from '../ai/aiSessionState';
import {
  getDraftParentRule,
  isIdeaDraftType,
  PRIORITY_OPTIONS,
  SEVERITY_OPTIONS
} from './issueDraftFields';
import { resolveBackendMode } from '../board/boardMeta';
import { fetchModelOptions, hasModelCatalog, providerIconName, providerLabel } from '../ai/modelProviders';
import { isProviderUsableForSessions } from '../ai/providerAvailability';
import { ChipSelect } from '../ui/ChipSelect';

/** Centre-pane AI tooling views the detail panel can hand off to. */
export type IssueAiView = 'review' | 'lpr';

interface IssueDetailProps {
  issueKey: string;
  connectionId?: string;
  projectId?: string;
  workflowOptions?: SessionWorkflowOption[];
  expanded?: boolean;
  onToggleExpanded?: () => void;
  onClose: () => void;
  onChanged: () => void;
  /**
   * Bumped by the shell when something outside this panel (an applied AI review)
   * changed the ticket. The panel refetches so it neither shows stale text nor
   * lets a later Save overwrite the change from an out-of-date draft; unsaved
   * edits in the draft are left alone.
   */
  refreshToken?: number;
  /** Navigates the panel to another issue (parent chip, sub-task, linked issue). */
  onOpenIssue?: (issueKey: string) => void;
  /** Opens the Sessions view focused on this issue's agent session. */
  onOpenSession?: (issueKey: string) => void;
  /** Opens a full-page review tool for this issue. Analysis runs in its agent session. */
  onOpenAiView?: (
    issueKey: string,
    view: IssueAiView,
    runtime?: { provider?: AiProvider; model?: string }
  ) => void;
  /** Opens the AI Provider settings for first-run configuration. */
  onOpenAiSettings?: () => void;
}

interface StartAiSessionDialogProps {
  issue: IssueDetails;
  existingSession?: AgentSessionRecord;
  providerStatuses: AiProviderStatus[];
  selectedProvider?: AiProvider;
  onProviderChange: (provider: AiProvider) => void;
  runtimeModels?: ModelOptions;
  selectedModel: string;
  onModelChange: (model: string) => void;
  modelsLoading: boolean;
  governedWorkflows?: SessionWorkflowOption[];
  workflows: AgentWorkflowReference[];
  assignedWorkflow?: AgentWorkflowReference;
  onClose: () => void;
  onViewExisting?: () => void;
  onStart: (task: AgentTaskDefinition, governedWorkflowId?: string) => Promise<void>;
}

function StartAiSessionDialog({
  issue,
  existingSession,
  providerStatuses,
  selectedProvider,
  onProviderChange,
  runtimeModels,
  selectedModel,
  onModelChange,
  modelsLoading,
  governedWorkflows = [],
  workflows,
  assignedWorkflow,
  onClose,
  onViewExisting,
  onStart
}: StartAiSessionDialogProps) {
  const previous = existingSession?.taskDefinition;
  const [goal, setGoal] = useState(
    previous?.goal ?? `${issue.summary}${issue.description ? `\n${issue.description.slice(0, 200)}` : ''}`
  );
  const [scope, setScope] = useState(previous?.scope ?? 'This issue and related files');
  const [definitionOfDone, setDefinitionOfDone] = useState(
    previous?.definitionOfDone ?? 'All acceptance criteria met, code compiles, tests pass'
  );
  const [governedWorkflowId, setGovernedWorkflowId] = useState(
    existingSession?.workflowId ?? ''
  );
  const initialWorkflow = previous?.workflow ?? assignedWorkflow;
  const [workflowPackId, setWorkflowPackId] = useState(initialWorkflow?.id ?? '');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | undefined>();
  const configuredProviders = providerStatuses.filter(isProviderUsableForSessions);
  const selectedStatus = providerStatuses.find(status => status.provider === selectedProvider);
  const workflowPackOptions = initialWorkflow && !workflows.some(workflow => workflow.id === initialWorkflow.id)
    ? [initialWorkflow, ...workflows]
    : workflows;
  const selectedGovernedWorkflow = governedWorkflows.find(option => option.id === governedWorkflowId);

  const submit = async () => {
    if (!goal.trim() || !scope.trim() || !definitionOfDone.trim() || !selectedProvider) {
      return;
    }
    if (selectedGovernedWorkflow && !selectedGovernedWorkflow.ready) {
      setStartError(selectedGovernedWorkflow.blockers?.join(' ') || 'This workflow is not ready to run.');
      return;
    }
    setStarting(true);
    setStartError(undefined);
    try {
      const workflowPack = workflowPackOptions.find(option => option.id === workflowPackId);
      await onStart(
        {
          kind: 'general',
          goal: goal.trim(),
          scope: scope.trim(),
          definitionOfDone: definitionOfDone.trim(),
          ...(workflowPack ? { workflow: workflowPack } : {})
        },
        governedWorkflowId || undefined
      );
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
      setStarting(false);
    }
  };

  return (
    <div className="modal-overlay" data-testid="issue-session-dialog" onClick={() => !starting && onClose()}>
      <div className="modal-card session-setup-card" onClick={event => event.stopPropagation()}>
        <div className="modal-header">
          <Icon name="robot" size={14} />
          <div className="session-setup-heading">
            <h3>Start AI session</h3>
            <span>{issue.key} — {issue.summary}</span>
          </div>
          <span style={{ flex: 1 }} />
          <button className="icon-btn icon-btn-sm" aria-label="Close" disabled={starting} onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className="modal-body session-setup-body">
          {existingSession && (
            <div className="info-banner" data-testid="issue-session-existing-warning">
              This ticket already has a {agentStateLabel(existingSession.state).toLowerCase()} session.
              Starting a new one will stop and replace it.
              {onViewExisting && (
                <button className="btn btn-compact" type="button" onClick={onViewExisting}>
                  View existing
                </button>
              )}
            </div>
          )}
          {startError && <div className="error-banner" data-testid="issue-session-error">{startError}</div>}

          <label className="session-setup-field">
            <span>Goal</span>
            <textarea
              className="textarea"
              data-testid="issue-session-goal"
              rows={4}
              value={goal}
              onChange={event => setGoal(event.target.value)}
            />
          </label>
          <label className="session-setup-field">
            <span>Scope</span>
            <input
              className="input"
              data-testid="issue-session-scope"
              value={scope}
              onChange={event => setScope(event.target.value)}
            />
          </label>
          <label className="session-setup-field">
            <span>Definition of Done</span>
            <textarea
              className="textarea"
              data-testid="issue-session-done"
              rows={3}
              value={definitionOfDone}
              onChange={event => setDefinitionOfDone(event.target.value)}
            />
          </label>

          <div className="session-setup-options">
            <label className="session-setup-field">
              <span>Provider</span>
              <ChipSelect
                block
                ariaLabel="Provider"
                data-testid="issue-ai-provider"
                value={selectedProvider ?? ''}
                placeholder="No configured provider"
                disabled={starting || configuredProviders.length === 0}
                onChange={value => onProviderChange(value as AiProvider)}
                options={configuredProviders.map(status => ({ value: status.provider, label: providerLabel(status.provider), icon: providerIconName(status.provider) }))}
              />
            </label>
            <label className="session-setup-field">
              <span>Model</span>
              <ChipSelect
                block
                ariaLabel="Model"
                data-testid="issue-ai-runtime-model"
                value={selectedModel}
                icon="sparkles"
                disabled={starting || modelsLoading || !runtimeModels?.options.length}
                onChange={onModelChange}
                options={[
                  { value: '', label: modelsLoading ? 'Loading models…' : 'Provider default' },
                  ...(runtimeModels?.options.map(option => ({ value: option.value, label: option.name, description: option.description })) ?? [])
                ]}
              />
            </label>
          </div>

          {governedWorkflows.length > 0 && (
            <label className="session-setup-field">
              <span>Governed workflow</span>
              <ChipSelect
                block
                ariaLabel="Governed workflow"
                data-testid="issue-session-workflow"
                value={governedWorkflowId}
                disabled={starting}
                onChange={setGovernedWorkflowId}
                options={[
                  { value: '', label: 'No governed workflow — ordinary session' },
                  ...governedWorkflows.map(workflow => ({
                    value: workflow.id,
                    label: workflow.name,
                    meta: `v${workflow.version}${workflow.ready ? '' : ' · not ready'}`
                  }))
                ]}
              />
              {governedWorkflowId && (() => {
                const selected = governedWorkflows.find(option => option.id === governedWorkflowId);
                return selected && !selected.ready ? (
                  <small className="form-hint form-hint-error">
                    {selected.blockers?.join(' ') || 'This workflow is not ready to run.'}
                  </small>
                ) : selected?.description ? <small className="form-hint">{selected.description}</small> : null;
              })()}
            </label>
          )}

          {workflows.length > 0 && (
            <label className="session-setup-field">
              <span>Workflow pack</span>
              <ChipSelect
                block
                ariaLabel="Workflow pack"
                data-testid="issue-session-workflow-pack"
                value={workflowPackId}
                disabled={starting}
                onChange={setWorkflowPackId}
                options={[{ value: '', label: 'No workflow pack' }, ...workflowPackOptions.map(workflow => ({ value: workflow.id, label: workflow.name }))]}
              />
            </label>
          )}

          {selectedProvider && (
            <p className="detail-ai-provider-hint">
              <Icon name={providerIconName(selectedProvider)} size={12} />
              {selectedStatus?.configured
                ? `The shared Praxis execution prompt will run with ${providerLabel(selectedProvider)}${selectedModel ? ` · ${selectedModel}` : ''}.`
                : `${providerLabel(selectedProvider)} is not configured. Open Settings → AI Provider.`}
            </p>
          )}
        </div>
        <div className="session-setup-footer">
          <button className="btn" type="button" disabled={starting} onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            type="button"
            data-testid="issue-session-start"
            disabled={
              starting ||
              !selectedStatus?.configured ||
              !goal.trim() ||
              !scope.trim() ||
              !definitionOfDone.trim() ||
              (selectedGovernedWorkflow !== undefined && !selectedGovernedWorkflow.ready)
            }
            onClick={() => void submit()}
          >
            <Icon name="play" size={13} />
            {starting ? 'Starting…' : existingSession ? 'Start new session' : 'Start session'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface EditDraft {
  summary: string;
  description: string;
  priority: string;
  severity: string;
  assignee: string;
  reportedBy: string;
  ideaTranscript: string;
  issueType: string;
  parentKey: string;
}

const ISSUE_TYPE_OPTIONS = ['Epic', 'Feature', 'Idea', 'Story', 'Task', 'Subtask', 'Bug', 'Issue'];

/** Datalist values are "KEY — Summary" so the summary is visible in the picker. */
const PARENT_OPTION_SEPARATOR = '—';

type EditableField = keyof EditDraft;

const EDITABLE_FIELDS_BY_MODE: Record<BackendMode, ReadonlySet<EditableField>> = {
  demo: new Set(['summary', 'description', 'assignee', 'priority', 'issueType', 'parentKey']),
  folder: new Set([
    'summary',
    'description',
    'assignee',
    'priority',
    'severity',
    'reportedBy',
    'parentKey',
    'ideaTranscript'
  ]),
  // App-storage projects: `ProjectIssueTrackerService.updateIssue` only writes
  // these three, so offering more would silently drop the edit.
  app: new Set(['summary', 'description', 'issueType']),
  project: new Set(['summary', 'description', 'issueType']),
  jiracloud: new Set(['summary', 'description', 'assignee', 'priority', 'issueType', 'parentKey']),
  gitlab: new Set(['summary', 'description', 'assignee']),
  github: new Set(['summary', 'description', 'assignee'])
};

function supportsEdit(mode: BackendMode, field: EditableField): boolean {
  return EDITABLE_FIELDS_BY_MODE[mode].has(field);
}

function unsupportedEditHelp(mode: BackendMode, field: EditableField): string | undefined {
  return supportsEdit(mode, field)
    ? undefined
    : `This field is read-only for ${mode === 'jiracloud' ? 'Jira Cloud' : mode}.`;
}

function FieldRow({
  label,
  description,
  stacked = false,
  children
}: {
  label: string;
  description?: string;
  /** Use a full-width control beneath its label for long-form content. */
  stacked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`settings-field-row${stacked ? ' settings-field-row-stacked' : ''}`}>
      <div className="settings-field-label">
        <strong>{label}</strong>
        {description && <div className="settings-field-help">{description}</div>}
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  );
}

function ReadonlyFieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-field-row">
      <div className="settings-field-label">
        <strong>{label}</strong>
      </div>
      <div className="settings-field-control">
        <span className="detail-meta">{value}</span>
      </div>
    </div>
  );
}

function emptyDraft(): EditDraft {
  return {
    summary: '',
    description: '',
    priority: '',
    severity: '',
    assignee: '',
    reportedBy: '',
    ideaTranscript: '',
    issueType: 'Task',
    parentKey: ''
  };
}

function draftFromIssue(issue: IssueDetails): EditDraft {
  return {
    summary: issue.summary ?? '',
    description: issue.description ?? '',
    priority: issue.priority ?? '',
    severity: issue.severity ?? '',
    assignee: issue.assignee ?? '',
    reportedBy: issue.reportedBy ?? '',
    ideaTranscript: issue.ideaTranscript ?? '',
    issueType: issue.issueType ?? 'Task',
    parentKey: issue.parentKey ?? ''
  };
}

function extractParentKey(raw: string): string {
  const value = raw.trim();
  const separator = ` ${PARENT_OPTION_SEPARATOR} `;
  const separatorIndex = value.indexOf(separator);
  return separatorIndex === -1 ? value : value.slice(0, separatorIndex).trim();
}

function formatDate(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return '—';
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return trimmed;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(parsed);
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function selectOptions(current: string | undefined, defaults: readonly string[]): string[] {
  return [current?.trim(), ...defaults]
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .filter((value, index, array) => array.findIndex(candidate => candidate === value) === index);
}

function isDraftDirty(issue: IssueDetails, draft: EditDraft, statusTransitionId: string): boolean {
  const baseline = draftFromIssue(issue);
  return (
    statusTransitionId !== '' ||
    draft.summary !== baseline.summary ||
    draft.description !== baseline.description ||
    draft.priority !== baseline.priority ||
    draft.severity !== baseline.severity ||
    draft.assignee !== baseline.assignee ||
    draft.reportedBy !== baseline.reportedBy ||
    draft.ideaTranscript !== baseline.ideaTranscript ||
    draft.issueType !== baseline.issueType ||
    draft.parentKey !== baseline.parentKey
  );
}

function buildChangedIssuePatch(
  issue: IssueDetails,
  draft: EditDraft,
  mode: BackendMode,
  parentAllowed: boolean
): UpdateIssueInput {
  const baseline = draftFromIssue(issue);
  const patch: UpdateIssueInput = {};
  if (supportsEdit(mode, 'summary') && draft.summary !== baseline.summary) {
    patch.summary = draft.summary.trim();
  }
  if (supportsEdit(mode, 'description') && draft.description !== baseline.description) {
    patch.description = draft.description;
  }
  if (supportsEdit(mode, 'ideaTranscript') && draft.ideaTranscript !== baseline.ideaTranscript) {
    patch.ideaTranscript = draft.ideaTranscript;
  }
  if (supportsEdit(mode, 'parentKey') && parentAllowed && draft.parentKey !== baseline.parentKey) {
    patch.parentKey = extractParentKey(draft.parentKey).trim() || null;
  }
  if (supportsEdit(mode, 'assignee') && draft.assignee !== baseline.assignee) {
    patch.assignee = draft.assignee.trim() || null;
  }
  if (supportsEdit(mode, 'priority') && draft.priority !== baseline.priority && draft.priority) {
    patch.priority = draft.priority;
  }
  if (supportsEdit(mode, 'severity') && draft.severity !== baseline.severity) {
    patch.severity = draft.severity;
  }
  if (supportsEdit(mode, 'reportedBy') && draft.reportedBy !== baseline.reportedBy) {
    patch.reportedBy = draft.reportedBy.trim();
  }
  if (supportsEdit(mode, 'issueType') && draft.issueType !== baseline.issueType) {
    patch.issueType = draft.issueType.trim();
  }
  return patch;
}

export function IssueDetail({
  issueKey,
  connectionId,
  projectId,
  workflowOptions,
  expanded = false,
  onToggleExpanded,
  onClose,
  onChanged,
  refreshToken,
  onOpenIssue,
  onOpenSession,
  onOpenAiView,
  onOpenAiSettings
}: IssueDetailProps) {
  const { confirm } = useDialogs();
  const [discoveredProjectId, setDiscoveredProjectId] = useState<string | undefined>();
  const effectiveProjectId = projectId ?? discoveredProjectId;

  useEffect(() => {
    if (projectId) return;
    if (connectionId?.startsWith('project:')) {
      setDiscoveredProjectId(connectionId.slice('project:'.length));
      return;
    }
    let cancelled = false;
    window.praxis.connection.list().then(connections => {
      if (cancelled) return;
      if (connectionId) {
        const foundId = connections.find(c => c.id === connectionId)?.settings?.projectId;
        if (typeof foundId === 'string' && foundId.length > 0) {
          setDiscoveredProjectId(foundId);
          return;
        }
      }
      return window.praxis.projects.list().then(projects => {
        if (cancelled) return;
        if (projects.length === 1) {
          setDiscoveredProjectId(projects[0].id);
        }
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, connectionId]);

  const [loadedWorkflows, setLoadedWorkflows] = useState<SessionWorkflowOption[]>([]);
  const effectiveWorkflows = (workflowOptions && workflowOptions.length > 0)
    ? workflowOptions
    : loadedWorkflows;

  useEffect(() => {
    if (!effectiveProjectId || (workflowOptions && workflowOptions.length > 0)) {
      return;
    }
    let cancelled = false;
    Promise.all([
      window.praxis.workflows.listTemplates(effectiveProjectId).catch(() => []),
      window.praxis.workflows.templateReadiness(effectiveProjectId).catch(() => [])
    ]).then(([templates, readiness]) => {
      if (cancelled) return;
      const readinessById = new Map(readiness.map(item => [item.templateId, item]));
      const seenIds = new Set<string>();
      const availableTemplates = [
        ...templates.filter(t => t.source === 'project'),
        ...templates.filter(t => t.source !== 'project')
      ].filter(t => {
        if (seenIds.has(t.definition.id)) return false;
        seenIds.add(t.definition.id);
        return true;
      });
      const options: SessionWorkflowOption[] = availableTemplates.map(template => {
        const status = readinessById.get(template.definition.id);
        const blockers = status
          ? Object.values(status.blockingByNode)
          : ['Live workflow readiness could not be checked.'];
        return {
          id: template.definition.id,
          name: template.definition.name,
          ...(template.definition.description ? { description: template.definition.description } : {}),
          version: template.definition.version,
          ready: !!status?.structureOk && !!status?.agentsOk,
          ...(blockers.length > 0 ? { blockers } : {})
        };
      });
      setLoadedWorkflows(options);
    });
    return () => {
      cancelled = true;
    };
  }, [effectiveProjectId, workflowOptions]);
  const [issue, setIssue] = useState<IssueDetails | undefined>();
  const [commentBody, setCommentBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [draft, setDraft] = useState<EditDraft>(emptyDraft);
  const [statusTransitionId, setStatusTransitionId] = useState('');
  const [connectionMode, setConnectionMode] = useState<BackendMode>('demo');
  const [parentItems, setParentItems] = useState<IssueSummary[]>([]);
  const [descriptionEditing, setDescriptionEditing] = useState(false);
  const [providerStatuses, setProviderStatuses] = useState<AiProviderStatus[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<AiProvider | undefined>();
  const [runtimeModels, setRuntimeModels] = useState<ModelOptions | undefined>();
  const [selectedRuntimeModel, setSelectedRuntimeModel] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [showSessionSetup, setShowSessionSetup] = useState(false);
  const [analysisGateEnabled, setAnalysisGateEnabled] = useState(false);
  const [analysisConfirmed, setAnalysisConfirmed] = useState(false);
  const [analysisPromptConfigured, setAnalysisPromptConfigured] = useState(false);
  const [workingDirectoryConfigured, setWorkingDirectoryConfigured] = useState(false);
  const [deliveryConfigured, setDeliveryConfigured] = useState(false);
  /** This issue's agent session, if one exists — live via the push channel. */
  const [agentSession, setAgentSession] = useState<AgentSessionRecord | undefined>();
  /** Assigned workflow pack (if any) and the picker modal's visibility. */
  const [workflowAssignment, setWorkflowAssignment] = useState<IssueWorkflowAssignment | undefined>();
  const [showWorkflowPicker, setShowWorkflowPicker] = useState(false);
  const [availableWorkflows, setAvailableWorkflows] = useState<AgentWorkflowReference[]>([]);
  const [subTaskAssignments, setSubTaskAssignments] = useState<
    Record<string, IssueWorkflowAssignment | undefined>
  >({});
  /** Merge requests for this issue, loaded on demand (GitLab connections only). */
  const [mergeRequests, setMergeRequests] = useState<GitLabMergeRequest[] | undefined>();
  const [mrError, setMrError] = useState<string | undefined>();

  const refreshIssue = useCallback(() => {
    void window.praxis.issue.get(issueKey, connectionId).then(setIssue);
  }, [issueKey, connectionId]);

  const syncDraftFromIssue = useCallback((loaded: IssueDetails) => {
    setDraft(draftFromIssue(loaded));
    setStatusTransitionId('');
    setDescriptionEditing(false);
    setShowSessionSetup(false);
  }, []);

  useEffect(() => {
    setIssue(undefined);
    setError(undefined);
    setDraft(emptyDraft());
    setStatusTransitionId('');
    setDescriptionEditing(false);
    void window.praxis.issue
      .get(issueKey, connectionId)
      .then(loaded => {
        setIssue(loaded);
        setDraft(draftFromIssue(loaded));
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, [issueKey, connectionId]);

  useEffect(() => {
    let cancelled = false;
    void window.praxis.connection
      .list()
      .then(connections => {
        if (cancelled) {
          return;
        }
        setConnectionMode(resolveBackendMode(connectionId, connections));
      })
      .catch(() => {
        if (!cancelled) {
          setConnectionMode('demo');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.praxis.ai.listProviderStatuses(),
      window.praxis.settings.get()
    ])
      .then(([statuses, settings]) => {
        if (cancelled) {
          return;
        }
        setProviderStatuses(statuses);
        setAnalysisGateEnabled(settings.ai.analysisGateEnabled);
        setAnalysisPromptConfigured(Boolean(settings.ai.analysisPrompt.trim()));
        setWorkingDirectoryConfigured(Boolean(settings.ai.workingDirectory.trim()));
        setDeliveryConfigured(
          settings.delivery.enabled &&
          Boolean(settings.delivery.publishCommand.trim()) &&
          Boolean(settings.delivery.artifactPattern.trim())
        );
        setSelectedProvider(current => {
          if (
            current &&
            statuses.some(status => status.provider === current && isProviderUsableForSessions(status))
          ) {
            return current;
          }
          const active = statuses.find(
            status =>
              status.provider === settings.ai.activeProvider &&
              isProviderUsableForSessions(status)
          );
          return active?.provider ?? statuses.find(isProviderUsableForSessions)?.provider;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setProviderStatuses([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAnalysisConfirmed(false);
    void window.praxis.ai
      .getAnalysis(issueKey)
      .then(state => {
        if (!cancelled) {
          setAnalysisConfirmed(state.confirmed);
        }
      })
      .catch(() => undefined);
    const unsubscribe = window.praxis.ai.onAnalysisChanged(state => {
      if (state.issueKey === issueKey) {
        setAnalysisConfirmed(state.confirmed);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [issueKey]);

  useEffect(() => {
    setRuntimeModels(undefined);
    setSelectedRuntimeModel('');
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
        if (cancelled || !options) {
          return;
        }
        const enabled = settings.ai.providers[selectedProvider]?.enabledModelIds;
        const filtered = enabled
          ? { ...options, options: options.options.filter(option => enabled.includes(option.value)) }
          : options;
        setRuntimeModels(filtered);
        setSelectedRuntimeModel(
          filtered.currentValue && filtered.options.some(option => option.value === filtered.currentValue)
            ? filtered.currentValue
            : (filtered.options[0]?.value ?? '')
        );
      })
      .catch(() => {
        if (!cancelled) {
          setRuntimeModels(undefined);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setModelsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProvider]);

  const parentRule = getDraftParentRule(draft.issueType, connectionMode);
  const issueTypeOptions = useMemo(
    () => selectOptions(draft.issueType, ISSUE_TYPE_OPTIONS),
    [draft.issueType]
  );
  const priorityOptions = useMemo(
    () => selectOptions(draft.priority, PRIORITY_OPTIONS),
    [draft.priority]
  );
  const severityOptions = useMemo(
    () => selectOptions(draft.severity, SEVERITY_OPTIONS),
    [draft.severity]
  );
  const isDirty = issue ? isDraftDirty(issue, draft, statusTransitionId) : false;
  const lastRefreshToken = useRef(refreshToken);
  const isDirtyRef = useRef(false);
  isDirtyRef.current = isDirty;
  useEffect(() => {
    if (refreshToken === lastRefreshToken.current) return;
    lastRefreshToken.current = refreshToken;
    void window.praxis.issue
      .get(issueKey, connectionId)
      .then(loaded => {
        setIssue(loaded);
        if (!isDirtyRef.current) setDraft(draftFromIssue(loaded));
      })
      .catch(() => undefined);
  }, [refreshToken, issueKey, connectionId]);

  const isIdeaIssue = isIdeaDraftType(draft.issueType);
  // Keep this renderer-side check aligned with the core decomposition router
  // without importing the Node-oriented core runtime into the browser bundle.
  const isFeatureRequest = issue?.description?.trim().toLowerCase().includes('feature request') ?? false;
  const analysisRequired = analysisGateEnabled && !analysisConfirmed;
  const selectedProviderStatus = providerStatuses.find(status => status.provider === selectedProvider);
  const configuredProviders = providerStatuses.filter(isProviderUsableForSessions);
  const workflowActionsReady =
    workingDirectoryConfigured && (!analysisGateEnabled || analysisConfirmed);

  useEffect(() => {
    if (!parentRule.canHaveParent || !issue?.projectKey) {
      setParentItems([]);
      return;
    }
    let cancelled = false;
    void window.praxis.issue
      .getParentItems(
        {
          projectKeys: [issue.projectKey],
          statuses: [],
          issueTypes: [],
          searchText: '',
          assigneeMode: 'all',
          grouping: 'none'
        },
        undefined,
        { childIssueType: draft.issueType },
        connectionId
      )
      .then(items => {
        if (!cancelled) {
          setParentItems(items.filter(item => item.key !== issueKey));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setParentItems([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [parentRule.canHaveParent, issue?.projectKey, draft.issueType, connectionId, issueKey]);

  // Track this issue's agent session: initial pull, then follow push updates
  // for this key so the state chip and abort button stay live.
  useEffect(() => {
    let cancelled = false;
    setAgentSession(undefined);
    void window.praxis.ai
      .listSessions()
      .then(sessions => {
        if (!cancelled) {
          setAgentSession(sessions.find(session => session.issueKey === issueKey));
        }
      })
      .catch(() => undefined);
    const unsubscribe = window.praxis.ai.onSessionChanged(record => {
      if (record.issueKey === issueKey) {
        setAgentSession(record);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [issueKey]);

  useEffect(() => {
    let cancelled = false;
    const subTaskKeys = issue?.subTasks?.map(subTask => subTask.key) ?? [];
    Promise.all([
      window.praxis.ai.listWorkflowPacks(),
      Promise.all(
        subTaskKeys.map(async key => [key, await window.praxis.ai.getWorkflowAssignment(key)] as const)
      )
    ])
      .then(([workflows, assignments]) => {
        if (!cancelled) {
          setAvailableWorkflows(workflows);
          setSubTaskAssignments(Object.fromEntries(assignments));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAvailableWorkflows([]);
          setSubTaskAssignments({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [issue?.subTasks]);

  // Workflow-pack assignment for this issue.
  useEffect(() => {
    let cancelled = false;
    setWorkflowAssignment(undefined);
    setMergeRequests(undefined);
    setMrError(undefined);
    void window.praxis.ai
      .getWorkflowAssignment(issueKey)
      .then(assignment => {
        if (!cancelled) {
          setWorkflowAssignment(assignment);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [issueKey]);

  const openInBrowser = (url: string | undefined) => {
    if (url) {
      void window.praxis.shell.openExternal(url);
    }
  };

  const resetDraft = () => {
    if (issue) {
      syncDraftFromIssue(issue);
      setError(undefined);
    }
  };

  const refreshDetails = async () => {
    if (isDirty && !(await confirm({ title: 'Discard unsaved ticket changes?', message: 'The ticket will be reloaded from the tracker.', confirmLabel: 'Discard and refresh', danger: true }))) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const loaded = await window.praxis.issue.get(issueKey, connectionId);
      setIssue(loaded);
      syncDraftFromIssue(loaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const closeDetails = async () => {
    if (!isDirty || (await confirm({ title: 'Discard unsaved ticket changes?', confirmLabel: 'Discard', danger: true }))) {
      onClose();
    }
  };

  const openRelatedIssue = async (key: string) => {
    if (!isDirty || (await confirm({ title: 'Discard unsaved ticket changes?', message: 'Another ticket will open in its place.', confirmLabel: 'Discard and open', danger: true }))) {
      onOpenIssue?.(key);
    }
  };

  const assignToMe = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const label = await window.praxis.issue.getSelfAssigneeLabel(connectionId);
      if (!label) {
        throw new Error('The current tracker user could not be resolved. Enter an assignee manually.');
      }
      await window.praxis.issue.update(issueKey, { assignee: label }, connectionId);
      const loaded = await window.praxis.issue.get(issueKey, connectionId);
      setIssue(loaded);
      syncDraftFromIssue(loaded);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      refreshIssue();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openSessionSetup = () => {
    if (isDirty) {
      setError('Save or reset the ticket changes before starting an AI session so the agent receives the current details.');
      return;
    }
    setError(undefined);
    setShowSessionSetup(true);
  };

  const startAiSession = async (task: AgentTaskDefinition, chosenWorkflowId?: string) => {
    const record = await window.praxis.ai.delegate({
      issueKey,
      connectionId,
      ...(effectiveProjectId ? { projectId: effectiveProjectId } : {}),
      task,
      provider: selectedProvider,
      model: selectedRuntimeModel || undefined
    });
    if (chosenWorkflowId) {
      if (!effectiveProjectId) {
        await window.praxis.ai.deleteSession(record.issueKey);
        throw new Error('A project is required to run a governed workflow.');
      }
      try {
        await window.praxis.workflows.startRun(
          effectiveProjectId,
          chosenWorkflowId,
          issue?.summary || task.goal,
          { issueKey, connectionId },
          { sessionKey: record.issueKey, sessionId: record.sessionId }
        );
      } catch (error) {
        await window.praxis.ai.deleteSession(record.issueKey).catch(() => undefined);
        throw error;
      }
    }
    setAgentSession(record);
    setShowSessionSetup(false);
    onOpenSession?.(record.issueKey);
  };

  const primaryAiMode = agentSession ? 'session' : analysisRequired ? 'analysis' : 'start';
  const runPrimaryAiAction = () => {
    if (primaryAiMode === 'session') {
      onOpenSession?.(issueKey);
      return;
    }
    if (primaryAiMode === 'analysis') {
      if (!selectedProviderStatus?.configured) {
        setError('Configure an AI provider before analyzing this ticket.');
        return;
      }
      if (!analysisPromptConfigured) {
        setError('Set an analysis system prompt under Settings → AI Provider before analyzing this ticket.');
        return;
      }
      setBusy(true);
      setError(undefined);
      void window.praxis.ai
        .delegate({
          issueKey,
          connectionId,
          provider: selectedProviderStatus.provider,
          model: selectedRuntimeModel || undefined,
          purpose: 'analysis'
        })
        .then(record => {
          setAgentSession(record);
          onOpenSession?.(record.issueKey);
        })
        .catch(err => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false));
      return;
    }
    openSessionSetup();
  };

  const saveEdits = () => {
    if (!issue) {
      return;
    }
    const trimmedSummary = draft.summary.trim();
    if (!trimmedSummary) {
      setError('Summary is required.');
      return;
    }

    const payload = buildChangedIssuePatch(
      issue,
      { ...draft, summary: trimmedSummary },
      connectionMode,
      parentRule.canHaveParent
    );

    void (async () => {
      setBusy(true);
      setError(undefined);
      try {
        const updated = await window.praxis.issue.update(issueKey, payload, connectionId);
        const savedIssueKey = updated.key;
        if (statusTransitionId) {
          await window.praxis.issue.transition(savedIssueKey, statusTransitionId, connectionId);
        }
        const loaded = await window.praxis.issue.get(savedIssueKey, connectionId);
        setIssue(loaded);
        syncDraftFromIssue(loaded);
        if (savedIssueKey !== issueKey) {
          onOpenIssue?.(savedIssueKey);
        }
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="detail-panel">
      <div className="detail-header">
        <Icon name="ticket" size={14} />
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{issueKey}</h3>
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-compact detail-start-session-btn"
          aria-label={
            primaryAiMode === 'session'
              ? 'View AI session'
              : primaryAiMode === 'analysis'
                ? 'Analyze ticket'
                : 'Start AI session'
          }
          title={
            primaryAiMode === 'session'
              ? 'Open this ticket’s AI session'
              : primaryAiMode === 'analysis'
                ? 'Analyze and confirm this ticket before starting AI'
                : 'Start an AI session from this ticket'
          }
          data-testid="issue-primary-ai-btn"
          data-ai-mode={primaryAiMode}
          disabled={
            !issue ||
            busy ||
            (primaryAiMode === 'session' && !onOpenSession) ||
            (primaryAiMode === 'analysis' && !onOpenSession)
          }
          onClick={runPrimaryAiAction}
        >
          <Icon
            name={primaryAiMode === 'analysis' ? 'search' : primaryAiMode === 'session' ? 'terminal' : 'robot'}
            size={13}
          />
          <span>
            {primaryAiMode === 'analysis'
              ? 'Analyze ticket'
              : primaryAiMode === 'session'
                ? 'View AI'
                : 'Start AI'}
          </span>
        </button>
        {onToggleExpanded && (
          <button
            className="icon-btn icon-btn-sm"
            aria-label={expanded ? 'Restore ticket details' : 'Expand ticket details'}
            aria-pressed={expanded}
            title={expanded ? 'Restore ticket details' : 'Expand ticket details'}
            data-testid="issue-expand-btn"
            onClick={onToggleExpanded}
          >
            <Icon name={expanded ? 'window-restore' : 'window-maximize'} size={13} />
          </button>
        )}
        <button
          className="icon-btn icon-btn-sm"
          aria-label="Refresh ticket"
          title="Refresh ticket"
          data-testid="issue-refresh-btn"
          disabled={busy}
          onClick={() => void refreshDetails()}
        >
          <Icon name="refresh" size={13} />
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Close" onClick={() => void closeDetails()}>
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="detail-body">
        {!issue && !error && <p className="placeholder-text">Loading…</p>}
        {error && !issue && <div className="error-banner">{error}</div>}

        {issue && (
          <>
            <div className="new-issue-form" data-testid="issue-edit-form">
              {error && <div className="error-banner">{error}</div>}

              <ReadonlyFieldRow
                label="Project"
                value={
                  issue.projectName
                    ? `${issue.projectKey} · ${issue.projectName}`
                    : issue.projectKey || '—'
                }
              />
              <ReadonlyFieldRow label="Created" value={formatDate(issue.created)} />
              <ReadonlyFieldRow label="Updated" value={formatDate(issue.updated)} />
              {issue.branch && <ReadonlyFieldRow label="Branch" value={issue.branch} />}
              {issue.complexity && <ReadonlyFieldRow label="Complexity" value={issue.complexity} />}

              <FieldRow label="Summary" description={unsupportedEditHelp(connectionMode, 'summary')}>
                <input
                  className="input new-issue-grow"
                  data-testid="issue-edit-summary"
                  value={draft.summary}
                  disabled={!supportsEdit(connectionMode, 'summary')}
                  onChange={event => setDraft(current => ({ ...current, summary: event.target.value }))}
                />
              </FieldRow>

              <FieldRow label="Status">
                <ChipSelect
                  block
                  className="new-issue-grow"
                  ariaLabel="Status"
                  data-testid="issue-edit-status"
                  value={statusTransitionId}
                  onChange={setStatusTransitionId}
                  disabled={!issue.transitions?.length}
                  options={[
                    { value: '', label: issue.status },
                    ...(issue.transitions?.map(transition => ({ value: transition.id, label: transition.toStatus ?? transition.name })) ?? [])
                  ]}
                />
              </FieldRow>

              <FieldRow label="Ticket type" description={unsupportedEditHelp(connectionMode, 'issueType')}>
                <ChipSelect
                  block
                  className="new-issue-grow"
                  ariaLabel="Ticket type"
                  data-testid="issue-edit-issueType"
                  value={draft.issueType}
                  disabled={!supportsEdit(connectionMode, 'issueType')}
                  onChange={value => setDraft(current => ({ ...current, issueType: value, parentKey: '' }))}
                  options={issueTypeOptions.map(type => ({ value: type, label: type }))}
                />
              </FieldRow>

              <FieldRow label="Assignee" description={unsupportedEditHelp(connectionMode, 'assignee')}>
                <input
                  className="input new-issue-grow"
                  data-testid="issue-edit-assignee"
                  value={draft.assignee}
                  disabled={!supportsEdit(connectionMode, 'assignee')}
                  onChange={event => setDraft(current => ({ ...current, assignee: event.target.value }))}
                />
                <button
                  type="button"
                  className="btn btn-compact"
                  data-testid="issue-assign-me-btn"
                  disabled={busy || !supportsEdit(connectionMode, 'assignee')}
                  onClick={() => void assignToMe()}
                >
                  Assign to me
                </button>
              </FieldRow>

              <FieldRow label="Priority" description={unsupportedEditHelp(connectionMode, 'priority')}>
                <ChipSelect
                  block
                  className="new-issue-grow"
                  ariaLabel="Priority"
                  data-testid="issue-edit-priority"
                  value={draft.priority}
                  disabled={!supportsEdit(connectionMode, 'priority')}
                  onChange={value => setDraft(current => ({ ...current, priority: value }))}
                  options={[{ value: '', label: '—' }, ...priorityOptions.map(option => ({ value: option, label: option }))]}
                />
              </FieldRow>

              <FieldRow label="Severity" description={unsupportedEditHelp(connectionMode, 'severity')}>
                <ChipSelect
                  block
                  className="new-issue-grow"
                  ariaLabel="Severity"
                  data-testid="issue-edit-severity"
                  value={draft.severity}
                  disabled={!supportsEdit(connectionMode, 'severity')}
                  onChange={value => setDraft(current => ({ ...current, severity: value }))}
                  options={[{ value: '', label: '— None —' }, ...severityOptions.map(option => ({ value: option, label: option }))]}
                />
              </FieldRow>

              <FieldRow label="Reported by" description={unsupportedEditHelp(connectionMode, 'reportedBy')}>
                <input
                  className="input new-issue-grow"
                  data-testid="issue-edit-reportedBy"
                  value={draft.reportedBy}
                  disabled={!supportsEdit(connectionMode, 'reportedBy')}
                  onChange={event => setDraft(current => ({ ...current, reportedBy: event.target.value }))}
                />
              </FieldRow>

              {parentRule.canHaveParent && (
                <FieldRow
                  label={parentRule.label}
                  description={
                    unsupportedEditHelp(connectionMode, 'parentKey') ?? parentRule.helperText
                  }
                >
                  <input
                    className="input new-issue-grow"
                    data-testid="issue-edit-parent"
                    list="issue-detail-parent-options"
                    placeholder={parentRule.placeholder}
                    value={draft.parentKey}
                    disabled={!supportsEdit(connectionMode, 'parentKey')}
                    onChange={event => setDraft(current => ({ ...current, parentKey: event.target.value }))}
                  />
                  <datalist id="issue-detail-parent-options">
                    {parentItems.map(item => (
                      <option
                        key={item.key}
                        value={`${item.key} ${PARENT_OPTION_SEPARATOR} ${item.summary}`}
                      />
                    ))}
                  </datalist>
                  {onOpenIssue && issue.parentKey && (
                    <button
                      type="button"
                      className="chip"
                      data-testid="issue-parent-link"
                      title={issue.parentIssue?.summary ?? issue.parentKey}
                      onClick={() => void openRelatedIssue(issue.parentIssue?.key ?? issue.parentKey ?? '')}
                    >
                      Open {issue.parentIssue?.key ?? issue.parentKey}
                    </button>
                  )}
                  {issue.parentIssue && (
                    <div className="detail-parent-preview">
                      <strong>{issue.parentIssue.summary}</strong>
                      {issue.parentIssue.description && <Markdown text={issue.parentIssue.description} />}
                    </div>
                  )}
                </FieldRow>
              )}

              <FieldRow
                label="Description"
                stacked
                description={
                  unsupportedEditHelp(connectionMode, 'description') ??
                  (descriptionEditing ? 'Edit Markdown directly.' : 'Click the rendered description to edit Markdown.')
                }
              >
                {descriptionEditing ? (
                  <textarea
                    autoFocus
                    className="textarea detail-inline-description-editor"
                    data-testid="issue-edit-description"
                    rows={8}
                    value={draft.description}
                    onBlur={() => setDescriptionEditing(false)}
                    onChange={event => setDraft(current => ({ ...current, description: event.target.value }))}
                  />
                ) : (
                  <div
                    className={`detail-markdown-preview detail-inline-description${
                      supportsEdit(connectionMode, 'description') ? ' is-editable' : ''
                    }`}
                    data-testid="issue-description"
                    role={supportsEdit(connectionMode, 'description') ? 'button' : undefined}
                    tabIndex={supportsEdit(connectionMode, 'description') ? 0 : undefined}
                    onClick={event => {
                      if (
                        supportsEdit(connectionMode, 'description') &&
                        !(event.target as HTMLElement).closest('a')
                      ) {
                        setDescriptionEditing(true);
                      }
                    }}
                    onKeyDown={event => {
                      if (
                        supportsEdit(connectionMode, 'description') &&
                        (event.key === 'Enter' || event.key === ' ')
                      ) {
                        event.preventDefault();
                        setDescriptionEditing(true);
                      }
                    }}
                  >
                    {draft.description.trim() ? (
                      <Markdown text={draft.description} />
                    ) : (
                      <span className="placeholder-text">Add a description…</span>
                    )}
                  </div>
                )}
              </FieldRow>

              {isIdeaDraftType(draft.issueType) && (
                <FieldRow
                  label="AI research transcript"
                  description="Idea tickets keep research here instead of code delivery workflows."
                >
                  <textarea
                    className="textarea"
                    data-testid="issue-edit-ideaTranscript"
                    rows={5}
                    value={draft.ideaTranscript}
                    disabled={!supportsEdit(connectionMode, 'ideaTranscript')}
                    onChange={event =>
                      setDraft(current => ({ ...current, ideaTranscript: event.target.value }))
                    }
                  />
                </FieldRow>
              )}

              <div className="chip-row" style={{ marginTop: 12, gap: 'var(--space-2)' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="issue-edit-save-btn"
                  disabled={busy || !draft.summary.trim() || !isDirty}
                  onClick={saveEdits}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="btn"
                  data-testid="issue-edit-reset-btn"
                  disabled={busy || !isDirty}
                  onClick={resetDraft}
                >
                  Reset
                </button>
              </div>
            </div>

            {issue.subTasks && issue.subTasks.length > 0 && (
              <div className="detail-section">
                <div className="detail-section-label">Sub-tasks ({issue.subTasks.length})</div>
                <div style={{ marginTop: 6 }}>
                  {issue.subTasks.map(subTask => (
                    <div key={subTask.key} className="detail-list-row" data-testid="issue-subtask-row">
                      {onOpenIssue ? (
                        <button
                          className="detail-list-key"
                          title={subTask.summary}
                          onClick={() => void openRelatedIssue(subTask.key)}
                        >
                          {subTask.key}
                        </button>
                      ) : (
                        <span className="detail-list-key">{subTask.key}</span>
                      )}
                      <span className="detail-list-summary">{subTask.summary}</span>
                      <span className="detail-meta">{subTask.status}</span>
                      {availableWorkflows.length > 0 && (
                        <ChipSelect
                          className="detail-subtask-workflow"
                          ariaLabel={`Workflow for ${subTask.key}`}
                          data-testid={`subtask-workflow-${subTask.key}`}
                          value={subTaskAssignments[subTask.key]?.workflow?.instructionsPath ?? ''}
                          disabled={busy}
                          onChange={value => {
                            const workflow =
                              availableWorkflows.find(
                                candidate => candidate.instructionsPath === value
                              ) ?? null;
                            void window.praxis.ai
                              .setWorkflowAssignment(subTask.key, workflow)
                              .then(() => window.praxis.ai.getWorkflowAssignment(subTask.key))
                              .then(assignment =>
                                setSubTaskAssignments(current => ({
                                  ...current,
                                  [subTask.key]: assignment
                                }))
                              )
                              .catch(err => setError(err instanceof Error ? err.message : String(err)));
                          }}
                          options={[
                            { value: '', label: 'No workflow' },
                            ...availableWorkflows.map(workflow => ({ value: workflow.instructionsPath, label: workflow.name }))
                          ]}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {issue.linkedIssues && issue.linkedIssues.length > 0 && (
              <div className="detail-section">
                <div className="detail-section-label">Linked issues ({issue.linkedIssues.length})</div>
                <div style={{ marginTop: 6 }}>
                  {issue.linkedIssues.map(link => (
                    <div
                      key={`${link.relationship}-${link.key}`}
                      className="detail-list-row"
                      data-testid="issue-linked-row"
                    >
                      <span className="detail-meta" style={{ minWidth: 90 }}>
                        {link.relationship}
                      </span>
                      {onOpenIssue ? (
                        <button
                          className="detail-list-key"
                          title={link.summary ?? link.key}
                          onClick={() => void openRelatedIssue(link.key)}
                        >
                          {link.key}
                        </button>
                      ) : (
                        <span className="detail-list-key">{link.key}</span>
                      )}
                      <span className="detail-list-summary">{link.summary ?? ''}</span>
                      {link.status && <span className="detail-meta">{link.status}</span>}
                      {link.browseUrl && (
                        <button
                          className="icon-btn icon-btn-sm"
                          aria-label={`Open ${link.key} in browser`}
                          title="Open in browser"
                          onClick={() => openInBrowser(link.browseUrl)}
                        >
                          <Icon name="external-link" size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {issue.attachments && issue.attachments.length > 0 && (
              <div className="detail-section">
                <div className="detail-section-label">Attachments ({issue.attachments.length})</div>
                <div style={{ marginTop: 6 }}>
                  {issue.attachments.map((attachment, index) => (
                    <div
                      key={attachment.id ?? `${attachment.fileName}-${index}`}
                      className="detail-list-row"
                      data-testid="issue-attachment-row"
                    >
                      <Icon name="paperclip" size={12} />
                      {attachment.contentUrl ? (
                        <button
                          className="detail-list-key"
                          title="Open in browser"
                          onClick={() => openInBrowser(attachment.contentUrl)}
                        >
                          {attachment.fileName}
                        </button>
                      ) : (
                        <span className="detail-list-key">{attachment.fileName}</span>
                      )}
                      {attachment.sizeBytes !== undefined && (
                        <span className="detail-meta">{formatBytes(attachment.sizeBytes)}</span>
                      )}
                      {attachment.author && <span className="detail-meta">{attachment.author}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="detail-section">
              <div className="detail-section-label">AI agent</div>
              <div style={{ marginTop: 6 }} data-testid="issue-ai-section">
                <div className="ai-lifecycle-status" data-testid="issue-analysis-status">
                  <span className={`chip${analysisConfirmed ? ' chip-success' : ''}`}>
                    {analysisConfirmed
                      ? 'Analysis confirmed'
                      : analysisGateEnabled
                        ? 'Analysis required'
                        : 'Analysis optional'}
                  </span>
                  {agentSession && (
                    <span className={agentStateBadgeClass(agentSession.state)}>
                      Session {agentStateLabel(agentSession.state).toLowerCase()}
                    </span>
                  )}
                </div>
                <div className="detail-ai-runtime-options" data-testid="issue-ai-runtime-options">
                  <label className="detail-ai-runtime-field">
                    <span>AI provider</span>
                    <ChipSelect
                      block
                      ariaLabel="AI provider"
                      data-testid="issue-detail-ai-provider"
                      value={selectedProvider ?? ''}
                      placeholder="No configured provider"
                      disabled={configuredProviders.length === 0}
                      onChange={value => setSelectedProvider(value as AiProvider)}
                      options={configuredProviders.map(status => ({ value: status.provider, label: providerLabel(status.provider), icon: providerIconName(status.provider) }))}
                    />
                  </label>
                  <label className="detail-ai-runtime-field">
                    <span>Model</span>
                    <ChipSelect
                      block
                      ariaLabel="Model"
                      data-testid="issue-detail-ai-model"
                      value={selectedRuntimeModel}
                      icon="sparkles"
                      disabled={modelsLoading || !runtimeModels?.options.length}
                      onChange={setSelectedRuntimeModel}
                      options={[
                        { value: '', label: modelsLoading ? 'Loading models…' : 'Provider default' },
                        ...(runtimeModels?.options.map(option => ({ value: option.value, label: option.name, description: option.description })) ?? [])
                      ]}
                    />
                  </label>
                  {onOpenAiSettings && (
                    <button
                      className="btn btn-compact"
                      type="button"
                      data-testid="issue-ai-configure-btn"
                      onClick={onOpenAiSettings}
                    >
                      Configure
                    </button>
                  )}
                </div>
                {!selectedProviderStatus?.configured && (
                  <p className="detail-ai-provider-hint" data-testid="issue-ai-provider-warning">
                    Configure a provider and analysis prompt before running analysis.
                  </p>
                )}
                <div className="workflow-assignment-row" data-testid="workflow-assignment-row">
                  <div style={{ flex: 1 }}>
                    <span className="detail-meta" data-testid="workflow-assignment-label">
                      {workflowAssignment?.workflow
                        ? `Workflow pack: ${workflowAssignment.workflow.name}`
                        : 'No workflow pack assigned'}
                    </span>
                    {workflowAssignment && (
                      <span className="workflow-assignment-meta" data-testid="workflow-assignment-meta">
                        {workflowAssignment.source}
                        {workflowAssignment.reason ? ` · ${workflowAssignment.reason}` : ''}
                      </span>
                    )}
                  </div>
                  <button
                    className="chip"
                    data-testid="workflow-assignment-change"
                    onClick={() => setShowWorkflowPicker(true)}
                  >
                    Change
                  </button>
                </div>

                <div className="chip-row" style={{ margin: '6px 0' }}>
                  {onOpenAiView && (
                    <>
                      <button
                        className="chip"
                        data-testid="issue-ai-review-btn"
                        title="Assess the ticket's clarity and completeness"
                        onClick={() => onOpenAiView(issueKey, 'review', {
                          provider: selectedProvider,
                          model: selectedRuntimeModel || undefined
                        })}
                      >
                        Review ticket
                      </button>
                      {!isIdeaIssue && agentSession?.state === 'completed' && (
                        <button
                          className="chip"
                          data-testid="issue-ai-lpr-btn"
                          title="Review the completed implementation: code, security and verdict"
                          onClick={() => onOpenAiView(issueKey, 'lpr', {
                            provider: selectedProvider,
                            model: selectedRuntimeModel || undefined
                          })}
                        >
                          Review implementation
                        </button>
                      )}
                    </>
                  )}
                  {!isIdeaIssue && !isFeatureRequest && (
                      <button
                        className="chip"
                        data-testid="issue-ai-delivery-btn"
                        disabled={busy || !deliveryConfigured || !workflowActionsReady}
                        title={
                          !deliveryConfigured
                            ? 'Configure and enable the delivery workflow in Settings first'
                            : !workingDirectoryConfigured
                              ? 'Set the AI working directory in Settings first'
                              : analysisRequired
                                ? 'Confirm the ticket analysis first'
                                : 'Run the configured delivery workflow'
                        }
                        onClick={() =>
                          void runAction(() =>
                            window.praxis.ai.startDelivery(issueKey, connectionId).then(() => undefined)
                          )
                        }
                      >
                        Start delivery
                      </button>
                  )}
                  {!isIdeaIssue && isFeatureRequest && (
                      <button
                        className="chip"
                        data-testid="issue-ai-decompose-btn"
                        disabled={busy || !workflowActionsReady}
                        title={
                          !workingDirectoryConfigured
                            ? 'Set the AI working directory in Settings first'
                            : analysisRequired
                              ? 'Confirm the ticket analysis first'
                              : 'Break this feature request into sub-tasks'
                        }
                        onClick={() =>
                          void runAction(() =>
                            window.praxis.ai.decomposeFeature(issueKey, connectionId).then(() => undefined)
                          )
                        }
                      >
                        Decompose
                      </button>
                  )}
                </div>

                {!agentSession && (
                  <p className="placeholder-text" style={{ margin: '0 0 6px' }}>
                    No AI session has been started for this ticket.
                  </p>
                )}
                {agentSession && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span
                        className={agentStateBadgeClass(agentSession.state)}
                        data-testid="issue-ai-state"
                      >
                        {agentStateLabel(agentSession.state)}
                      </span>
                      <span className="detail-meta">
                        {agentSession.stepCount} {agentSession.stepCount === 1 ? 'step' : 'steps'}
                      </span>
                      {agentSession.delivery && (
                        <span className="chip" data-testid="issue-ai-delivery-phase">
                          {agentSession.delivery.phase}
                          {agentSession.delivery.finalizationState !== 'pending' &&
                            ` · ${agentSession.delivery.finalizationState}`}
                        </span>
                      )}
                    </div>
                    {agentSession.delivery?.finalizationMessage && (
                      <p
                        className="detail-meta"
                        data-testid="issue-ai-finalization-message"
                        style={{ margin: '4px 0 0' }}
                      >
                        {agentSession.delivery.finalizationMessage}
                      </p>
                    )}
                    <div className="chip-row" style={{ marginTop: 6 }}>
                      {onOpenSession && (
                        <button
                          className="chip"
                          data-testid="issue-ai-view-session"
                          onClick={() => onOpenSession(issueKey)}
                        >
                          View session
                        </button>
                      )}
                      {!isTerminalAgentState(agentSession.state) && (
                        <button
                          className="chip"
                          data-testid="issue-ai-abort-btn"
                          disabled={busy}
                          onClick={() => void runAction(() => window.praxis.ai.abort(issueKey))}
                        >
                          Abort
                        </button>
                      )}
                      {isTerminalAgentState(agentSession.state) && (
                        <button
                          className="chip"
                          data-testid="issue-ai-restart-btn"
                          disabled={busy}
                          onClick={openSessionSetup}
                        >
                          Run again
                        </button>
                      )}
                    </div>
                  </>
                )}

                {agentSession?.delivery?.featureDecomposition && (
                  <div data-testid="decomposition-subtasks" style={{ marginTop: 8 }}>
                    <div className="detail-section-label" style={{ marginBottom: 4 }}>
                      Sub-tasks — {agentSession.delivery.featureDecomposition.featureBranch}
                    </div>
                    {[...agentSession.delivery.featureDecomposition.subTasks]
                      .sort((a, b) => a.order - b.order)
                      .map(subTask => (
                        <div key={subTask.issueKey} className="subtask-row" data-testid={`subtask-${subTask.issueKey}`}>
                          <button
                            className="subtask-key"
                            onClick={() => onOpenIssue?.(subTask.issueKey)}
                          >
                            {subTask.issueKey}
                          </button>
                          <span className="subtask-summary">{subTask.summary}</span>
                          <span className="detail-meta">{subTask.deliveryState ?? 'pending'}</span>
                          {(subTask.deliveryState ?? 'pending') === 'pending' && (
                            <button
                              className="chip"
                              data-testid={`subtask-start-${subTask.issueKey}`}
                              disabled={busy}
                              onClick={() =>
                                void runAction(() =>
                                  window.praxis.ai
                                    .startSubTaskDelivery(issueKey, subTask.issueKey, connectionId)
                                    .then(() => undefined)
                                )
                              }
                            >
                              Start
                            </button>
                          )}
                        </div>
                      ))}
                  </div>
                )}

                {connectionId && (
                  <div data-testid="issue-mr-section" style={{ marginTop: 8 }}>
                    <div className="chip-row">
                      <button
                        className="chip"
                        data-testid="issue-mr-load-btn"
                        disabled={busy}
                        onClick={() => {
                          setMrError(undefined);
                          void window.praxis.ai
                            .listMergeRequests(issueKey, connectionId)
                            .then(setMergeRequests)
                            .catch(err =>
                              setMrError(err instanceof Error ? err.message : String(err))
                            );
                        }}
                      >
                        Merge requests
                      </button>
                      <button
                        className="chip"
                        data-testid="issue-mr-create-btn"
                        disabled={busy}
                        onClick={() =>
                          void runAction(() =>
                            window.praxis.ai
                              .createMergeRequest(issueKey, connectionId)
                              .then(created => setMergeRequests(current => [...(current ?? []), created]))
                          )
                        }
                      >
                        Create MR
                      </button>
                      <button
                        className="chip"
                        data-testid="issue-mr-check-btn"
                        disabled={busy}
                        onClick={() =>
                          void runAction(() =>
                            window.praxis.ai
                              .checkMergeRequestFeedback(issueKey, connectionId)
                              .then(() => undefined)
                          )
                        }
                      >
                        Check feedback
                      </button>
                    </div>
                    {mrError && <p className="error-banner" data-testid="issue-mr-error">{mrError}</p>}
                    {mergeRequests?.map(mergeRequest => (
                      <div key={mergeRequest.iid} className="subtask-row" data-testid={`mr-${mergeRequest.iid}`}>
                        <button
                          className="subtask-key"
                          onClick={() => openInBrowser(mergeRequest.webUrl)}
                        >
                          !{mergeRequest.iid}
                        </button>
                        <span className="subtask-summary">{mergeRequest.title}</span>
                        <span className="detail-meta">{mergeRequest.state}</span>
                      </div>
                    ))}
                    {mergeRequests?.length === 0 && (
                      <p className="placeholder-text">No merge requests reference {issueKey}.</p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {showWorkflowPicker && (
              <WorkflowPicker
                current={workflowAssignment?.workflow}
                onClose={() => setShowWorkflowPicker(false)}
                onSelect={workflow => {
                  setShowWorkflowPicker(false);
                  void window.praxis.ai
                    .setWorkflowAssignment(issueKey, workflow)
                    .then(() => window.praxis.ai.getWorkflowAssignment(issueKey))
                    .then(setWorkflowAssignment)
                    .catch(err => setError(err instanceof Error ? err.message : String(err)));
                }}
              />
            )}

            {showSessionSetup && issue && (
              <StartAiSessionDialog
                issue={issue}
                existingSession={agentSession}
                providerStatuses={providerStatuses}
                selectedProvider={selectedProvider}
                onProviderChange={setSelectedProvider}
                runtimeModels={runtimeModels}
                selectedModel={selectedRuntimeModel}
                onModelChange={setSelectedRuntimeModel}
                modelsLoading={modelsLoading}
                governedWorkflows={effectiveWorkflows}
                workflows={availableWorkflows}
                assignedWorkflow={workflowAssignment?.workflow}
                onClose={() => setShowSessionSetup(false)}
                onViewExisting={
                  agentSession && onOpenSession
                    ? () => {
                        setShowSessionSetup(false);
                        onOpenSession(issueKey);
                      }
                    : undefined
                }
                onStart={startAiSession}
              />
            )}

            <div className="detail-section">
              <div className="detail-section-label">Comments</div>
              <div style={{ marginTop: 6 }}>
                {issue.comments?.map((comment, index) => (
                  <div key={comment.id ?? index} className="comment-bubble">
                    <div className="comment-heading">
                      <span className="comment-author">{comment.author}</span>
                      {(comment.created || comment.updated) && (
                        <time dateTime={comment.created ?? comment.updated}>
                          {formatDate(comment.created ?? comment.updated)}
                        </time>
                      )}
                    </div>
                    <Markdown text={comment.body} />
                  </div>
                ))}
                {!issue.comments?.length && <span className="placeholder-text">No comments yet.</span>}
              </div>
              <textarea
                className="textarea"
                value={commentBody}
                onChange={event => setCommentBody(event.target.value)}
                placeholder="Add a comment…"
                rows={3}
                style={{ marginTop: 8 }}
              />
              <button
                className="btn btn-primary"
                style={{ marginTop: 8 }}
                disabled={busy || !commentBody.trim()}
                onClick={() =>
                  void runAction(async () => {
                    await window.praxis.issue.addComment(issueKey, commentBody, connectionId);
                    setCommentBody('');
                  })
                }
              >
                Add comment
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
