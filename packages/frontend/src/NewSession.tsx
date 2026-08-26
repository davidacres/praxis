import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type {
  AiProvider,
  AiProviderStatus,
  AgentToolMode,
  Board,
  IssueSummary,
  ModelOptions
} from '@ticket-manager/core';
import { Icon } from './Icon';
import { fetchModelOptions, MODEL_PROVIDERS, PROVIDER_LABELS, providerIconName } from './modelProviders';
import { useSettings } from './useSettings';

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
  /** Starts the session; rejects (e.g. provider not configured) surface inline. */
  onSubmit: (input: {
    board: Board;
    issueKey: string;
    title: string;
    goal: string;
    provider?: AiProvider;
    model?: string;
    toolMode: AgentToolMode;
  }) => Promise<void>;
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
  onNewProject
  , toolModeForBoard,
  onSelectedBoardChange
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
  const [toolMode, setToolMode] = useState<AgentToolMode>('full');
  const [modelFilter, setModelFilter] = useState('');
  const [modelMenuPos, setModelMenuPos] = useState<{ top: number; left: number } | undefined>();
  const modelChipRef = useRef<HTMLButtonElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const noticeVisible = connectionCount === 0 && !dismissed;
  const selectedBoard = boards.find(board => board.id === selectedBoardId);
  const enabledModelKey = selectedProvider
    ? JSON.stringify(liveSettings?.ai.providers[selectedProvider]?.enabledModelIds ?? null)
    : '';

  useEffect(() => {
    onSelectedBoardChange?.(selectedBoard);
  }, [onSelectedBoardChange, selectedBoard]);

  useEffect(() => {
    if (selectedBoard) {
      const projectDefault = toolModeForBoard?.(selectedBoard);
      if (projectDefault) setToolMode(projectDefault);
    }
  }, [selectedBoard, toolModeForBoard]);

  useEffect(() => {
    if (!boards.some(board => board.id === selectedBoardId)) {
      setSelectedBoardId(boards[0]?.id ?? '');
    }
  }, [boards, selectedBoardId]);

  useEffect(() => {
    setOpenTickets([]);
    setSelectedIssueKey('');
    if (!selectedBoard) {
      return;
    }
    let cancelled = false;
    setTicketsLoading(true);
    window.ticketManager.board
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
    setSessionTitle(selectedIssueKey);
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
    window.ticketManager.ai
      .listProviderStatuses()
      .then(setProviderStatuses)
      .catch(() => setProviderStatuses([]));
    // Default to the app's active provider (Settings → AI Provider), not
    // just "whichever happens to be configured" — a CLI-hosted provider is
    // always reported as "configured" (it needs no API key from us) even
    // when its binary isn't installed, so auto-picking "first configured"
    // could silently swap the session onto a provider the user never chose.
    window.ticketManager.settings
      .get()
      .then(settings => setSelectedProvider(current => current ?? settings.ai.activeProvider))
      .catch(() => {});
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
    Promise.all([fetchModelOptions(selectedProvider, false), window.ticketManager.settings.get()])
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
    Promise.all([fetchModelOptions(selectedProvider, true), window.ticketManager.settings.get()])
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
    if (!selectedBoard || !selectedIssueKey || !title || !trimmed || submitting) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit({
        board: selectedBoard,
        issueKey: selectedIssueKey,
        title,
        goal: trimmed,
        provider: selectedProvider,
        model: selectedModel,
        toolMode
      });
      setGoal('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="session-view" data-testid="new-session-view">
      <div className="session-inner">
        {onNewProject && (
          <div className="project-empty-callout" data-testid="project-empty-state">
            <div><strong>{projectCount === 0 ? 'Create your first project' : 'Create a new project'}</strong><span>Start with a durable brief, local board, and editable starter tickets.</span></div>
            <button className="btn btn-primary" onClick={onNewProject}>New Project</button>
          </div>
        )}
        <h1 className="session-heading">
          New session in{' '}
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
            <span>{selectedBoard?.name ?? 'Select board'}</span>
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
              {boards.length === 0 && <div className="popover-label">No boards available</div>}
              {boards.map(board => (
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
            disabled={ticketsLoading || openTickets.length === 0}
            onClick={() => toggleHeadingMenu('ticket', ticketChipRef)}
          >
            <Icon name="ticket" size={17} />
            <span>{ticketsLoading ? 'Loading tickets…' : selectedIssueKey || 'No open tickets'}</span>
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
                setSessionTitle(current => current.trim() || selectedIssueKey);
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
            <strong data-testid="new-session-title">{sessionTitle || 'Select a ticket'}</strong>
          )}
          <button
            className="icon-btn icon-btn-sm"
            aria-label="Edit session name"
            title="Edit session name"
            data-testid="new-session-title-edit"
            disabled={!selectedIssueKey}
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
            <div className="error-banner" data-testid="new-session-error" style={{ margin: '8px 12px 0' }}>
              {error}
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
            onChange={event => setGoal(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />

          <div className="composer-controls">
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
            {selectedProvider && MODEL_PROVIDERS.has(selectedProvider) && (modelsLoading || modelOptions) && (
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
                  : (modelOptions?.options.find(option => option.value === selectedModel)?.name ?? 'Model')}
                <Icon name="chevron-down" size={12} />
              </button>
            )}
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
                  {filteredModelOptions.map(option => (
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
                      {option.name}
                    </button>
                  ))}
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
            <span className="spacer" />
            <button className="composer-chip" aria-label="Dictate">
              <Icon name="mic" size={15} />
            </button>
            <button
              className="composer-send"
              aria-label="Start session"
              data-testid="new-session-submit"
              disabled={!selectedBoard || !selectedIssueKey || !sessionTitle.trim() || !goal.trim() || submitting}
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
