import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentConversationMode, AgentSessionRecord, AiHandoverBriefEdits, AiProvider, HandoverBrief, ModelOptions } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { isTerminalAgentState } from './aiSessionState';
import { fetchModelOptions, MODEL_PROVIDERS, PROVIDER_LABELS, providerIconName } from './modelProviders';
import { formatStarted } from './sessionNav';

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
  return isTerminalAgentState(session.state) || session.state === 'paused' || session.state === 'not_started';
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

export function SessionRuntimeHistory({ session }: { session: AgentSessionRecord }) {
  const epochs = session.runtimeEpochs ?? [];
  if (epochs.length === 0) return null;
  return (
    <div className="agent-runtime-block session-runtime-history" data-testid="session-runtime-history">
      <span className="rail-sub">Runtime history</span>
      <ol className="session-epoch-list">
        {epochs.map(epoch => (
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

interface TransitionDialogsProps {
  session: AgentSessionRecord;
  open: 'model' | 'handover' | undefined;
  onClose: () => void;
}

export function SessionTransitionDialogs({ session, open, onClose }: TransitionDialogsProps) {
  const [provider, setProvider] = useState<AiProvider>(session.provider ?? 'openai');
  const [model, setModel] = useState(session.model ?? '');
  const [options, setOptions] = useState<ModelOptions>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notes, setNotes] = useState(session.handoverBrief?.userNotes ?? '');

  useEffect(() => {
    if (!open) return;
    setProvider(session.provider ?? 'openai');
    setModel(session.model ?? '');
    setNotes(session.handoverBrief?.userNotes ?? '');
    setError(undefined);
  }, [open, session.issueKey, session.model, session.provider, session.handoverBrief?.userNotes]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchModelOptions(provider, false).then(next => {
      if (cancelled) return;
      setOptions(next);
      setModel(current => {
        if (next?.options.length && !next.options.some(option => option.value === current)) {
          return next.currentValue || next.options[0].value;
        }
        return current;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, provider]);

  if (!open) return null;

  const title = open === 'model' ? 'Change model' : 'Hand over session';
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (open === 'model') {
        await window.praxis.ai.updateSessionModel(session.issueKey, model);
      } else {
        await window.praxis.ai.handoverSession(session.issueKey, {
          provider,
          model: model || undefined,
          expectedBriefRevision: session.handoverBrief?.revision ?? 0,
          briefEdits: notes !== (session.handoverBrief?.userNotes ?? '') ? { userNotes: notes } : undefined
        });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" data-testid={open === 'model' ? 'session-model-dialog' : 'session-handover-dialog'} onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="session-transition-title" onClick={event => event.stopPropagation()}>
        <h2 id="session-transition-title">{title}</h2>
        {open === 'handover' && (
          <p className="hint">
            The same Praxis session, worktree and brief continue. The receiving AI starts a new native runtime and is asked to inspect the current files.
          </p>
        )}
        {open === 'handover' && (
          <label className="session-brief-field">
            <span className="rail-sub">Provider</span>
            <select data-testid="session-handover-provider" value={provider} onChange={event => setProvider(event.target.value as AiProvider)}>
              {[...MODEL_PROVIDERS].map(id => (
                <option key={id} value={id}>{PROVIDER_LABELS[id]}</option>
              ))}
            </select>
          </label>
        )}
        <label className="session-brief-field">
          <span className="rail-sub">Model</span>
          {options?.options.length ? (
            <select data-testid="session-transition-model" value={model} onChange={event => setModel(event.target.value)}>
              {options.options.map(option => (
                <option key={option.value} value={option.value}>{option.name || option.value}</option>
              ))}
            </select>
          ) : (
            <input data-testid="session-transition-model" value={model} onChange={event => setModel(event.target.value)} />
          )}
        </label>
        {open === 'handover' && (
          <label className="session-brief-field">
            <span className="rail-sub">Notes for the next AI</span>
            <textarea data-testid="session-handover-notes" rows={4} value={notes} onChange={event => setNotes(event.target.value)} />
          </label>
        )}
        {error && <p className="hint is-danger">{error}</p>}
        <div className="session-brief-actions">
          <button type="button" className="btn btn-primary" data-testid="session-transition-confirm" disabled={busy || !model} onClick={() => void submit()}>
            {busy ? 'Working…' : open === 'model' ? 'Change model' : 'Hand over'}
          </button>
          <button type="button" className="btn" data-testid="session-transition-cancel" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body
  );
}



export function SessionConversationDialog({ session, open, onClose }: { session: AgentSessionRecord; open: boolean; onClose: () => void }) {
  const defaultProvider = [...MODEL_PROVIDERS].find(provider => provider !== session.provider) ?? session.provider ?? 'openai';
  const [provider, setProvider] = useState<AiProvider>(defaultProvider);
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<AgentConversationMode>('consult');
  const [turnCap, setTurnCap] = useState(6);
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
  }, [open, session.issueKey, defaultProvider]);

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

  if (!open) return null;
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
    <div className="modal-backdrop" data-testid="session-conversation-dialog" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="session-conversation-title" onClick={event => event.stopPropagation()}>
        <h2 id="session-conversation-title">Bring in another AI</h2>
        <p className="hint">This starts a bounded, sequential conversation. Two models may incur spend; only one can hold tools at a time.</p>
        <label className="session-brief-field"><span className="rail-sub">Second AI provider</span>
          <select data-testid="session-conversation-provider" value={provider} onChange={event => setProvider(event.target.value as AiProvider)}>
            {[...MODEL_PROVIDERS].map(id => <option key={id} value={id}>{PROVIDER_LABELS[id]}</option>)}
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
        <div className="session-brief-actions"><button type="button" className="btn btn-primary" data-testid="session-conversation-confirm" disabled={busy || !model} onClick={() => void submit()}>{busy ? 'Starting…' : 'Start conversation'}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
      </div>
    </div>, document.body
  );
}

export function SessionConversationActions({ session, onStart, onStop, onToolOwner }: {
  session: AgentSessionRecord; onStart: () => void; onStop: () => void; onToolOwner: (id: string) => void;
}) {
  const conversation = session.conversation;
  const idle = canChangeSessionRuntime(session);
  if (conversation?.state === 'running') {
    const current = conversation.participants.find(participant => participant.id === conversation.currentSpeakerId);
    const owner = conversation.participants.find(participant => participant.id === conversation.toolOwnerId);
    return <>
      <span className="composer-chip session-runtime-chip" data-testid="session-conversation-status">{conversation.mode} · {conversation.turnsUsed}/{conversation.turnCap} · {current?.displayLabel}</span>
      <span className="composer-chip session-runtime-chip" data-testid="session-conversation-tool-owner">Tools: {owner?.displayLabel ?? 'None'}</span>
      {conversation.mode === 'pair' && idle && conversation.participants.map(participant => <button key={participant.id} className="composer-chip" type="button" data-testid={`session-conversation-owner-${participant.id}`} disabled={participant.id === conversation.toolOwnerId} onClick={() => onToolOwner(participant.id)}>Give tools to {participant.role}</button>)}
      <button type="button" className="composer-chip" data-testid="session-stop-conversation" onClick={onStop}><Icon name="close" size={14} />Stop conversation</button>
    </>;
  }
  return <button type="button" className="composer-chip" data-testid="session-start-conversation" disabled={!idle} title={idle ? 'Bring a second AI into this session' : 'Wait until this turn finishes.'} onClick={onStart}><Icon name="chats" size={14} />Bring in another AI</button>;
}
