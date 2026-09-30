import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentConversationMode,
  AgentSessionRecord,
  AgentToolMode,
  AiHandoverBriefEdits,
  AiProvider,
  AiProviderStatus,
  HandoverBrief,
  ModelOptions,
  ReasoningEffort,
  SessionRuntimeEpoch
} from '@praxis/core';
import { Icon, type IconName } from '../ui/Icon';
import {
  allModelProviderIds,
  fetchModelOptions,
  providerIconName,
  providerLabel,
  providerSupportsTools,
  refreshModelOptions,
  REASONING_EFFORT_LEVELS
} from './modelProviders';
import { formatContextLength, formatModelCost, formatStarted, getKnownContextLength, getModelPricing } from './sessionNav';
import { isProviderUsable } from './providerAvailability';
import { isTerminalAgentState } from './aiSessionState';
import { ChipSelect } from '../ui/ChipSelect';

function purposeOf(session: AgentSessionRecord) {
  return session.purpose ?? {
    issueKey: session.issueKey,
    title: session.title,
    goal: session.taskDefinition.goal,
    scope: session.taskDefinition.scope,
    definitionOfDone: session.taskDefinition.definitionOfDone
  };
}

export function canChangeSessionRuntime(session: AgentSessionRecord): boolean {
  return session.state !== 'executing' && session.state !== 'planning';
}

function freshnessLabel(brief: HandoverBrief): string {
  if (brief.freshness === 'updating') return 'Updating…';
  if (brief.freshness === 'stale') return 'Stale';
  if (brief.freshness === 'failed') return brief.lastError ? `Failed: ${brief.lastError}` : 'Failed';
  return `Updated ${formatStarted(brief.updatedAt)}`;
}

export function SessionPurposeBlock({ session }: { session: AgentSessionRecord }) {
  const purpose = purposeOf(session);
  return (
    <div className="agent-runtime-block session-purpose" data-testid="session-purpose">
      <span className="rail-sub">Purpose</span>
      <strong data-testid="session-purpose-title">{purpose.title?.trim() || purpose.goal.split('\n')[0] || purpose.issueKey}</strong>
      {purpose.issueKey && !/^SESSION-/i.test(purpose.issueKey) && (
        <p className="session-summary-text" data-testid="session-purpose-key">{purpose.issueKey}</p>
      )}
      {purpose.goal && <p className="session-summary-text" data-testid="session-purpose-goal">{purpose.goal}</p>}
      {purpose.scope && (
        <p className="session-summary-text" data-testid="session-purpose-scope">
          <span className="rail-sub">Scope</span> {purpose.scope}
        </p>
      )}
      {purpose.definitionOfDone && (
        <p className="session-summary-text" data-testid="session-purpose-done">
          <span className="rail-sub">Done when</span> {purpose.definitionOfDone}
        </p>
      )}
    </div>
  );
}

const BRIEF_FIELDS: Array<{ key: keyof AiHandoverBriefEdits; label: string; testId: string }> = [
  { key: 'progress', label: 'Progress', testId: 'session-brief-progress' },
  { key: 'changes', label: 'Changes', testId: 'session-brief-changes' },
  { key: 'decisions', label: 'Decisions', testId: 'session-brief-decisions' },
  { key: 'risks', label: 'Risks', testId: 'session-brief-risks' },
  { key: 'openQuestions', label: 'Open questions', testId: 'session-brief-questions' },
  { key: 'nextSteps', label: 'Next steps', testId: 'session-brief-next' },
  { key: 'userNotes', label: 'Your notes', testId: 'session-brief-notes' }
];

export function SessionHandoverBrief({ session }: { session: AgentSessionRecord }) {
  const brief = session.handoverBrief;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AiHandoverBriefEdits>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditing(false);
    setError(undefined);
  }, [session.sessionId]);

  if (!brief) {
    return (
      <div className="agent-runtime-block" data-testid="session-brief-missing">
        <span className="rail-sub">Handover brief</span>
        <p className="session-summary-text">No brief yet — it appears after the first completed turn.</p>
      </div>
    );
  }

  const startEdit = () => {
    setDraft({
      progress: brief.progress,
      changes: brief.changes,
      decisions: brief.decisions,
      risks: brief.risks,
      openQuestions: brief.openQuestions,
      nextSteps: brief.nextSteps,
      userNotes: brief.userNotes
    });
    setEditing(true);
    setError(undefined);
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await window.praxis.ai.editHandoverBrief(session.issueKey, brief.revision, draft);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="agent-runtime-block session-handover-brief" data-testid="session-handover-brief">
      <div className="session-brief-head">
        <span className="rail-sub">Handover brief</span>
        <span className={`session-brief-freshness is-${brief.freshness}`} data-testid="session-brief-freshness">
          {freshnessLabel(brief)}
        </span>
      </div>
      {BRIEF_FIELDS.map(field => {
        const value = editing ? draft[field.key] ?? '' : brief[field.key] ?? '';
        if (!editing && !value) return null;
        return (
          <label key={field.key} className="session-brief-field">
            <span className="rail-sub">{field.label}</span>
            {editing ? (
              <textarea
                data-testid={field.testId}
                rows={field.key === 'userNotes' ? 3 : 2}
                value={value}
                onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value }))}
              />
            ) : (
              <p className="session-summary-text" data-testid={field.testId}>{value}</p>
            )}
          </label>
        );
      })}
      {brief.touchedFiles.length > 0 && !editing && (
        <p className="session-summary-text" data-testid="session-brief-files">
          Files: {brief.touchedFiles.join(', ')}
        </p>
      )}
      <div className="session-brief-actions">
        {editing ? (
          <>
            <button type="button" className="btn btn-primary" data-testid="session-brief-save" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save brief'}
            </button>
            <button type="button" className="btn" data-testid="session-brief-cancel" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="btn" data-testid="session-brief-edit" onClick={startEdit}>Edit brief</button>
        )}
      </div>
      {error && <p className="hint is-danger">{error}</p>}
    </div>
  );
}

export const MAX_DISPLAYED_RUNTIME_EPOCHS = 5;

export function limitDisplayedRuntimeEpochs(
  epochs: SessionRuntimeEpoch[],
  max = MAX_DISPLAYED_RUNTIME_EPOCHS
): SessionRuntimeEpoch[] {
  if (epochs.length <= max) return epochs;
  return epochs.slice(-max);
}

export function SessionRuntimeHistory({ session }: { session: AgentSessionRecord }) {
  const epochs = session.runtimeEpochs ?? [];
  if (epochs.length === 0) return null;
  const displayedEpochs = limitDisplayedRuntimeEpochs(epochs);
  return (
    <div className="agent-runtime-block session-runtime-history" data-testid="session-runtime-history">
      <span className="rail-sub">Runtime history</span>
      <ol className="session-epoch-list" start={epochs.length - displayedEpochs.length + 1}>
        {displayedEpochs.map(epoch => (
          <li key={epoch.id} data-testid="session-runtime-epoch">
            <strong>
              {epoch.provider ? providerLabel(epoch.provider) : 'Provider'}
              {epoch.model ? ` · ${epoch.model}` : ''}
            </strong>
            <p className="session-summary-text">
              {epoch.reason === 'started' ? 'Started' : epoch.reason === 'model_change' ? 'Model change' : 'Handover'}
              {' · '}
              {formatStarted(epoch.startedAt)}
              {epoch.endedAt ? ` → ${formatStarted(epoch.endedAt)}` : ' · current'}
              {epoch.tokenUsage?.totalTokens != null ? ` · ${epoch.tokenUsage.totalTokens} tokens` : ''}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

export interface ComposerPopoverPosition {
  bottom: number;
  left: number;
}

interface TransitionDialogsProps {
  session: AgentSessionRecord;
  open: 'model' | 'reasoning' | 'handover' | 'toolMode' | 'folder' | undefined;
  position: ComposerPopoverPosition | undefined;
  onClose: () => void;
  onAddProvider?: (provider: AiProvider) => void;
}

const HANDOVER_CONFIRMATION_KEY = 'praxis-ai-handover-confirmation';

function anchoredPopoverStyle(position: ComposerPopoverPosition, width: number): CSSProperties {
  return {
    position: 'fixed',
    bottom: position.bottom,
    left: Math.max(12, Math.min(position.left, window.innerWidth - width - 12))
  };
}

function preferredModel(options: ModelOptions | undefined): string | undefined {
  if (!options) return undefined;
  if (options.currentValue && options.options.some(option => option.value === options.currentValue)) {
    return options.currentValue;
  }
  return options.options[0]?.value;
}

export function SessionTransitionDialogs({ session, open, position, onClose, onAddProvider }: TransitionDialogsProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [options, setOptions] = useState<ModelOptions>();
  const [providerStatuses, setProviderStatuses] = useState<AiProviderStatus[]>();
  const [pendingProvider, setPendingProvider] = useState<AiProvider>();
  const [modelFilter, setModelFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setPendingProvider(undefined);
    setModelFilter('');
    setError(undefined);
    setOptions(undefined);
    setProviderStatuses(undefined);
  }, [open, session.issueKey]);

  useEffect(() => {
    if (open !== 'model' || !session.provider) return;
    let cancelled = false;
    setLoading(true);
    void fetchModelOptions(session.provider, false)
      .then(next => {
        if (!cancelled) setOptions(next);
      })
      .catch(cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, session.provider]);

  useEffect(() => {
    if (open !== 'handover') return;
    let cancelled = false;
    setLoading(true);
    void window.praxis.ai.listProviderStatuses()
      .then(statuses => {
        if (!cancelled) setProviderStatuses(statuses);
      })
      .catch(cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (menuRef.current?.contains(target)) return;
      if (target.closest('[data-testid="session-provider"], [data-testid="session-model"], [data-testid="session-reasoning"], [data-testid="session-tool-mode"], [data-testid="session-working-directory"]')) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open]);

  if (!open || !position) return null;

  const changeModel = async (model: string) => {
    if (model === session.model) {
      onClose();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await window.praxis.ai.updateSessionModel(session.issueKey, model);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const changeReasoningEffort = async (reasoningEffort: ReasoningEffort) => {
    if (reasoningEffort === (session.reasoningEffort ?? 'off')) {
      onClose();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await window.praxis.ai.updateSessionReasoningEffort(session.issueKey, reasoningEffort);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const refreshModels = async () => {
    if (!session.provider) return;
    setLoading(true);
    setError(undefined);
    try {
      setOptions(await refreshModelOptions(session.provider));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const TOOL_MODES: Array<{ mode: AgentToolMode; label: string; desc: string; icon: IconName }> = [
    { mode: 'project-only', label: 'Project only', desc: 'Chat and manage tickets only; no file or shell access', icon: 'search' },
    { mode: 'read-only', label: 'Read only', desc: 'Inspect codebase and read files; no file editing or shell commands', icon: 'search' },
    { mode: 'full', label: 'Full tools', desc: 'Read and edit files, and execute terminal commands', icon: 'tools' }
  ];

  const changeToolMode = async (targetMode: AgentToolMode) => {
    if (targetMode === session.toolMode) {
      onClose();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      let dir = session.workingDirectory;
      if ((targetMode === 'full' || targetMode === 'read-only') && !dir) {
        const picked = await window.praxis.dialog.pickFolder('Choose working folder for this session');
        if (!picked) {
          setBusy(false);
          return;
        }
        dir = picked;
      }
      await window.praxis.ai.updateSessionToolAccess(session.issueKey, {
        toolMode: targetMode,
        ...(dir ? { workingDirectory: dir } : {})
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handover = async (provider: AiProvider, remember: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const providerModels = await fetchModelOptions(provider, false);
      await window.praxis.ai.handoverSession(session.issueKey, {
        provider,
        model: preferredModel(providerModels),
        expectedBriefRevision: session.handoverBrief?.revision ?? 0
      });
      if (remember) localStorage.setItem(HANDOVER_CONFIRMATION_KEY, 'always');
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const providerIsSelectable = (provider: AiProvider) =>
    provider === session.provider
    || (providerSupportsTools(provider) && providerStatuses?.some(status => status.provider === provider && isProviderUsable(status)) === true);

  const chooseProvider = (provider: AiProvider) => {
    if (!providerIsSelectable(provider)) return;
    if (provider === session.provider) {
      onClose();
      return;
    }
    if (localStorage.getItem(HANDOVER_CONFIRMATION_KEY) === 'always') {
      void handover(provider, false);
      return;
    }
    setPendingProvider(provider);
    setError(undefined);
  };

  const filteredOptions = (options?.options ?? []).filter(option => {
    const query = modelFilter.trim().toLowerCase();
    return !query || option.name.toLowerCase().includes(query) || option.value.toLowerCase().includes(query);
  });

  return createPortal(
    <div
      ref={menuRef}
      className="composer-provider-menu session-runtime-popover"
      role={pendingProvider ? 'dialog' : 'listbox'}
      aria-label={
        pendingProvider
          ? 'Confirm AI provider handover'
          : open === 'model'
            ? 'Model'
            : open === 'reasoning'
              ? 'Reasoning effort'
              : open === 'toolMode'
                ? 'Tool access'
                : open === 'folder'
                  ? 'Working folder'
                  : 'AI provider'
      }
      data-testid={
        open === 'model'
          ? 'session-model-menu'
          : open === 'reasoning'
            ? 'session-reasoning-menu'
            : open === 'toolMode'
              ? 'session-tool-mode-menu'
              : open === 'folder'
                ? 'session-folder-menu'
                : 'session-provider-menu'
      }
      style={anchoredPopoverStyle(position, open === 'toolMode' ? 320 : 300)}
    >
      {open === 'toolMode' ? (
        <>
          <div className="session-popover-heading" style={{ padding: '8px 12px 4px' }}>
            <Icon name="tools" size={14} />
            <strong>Tool access</strong>
          </div>
          {TOOL_MODES.map(opt => (
            <button
              key={opt.mode}
              type="button"
              className={`composer-provider-option${session.toolMode === opt.mode ? ' active' : ''}`}
              data-testid={`session-tool-mode-option-${opt.mode}`}
              role="option"
              aria-selected={session.toolMode === opt.mode}
              title={opt.desc}
              disabled={busy}
              onClick={() => void changeToolMode(opt.mode)}
            >
              <Icon name={opt.icon} size={14} />
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left' }}>
                <span className="composer-model-option-name">{opt.label}</span>
                <span className="composer-chip-meta" style={{ fontSize: '11px', opacity: 0.8 }}>{opt.desc}</span>
              </div>
            </button>
          ))}
          {error && <p className="session-popover-error">{error}</p>}
        </>
      ) : open === 'folder' ? (
        <>
          <div className="session-popover-heading" style={{ padding: '8px 12px 4px' }}>
            <Icon name="folder" size={14} />
            <strong>Working folder</strong>
          </div>
          {session.workingDirectory && (
            <div className="composer-provider-option" style={{ cursor: 'default', opacity: 0.85 }} title={session.workingDirectory}>
              <Icon name="folder" size={14} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '240px', fontSize: '12px' }}>
                {session.workingDirectory}
              </span>
            </div>
          )}
          <button
            type="button"
            className="composer-provider-option"
            data-testid="session-folder-change"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                const picked = await window.praxis.dialog.pickFolder('Choose working folder for this session');
                if (picked) {
                  await window.praxis.ai.updateSessionToolAccess(session.issueKey, { workingDirectory: picked });
                  onClose();
                }
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="folder" size={14} />
            <span>{session.workingDirectory ? 'Change working folder…' : 'Choose working folder…'}</span>
          </button>
          {session.workingDirectory && (
            <button
              type="button"
              className="composer-provider-option"
              data-testid="session-folder-detach"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(undefined);
                try {
                  await window.praxis.ai.updateSessionToolAccess(session.issueKey, {
                    workingDirectory: null,
                    toolMode: 'project-only'
                  });
                  onClose();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Icon name="close" size={14} />
              <span>Detach folder (revert to Project only)</span>
            </button>
          )}
          {error && <p className="session-popover-error">{error}</p>}
        </>
      ) : pendingProvider ? (
        <div className="session-handover-confirm" data-testid="session-handover-confirmation">
          <div className="session-popover-heading">
            <Icon name="info" size={15} />
            <strong>Hand over to {providerLabel(pendingProvider)}?</strong>
          </div>
          <p>
            This continues the current session with {providerLabel(pendingProvider)}. The new AI receives the session brief and workspace context.
          </p>
          <p className="session-popover-note">Always skips this confirmation for future provider changes on this Praxis installation.</p>
          {error && <p className="session-popover-error">{error}</p>}
          <div className="session-popover-actions">
            <button type="button" className="btn" data-testid="session-handover-no" disabled={busy} onClick={() => setPendingProvider(undefined)}>No</button>
            <button type="button" className="btn" data-testid="session-handover-always" disabled={busy} onClick={() => void handover(pendingProvider, true)}>Always</button>
            <button type="button" className="btn btn-primary" data-testid="session-handover-yes" disabled={busy} onClick={() => void handover(pendingProvider, false)}>{busy ? 'Handing over…' : 'Yes'}</button>
          </div>
        </div>
      ) : open === 'model' ? (
        <>
          <div className="model-menu-search-row">
            <input
              type="text"
              className="input"
              placeholder="Filter models…"
              value={modelFilter}
              onChange={event => setModelFilter(event.target.value)}
              data-testid="session-model-filter"
              autoFocus
            />
            <button
              type="button"
              className="model-menu-refresh"
              aria-label={`Refresh ${session.provider ? providerLabel(session.provider) : ''} models`}
              title="Refresh model list"
              data-testid="session-model-refresh"
              disabled={loading || busy}
              onClick={() => void refreshModels()}
            >
              <Icon name="refresh" size={14} />
            </button>
          </div>
          {loading && <div className="popover-label">Loading models…</div>}
          {!loading && filteredOptions.length === 0 && <div className="popover-label">No models available</div>}
          {filteredOptions.map(option => {
            const contextLimit = option.contextLength ?? getKnownContextLength(option.value, session.provider);
            const contextSize = formatContextLength(contextLimit);
            const pricing = option.pricing ?? getModelPricing(session.provider, option.value);
            const cost = formatModelCost(pricing);
            return (
              <button
                key={option.value}
                type="button"
                className={`composer-provider-option${session.model === option.value ? ' active' : ''}`}
                data-testid={`session-model-option-${option.value}`}
                role="option"
                aria-selected={session.model === option.value}
                title={option.description}
                disabled={busy}
                onClick={() => void changeModel(option.value)}
              >
                <Icon name="sparkles" size={14} />
                <span className="composer-model-option-name">{option.name || option.value}</span>
                {(contextSize || cost) && (
                  <span className="composer-model-option-meta">
                    {contextSize && <span className="composer-model-badge is-context">{contextSize}</span>}
                    {cost && <span className="composer-model-badge is-cost">{cost}</span>}
                  </span>
                )}
              </button>
            );
          })}
          {error && <p className="session-popover-error">{error}</p>}
        </>
      ) : open === 'reasoning' ? (
        <>
          {REASONING_EFFORT_LEVELS.map(level => (
            <button
              key={level}
              type="button"
              className={`composer-provider-option${(session.reasoningEffort ?? 'off') === level ? ' active' : ''}`}
              data-testid={`session-reasoning-option-${level}`}
              role="option"
              aria-selected={(session.reasoningEffort ?? 'off') === level}
              disabled={busy}
              onClick={() => void changeReasoningEffort(level)}
            >
              <Icon name="lightbulb" size={14} />
              <span className="composer-model-option-name">{level[0].toUpperCase() + level.slice(1)}</span>
            </button>
          ))}
          {error && <p className="session-popover-error">{error}</p>}
        </>
      ) : (
        <>
          {loading && <div className="popover-label">Loading providers…</div>}
          {/* Only providers with a usable key/CLI (or the session's own current
              one, so it stays visible even if its config changed underneath
              it) are worth showing — an unconfigured entry has no working
              action here (its row and "add" button were both dead clicks). */}
          {!loading && allModelProviderIds().filter(providerIsSelectable).map(provider => (
            <div
              key={provider}
              className={`composer-provider-option${session.provider === provider ? ' active' : ''}`}
              data-testid={`session-provider-option-${provider}`}
              role="option"
              aria-selected={session.provider === provider}
              tabIndex={0}
              onClick={() => chooseProvider(provider)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  chooseProvider(provider);
                }
              }}
            >
              <Icon name={providerIconName(provider)} size={14} />
              <span>{providerLabel(provider)}</span>
              <button
                type="button"
                className="composer-provider-add"
                aria-label={`Add ${providerLabel(provider)} to this chat`}
                data-testid={`session-provider-add-${provider}`}
                onClick={event => {
                  event.stopPropagation();
                  onAddProvider?.(provider);
                }}
              >
                <Icon name="plus" size={13} />
              </button>
            </div>
          ))}
          {!loading && allModelProviderIds().every(provider => !providerIsSelectable(provider)) && (
            <div className="popover-label">No providers configured — add one in Settings → AI.</div>
          )}
          {error && <p className="session-popover-error">{error}</p>}
        </>
      )}
    </div>,
    document.body
  );
}



export function SessionConversationDialog({ session, open, position, onClose, initialProvider }: { session: AgentSessionRecord; open: boolean; position: ComposerPopoverPosition | undefined; onClose: () => void; initialProvider?: AiProvider }) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // Undefined until the fetch below resolves — an empty configured list at
  // that point reads as "still loading", not "nothing configured".
  const [providerStatuses, setProviderStatuses] = useState<AiProviderStatus[]>();
  const configuredProviders = allModelProviderIds().filter(id =>
    providerSupportsTools(id) && providerStatuses?.some(status => status.provider === id && isProviderUsable(status))
  );
  const defaultProvider =
    configuredProviders.find(id => id !== session.provider) ?? configuredProviders[0] ?? session.provider ?? 'openai';
  const [provider, setProvider] = useState<AiProvider>(defaultProvider);
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<AgentConversationMode>('consult');
  const [turnCap, setTurnCap] = useState(6);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.praxis.ai.listProviderStatuses().then(statuses => {
      if (!cancelled) setProviderStatuses(statuses);
    });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (open && initialProvider) setProvider(initialProvider);
  }, [open, initialProvider]);
  const [options, setOptions] = useState<ModelOptions>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setProvider(defaultProvider);
    setModel('');
    setMode('consult');
    setTurnCap(6);
    setError(undefined);
    // Deliberately not keyed on `defaultProvider`/`providerStatuses`: this
    // resets the form once when the dialog opens, not every time the async
    // provider-status fetch resolves — otherwise it would stomp on
    // `initialProvider` (set in the same batch as `open`) or a selection the
    // user already made while the fetch was still in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session.issueKey]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchModelOptions(provider, false).then(next => {
      if (cancelled) return;
      setOptions(next);
      setModel(next?.currentValue || next?.options[0]?.value || '');
    });
    return () => { cancelled = true; };
  }, [open, provider]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (popoverRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open]);

  if (!open || !position) return null;
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await window.praxis.ai.startConversation(session.issueKey, { provider, model: model || undefined, mode, turnCap });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div
      ref={popoverRef}
      className="composer-provider-menu session-conversation-popover"
      role="dialog"
      aria-labelledby="session-conversation-title"
      data-testid="session-conversation-dialog"
      style={anchoredPopoverStyle(position, 340)}
    >
        <div className="session-popover-heading">
          <Icon name="chats" size={15} />
          <strong id="session-conversation-title">Bring in another AI</strong>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Close" onClick={onClose}><Icon name="close" size={13} /></button>
        </div>
        <p className="session-popover-note">Starts a bounded conversation. Two models may incur spend; only one can hold tools at a time.</p>
        <label className="session-brief-field"><span className="rail-sub">Second AI provider</span>
          <ChipSelect
            block
            ariaLabel="Second AI provider"
            data-testid="session-conversation-provider"
            value={provider}
            disabled={!providerStatuses || configuredProviders.length === 0}
            placeholder={!providerStatuses ? 'Loading providers…' : 'No providers configured'}
            onChange={value => setProvider(value as AiProvider)}
            options={configuredProviders.map(id => ({ value: id, label: providerLabel(id), icon: providerIconName(id) }))}
          />
        </label>
        <label className="session-brief-field"><span className="rail-sub">Model</span>
          {options?.options.length ? <ChipSelect block ariaLabel="Model" data-testid="session-conversation-model" value={model} icon="sparkles" onChange={setModel} options={options.options.map(option => ({ value: option.value, label: option.name || option.value, description: option.description }))} />
            : <input data-testid="session-conversation-model" value={model} onChange={event => setModel(event.target.value)} />}
        </label>
        <label className="session-brief-field"><span className="rail-sub">Mode</span>
          <ChipSelect
            block
            ariaLabel="Mode"
            data-testid="session-conversation-mode"
            value={mode}
            onChange={value => setMode(value as AgentConversationMode)}
            options={[
              { value: 'consult', label: 'Consult', description: 'Both read only' },
              { value: 'debate', label: 'Debate', description: 'Both read only' },
              { value: 'pair', label: 'Pair', description: 'One tool owner at a time' }
            ]}
          />
        </label>
        <label className="session-brief-field"><span className="rail-sub">Total AI turns</span>
          <input data-testid="session-conversation-turn-cap" type="number" min={1} max={20} value={turnCap} onChange={event => setTurnCap(Number(event.target.value))} />
        </label>
        {error && <p className="hint is-danger">{error}</p>}
        <div className="session-popover-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" data-testid="session-conversation-confirm" disabled={busy || !model} onClick={() => void submit()}>{busy ? 'Starting…' : 'Start conversation'}</button></div>
    </div>, document.body
  );
}

export function SessionConversationActions({ session, onStop, onToolOwner, targetId, onTargetChange }: {
  session: AgentSessionRecord; onStop: () => void; onToolOwner: (id: string) => void;
  targetId?: string; onTargetChange?: (id: string) => void;
}) {
  const conversation = session.conversation;
  const idle = canChangeSessionRuntime(session);
  if (conversation?.state === 'running') {
    const current = conversation.participants.find(participant => participant.id === conversation.currentSpeakerId);
    const owner = conversation.participants.find(participant => participant.id === conversation.toolOwnerId);
    return <>
      <ChipSelect
        variant="plain"
        className="session-conversation-target"
        data-testid="session-conversation-target"
        ariaLabel="Choose which AI receives your message"
        value={targetId ?? current?.id ?? ''}
        onChange={value => onTargetChange?.(value)}
        options={conversation.participants.map(participant => ({
          value: participant.id,
          label: `Ask ${participant.displayLabel}`,
          icon: providerIconName(participant.provider)
        }))}
      />
      <span className="composer-chip session-runtime-chip is-readonly" data-testid="session-conversation-status">{conversation.mode} · {conversation.turnsUsed}/{conversation.turnCap} · {current?.displayLabel}</span>
      <span className="composer-chip session-runtime-chip is-readonly" data-testid="session-conversation-tool-owner">Tools: {owner?.displayLabel ?? 'None'}</span>
      {conversation.mode === 'pair' && idle && conversation.participants.map(participant => <button key={participant.id} className="composer-chip" type="button" data-testid={`session-conversation-owner-${participant.id}`} disabled={participant.id === conversation.toolOwnerId} onClick={() => onToolOwner(participant.id)}>Give tools to {participant.role}</button>)}
      <button type="button" className="composer-chip" data-testid="session-stop-conversation" onClick={onStop}><Icon name="close" size={14} />Stop conversation</button>
    </>;
  }
  return null;
}

/**
 * In the composer when the session's AI ran out of credits or hit its usage
 * limit: hand the session over to another AI that is set up — it carries on
 * from the handover brief — or stop here. Never switches without the user.
 */
export function SessionLimitSwitch({ session, onStop }: { session: AgentSessionRecord; onStop: () => void }) {
  const [usable, setUsable] = useState<AiProvider[]>();
  const [choice, setChoice] = useState<AiProvider>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void window.praxis.ai
      .listProviderStatuses()
      .then(statuses => {
        if (!cancelled) setUsable(statuses.filter(isProviderUsable).map(status => status.provider));
      })
      .catch(() => {
        if (!cancelled) setUsable([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session.issueKey]);

  const who = session.provider ? aiName(session.provider) : 'This AI';
  const choices = (usable ?? []).filter(provider => provider !== session.provider);
  const selected = choice && choices.includes(choice) ? choice : choices[0];
  const running = !isTerminalAgentState(session.state);

  const switchAndContinue = async () => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      if (running) await window.praxis.ai.abort(session.issueKey);
      const models = await fetchModelOptions(selected, false);
      await window.praxis.ai.handoverSession(session.issueKey, {
        provider: selected,
        model: preferredModel(models),
        expectedBriefRevision: session.handoverBrief?.revision ?? 0
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      if (running) await window.praxis.ai.abort(session.issueKey);
      onStop();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="session-limit-switch" role="alert" data-testid="session-limit-switch">
      <div className="session-limit-switch-text">
        <strong>{who} ran out of budget.</strong>{' '}
        {choices.length > 0
          ? 'Switch to another AI to carry on where it stopped, or stop here.'
          : usable
            ? 'No other AI is set up — add one in Settings › AI Provider, or stop here.'
            : ''}
        {error && <span className="session-limit-switch-error"> {error}</span>}
      </div>
      <div className="session-limit-switch-actions">
        {choices.length > 0 && (
          <>
            <div className="session-limit-provider-list" role="listbox" aria-label="Switch to" data-testid="session-limit-switch-to">
              {choices.map(provider => (
                <button
                  key={provider}
                  type="button"
                  className={`composer-chip${selected === provider ? ' active' : ''}`}
                  role="option"
                  aria-selected={selected === provider}
                  disabled={busy}
                  onClick={() => setChoice(provider)}
                >
                  <Icon name={providerIconName(provider)} size={14} />
                  {aiName(provider)}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-primary btn-compact" data-testid="session-limit-switch-go" disabled={busy} onClick={() => void switchAndContinue()}>
              Switch and continue
            </button>
          </>
        )}
        <button type="button" className="btn btn-quiet btn-compact" data-testid="session-limit-stop" disabled={busy} onClick={() => void stop()}>
          Stop
        </button>
      </div>
    </div>
  );
}

function aiName(provider: AiProvider): string {
  return (providerLabel(provider) ?? provider).replace(/\s*\(local\)$/, '').replace(/ CLI$/, '');
}
