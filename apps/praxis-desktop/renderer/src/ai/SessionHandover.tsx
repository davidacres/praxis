import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentConversationMode,
  AgentSessionRecord,
  AiHandoverBriefEdits,
  AiProvider,
  AiProviderStatus,
  HandoverBrief,
  ModelOptions,
  SessionRuntimeEpoch
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { fetchModelOptions, MODEL_PROVIDERS, PROVIDER_LABELS, providerIconName, refreshModelOptions } from './modelProviders';
import { formatContextLength, formatModelCost, formatStarted, getKnownContextLength, getModelPricing } from './sessionNav';

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
              {epoch.provider ? PROVIDER_LABELS[epoch.provider] : 'Provider'}
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
  open: 'model' | 'handover' | undefined;
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
      if (target.closest('[data-testid="session-provider"], [data-testid="session-model"]')) return;
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
    provider === session.provider || providerStatuses?.some(status => status.provider === provider && status.configured) === true;

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
      aria-label={pendingProvider ? 'Confirm AI provider handover' : open === 'model' ? 'Model' : 'AI provider'}
      data-testid={open === 'model' ? 'session-model-menu' : 'session-provider-menu'}
      style={anchoredPopoverStyle(position, 300)}
    >
      {pendingProvider ? (
        <div className="session-handover-confirm" data-testid="session-handover-confirmation">
          <div className="session-popover-heading">
            <Icon name="info" size={15} />
            <strong>Hand over to {PROVIDER_LABELS[pendingProvider]}?</strong>
          </div>
          <p>
            This continues the current session with {PROVIDER_LABELS[pendingProvider]}. The new AI receives the session brief and workspace context.
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
              aria-label={`Refresh ${session.provider ? PROVIDER_LABELS[session.provider] : ''} models`}
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
      ) : (
        <>
          {loading && <div className="popover-label">Loading providers…</div>}
          {/* Only providers with a usable key/CLI (or the session's own current
              one, so it stays visible even if its config changed underneath
              it) are worth showing — an unconfigured entry has no working
              action here (its row and "add" button were both dead clicks). */}
          {!loading && [...MODEL_PROVIDERS].filter(providerIsSelectable).map(provider => (
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
              <span>{PROVIDER_LABELS[provider]}</span>
              <button
                type="button"
                className="composer-provider-add"
                aria-label={`Add ${PROVIDER_LABELS[provider]} to this chat`}
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
          {!loading && [...MODEL_PROVIDERS].every(provider => !providerIsSelectable(provider)) && (
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
  const configuredProviders = [...MODEL_PROVIDERS].filter(id =>
    providerStatuses?.some(status => status.provider === id && status.configured)
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
          <select
            data-testid="session-conversation-provider"
            value={provider}
            disabled={!providerStatuses || configuredProviders.length === 0}
            onChange={event => setProvider(event.target.value as AiProvider)}
          >
            {!providerStatuses && <option value={provider}>Loading providers…</option>}
            {providerStatuses && configuredProviders.length === 0 && <option value={provider}>No providers configured</option>}
            {configuredProviders.map(id => <option key={id} value={id}>{PROVIDER_LABELS[id]}</option>)}
          </select>
        </label>
        <label className="session-brief-field"><span className="rail-sub">Model</span>
          {options?.options.length ? <select data-testid="session-conversation-model" value={model} onChange={event => setModel(event.target.value)}>{options.options.map(option => <option key={option.value} value={option.value}>{option.name || option.value}</option>)}</select>
            : <input data-testid="session-conversation-model" value={model} onChange={event => setModel(event.target.value)} />}
        </label>
        <label className="session-brief-field"><span className="rail-sub">Mode</span>
          <select data-testid="session-conversation-mode" value={mode} onChange={event => setMode(event.target.value as AgentConversationMode)}>
            <option value="consult">Consult — both read only</option><option value="debate">Debate — both read only</option><option value="pair">Pair — one tool owner at a time</option>
          </select>
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
      <label className="composer-chip session-conversation-target" data-testid="session-conversation-target">
        <Icon name={providerIconName((conversation.participants.find(participant => participant.id === targetId) ?? current)?.provider ?? 'openai')} size={13} />
        <span>Ask</span>
        <select aria-label="Choose which AI receives your message" value={targetId ?? current?.id ?? ''} onChange={event => onTargetChange?.(event.target.value)}>
          {conversation.participants.map(participant => <option key={participant.id} value={participant.id}>{participant.displayLabel}</option>)}
        </select>
      </label>
      <span className="composer-chip session-runtime-chip is-readonly" data-testid="session-conversation-status">{conversation.mode} · {conversation.turnsUsed}/{conversation.turnCap} · {current?.displayLabel}</span>
      <span className="composer-chip session-runtime-chip is-readonly" data-testid="session-conversation-tool-owner">Tools: {owner?.displayLabel ?? 'None'}</span>
      {conversation.mode === 'pair' && idle && conversation.participants.map(participant => <button key={participant.id} className="composer-chip" type="button" data-testid={`session-conversation-owner-${participant.id}`} disabled={participant.id === conversation.toolOwnerId} onClick={() => onToolOwner(participant.id)}>Give tools to {participant.role}</button>)}
      <button type="button" className="composer-chip" data-testid="session-stop-conversation" onClick={onStop}><Icon name="close" size={14} />Stop conversation</button>
    </>;
  }
  return null;
}
