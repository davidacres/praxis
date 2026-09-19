import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type {
  AiProvider,
  AiProviderStatus,
  AgentToolMode,
  Board,
  IssueSummary,
  ModelOptions,
  SessionMode
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { fetchModelOptions, MODEL_PROVIDERS, PROVIDER_LABELS, providerIconName } from './modelProviders';
import { formatContextLength, formatModelCost, getKnownContextLength, getModelPricing } from './sessionNav';
import { useSettings } from '../settings/useSettings';

/** Last path segment, for a compact working-folder chip label. */
function basename(fsPath: string): string {
  const parts = fsPath.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? fsPath;
}

/** Applies a provider's curated `enabledModelIds` (Settings → AI Provider → Models) to a fetched catalog. */
function applyEnabledModelCuration(options: ModelOptions, enabledModelIds: string[] | undefined): ModelOptions {
  if (!enabledModelIds) {
    return options;
  }
  const allowed = new Set(enabledModelIds);
  return { ...options, options: options.options.filter(option => allowed.has(option.value)) };
}

/** The provider's own current model if curation left it selectable, otherwise the first curated option. */
function pickDefaultModel(options: ModelOptions | undefined): string | undefined {
  if (!options) {
    return undefined;
  }
  if (options.currentValue && options.options.some(o => o.value === options.currentValue)) {
    return options.currentValue;
  }
  return options.options[0]?.value;
}

export interface NewSessionProps {
  boards: Board[];
  /** Project-scoped governed definitions that can be attached to this session. */
  workflowOptions?: SessionWorkflowOption[];
  /** Starts the session; rejects (e.g. provider not configured) surface inline. */
  onSubmit: (input: {
    board?: Board;
    issueKey?: string;
    title: string;
    goal: string;
    provider?: AiProvider;
    model?: string;
    toolMode: AgentToolMode;
    mode: SessionMode;
    workingDirectory?: string;
    runInWorktree?: boolean;
    /** Explicit provider-neutral profile and executable host binding. */
    agentId?: string;
    profileId?: string;
    hostId?: string;
    skillNames?: string[];
    workflowId?: string;
  }) => Promise<void>;
  /** Pre-attributes the composer to a profile/host binding from the Agent Hub. */
  agentContext?: { agentId: string; profileId?: string; hostId?: string; skillNames: string[] };
  /** Working folder pre-selected by the caller (e.g. the chosen project board's folder). */
  defaultWorkingDirectory?: string;
  /**
   * When set, the composer is scoped to a project / workspace rather than a
   * board and ticket: the board + ticket pickers are hidden (the session isn't
   * tied to a ticket — "you should not have to use a board or ticket to work"),
   * the heading names the scope, and the working folder shows as a read-only
   * label instead of a picker.
   */
  scopeLabel?: string;
  /** Seeds the tool-mode toggle — e.g. the scoped project's configured default. */
  defaultToolMode?: AgentToolMode;
  /**
   * Number of configured tracker connections. Zero means every board on screen
   * comes from the built-in demo backend, which is worth saying out loud before
   * someone starts a session against throwaway data.
   */
  connectionCount: number;
  onOpenConnections: () => void;
  projectCount?: number;
  onNewProject?: () => void;
  toolModeForBoard?: (board: Board) => AgentToolMode | undefined;
  onSelectedBoardChange?: (board: Board | undefined) => void;
}

export interface SessionWorkflowOption {
  id: string;
  name: string;
  description?: string;
  version: number;
  ready: boolean;
  blockers?: string[];
}

const FREEFORM_BOARD_ID = '__freeform__';

/**
 * The default centre view. Laid out against the reference chrome: a muted
 * sentence with inline chips, then a single composer card whose first row is the
 * notice, then the borderless run-options row split left/right.
 */
export function NewSession({
  boards,
  onSubmit,
  connectionCount,
  onOpenConnections,
  projectCount = 0,
  onNewProject,
  workflowOptions,
  toolModeForBoard,
  onSelectedBoardChange,
  agentContext,
  defaultWorkingDirectory,
  scopeLabel,
  defaultToolMode
}: NewSessionProps) {
  const { settings: liveSettings } = useSettings();
  const [goal, setGoal] = useState('');
  const [selectedBoardId, setSelectedBoardId] = useState('');
  const [openTickets, setOpenTickets] = useState<IssueSummary[]>([]);
  const [selectedIssueKey, setSelectedIssueKey] = useState('');
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [sessionTitle, setSessionTitle] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const titleBeforeEditRef = useRef('');
  const [boardMenuPos, setBoardMenuPos] = useState<{ top: number; left: number } | undefined>();
  const [ticketMenuPos, setTicketMenuPos] = useState<{ top: number; left: number } | undefined>();
  const boardChipRef = useRef<HTMLButtonElement | null>(null);
  const ticketChipRef = useRef<HTMLButtonElement | null>(null);
  const boardMenuRef = useRef<HTMLDivElement | null>(null);
  const ticketMenuRef = useRef<HTMLDivElement | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [providerStatuses, setProviderStatuses] = useState<AiProviderStatus[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<AiProvider | undefined>();
  const [providerMenuPos, setProviderMenuPos] = useState<{ top: number; left: number } | undefined>();
  const providerChipRef = useRef<HTMLButtonElement | null>(null);
  const providerMenuRef = useRef<HTMLDivElement | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOptions | undefined>();
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | undefined>();
  const [toolMode, setToolMode] = useState<AgentToolMode>(defaultToolMode ?? 'full');
  const [mode, setMode] = useState<SessionMode>('chat');
  const [workingDirectory, setWorkingDirectory] = useState<string | undefined>(defaultWorkingDirectory);
  const [runInWorktree, setRunInWorktree] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const [folderIsRepo, setFolderIsRepo] = useState(false);
  const folderLocked = Boolean(defaultWorkingDirectory);
  const workflowOptionsForPicker = workflowOptions ?? [];
  const [modelFilter, setModelFilter] = useState('');
  const [modelMenuPos, setModelMenuPos] = useState<{ top: number; left: number } | undefined>();
  const modelChipRef = useRef<HTMLButtonElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const noticeVisible = connectionCount === 0 && !dismissed;
  const selectableBoards = boards.filter(board => board.availability !== 'missing');
  const selectedBoard = selectableBoards.find(board => board.id === selectedBoardId);
  const enabledModelKey = selectedProvider
    ? JSON.stringify(liveSettings?.ai.providers[selectedProvider]?.enabledModelIds ?? null)
    : '';

  useEffect(() => {
    onSelectedBoardChange?.(selectedBoard);
  }, [onSelectedBoardChange, selectedBoard]);

  // A project board owns the working folder; otherwise keep the user's pick,
  // seeded from the global default (Settings → AI Provider → Working directory).
  useEffect(() => {
    if (defaultWorkingDirectory) {
      setWorkingDirectory(defaultWorkingDirectory);
      return;
    }
    const globalDefault = liveSettings?.ai.workingDirectory?.trim();
    if (globalDefault) {
      setWorkingDirectory(current => current ?? globalDefault);
    }
  }, [defaultWorkingDirectory, liveSettings?.ai.workingDirectory]);

  // Only offer "run in a worktree" when the chosen folder is a git repo.
  useEffect(() => {
    setFolderIsRepo(false);
    if (!workingDirectory) {
      setRunInWorktree(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.praxis.git
        .preflight(workingDirectory)
        .then(result => {
          if (cancelled) return;
          const isRepo = result.status === 'repository' || result.status === 'worktree';
          setFolderIsRepo(isRepo);
          if (!isRepo) setRunInWorktree(false);
        })
        .catch(() => {
          if (!cancelled) setFolderIsRepo(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workingDirectory]);

  useEffect(() => {
    if (selectedBoard) {
      const projectDefault = toolModeForBoard?.(selectedBoard);
      if (projectDefault) setToolMode(projectDefault);
    }
  }, [selectedBoard, toolModeForBoard]);

  useEffect(() => {
    if (selectedBoardId !== FREEFORM_BOARD_ID && selectedBoardId && !selectableBoards.some(board => board.id === selectedBoardId)) {
      setSelectedBoardId('');
    }
  }, [selectableBoards, selectedBoardId]);

  useEffect(() => {
    if (selectedWorkflowId && !workflowOptionsForPicker.some(option => option.id === selectedWorkflowId)) {
      setSelectedWorkflowId('');
    }
  }, [selectedWorkflowId, workflowOptionsForPicker]);

  useEffect(() => {
    setOpenTickets([]);
    setSelectedIssueKey('');
    if (!selectedBoard) {
      return;
    }
    let cancelled = false;
    setTicketsLoading(true);
    window.praxis.board
      .get(selectedBoard)
      .then(details => {
        if (cancelled) return;
        const tickets = details.issues.filter(issue => {
          const category = issue.statusCategory?.trim().toLowerCase();
          const status = issue.status.trim().toLowerCase();
          return category !== 'done' && !['done', 'closed', 'resolved', 'complete', 'completed', 'cancelled', 'canceled'].includes(status);
        });
        setOpenTickets(tickets);
        setSelectedIssueKey(tickets[0]?.key ?? '');
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setTicketsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBoard]);

  useEffect(() => {
    setSessionTitle(selectedIssueKey || 'New session');
    setEditingTitle(false);
  }, [selectedIssueKey]);

  useEffect(() => {
    if (!boardMenuPos && !ticketMenuPos) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        boardMenuRef.current?.contains(target) ||
        ticketMenuRef.current?.contains(target) ||
        boardChipRef.current?.contains(target) ||
        ticketChipRef.current?.contains(target)
      ) {
        return;
      }
      setBoardMenuPos(undefined);
      setTicketMenuPos(undefined);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
  }, [boardMenuPos, ticketMenuPos]);

  useEffect(() => {
    // Default to the app's active provider (Settings → AI Provider) only when it
    // is actually configured — otherwise leave the picker empty so the composer
    // never shows a provider that isn't in the (configured-only) menu, and never
    // silently swaps the session onto a provider the user never chose.
    Promise.all([window.praxis.ai.listProviderStatuses(), window.praxis.settings.get()])
      .then(([statuses, settings]) => {
        setProviderStatuses(statuses);
        const active = statuses.find(status => status.provider === settings.ai.activeProvider && status.configured);
        setSelectedProvider(current => current ?? active?.provider);
      })
      .catch(() => setProviderStatuses([]));
  }, []);

  useEffect(() => {
    if (!providerMenuPos) {
      return;
    }
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (providerMenuRef.current?.contains(target) || providerChipRef.current?.contains(target)) {
        return;
      }
      setProviderMenuPos(undefined);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
  }, [providerMenuPos]);

  useEffect(() => {
    if (!modelMenuPos) {
      return;
    }
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (modelMenuRef.current?.contains(target) || modelChipRef.current?.contains(target)) {
        return;
      }
      setModelMenuPos(undefined);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
  }, [modelMenuPos]);

  // Model selection applies to `hostKind: 'acp'` providers (Claude Code,
  // Codex — fetched from ACP's `session/new` config options, no cost but a
  // real subprocess handshake) and `kind: 'api'` providers with a real
  // model-listing endpoint (Vercel/OpenAI/Anthropic — cached in the main
  // process, see `modelCatalog.ts`). Only runs for a provider that could
  // plausibly have models, not on every render.
  useEffect(() => {
    setSelectedModel(undefined);
    setModelOptions(undefined);
    setModelFilter('');
    if (!selectedProvider || !MODEL_PROVIDERS.has(selectedProvider)) {
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    Promise.all([fetchModelOptions(selectedProvider, false), window.praxis.settings.get()])
      .then(([options, settings]) => {
        if (cancelled) {
          return;
        }
        const curated = options
          ? applyEnabledModelCuration(options, settings.ai.providers[selectedProvider]?.enabledModelIds)
          : undefined;
        setModelOptions(curated);
        setSelectedModel(pickDefaultModel(curated));
      })
      .catch(() => {
        if (!cancelled) {
          setModelOptions(undefined);
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
  }, [selectedProvider, enabledModelKey]);

  /** Bypasses the main process's model-list cache — e.g. the gateway added a model server-side. */
  const refreshModels = () => {
    if (!selectedProvider) {
      return;
    }
    setModelsLoading(true);
    Promise.all([fetchModelOptions(selectedProvider, true), window.praxis.settings.get()])
      .then(([options, settings]) => {
        const curated = options
          ? applyEnabledModelCuration(options, settings.ai.providers[selectedProvider]?.enabledModelIds)
          : undefined;
        setModelOptions(curated);
        setSelectedModel(current =>
          current && curated?.options.some(o => o.value === current) ? current : pickDefaultModel(curated)
        );
      })
      .catch(() => setModelOptions(undefined))
      .finally(() => setModelsLoading(false));
  };

  const filteredModelOptions = (modelOptions?.options ?? []).filter(option => {
    const query = modelFilter.trim().toLowerCase();
    return !query || option.name.toLowerCase().includes(query) || option.value.toLowerCase().includes(query);
  });

  const configuredProviderStatuses = providerStatuses.filter(status => status.configured);

  const toggleModelMenu = () => {
    if (modelMenuPos) {
      setModelMenuPos(undefined);
      return;
    }
    const rect = modelChipRef.current?.getBoundingClientRect();
    if (rect) {
      setModelMenuPos({ top: rect.bottom + 4, left: rect.left });
    }
  };

  const toggleProviderMenu = () => {
    if (providerMenuPos) {
      setProviderMenuPos(undefined);
      return;
    }
    const rect = providerChipRef.current?.getBoundingClientRect();
    if (rect) {
      setProviderMenuPos({ top: rect.bottom + 4, left: rect.left });
    }
  };

  const toggleHeadingMenu = (
    kind: 'board' | 'ticket',
    ref: RefObject<HTMLButtonElement | null>
  ) => {
    const current = kind === 'board' ? boardMenuPos : ticketMenuPos;
    setBoardMenuPos(undefined);
    setTicketMenuPos(undefined);
    if (current) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const position = { top: rect.bottom + 6, left: rect.left };
    if (kind === 'board') setBoardMenuPos(position);
    else setTicketMenuPos(position);
  };

  const submit = async () => {
    const trimmed = goal.trim();
    const title = sessionTitle.trim();
    if (!title || !trimmed || submitting) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit({
        ...(selectedBoard ? { board: selectedBoard } : {}),
        ...(selectedIssueKey ? { issueKey: selectedIssueKey } : {}),
        title,
        goal: trimmed,
        provider: selectedProvider,
        model: selectedModel,
        toolMode,
        mode,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(runInWorktree ? { runInWorktree: true } : {}),
        ...(agentContext
          ? {
              agentId: agentContext.agentId,
              profileId: agentContext.profileId ?? agentContext.agentId,
              hostId: agentContext.hostId ?? agentContext.agentId,
              ...(agentContext.skillNames.length ? { skillNames: agentContext.skillNames } : {})
            }
          : {}),
        ...(selectedWorkflowId ? { workflowId: selectedWorkflowId } : {})
      });
      setGoal('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const pickFolder = async () => {
    const picked = await window.praxis.dialog.pickFolder('Select the session working folder');
    if (picked) setWorkingDirectory(picked);
  };

  return (
    <div className="session-view" data-testid="new-session-view">
      <div className="session-inner">
        {agentContext && (
          <div className="session-agent-context" role="note" data-testid="new-session-agent-context">
            <Icon name="robot" size={14} />
            <span>
              Profile <strong>{agentContext.profileId ?? agentContext.agentId}</strong> · host <strong>{agentContext.hostId ?? agentContext.agentId}</strong>
              {agentContext.skillNames.length > 0 && <> · skills: {agentContext.skillNames.join(', ')}</>}
            </span>
          </div>
        )}
        {onNewProject && (
          <div className="project-empty-callout" data-testid="project-empty-state">
            <div><strong>{projectCount === 0 ? 'Create your first project' : 'Create a new project'}</strong><span>Start with a durable brief, local board, and editable starter tickets.</span></div>
            <button className="btn btn-primary" onClick={onNewProject}>New Project</button>
          </div>
        )}
        {scopeLabel ? (
          <h1 className="session-heading" data-testid="new-session-scope-heading">
            New session in{' '}
            <span className="heading-chip is-static">
              <Icon name="folder" size={17} />
              <span>{scopeLabel}</span>
            </span>
          </h1>
        ) : (
        <h1 className="session-heading">
          {selectedBoard ? 'New session in' : 'No board'}{' '}
          <button
            ref={boardChipRef}
            className="heading-chip"
            type="button"
            data-testid="new-session-board-select"
            aria-haspopup="listbox"
            aria-expanded={Boolean(boardMenuPos)}
            onClick={() => toggleHeadingMenu('board', boardChipRef)}
          >
            <Icon name="folder" size={17} />
            <span>{selectedBoard?.name ?? 'No board'}</span>
            <Icon name="chevron-down" size={14} />
          </button>{' '}
          {boardMenuPos && createPortal(
            <div
              ref={boardMenuRef}
              className="composer-provider-menu heading-selector-menu"
              role="listbox"
              aria-label="Session board"
              style={{ position: 'fixed', top: boardMenuPos.top, left: boardMenuPos.left }}
            >
              <button
                type="button"
                className={`composer-provider-option${selectedBoardId === FREEFORM_BOARD_ID ? ' active' : ''}`}
                data-testid="new-session-no-board-option"
                role="option"
                aria-selected={selectedBoardId === FREEFORM_BOARD_ID}
                onClick={() => {
                  setSelectedBoardId(FREEFORM_BOARD_ID);
                  setBoardMenuPos(undefined);
                }}
              >
                <Icon name="chats" size={14} />
                <span className="heading-option-body">
                  <strong>No board</strong>
                  <small>Start a completely free-form chat</small>
                </span>
              </button>
              {selectableBoards.length === 0 && <div className="popover-label">No boards available</div>}
              {selectableBoards.map(board => (
                <button
                  key={`${board.connectionId ?? 'demo'}:${board.id}`}
                  type="button"
                  className={`composer-provider-option${selectedBoardId === board.id ? ' active' : ''}`}
                  data-testid="new-session-board-option"
                  role="option"
                  aria-selected={selectedBoardId === board.id}
                  onClick={() => {
                    setSelectedBoardId(board.id);
                    setBoardMenuPos(undefined);
                  }}
                >
                  <Icon name="folder" size={14} />
                  <span className="heading-option-body">
                    <strong>{board.name}</strong>
                    <small>{board.projectKey ?? board.type}</small>
                  </span>
                </button>
              ))}
            </div>,
            document.body
          )}
          <button
            ref={ticketChipRef}
            className="heading-chip"
            type="button"
            data-testid="new-session-ticket-select"
            aria-haspopup="listbox"
            aria-expanded={Boolean(ticketMenuPos)}
            disabled={ticketsLoading}
            onClick={() => toggleHeadingMenu('ticket', ticketChipRef)}
          >
            <Icon name="ticket" size={17} />
            <span>{ticketsLoading ? 'Loading tickets…' : selectedIssueKey || 'No ticket'}</span>
            <Icon name="chevron-down" size={14} />
          </button>
          {ticketMenuPos && createPortal(
            <div
              ref={ticketMenuRef}
              className="composer-provider-menu heading-selector-menu ticket-selector-menu"
              role="listbox"
              aria-label="Open ticket"
              style={{ position: 'fixed', top: ticketMenuPos.top, left: ticketMenuPos.left }}
            >
              <button
                type="button"
                className={`composer-provider-option${selectedIssueKey ? '' : ' active'}`}
                data-testid="new-session-no-ticket-option"
                role="option"
                aria-selected={!selectedIssueKey}
                onClick={() => {
                  setSelectedIssueKey('');
                  setTicketMenuPos(undefined);
                }}
              >
                <Icon name="chats" size={14} />
                <span className="heading-option-body">
                  <strong>No ticket</strong>
                  <small>Start a free-form chat session</small>
                </span>
              </button>
              {openTickets.map(issue => (
                <button
                  key={issue.key}
                  type="button"
                  className={`composer-provider-option${selectedIssueKey === issue.key ? ' active' : ''}`}
                  data-testid="new-session-ticket-option"
                  role="option"
                  aria-selected={selectedIssueKey === issue.key}
                  onClick={() => {
                    setSelectedIssueKey(issue.key);
                    setTicketMenuPos(undefined);
                  }}
                >
                  <Icon name="ticket" size={14} />
                  <span className="heading-option-body">
                    <strong>{issue.key}</strong>
                    <small>{issue.summary} · {issue.status}</small>
                  </span>
                </button>
              ))}
            </div>,
            document.body
          )}
        </h1>
        )}

        <div className="new-session-name-row">
          <span>Session name</span>
          {editingTitle ? (
            <input
              className="new-session-name-input"
              value={sessionTitle}
              data-testid="new-session-title-input"
              aria-label="Session name"
              autoFocus
              onChange={event => setSessionTitle(event.target.value)}
              onBlur={() => {
                setSessionTitle(current => current.trim() || selectedIssueKey || 'New session');
                setEditingTitle(false);
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setSessionTitle(titleBeforeEditRef.current);
                  setEditingTitle(false);
                }
              }}
            />
          ) : (
            <strong data-testid="new-session-title">{sessionTitle || 'New session'}</strong>
          )}
          <button
            className="icon-btn icon-btn-sm"
            aria-label="Edit session name"
            title="Edit session name"
            data-testid="new-session-title-edit"
            disabled={false}
            onClick={() => {
              titleBeforeEditRef.current = sessionTitle;
              setEditingTitle(true);
            }}
          >
            <Icon name="pencil" size={13} />
          </button>
        </div>

        <div className="composer">
          {error && (
            <div className="error-banner" data-testid="new-session-error" style={{ margin: '8px 12px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <span>{error}</span>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="Dismiss error"
                title="Dismiss"
                onClick={() => setError(undefined)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )}

          {noticeVisible && (
            <div className="composer-notice" role="status">
              <span className="composer-notice-icon">
                <Icon name="info" size={15} />
              </span>
              <div className="composer-notice-body">
                <div className="composer-notice-title">No tracker connected</div>
                <div className="composer-notice-text">
                  You're working against the built-in demo boards. Add a Jira, GitLab, or Live
                  Folder connection to run sessions on real issues.{' '}
                  <button className="notice-link" onClick={onOpenConnections}>
                    Open Connections
                  </button>
                </div>
              </div>
              <button
                className="icon-btn icon-btn-sm"
                aria-label="Dismiss notice"
                onClick={() => setDismissed(true)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )}

          <textarea
            className="composer-input"
            placeholder="What's the goal?"
            value={goal}
            rows={2}
            onChange={event => {
              setGoal(event.target.value);
              if (error) setError(undefined);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />

          {workflowOptionsForPicker.length > 0 && (
            <label className="composer-workflow-picker">
              <span>Workflow</span>
              <select
                className="input"
                value={selectedWorkflowId}
                data-testid="new-session-workflow-select"
                onChange={event => setSelectedWorkflowId(event.target.value)}
              >
                <option value="">No governed workflow — ordinary session</option>
                {workflowOptionsForPicker.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.name} · v{option.version}{option.ready ? '' : ' — not ready'}
                  </option>
                ))}
              </select>
              {selectedWorkflowId && (() => {
                const selected = workflowOptionsForPicker.find(option => option.id === selectedWorkflowId);
                return selected && !selected.ready ? (
                  <small className="form-hint form-hint-error">
                    {selected.blockers?.join(' ') || 'This workflow is not ready to run.'}
                  </small>
                ) : selected?.description ? <small className="form-hint">{selected.description}</small> : null;
              })()}
            </label>
          )}

          <div className="composer-controls">
            <div className="session-mode-toggle" role="group" aria-label="Session mode">
              {(['chat', 'analysis', 'review'] as SessionMode[]).map(option => (
                <button
                  key={option}
                  type="button"
                  className={mode === option ? 'active' : ''}
                  data-testid={`new-session-mode-${option}`}
                  aria-pressed={mode === option}
                  onClick={() => setMode(option)}
                >
                  {option[0].toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
            <button className="composer-chip" aria-label="Attach">
              <Icon name="plus" size={16} />
            </button>
            <button
              ref={providerChipRef}
              className="composer-chip"
              data-testid="new-session-provider-chip"
              aria-haspopup="listbox"
              aria-expanded={Boolean(providerMenuPos)}
              onClick={toggleProviderMenu}
            >
              <Icon name={selectedProvider ? providerIconName(selectedProvider) : 'robot'} size={14} />
              {selectedProvider ? PROVIDER_LABELS[selectedProvider] : 'Provider'}
              <Icon name="chevron-down" size={12} />
            </button>
            {providerMenuPos &&
              createPortal(
                <div
                  ref={providerMenuRef}
                  className="composer-provider-menu"
                  role="listbox"
                  aria-label="AI provider"
                  style={{ position: 'fixed', top: providerMenuPos.top, left: providerMenuPos.left }}
                >
                  {configuredProviderStatuses.length === 0 && (
                    <div className="popover-label">No providers configured</div>
                  )}
                  {configuredProviderStatuses.map(status => (
                    <button
                      key={status.provider}
                      type="button"
                      className={`composer-provider-option${selectedProvider === status.provider ? ' active' : ''}`}
                      data-testid={`new-session-provider-option-${status.provider}`}
                      role="option"
                      aria-selected={selectedProvider === status.provider}
                      onClick={() => {
                        setSelectedProvider(status.provider);
                        setProviderMenuPos(undefined);
                      }}
                    >
                      <Icon name={providerIconName(status.provider)} size={14} />
                      {PROVIDER_LABELS[status.provider]}
                    </button>
                  ))}
                </div>,
                document.body
              )}
            {selectedProvider && MODEL_PROVIDERS.has(selectedProvider) && (modelsLoading || modelOptions) && (() => {
              const selectedOption = modelOptions?.options.find(option => option.value === selectedModel);
              const contextLimit = selectedOption?.contextLength ?? getKnownContextLength(selectedModel, selectedProvider);
              const contextSize = formatContextLength(contextLimit);
              const pricing = selectedOption?.pricing ?? getModelPricing(selectedProvider, selectedModel);
              const cost = formatModelCost(pricing);
              return (
                <button
                  ref={modelChipRef}
                  className="composer-chip"
                  data-testid="new-session-model-chip"
                  aria-haspopup="listbox"
                  aria-expanded={Boolean(modelMenuPos)}
                  disabled={modelsLoading || !modelOptions}
                  onClick={toggleModelMenu}
                >
                  <Icon name="sparkles" size={14} />
                  {modelsLoading
                    ? 'Loading models…'
                    : (
                      <>
                        <span>{selectedOption?.name ?? selectedModel ?? 'Model'}</span>
                        {contextSize && <span className="composer-chip-meta">{contextSize}</span>}
                        {cost && <span className="composer-chip-meta">{cost}</span>}
                      </>
                    )}
                  <Icon name="chevron-down" size={12} />
                </button>
              );
            })()}
            {modelMenuPos &&
              modelOptions &&
              createPortal(
                <div
                  ref={modelMenuRef}
                  className="composer-provider-menu"
                  role="listbox"
                  aria-label="Model"
                  style={{ position: 'fixed', top: modelMenuPos.top, left: modelMenuPos.left }}
                >
                  <div className="model-menu-search-row">
                    <input
                      type="text"
                      className="input"
                      placeholder="Filter models…"
                      value={modelFilter}
                      onChange={event => setModelFilter(event.target.value)}
                      data-testid="new-session-model-filter"
                      autoFocus
                    />
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm"
                      aria-label="Refresh models"
                      data-testid="new-session-model-refresh"
                      disabled={modelsLoading}
                      onClick={() => refreshModels()}
                    >
                      <Icon name="refresh" size={13} />
                    </button>
                  </div>
                  {filteredModelOptions.length === 0 && (
                    <div className="popover-label">No matching models</div>
                  )}
                  {filteredModelOptions.map(option => {
                    const contextLimit = option.contextLength ?? getKnownContextLength(option.value, selectedProvider);
                    const contextSize = formatContextLength(contextLimit);
                    const pricing = option.pricing ?? getModelPricing(selectedProvider, option.value);
                    const cost = formatModelCost(pricing);
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`composer-provider-option${selectedModel === option.value ? ' active' : ''}`}
                        data-testid={`new-session-model-option-${option.value}`}
                        role="option"
                        aria-selected={selectedModel === option.value}
                        title={option.description}
                        onClick={() => {
                          setSelectedModel(option.value);
                          setModelMenuPos(undefined);
                        }}
                      >
                        <span className="composer-model-option-name">{option.name}</span>
                        {(contextSize || cost) && (
                          <span className="composer-model-option-meta">
                            {contextSize && <span className="composer-model-badge is-context">{contextSize}</span>}
                            {cost && <span className="composer-model-badge is-cost">{cost}</span>}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>,
                document.body
              )}
            <button
              className="composer-chip"
              type="button"
              data-testid="new-session-tool-mode"
              title={toolMode === 'project-only' ? 'This folderless project exposes project-board tools only' : toolMode === 'full' ? 'Tools can read and change the workspace' : 'Tools can only inspect the workspace'}
              disabled={toolMode === 'project-only'}
              onClick={() => setToolMode(current => current === 'full' ? 'read-only' : 'full')}
            >
              <Icon name={toolMode === 'full' ? 'tools' : 'search'} size={14} />
              {toolMode === 'project-only' ? 'Project only' : toolMode === 'full' ? 'Full tools' : 'Read only'}
            </button>
            {toolMode !== 'project-only' && (
              folderLocked && workingDirectory ? (
                // A project supplies the folder: show it, don't ask for it.
                <span
                  className="composer-chip is-readonly"
                  data-testid="new-session-folder"
                  title={workingDirectory}
                >
                  <Icon name="folder" size={14} />
                  {basename(workingDirectory)}
                </span>
              ) : (
              <button
                className="composer-chip"
                type="button"
                data-testid="new-session-folder"
                title={workingDirectory ? workingDirectory : 'Choose the folder the agent works in'}
                onClick={() => void pickFolder()}
              >
                <Icon name="folder" size={14} />
                {workingDirectory ? basename(workingDirectory) : 'Working folder'}
                {workingDirectory && (
                  <span
                    role="button"
                    aria-label="Clear working folder"
                    className="composer-chip-clear"
                    onClick={event => {
                      event.stopPropagation();
                      setWorkingDirectory(undefined);
                    }}
                  >
                    <Icon name="close" size={11} />
                  </span>
                )}
              </button>
              )
            )}
            {toolMode === 'full' && folderIsRepo && (
              <button
                className={`composer-chip${runInWorktree ? ' active' : ''}`}
                type="button"
                data-testid="new-session-worktree"
                aria-pressed={runInWorktree}
                title="Run this session in a dedicated git worktree branched off the folder's current branch"
                onClick={() => setRunInWorktree(current => !current)}
              >
                <Icon name="git-branch" size={14} />
                Git worktree
              </button>
            )}
            <span className="spacer" />
            <button className="composer-chip" aria-label="Dictate">
              <Icon name="mic" size={15} />
            </button>
            <button
              className="composer-send"
              aria-label="Start session"
              data-testid="new-session-submit"
              disabled={!sessionTitle.trim() || !goal.trim() || submitting}
              onClick={() => void submit()}
            >
              <Icon name="arrow-up" size={15} />
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
