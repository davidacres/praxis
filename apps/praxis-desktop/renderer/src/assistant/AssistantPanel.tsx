import { useCallback, useEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type SetStateAction } from 'react';
import type { WireImageAttachment, AgentPermissionMode, AgentToolMode, AiProvider, AiProviderStatus, ModelOptions, ReasoningEffort } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ProviderBrandLogo } from '../ui/ProviderBrandLogo';
import { ChipSelect } from '../ui/ChipSelect';
import { ReasoningEffortSlider } from '../ai/ReasoningEffortSlider';
import { SessionPermissionModeControl } from '../ai/SessionPermissionModeControl';
import { SessionGitBranchControl } from '../ai/SessionGitBranchControl';
import { SessionCodeIntelControl } from '../ai/SessionCodeIntelControl';
import { SessionUsageSummary } from '../ai/SessionUsageSummary';
import { useSettings } from '../settings/useSettings';
import { applyEnabledModelCuration, fetchModelOptions, hasModelCatalog, providerLabel, supportsReasoningEffort } from '../ai/modelProviders';
import { isProviderUsable } from '../ai/providerAvailability';
import { AssistantComposer } from './AssistantComposer';
import { AssistantContextBanner } from './AssistantContextBanner';
import { AssistantMessageCard } from './AssistantMessageCard';
import { useAssistant, type AssistantComposerPreferences, type AssistantController } from './AssistantProvider';
import { PERSONAS } from './personaMeta';
import { describeTurnCards, isEditingSurface, resolveTurnKeyBinding, type TurnControl, type TurnControlState } from './turnControlModel';

function useRuntimePreference<K extends keyof AssistantComposerPreferences>(assistant: AssistantController, key: K): [AssistantComposerPreferences[K], Dispatch<SetStateAction<AssistantComposerPreferences[K]>>] {
  const set = useCallback<Dispatch<SetStateAction<AssistantComposerPreferences[K]>>>(value => {
    assistant.setRuntimePreferences(current => ({ ...current, [key]: typeof value === 'function'
      ? (value as (current: AssistantComposerPreferences[K]) => AssistantComposerPreferences[K])(current[key]) : value }));
  }, [assistant.setRuntimePreferences, key]);
  return [assistant.runtimePreferences[key], set];
}

const GENERAL_PROMPTS = ['What should I work on next?', 'Explain how Praxis governs a workflow'];

/** The one conversation UI; the shell decides whether it floats or docks around it. */
export function AssistantPanel({ focusSignal }: { focusSignal: number }) {
  const a = useAssistant();
  const { settings } = useSettings();
  const [providerStatuses, setProviderStatuses] = useState<AiProviderStatus[]>([]);
  const [provider, setProvider] = useRuntimePreference(a, 'provider');
  const [modelOptions, setModelOptions] = useState<ModelOptions>();
  const [model, setModel] = useRuntimePreference(a, 'model');
  const [reasoningEffort, setReasoningEffort] = useRuntimePreference(a, 'reasoningEffort');
  const [permissionMode, setPermissionMode] = useRuntimePreference(a, 'permissionMode');
  const [mode, setMode] = useRuntimePreference(a, 'mode');
  const [toolMode, setToolMode] = useRuntimePreference(a, 'toolMode');
  const [workingDirectory, setWorkingDirectory] = useRuntimePreference(a, 'workingDirectory');
  // Recovery input is keyed `${turnId}:${attemptId}`: two interrupted turns in one conversation
  // (or a retried attempt) must never share an acknowledgement or a reconciliation note.
  const [reconciliationNotes, setReconciliationNotes] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [toolError, setToolError] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const stuckToBottom = useRef(true);

  useEffect(() => {
    const configured = settings?.ai.workingDirectory?.trim();
    if (configured) setWorkingDirectory(current => current || configured);
  }, [settings?.ai.workingDirectory]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.praxis.ai.listProviderStatuses(), window.praxis.settings.get()]).then(([statuses, currentSettings]) => {
      if (cancelled) return;
      setProviderStatuses(statuses);
      const active = statuses.find(status => status.provider === currentSettings.ai.activeProvider && isProviderUsable(status));
      setProvider(current => current ?? active?.provider);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!provider || !hasModelCatalog(provider)) {
      setModelOptions(undefined);
      setModel('');
      return;
    }
    let cancelled = false;
    setModelOptions(undefined);
    void Promise.all([fetchModelOptions(provider, false), window.praxis.settings.get()]).then(([options, currentSettings]) => {
      if (cancelled) return;
      const curated = options && applyEnabledModelCuration(options, currentSettings.ai.providers[provider]?.enabledModelIds);
      setModelOptions(curated);
      const configured = provider === 'vercel-gateway' ? currentSettings.ai.defaultModel : currentSettings.ai.providers[provider]?.defaultModel;
      const selected = configured?.trim() && curated?.options.some(option => option.value === configured.trim())
        ? configured.trim()
        : curated?.currentValue && curated.options.some(option => option.value === curated.currentValue)
          ? curated.currentValue
          : curated?.options[0]?.value ?? '';
      setModel(current => current && curated?.options.some(option => option.value === current) ? current : selected);
    }).catch(() => { if (!cancelled) setModelOptions(undefined); });
    return () => { cancelled = true; };
  }, [provider]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && stuckToBottom.current) element.scrollTop = element.scrollHeight;
  }, [a.messages, a.busy]);

  const prompts = a.pageContext?.suggestedPrompts?.length ? a.pageContext.suggestedPrompts : a.pageContext ? [] : GENERAL_PROMPTS;
  const pickWorkingDirectory = async () => {
    try {
      const selected = await window.praxis.dialog.pickFolder('Choose working folder for Virtual Team');
      if (selected) {
        setWorkingDirectory(selected);
        setToolError(undefined);
        return selected;
      }
    } catch (error) {
      setToolError(error instanceof Error ? error.message : String(error));
    }
    return undefined;
  };
  const send = async (text: string, images: WireImageAttachment[] = []) => {
    // Images need an agent turn, so a chat that would otherwise be tool-less runs read-only.
    const effectiveToolMode = mode === 'chat' ? toolMode : 'read-only';
    const turnToolMode = images.length > 0 && effectiveToolMode === 'project-only' ? 'read-only' : effectiveToolMode;
    if (turnToolMode !== 'project-only' && !workingDirectory) {
      setToolError(images.length > 0 ? 'Choose a working folder before sending images.' : 'Choose a working folder before using assistant tools.');
      return false;
    }
    setToolError(undefined);
    return a.send(text, a.teamMembers, { provider, model: model || undefined, reasoningEffort, permissionMode, mode, toolMode: turnToolMode, workingDirectory: workingDirectory || undefined, ...(images.length ? { images } : {}) });
  };
  /** The queue/recovery cards, derived from the committed snapshot by `turnControlModel`. */
  const turnCards = describeTurnCards(a.conversation, turn => {
    const stateKey = `${turn.id}:${turn.attempts.at(-1)?.id ?? ''}`;
    return {
      reconciliationNote: reconciliationNotes[stateKey],
      acknowledged: acknowledged[stateKey] ?? false,
      ...(a.activeToolSession ? { activeToolSession: a.activeToolSession } : {})
    } satisfies TurnControlState;
  });
  const recoveryControlRefs = useRef(new Map<string, HTMLButtonElement>());
  // Each control issues exactly one command: one command id against the revision on screen. A
  // stale command answers `conflict` with fresh state, which the subscription then renders.
  const issueControl = useCallback((control: TurnControl) => {
    if (!control.command || control.disabled) return;
    const assistant = window.praxis.assistant;
    const sent: Promise<unknown> =
      control.command.method === 'cancelTurn' ? assistant.cancelTurn(control.command.payload)
      : control.command.method === 'retryParticipant' ? assistant.retryParticipant(control.command.payload)
      : control.command.method === 'resolveAttempt' ? assistant.resolveAttempt(control.command.payload)
      : assistant.control(control.command.payload);
    sent.catch(error => setToolError(String(error)));
  }, []);
  /**
   * Panel-scoped key bindings. Every one needs a modifier, and presses from the composer or the
   * reconciliation note reach only Stop — the composer's own Enter handler has already sent.
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const control = resolveTurnKeyBinding(
      { key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, fromEditingSurface: isEditingSurface(event.target) },
      turnCards.map(entry => entry.card)
    );
    if (!control) return;
    event.preventDefault();
    event.stopPropagation();
    issueControl(control);
  };
  /**
   * A turn that needs a decision puts focus on its first recovery control, but never while the
   * user is typing in the composer: focus only moves when the panel is not the active editing
   * surface (nothing focused, or focus is on the panel itself / a control already there).
   */
  const focusedTurn = turnCards.find(entry => entry.card.needsAttention)?.turn.id;
  useEffect(() => {
    if (!focusedTurn) return;
    const active = document.activeElement;
    // The user is already working in a recovery card: never take focus from them.
    if (active instanceof HTMLElement && active.closest('[data-testid="assistant-turn-status"]')) return;
    // Nor while they are typing somewhere else — the composer is the active editing surface.
    const editing = active instanceof HTMLElement && (active.isContentEditable || ['INPUT', 'TEXTAREA'].includes(active.tagName));
    if (editing) return;
    const card = panelRef.current?.querySelector<HTMLElement>(`[data-testid="assistant-turn-status"][data-turn-id="${focusedTurn}"]`);
    const target = card?.querySelector<HTMLElement>('[data-recovery="true"]:not([disabled])') ?? card?.querySelector<HTMLElement>('button:not([disabled])');
    target?.focus();
  }, [focusedTurn]);

  const sendLabel = a.teamMembers.length === 0
    ? 'Send general chat'
    : a.teamMembers.length === 1
      ? `Send to ${PERSONAS.find(persona => persona.id === a.teamMembers[0])?.name ?? 'team member'}`
      : `Send to selected team (${a.teamMembers.length})`;

  return (
    <section ref={panelRef} className="assistant-panel" aria-label="Virtual team assistant" data-testid="assistant-panel" tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="assistant-header" data-testid="assistant-drag-handle">
        <div className="assistant-header-title">
          <strong><Icon name="sparkles" size={14} /> Virtual Team</strong>
          <span className="assistant-roster" role="group" aria-label="Select virtual team members">
            {PERSONAS.map(persona => (
              <button
                key={persona.id}
                type="button"
                className={`assistant-member-toggle persona-badge persona-badge--${persona.id}${a.teamMembers.includes(persona.id) ? ' is-selected' : ''}`}
                aria-label={`${a.teamMembers.includes(persona.id) ? 'Exclude' : 'Include'} ${persona.name}`}
                aria-pressed={a.teamMembers.includes(persona.id)}
                title={`${a.teamMembers.includes(persona.id) ? 'Included' : 'Excluded'} — ${persona.name} (@${persona.id})`}
                data-testid={`assistant-member-${persona.id}`}
                disabled={false}
                onClick={() => a.toggleTeamMember(persona.id)}
              >
                <Icon name={persona.icon} size={11} />
              </button>
            ))}
          </span>
        </div>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="New team chat" data-testid="assistant-new-chat" onClick={a.newChat}>
          <Icon name="plus" size={13} />
        </button>
        <button
          type="button"
          className={`icon-btn icon-btn-sm${a.docked ? ' is-active' : ''}`}
          aria-label={a.docked ? 'Unpin assistant to floating' : 'Pin assistant to the side'}
          aria-pressed={a.docked}
          data-testid="assistant-pin"
          onClick={() => a.setDocked(!a.docked)}
        >
          <Icon name="pin" size={13} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Close assistant" data-testid="assistant-close" onClick={() => a.setOpen(false)}>
          <Icon name="close" size={13} />
        </button>
      </header>

      <div
        className="assistant-feed"
        ref={scrollRef}
        data-testid="assistant-feed"
        onScroll={event => {
          const el = event.currentTarget;
          stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {a.messages.length === 0 && (
          <div className="assistant-empty">
            <Icon name="sparkles" size={18} />
            <p>Dev is selected for one-to-one chat by default. Select more members for a team reply, or deselect everyone for a general chat with the Tech Lead. An <code>@mention</code> still routes directly to that member.</p>
          </div>
        )}
        {a.messages.map(message => (
          <AssistantMessageCard
            key={message.id}
            message={message}
          />
        ))}
      </div>

      {turnCards.map(({ turn, card }) => {
        const attempt = turn.attempts.at(-1);
        const stateKey = `${turn.id}:${attempt?.id ?? ''}`;
        return <div key={turn.id} className="assistant-action-card" role="group" aria-label={card.ariaLabel} data-testid={card.testId} data-turn-id={turn.id} data-turn-state={turn.state}>
          <strong>{card.heading}</strong>
          {card.alert && card.alert !== a.error && <p role="alert">{card.alert}</p>}
          {card.contextAlert && card.contextAlert !== a.error && <p role="alert">{card.contextAlert}</p>}
          {card.controls.map(control => {
            if (control.kind === 'reconciliation-note') {
              return <label key={control.kind}>{control.label}<input
                value={control.field!.value}
                aria-label={control.ariaLabel}
                data-testid={control.testId}
                data-recovery="true"
                onChange={event => setReconciliationNotes(current => ({ ...current, [stateKey]: event.target.value }))}
              /></label>;
            }
            if (control.kind === 'resolve-confirmed') {
              return <label key={control.kind}><input
                type="checkbox"
                checked={control.field!.checked}
                aria-label={control.ariaLabel}
                data-testid={control.testId}
                data-recovery="true"
                onChange={event => setAcknowledged(current => ({ ...current, [stateKey]: event.target.checked }))}
              />{control.label}</label>;
            }
            return <button
              key={control.kind}
              className="btn btn-sm"
              data-testid={control.testId}
              aria-label={control.ariaLabel}
              disabled={control.disabled}
              title={control.disabled ? control.disabledReason : control.keyHint ? `${control.label} (${control.keyHint})` : undefined}
              data-recovery={control.recovery || undefined}
              ref={control.recovery ? node => { if (node) recoveryControlRefs.current.set(control.testId, node); } : undefined}
              onClick={() => issueControl(control)}
            >{control.label}</button>;
          })}
        </div>;
      })}

      {a.error && <div className="error-banner assistant-error" role="alert" data-testid="assistant-error">
        <span>{a.error}</span>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss error" data-testid="assistant-error-dismiss" onClick={a.dismissError}>
          <Icon name="close" size={12} />
        </button>
      </div>}
      {toolError && <div className="error-banner assistant-error" role="alert" data-testid="assistant-tool-error">
        <span>{toolError}</span>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss error" data-testid="assistant-tool-error-dismiss" onClick={() => setToolError(undefined)}>
          <Icon name="close" size={12} />
        </button>
      </div>}
      {a.activeToolSession?.state === 'awaiting_approval' && (() => {
        const events = a.activeToolSession.events;
        const lastCompleted = events.map(event => event.type).lastIndexOf('permission_completed');
        const pending = events.slice(lastCompleted + 1).find(event => event.type === 'permission_requested');
        return pending ? <div className="session-permission-card assistant-tool-permission" data-testid="assistant-tool-permission">
          <div className="session-permission-body"><div className="session-permission-heading"><Icon name="shield" size={14} />{pending.summary}</div>{pending.detail && <div className="session-permission-detail">{pending.detail}</div>}</div>
          <div className="session-permission-actions">
            <button className="btn" onClick={() => void window.praxis.ai.respondToPermission(a.activeToolSession!.issueKey, 'deny')}>Deny</button>
            <button className="btn btn-primary" onClick={() => void window.praxis.ai.respondToPermission(a.activeToolSession!.issueKey, 'allow_once')}>Allow</button>
          </div>
        </div> : null;
      })()}

      <AssistantContextBanner
        context={a.availableContext}
        detached={a.contextDetached}
        onToggleDetached={() => a.setContextDetached(!a.contextDetached)}
        prompts={prompts}
        busy={false}
        onPrompt={send}
        pinnedDecisions={a.conversation?.pinnedMessageIds.length ?? 0}
      />

      <div className="assistant-composer-area">
      <div className="session-usage-wrapper">
        <SessionUsageSummary usageContributions={a.conversation?.turns.flatMap(turn => turn.attempts.map(attempt => ({
          provider: String(turn.plan.runtimeOptions.provider ?? provider ?? settings?.ai.activeProvider ?? 'vercel-gateway') as AiProvider,
          ...(typeof turn.plan.runtimeOptions.model === 'string' ? { model: turn.plan.runtimeOptions.model } : {}),
          tokens: attempt.usage?.totalTokens, cost: attempt.reportedCost
        })))} session={a.activeToolSession ?? a.lastToolSession} usageSessions={a.toolUsageSessions} sessions={a.toolUsageSessions} spendLimit={settings?.ai.spendLimit ?? 0} draftProvider={provider} draftModel={model} activityLabel={a.conversation?.turns.some(turn => turn.attempts.length) ? 'Reported usage across conversation attempts' : 'No conversation usage recorded yet'} />
      </div>
      <AssistantComposer
        value={a.draft}
        onChange={a.setDraft}
        busy={a.busy}
        activeTurnStartedAt={a.activeTurnStartedAt}
        tokenCount={a.activeToolSession?.tokenUsage?.totalTokens}
        focusSignal={focusSignal}
        sendLabel={sendLabel}
        onSend={images => send(a.draft, images)}
        headerOptions={(
          <>
            <div className="session-mode-toggle" role="group" aria-label="Assistant mode">
              {(['chat', 'analysis', 'review'] as const).map(option => (
                <button key={option} type="button" className={mode === option ? 'active' : ''}
                  data-testid={`assistant-mode-${option}`} aria-pressed={mode === option} onClick={() => setMode(option)}>
                  {option[0].toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
            <div className="session-mode-panel-meta">
              <ChipSelect variant="plain" className="session-runtime-chip" data-testid="assistant-tool-mode"
                ariaLabel="Tool access" icon={mode === 'chat' && toolMode === 'full' ? 'tools' : 'search'}
                value={mode === 'chat' ? toolMode : 'read-only'} disabled={false || mode !== 'chat'}
                onChange={value => {
                  const next = value as AgentToolMode;
                  if (next === 'full' && !workingDirectory) {
                    void pickWorkingDirectory().then(folder => { if (folder) setToolMode('full'); });
                  } else setToolMode(next);
                }}
                options={[
                  { value: 'full', label: 'Full tools', description: 'Read, edit and run commands in the working folder', icon: 'tools' },
                  { value: 'read-only', label: 'Read only', description: 'Read files in the working folder without changing them', icon: 'search' },
                  { value: 'project-only', label: 'Project only', description: 'Chat without local file or shell tools', icon: 'folder' }
                ]} />
              <button type="button" className="composer-chip session-runtime-chip" data-testid="assistant-working-directory"
                disabled={false} title={workingDirectory || 'Choose a working folder for Virtual Team tools'} onClick={() => void pickWorkingDirectory()}>
                <Icon name="folder" size={14} /><span className="session-runtime-chip-label">{workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) || 'Attach folder…'}</span>
              </button>
            </div>
          </>
        )}
        composerOptions={(
          <div className="assistant-composer-options" data-testid="assistant-composer-options">
            <ChipSelect variant="plain" ariaLabel="AI provider" data-testid="assistant-provider" value={provider ?? ''} placeholder="Provider" icon={provider ? <ProviderBrandLogo provider={provider} size={13} decorative /> : 'globe'} disabled={false} onChange={value => setProvider(value as AiProvider)} options={providerStatuses.filter(isProviderUsable).map(status => ({ value: status.provider, label: status.label, icon: <ProviderBrandLogo provider={status.provider} size={13} decorative /> }))} />
            <ChipSelect variant="plain" ariaLabel="AI model" data-testid="assistant-model" value={model} placeholder={provider && hasModelCatalog(provider) ? 'Choose model…' : 'Default model'} icon="sparkles" disabled={false || !provider || !modelOptions?.options.length} onChange={setModel} options={modelOptions?.options.map(option => ({ value: option.value, label: option.name || option.value, description: option.description })) ?? []} />
            {supportsReasoningEffort(provider, model) && <ReasoningEffortSlider value={reasoningEffort} onChange={setReasoningEffort} disabled={false} testId="assistant-reasoning" />}
          </div>
        )}
      />
      <div className="session-composer-footer" title="Virtual Team chat is read-only; permission mode is included as context for the assistant.">
        <SessionPermissionModeControl value={permissionMode} onChange={setPermissionMode} testId="assistant" disabled={false} />
        <SessionGitBranchControl
          workingDirectory={workingDirectory || undefined}
          testId="assistant"
          disabled={false}
        />
        <SessionCodeIntelControl
          workingDirectory={workingDirectory || undefined}
          provider={provider}
          testId="assistant"
          disabled={false}
        />
      </div>
      </div>
    </section>
  );
}
