import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectRecord, WorkflowGateKind, WorkflowPolicyProfile } from '@praxis/core';
import { useDialogs } from '../ui/dialogs';

/**
 * Manages the global and project Workflow Policy Profiles that
 * `WorkflowPolicyStore` already composes strictest-wins over a run's gates —
 * until now there was no way to create one, so `allowGateBypass` stayed
 * deny-by-default and required gates/human-approval/trust rules were
 * unreachable from the app.
 */

const GATES: WorkflowGateKind[] = ['review', 'qa', 'security'];

function draftProfile(scope: 'global' | 'project', project: ProjectRecord): WorkflowPolicyProfile {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: scope === 'global' ? 'policy-global' : `policy-project-${project.id}`,
    name: scope === 'global' ? 'Global policy' : `${project.name} policy`,
    scope,
    ...(scope === 'project' ? { projectId: project.id } : {}),
    requiredGates: [],
    requireHumanApproval: false,
    allowGateBypass: false,
    requireTrustedAgents: false,
    maxAttemptsPerNode: 3,
    createdAt: now,
    updatedAt: now
  };
}

export function WorkflowPolicyPage({ project }: { project: ProjectRecord }) {
  const { confirm } = useDialogs();
  const [profiles, setProfiles] = useState<WorkflowPolicyProfile[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [savingScope, setSavingScope] = useState<'global' | 'project' | undefined>(undefined);

  const reload = useCallback(() => {
    void window.praxis.workflows.listPolicies().then(setProfiles, err => setError(String(err?.message ?? err)));
  }, []);

  useEffect(reload, [reload]);

  const global = useMemo(
    () => profiles?.find(profile => profile.scope === 'global') ?? draftProfile('global', project),
    [profiles, project]
  );
  const projectPolicy = useMemo(
    () =>
      profiles?.find(profile => profile.scope === 'project' && profile.projectId === project.id) ??
      draftProfile('project', project),
    [profiles, project]
  );

  const save = useCallback(
    async (scope: 'global' | 'project', next: WorkflowPolicyProfile) => {
      setSavingScope(scope);
      setError(undefined);
      try {
        await window.praxis.workflows.savePolicy(next);
        reload();
      } catch (err) {
        setError(String((err as Error)?.message ?? err));
      } finally {
        setSavingScope(undefined);
      }
    },
    [reload]
  );

  const remove = useCallback(
    async (profile: WorkflowPolicyProfile) => {
      if (!(await confirm({ title: 'Remove this policy?', message: 'Runs will no longer inherit its requirements.', confirmLabel: 'Remove policy', danger: true })))
        return;
      setError(undefined);
      try {
        await window.praxis.workflows.removePolicy(profile.id);
        reload();
      } catch (err) {
        setError(String((err as Error)?.message ?? err));
      }
    },
    [confirm, reload]
  );

  if (!profiles) return <div className="view-scroll wf-page" />;

  const storedGlobal = profiles.find(profile => profile.scope === 'global');
  const storedProject = profiles.find(profile => profile.scope === 'project' && profile.projectId === project.id);

  return (
    <div className="view-scroll wf-page">
      <header className="wf-header">
        <h1>Policies</h1>
        <span className="wf-header-sub">{project.name}</span>
      </header>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <PolicyForm
        title="Global policy"
        hint="Applies to every project. A project policy below can only tighten these rules, never loosen them."
        profile={global}
        stored={storedGlobal}
        saving={savingScope === 'global'}
        onSave={next => save('global', next)}
        onRemove={storedGlobal ? () => remove(storedGlobal) : undefined}
      />
      <PolicyForm
        title={`${project.name} policy`}
        hint="Composes with the global policy, strictest wins."
        profile={projectPolicy}
        stored={storedProject}
        saving={savingScope === 'project'}
        onSave={next => save('project', next)}
        onRemove={storedProject ? () => remove(storedProject) : undefined}
      />
    </div>
  );
}

function PolicyForm({
  title,
  hint,
  profile,
  stored,
  saving,
  onSave,
  onRemove
}: {
  title: string;
  hint: string;
  profile: WorkflowPolicyProfile;
  stored: WorkflowPolicyProfile | undefined;
  saving: boolean;
  onSave: (next: WorkflowPolicyProfile) => void;
  onRemove?: () => void;
}) {
  const [draft, setDraft] = useState(profile);
  useEffect(() => setDraft(profile), [profile]);

  const set = (patch: Partial<WorkflowPolicyProfile>) => setDraft(current => ({ ...current, ...patch }));

  return (
    <section className="wf-policy-card">
      <h2>{title}</h2>
      <p className="hint">{hint}</p>
      <fieldset className="form-fieldset">
        <legend>Required gates</legend>
        {GATES.map(gate => (
          <label key={gate} className="form-check">
            <input
              type="checkbox"
              checked={draft.requiredGates.includes(gate)}
              onChange={event =>
                set({
                  requiredGates: event.target.checked
                    ? [...draft.requiredGates, gate]
                    : draft.requiredGates.filter(g => g !== gate)
                })
              }
            />
            {gate}
          </label>
        ))}
      </fieldset>
      <label className="form-check">
        <input
          type="checkbox"
          checked={draft.requireHumanApproval}
          onChange={event => set({ requireHumanApproval: event.target.checked })}
        />
        Require a human approval stage
      </label>
      <label className="form-check">
        <input
          type="checkbox"
          checked={draft.allowGateBypass}
          onChange={event => set({ allowGateBypass: event.target.checked })}
        />
        Allow an attributed gate bypass
      </label>
      <label className="form-check">
        <input
          type="checkbox"
          checked={draft.requireTrustedAgents}
          onChange={event => set({ requireTrustedAgents: event.target.checked })}
        />
        Require trusted agents (untrusted or invalid agents fail preflight)
      </label>
      <div className="form-field">
        <label className="form-field-label">
          <span className="form-field-label-row">
            <span>Max attempts per node</span>
          </span>
          <input
            type="number"
            min={1}
            value={draft.maxAttemptsPerNode}
            onChange={event => set({ maxAttemptsPerNode: Math.max(1, Number(event.target.value) || 1) })}
          />
        </label>
      </div>
      <div className="wf-policy-actions">
        <button type="button" className="btn btn-primary" disabled={saving} onClick={() => onSave(draft)}>
          {saving ? 'Saving…' : stored ? 'Save changes' : 'Create policy'}
        </button>
        {onRemove && (
          <button type="button" className="btn btn-danger" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
    </section>
  );
}
