import { useEffect, useRef, useState } from 'react';
import type { WireImageAttachment, AgentPermissionMode, AgentToolMode, AiProvider, AiProviderStatus, ModelOptions, ReasoningEffort } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ChipSelect } from '../ui/ChipSelect';
import { ReasoningEffortSlider } from '../ai/ReasoningEffortSlider';
import { SessionPermissionModeControl } from '../ai/SessionPermissionModeControl';
import { SessionUsageSummary } from '../ai/SessionUsageSummary';
import { useSettings } from '../settings/useSettings';
import { applyEnabledModelCuration, fetchModelOptions, hasModelCatalog, providerIconName, providerLabel, supportsReasoningEffort } from '../ai/modelProviders';
import { isProviderUsable } from '../ai/providerAvailability';
import { AssistantComposer } from './AssistantComposer';
import { AssistantContextBanner } from './AssistantContextBanner';
import { AssistantMessageCard } from './AssistantMessageCard';
import { useAssistant } from './AssistantProvider';
import { PERSONAS } from './personaMeta';

const GENERAL_PROMPTS = ['What should I work on next?', 'Explain how Praxis governs a workflow'];

/** The one conversation UI; the shell decides whether it floats or docks around it. */
export function AssistantPanel({ focusSignal }: { focusSignal: number }) {
  const a = useAssistant();
  const { settings } = useSettings();
  const [providerStatuses, setProviderStatuses] = useState<AiProviderStatus[]>([]);
  const [provider, setProvider] = useState<AiProvider>();
  const [modelOptions, setModelOptions] = useState<ModelOptions>();
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>('manual');
  const [mode, setMode] = useState<'chat' | 'analysis' | 'review'>('chat');
  const [toolMode, setToolMode] = useState<AgentToolMode>('project-only');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [toolError, setToolError] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
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
    setModel('');
    setReasoningEffort('medium');
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
      setModel(selected);
      setReasoningEffort((selected && currentSettings.ai.providers[provider]?.modelReasoningDefaults?.[selected]) || 'medium');
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
  const send = (text: string, images: WireImageAttachment[] = []) => {
    // Images need an agent turn, so a chat that would otherwise be tool-less runs read-only.
    const effectiveToolMode = mode === 'chat' ? toolMode : 'read-only';
    const turnToolMode = images.length > 0 && effectiveToolMode === 'project-only' ? 'read-only' : effectiveToolMode;
    if (turnToolMode !== 'project-only' && !workingDirectory) {
      setToolError(images.length > 0 ? 'Choose a working folder before sending images.' : 'Choose a working folder before using assistant tools.');
      return;
    }
    setToolError(undefined);
    a.setDraft('');
    void a.send(text, a.teamMembers, { provider, model: model || undefined, reasoningEffort, permissionMode, mode, toolMode: turnToolMode, workingDirectory: workingDirectory || undefined, ...(images.length ? { images } : {}) });
  };
  const sendLabel = a.teamMembers.length === 0
    ? 'Send general chat'
    : a.teamMembers.length === 1
      ? `Send to ${PERSONAS.find(persona => persona.id === a.teamMembers[0])?.name ?? 'team member'}`
      : `Send to selected team (${a.teamMembers.length})`;

  return (
    <section className="assistant-panel" aria-label="Virtual team assistant" data-testid="assistant-panel">
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
                disabled={a.busy}
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
        {a.busy && <div className="assistant-message is-persona"><span className="placeholder-text">The team is thinking…</span></div>}
      </div>

      {a.error && <div className="error-banner assistant-error" role="alert">{a.error}</div>}
      {toolError && <div className="error-banner assistant-error" role="alert">{toolError}</div>}
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
        busy={a.busy}
        onPrompt={send}
      />

      <div className="assistant-composer-area">
      <div className="session-usage-wrapper">
        <SessionUsageSummary session={a.activeToolSession ?? a.lastToolSession} sessions={[]} spendLimit={settings?.ai.spendLimit ?? 0} draftProvider={provider} draftModel={model} activityLabel="Team chat usage unavailable" />
      </div>
      <AssistantComposer
        value={a.draft}
        onChange={a.setDraft}
        busy={a.busy}
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
                value={mode === 'chat' ? toolMode : 'read-only'} disabled={a.busy || mode !== 'chat'}
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
                disabled={a.busy} title={workingDirectory || 'Choose a working folder for Virtual Team tools'} onClick={() => void pickWorkingDirectory()}>
                <Icon name="folder" size={14} /><span className="session-runtime-chip-label">{workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) || 'Attach folder…'}</span>
              </button>
            </div>
          </>
        )}
        composerOptions={(
          <div className="assistant-composer-options" data-testid="assistant-composer-options">
            <ChipSelect variant="plain" ariaLabel="AI provider" data-testid="assistant-provider" value={provider ?? ''} placeholder="Provider" icon={provider ? providerIconName(provider) : 'globe'} disabled={a.busy} onChange={value => setProvider(value as AiProvider)} options={providerStatuses.filter(isProviderUsable).map(status => ({ value: status.provider, label: status.label, icon: providerIconName(status.provider) }))} />
            <ChipSelect variant="plain" ariaLabel="AI model" data-testid="assistant-model" value={model} placeholder={provider && hasModelCatalog(provider) ? 'Choose model…' : 'Default model'} icon="sparkles" disabled={a.busy || !provider || !modelOptions?.options.length} onChange={setModel} options={modelOptions?.options.map(option => ({ value: option.value, label: option.name || option.value, description: option.description })) ?? []} />
            {supportsReasoningEffort(provider, model) && <ReasoningEffortSlider value={reasoningEffort} onChange={setReasoningEffort} disabled={a.busy} testId="assistant-reasoning" />}
          </div>
        )}
      />
      <div className="session-composer-footer" title="Virtual Team chat is read-only; permission mode is included as context for the assistant.">
        <SessionPermissionModeControl value={permissionMode} onChange={setPermissionMode} testId="assistant" disabled={a.busy} />
      </div>
      </div>
    </section>
  );
}
