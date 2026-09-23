import { useMemo, useState } from 'react';
import type { AgentRuntimeSnapshot, AgentTransport, CatalogScope, ImportPreview, NewAgentProfileInput } from '@praxis/core';
import { Icon } from '../ui/Icon';
import {
  AGENT_TRANSPORTS,
  agentDraftErrors,
  skillDraftErrors,
  transportMeta,
  type AgentDraft,
  type SkillDraft
} from './agentAuthoring';
import { ChipSelect } from '../ui/ChipSelect';

function ScopeField({ value, onChange }: { value: CatalogScope; onChange: (scope: CatalogScope) => void }) {
  return (
    <fieldset className="form-fieldset">
      <legend>Scope</legend>
      <label className="form-check">
        <input type="radio" name="scope" checked={value === 'global'} onChange={() => onChange('global')} />
        Global — available to every project
      </label>
      <label className="form-check">
        <input type="radio" name="scope" checked={value === 'project'} onChange={() => onChange('project')} />
        This project — <code>.praxis/</code>, approval-required
      </label>
    </fieldset>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="agent-hub-field">
      <label className="form-field-label">
        <span>{label}</span>
        {children}
      </label>
      {error && <span className="hint is-warn">{error}</span>}
    </div>
  );
}

function Shell({
  title,
  onClose,
  busy,
  error,
  canSubmit,
  submitLabel,
  onSubmit,
  children
}: {
  title: string;
  onClose: () => void;
  busy: boolean;
  error?: string;
  canSubmit: boolean;
  submitLabel: string;
  onSubmit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="modal-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header agent-hub-dialog-head">
          <h3>{title}</h3>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className="modal-body agent-hub-dialog">
          {error && (
            <p role="alert" className="error-banner">
              {error}
            </p>
          )}
          {children}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={busy || !canSubmit}>
            {busy ? 'Working…' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CreateAgentDialog({
  defaultScope,
  existingIds,
  onClose,
  onCreated
}: {
  defaultScope: CatalogScope;
  existingIds: string[];
  onClose: () => void;
  onCreated: (snapshot: AgentRuntimeSnapshot) => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>({
    scope: defaultScope,
    name: '',
    id: '',
    transport: 'acp',
    command: '',
    url: '',
    args: '',
    activation: 'onDemand',
    scaffold: true
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = (patch: Partial<AgentDraft>) => setDraft(current => ({ ...current, ...patch }));

  const errors = useMemo(() => agentDraftErrors(draft, existingIds), [draft, existingIds]);
  const meta = transportMeta(draft.transport);

  const submit = () => {
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(undefined);
    void window.praxis.agentRuntime
      .createAgent({
        scope: draft.scope,
        name: draft.name.trim(),
        id: draft.id.trim(),
        transport: draft.transport,
        ...(meta.needs === 'command' ? { command: draft.command.trim() } : { url: draft.url.trim() }),
        ...(draft.args.trim() ? { args: draft.args.trim().split(/\s+/) } : {}),
        activation: draft.activation,
        scaffold: draft.scaffold
      })
      .then(onCreated)
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <Shell
      title="New agent"
      onClose={onClose}
      busy={busy}
      error={error}
      canSubmit={Object.keys(errors).length === 0}
      submitLabel="Create agent"
      onSubmit={submit}
    >
      <ScopeField value={draft.scope} onChange={scope => set({ scope })} />
      <Field label="Display name" error={errors.name}>
        <input value={draft.name} onChange={event => set({ name: event.target.value })} placeholder="Praxis Reviewer" />
      </Field>
      <Field label="ID" error={errors.id}>
        <input value={draft.id} onChange={event => set({ id: event.target.value })} placeholder="praxis-reviewer" />
      </Field>
      <Field label="Transport">
        <ChipSelect
          block
          ariaLabel="Transport"
          value={draft.transport}
          onChange={value => set({ transport: value as AgentTransport })}
          options={AGENT_TRANSPORTS.map(transport => ({ value: transport.id, label: transport.label }))}
        />
      </Field>
      {meta.needs === 'command' ? (
        <>
          <Field label="Command" error={errors.command}>
            <input value={draft.command} onChange={event => set({ command: event.target.value })} placeholder="node" />
          </Field>
          <Field label="Arguments (space-separated)">
            <input value={draft.args} onChange={event => set({ args: event.target.value })} placeholder="index.js" />
          </Field>
        </>
      ) : (
        <Field label="URL" error={errors.url}>
          <input value={draft.url} onChange={event => set({ url: event.target.value })} placeholder="https://…" />
        </Field>
      )}
      <Field label="Activation">
        <ChipSelect
          block
          ariaLabel="Activation"
          value={draft.activation}
          onChange={value => set({ activation: value as 'onDemand' | 'startup' })}
          options={[
            { value: 'onDemand', label: 'On demand', description: 'Starts when a session first needs it' },
            { value: 'startup', label: 'At startup', description: 'Starts with Praxis' }
          ]}
        />
      </Field>
      <label className="form-check">
        <input type="checkbox" checked={draft.scaffold} onChange={event => set({ scaffold: event.target.checked })} />
        Also write a labelled starter implementation
      </label>
    </Shell>
  );
}

export function CreateSkillDialog({
  defaultScope,
  existingNames,
  onClose,
  onCreated
}: {
  defaultScope: CatalogScope;
  existingNames: string[];
  onClose: () => void;
  onCreated: (snapshot: AgentRuntimeSnapshot) => void;
}) {
  const [draft, setDraft] = useState<SkillDraft>({
    scope: defaultScope,
    name: '',
    description: '',
    version: '',
    triggers: '',
    instructions: '',
    includeScripts: false,
    includeReferences: false,
    includeExamples: false
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = (patch: Partial<SkillDraft>) => setDraft(current => ({ ...current, ...patch }));
  const errors = useMemo(() => skillDraftErrors(draft, existingNames), [draft, existingNames]);

  const submit = () => {
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(undefined);
    void window.praxis.agentRuntime
      .createSkill({
        scope: draft.scope,
        name: draft.name.trim(),
        description: draft.description.trim(),
        ...(draft.version.trim() ? { version: draft.version.trim() } : {}),
        ...(draft.triggers.trim() ? { triggers: draft.triggers.split(',').map(t => t.trim()).filter(Boolean) } : {}),
        ...(draft.instructions.trim() ? { instructions: draft.instructions } : {}),
        includeScripts: draft.includeScripts,
        includeReferences: draft.includeReferences,
        includeExamples: draft.includeExamples
      })
      .then(onCreated)
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <Shell
      title="New skill"
      onClose={onClose}
      busy={busy}
      error={error}
      canSubmit={Object.keys(errors).length === 0}
      submitLabel="Create skill"
      onSubmit={submit}
    >
      <ScopeField value={draft.scope} onChange={scope => set({ scope })} />
      <Field label="Name" error={errors.name}>
        <input value={draft.name} onChange={event => set({ name: event.target.value })} placeholder="code-audit" />
      </Field>
      <Field label="Description" error={errors.description}>
        <input
          value={draft.description}
          onChange={event => set({ description: event.target.value })}
          placeholder="Audits a diff for risky changes."
        />
      </Field>
      <Field label="Version (optional)">
        <input value={draft.version} onChange={event => set({ version: event.target.value })} placeholder="1.0.0" />
      </Field>
      <Field label="Triggers (comma-separated, optional)">
        <input value={draft.triggers} onChange={event => set({ triggers: event.target.value })} placeholder="review, audit" />
      </Field>
      <Field label="Instructions (optional)">
        <textarea
          rows={3}
          value={draft.instructions}
          onChange={event => set({ instructions: event.target.value })}
          placeholder="Markdown body for SKILL.md"
        />
      </Field>
      <fieldset className="form-fieldset">
        <legend>Package folders</legend>
        <label className="form-check">
          <input type="checkbox" checked={draft.includeScripts} onChange={event => set({ includeScripts: event.target.checked })} />
          scripts/
        </label>
        <label className="form-check">
          <input
            type="checkbox"
            checked={draft.includeReferences}
            onChange={event => set({ includeReferences: event.target.checked })}
          />
          references/
        </label>
        <label className="form-check">
          <input type="checkbox" checked={draft.includeExamples} onChange={event => set({ includeExamples: event.target.checked })} />
          examples/
        </label>
      </fieldset>
    </Shell>
  );
}

export function ImportDialog({
  defaultScope,
  allowedKinds = ['agent', 'profile', 'skill'],
  onClose,
  onImported
}: {
  defaultScope: CatalogScope;
  /** Restricts which kind of folder this dialog accepts — the primary Agent Hub
   * only offers profile/skill; launch-binding import is Settings-only. */
  allowedKinds?: Array<'agent' | 'profile' | 'skill'>;
  onClose: () => void;
  onImported: (snapshot: AgentRuntimeSnapshot) => void;
}) {
  const [scope, setScope] = useState<CatalogScope>(defaultScope);
  const [kind, setKind] = useState<'agent' | 'profile' | 'skill'>(allowedKinds[0] ?? 'profile');
  const [sourceDir, setSourceDir] = useState<string>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [onDuplicate, setOnDuplicate] = useState<'block' | 'rename'>('block');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const kindLabels: Record<'agent' | 'profile' | 'skill', string> = {
    agent: 'launch binding',
    profile: 'agent profile',
    skill: 'skill'
  };
  const kindsDescription = allowedKinds.map(item => kindLabels[item]).join(', ').replace(/, ([^,]*)$/, ' or $1');

  const choose = async () => {
    const folder = await window.praxis.dialog.pickFolder(`Choose the ${kindsDescription} folder to import`);
    if (!folder) return;
    setSourceDir(folder);
    setError(undefined);
    setBusy(true);
    try {
      setPreview(await window.praxis.agentRuntime.previewImport(kind, folder, scope));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const rePreview = (nextKind: 'agent' | 'profile' | 'skill', nextScope: CatalogScope) => {
    setKind(nextKind);
    setScope(nextScope);
    if (!sourceDir) return;
    setBusy(true);
    void window.praxis.agentRuntime
      .previewImport(nextKind, sourceDir, nextScope)
      .then(setPreview)
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const submit = () => {
    if (!sourceDir || !preview || preview.errors.length > 0) return;
    setBusy(true);
    setError(undefined);
    void window.praxis.agentRuntime
      .importItem(kind, sourceDir, scope, onDuplicate)
      .then(onImported)
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const blocked = !preview || preview.errors.length > 0 || (preview.duplicate && onDuplicate === 'block');

  return (
    <Shell
      title={`Import ${kindsDescription}`}
      onClose={onClose}
      busy={busy}
      error={error}
      canSubmit={!!sourceDir && !blocked}
      submitLabel="Import"
      onSubmit={submit}
    >
      <fieldset className="form-fieldset">
        <legend>Kind</legend>
        {allowedKinds.includes('agent') && (
          <label className="form-check">
            <input type="radio" name="kind" checked={kind === 'agent'} onChange={() => rePreview('agent', scope)} />
            Launch binding folder (contains <code>agent.json</code>)
          </label>
        )}
        {allowedKinds.includes('profile') && (
          <label className="form-check">
            <input type="radio" name="kind" checked={kind === 'profile'} onChange={() => rePreview('profile', scope)} />
            Agent profile folder (contains <code>AGENT.md</code>)
          </label>
        )}
        {allowedKinds.includes('skill') && (
          <label className="form-check">
            <input type="radio" name="kind" checked={kind === 'skill'} onChange={() => rePreview('skill', scope)} />
            Skill folder (contains <code>SKILL.md</code>)
          </label>
        )}
      </fieldset>
      <ScopeField value={scope} onChange={next => rePreview(kind, next)} />
      <div className="agent-import-source">
        <span className="agent-detail-path" title={sourceDir}>
          {sourceDir ?? 'No folder chosen'}
        </span>
        <button type="button" className="btn btn-compact" onClick={() => void choose()}>
          <Icon name="folder-open" size={13} /> Choose folder
        </button>
      </div>

      {preview && (
        <div className={`agent-import-preview${preview.errors.length > 0 ? ' is-invalid' : ''}`} role="status">
          <strong>{preview.name || '(unnamed)'}</strong>
          {preview.errors.length > 0 ? (
            <ul className="issues">
              {preview.errors.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          ) : preview.duplicate ? (
            <>
              <p className="hint is-warn">A {kind} named "{preview.name}" already exists in this scope.</p>
              <label className="form-check">
                <input type="radio" name="dup" checked={onDuplicate === 'block'} onChange={() => setOnDuplicate('block')} />
                Cancel — don't import
              </label>
              <label className="form-check">
                <input type="radio" name="dup" checked={onDuplicate === 'rename'} onChange={() => setOnDuplicate('rename')} />
                Import under a new name
              </label>
            </>
          ) : (
            <p className="hint">Valid — nothing runs during import.</p>
          )}
        </div>
      )}
    </Shell>
  );
}


export function CreateAgentProfileDialog({
  defaultScope,
  existingIds,
  onClose,
  onCreated
}: {
  defaultScope: CatalogScope;
  existingIds: string[];
  onClose: () => void;
  onCreated: (snapshot: AgentRuntimeSnapshot) => void;
}) {
  const [draft, setDraft] = useState<NewAgentProfileInput>({
    scope: defaultScope,
    id: '',
    name: '',
    instructions: ''
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const idError = draft.id && !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(draft.id)
    ? 'Use 2–64 lowercase letters, digits or dashes.'
    : existingIds.includes(draft.id)
      ? 'That profile id already exists.'
      : undefined;
  const canSubmit = !!draft.id && !!draft.name.trim() && !!draft.instructions.trim() && !idError;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onCreated(await window.praxis.agentRuntime.createProfile(draft));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <Shell title="New agent profile" onClose={onClose} busy={busy} error={error} canSubmit={canSubmit} submitLabel="Create profile" onSubmit={() => void submit()}>
      <ScopeField value={draft.scope} onChange={scope => setDraft(current => ({ ...current, scope }))} />
      <Field label="Profile ID" error={idError}>
        <input value={draft.id} placeholder="praxis-implementer" onChange={event => setDraft(current => ({ ...current, id: event.target.value }))} />
      </Field>
      <Field label="Display name">
        <input value={draft.name} placeholder="Praxis Implementer" onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} />
      </Field>
      <Field label="Description">
        <input value={draft.description ?? ''} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} />
      </Field>
      <Field label="Preferred skills (comma-separated)">
        <input
          value={(draft.preferredSkills ?? []).join(', ')}
          onChange={event => setDraft(current => ({ ...current, preferredSkills: event.target.value.split(',').map(value => value.trim()).filter(Boolean) }))}
        />
      </Field>
      <Field label="Agent instructions">
        <textarea rows={10} value={draft.instructions} onChange={event => setDraft(current => ({ ...current, instructions: event.target.value }))} />
      </Field>
      <p className="hint">Creates a provider-neutral AGENT.md profile. Launch bindings for custom agents are configured separately.</p>
    </Shell>
  );
}
