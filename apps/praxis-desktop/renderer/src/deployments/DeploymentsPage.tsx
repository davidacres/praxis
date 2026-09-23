import { useEffect, useState } from 'react';
import type {
  CredentialBindingStatus,
  DeploymentProfile,
  DeploymentProfileIssue,
  DeploymentRun,
  ExecutorRef,
  ProjectRecord,
  PublishedArtifact,
  PublishManifest,
  RunReadinessProbe,
  TargetRef
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { FieldRow } from '../ui/formControls';
import {
  emptyDeploymentProfile,
  newDirectProcessExecutor,
  newDirectoryTarget,
  newGitHubActionsExecutor,
  newGitLabCiExecutor,
  newIisTarget,
  newLocalProcessTarget,
  setExecutor,
  setTarget,
  slugify,
  uniqueId,
  updateProfile
} from './deploymentEdits';
import { ChipSelect } from '../ui/ChipSelect';

/**
 * Deployment profile selection and review (FX-BE-059 / FX-BE-060 / TASK-159).
 *
 * A project can hold several deployment profiles (one per environment, or
 * per target) — a rail on the left picks one, the editor on the right edits
 * it. Executor and target are deliberately two separate selectors (this
 * task's own "render executor and target as separate selectors" acceptance
 * line): choosing an executor never implies or resets a target, and vice
 * versa, because the two vary independently — a `direct-process` executor
 * can ship to either a `local-process` or a `directory` target.
 *
 * Neither this component nor `deploymentEdits.ts` ever reads a project's
 * issue-tracker connection: there is nothing here that could rewrite the
 * deployment target when the tracker changes, because nothing here is
 * wired to the tracker at all.
 */

const EXECUTOR_KINDS: Array<{ kind: ExecutorRef['kind']; label: string; supported: boolean }> = [
  { kind: 'direct-process', label: 'Direct process (script)', supported: true },
  { kind: 'github-actions', label: 'GitHub Actions', supported: false },
  { kind: 'gitlab-ci', label: 'GitLab CI', supported: false }
];

const TARGET_KINDS: Array<{ kind: TargetRef['kind']; label: string; supported: boolean }> = [
  { kind: 'local-process', label: 'Local process', supported: true },
  { kind: 'directory', label: 'Directory (web root)', supported: true },
  { kind: 'iis', label: 'IIS site', supported: false }
];

const PROBE_KINDS: Array<{ kind: RunReadinessProbe['kind']; label: string }> = [
  { kind: 'http', label: 'HTTP' },
  { kind: 'tcp', label: 'TCP' },
  { kind: 'log-line', label: 'Log line' }
];

function issuesFor(issues: DeploymentProfileIssue[], prefix: string): DeploymentProfileIssue[] {
  return issues.filter(issue => issue.path === prefix || issue.path.startsWith(`${prefix}.`));
}

export interface DeploymentsPageProps {
  project: ProjectRecord;
}

export function DeploymentsPage({ project }: DeploymentsPageProps) {
  const [profiles, setProfiles] = useState<DeploymentProfile[] | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [draft, setDraft] = useState<DeploymentProfile | undefined>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [validation, setValidation] = useState<{ valid: boolean; errors: DeploymentProfileIssue[] } | undefined>();
  const [preflight, setPreflight] = useState<DeploymentProfileIssue[]>([]);
  const [credentials, setCredentials] = useState<{ statuses: CredentialBindingStatus[]; allBound: boolean } | undefined>();

  const load = () => {
    void window.praxis.deployments.listProfiles(project.id).then(list => {
      setProfiles(list);
      setSelectedId(current => current ?? list[0]?.id);
    });
  };

  useEffect(() => {
    setProfiles(undefined);
    setSelectedId(undefined);
    setDraft(undefined);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(() => {
    if (!selectedId) {
      setDraft(undefined);
      return;
    }
    const existing = profiles?.find(p => p.id === selectedId);
    setDraft(existing);
    setDirty(false);
  }, [selectedId, profiles]);

  // Live validation and capability preflight run over IPC, debounced — the
  // renderer cannot call core's validators directly (types-only rule).
  useEffect(() => {
    if (!draft) {
      setValidation(undefined);
      setPreflight([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      void window.praxis.deployments.validateProfile(draft).then(result => {
        if (!cancelled) setValidation(result);
      });
      void window.praxis.deployments.preflightCapabilities(draft).then(issues => {
        if (!cancelled) setPreflight(issues);
      });
      void window.praxis.deployments.evaluateCredentials(draft).then(result => {
        if (!cancelled) setCredentials(result);
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [draft]);

  const mutate = (next: DeploymentProfile) => {
    setDraft(next);
    setDirty(true);
  };

  const createProfile = () => {
    const taken = new Set((profiles ?? []).map(p => p.id));
    const id = uniqueId(slugify('profile'), taken);
    const fresh = emptyDeploymentProfile({ id, projectId: project.id, name: 'New profile' });
    setProfiles(current => [...(current ?? []), fresh]);
    setSelectedId(id);
    setDraft(fresh);
    setDirty(true);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(undefined);
    try {
      const saved = await window.praxis.deployments.saveProfile(project.id, draft);
      setDraft(saved);
      setDirty(false);
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  if (!profiles) {
    return (
      <div className="empty-state">
        <Icon name="rocket" size={28} />
        <span>Loading deployment profiles…</span>
      </div>
    );
  }

  return (
    // Reuses the workflow designer's three-column grid (rail + main + aux) —
    // shared layout infrastructure, not workflow-specific despite the class
    // prefix (`.rail`/`.inspector` are shared across features the same way).
    <div className="view-scroll wf-page">
      <div className="wf-designer">
        <nav className="rail" aria-label="Deployment profiles">
          <div className="rail-head">
            <strong>Profiles</strong>
            <button type="button" className="btn btn-compact" aria-label="New deployment profile" onClick={createProfile}>
              <Icon name="plus" size={13} />
            </button>
          </div>
          <ul className="rail-list">
            {profiles.map(p => (
              <li key={p.id}>
                <button
                  type="button"
                  className="rail-row"
                  aria-pressed={p.id === selectedId}
                  onClick={() => setSelectedId(p.id)}
                >
                  <span className="rail-main">
                    <span className="rail-name">{p.name || p.id}</span>
                    <span className="rail-sub">{p.environment || 'no environment set'}</span>
                  </span>
                </button>
              </li>
            ))}
            {profiles.length === 0 && <li className="rail-empty">No deployment profiles yet.</li>}
          </ul>
        </nav>

        <section>
          {!draft ? (
            <div className="empty-state">
              <Icon name="rocket" size={28} />
              <span>Select or create a deployment profile.</span>
            </div>
          ) : (
            <DeploymentProfileForm
              profile={draft}
              validation={validation}
              preflight={preflight}
              credentials={credentials}
              onChange={mutate}
            />
          )}
        </section>

        {draft && (
          <aside className="inspector" aria-label="Save and review">
            <div className="inspector-card">
              <div className="inspector-head">
                <h2>Save</h2>
              </div>
              {error && <p className="wf-stage-error">{error}</p>}
              <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save profile'}
              </button>
              {validation && !validation.valid && (
                <ul className="issues">
                  {validation.errors.map((issue, index) => (
                    <li key={index}>{issue.message}</li>
                  ))}
                </ul>
              )}
            </div>

            <DeploymentReviewPanel profile={draft} preflight={preflight} credentials={credentials} />
            <DeploymentHistoryPanel project={project} profile={draft} allProfiles={profiles} />
          </aside>
        )}
      </div>
    </div>
  );
}

// ── Profile form ─────────────────────────────────────────────────────────

function DeploymentProfileForm({
  profile,
  validation,
  preflight,
  credentials,
  onChange
}: {
  profile: DeploymentProfile;
  validation: { valid: boolean; errors: DeploymentProfileIssue[] } | undefined;
  preflight: DeploymentProfileIssue[];
  credentials: { statuses: CredentialBindingStatus[]; allBound: boolean } | undefined;
  onChange: (next: DeploymentProfile) => void;
}) {
  const executorIssues = issuesFor(validation?.errors ?? [], 'executor');
  const targetIssues = issuesFor(validation?.errors ?? [], 'target');

  return (
    <div className="inspector-card">
      <div className="inspector-head">
        <h2>{profile.name || 'Untitled profile'}</h2>
      </div>

      <FieldRow label="Name">
        <input value={profile.name} onChange={e => onChange(updateProfile(profile, { name: e.target.value }))} />
      </FieldRow>
      <FieldRow label="Environment" description="Free text — e.g. staging, production. Not a Praxis-defined list.">
        <input value={profile.environment} onChange={e => onChange(updateProfile(profile, { environment: e.target.value }))} />
      </FieldRow>

      {/* Executor and target are two independent selectors, never coupled to each other or to any tracker connection. */}
      <FieldRow label="Executor">
        <ChipSelect
          ariaLabel="Executor"
          value={profile.executor.kind}
          onChange={value => {
            const kind = value as ExecutorRef['kind'];
            const executor =
              kind === 'direct-process'
                ? newDirectProcessExecutor()
                : kind === 'github-actions'
                  ? newGitHubActionsExecutor()
                  : newGitLabCiExecutor();
            onChange(setExecutor(profile, executor));
          }}
          options={EXECUTOR_KINDS.map(candidate => ({
            value: candidate.kind,
            label: candidate.label,
            meta: candidate.supported ? undefined : 'not yet implemented'
          }))}
        />
      </FieldRow>
      {profile.executor.kind === 'github-actions' && (
        <FieldRow label="Workflow file">
          <input
            value={profile.executor.workflowFile}
            onChange={e => onChange(setExecutor(profile, { kind: 'github-actions', workflowFile: e.target.value }))}
          />
        </FieldRow>
      )}
      {profile.executor.kind === 'gitlab-ci' && (
        <FieldRow label="Pipeline file">
          <input
            value={profile.executor.pipelineFile}
            onChange={e => onChange(setExecutor(profile, { kind: 'gitlab-ci', pipelineFile: e.target.value }))}
          />
        </FieldRow>
      )}
      {executorIssues.length > 0 && (
        <ul className="issues">
          {executorIssues.map((issue, index) => (
            <li key={index}>{issue.message}</li>
          ))}
        </ul>
      )}

      <FieldRow label="Target">
        <ChipSelect
          ariaLabel="Target"
          value={profile.target.kind}
          onChange={value => {
            const kind = value as TargetRef['kind'];
            const target = kind === 'local-process' ? newLocalProcessTarget() : kind === 'directory' ? newDirectoryTarget() : newIisTarget();
            onChange(setTarget(profile, target));
          }}
          options={TARGET_KINDS.map(candidate => ({
            value: candidate.kind,
            label: candidate.label,
            meta: candidate.supported ? undefined : 'not yet implemented'
          }))}
        />
      </FieldRow>
      {profile.target.kind === 'local-process' && (
        <LocalProcessTargetFields target={profile.target} onChange={target => onChange(setTarget(profile, target))} />
      )}
      {profile.target.kind === 'directory' && (
        <FieldRow label="Path" description="The persistent web root this profile updates in place.">
          <input value={profile.target.path} onChange={e => onChange(setTarget(profile, { kind: 'directory', path: e.target.value }))} />
        </FieldRow>
      )}
      {profile.target.kind === 'iis' && (
        <IisTargetFields target={profile.target} onChange={target => onChange(setTarget(profile, target))} />
      )}
      {targetIssues.length > 0 && (
        <ul className="issues">
          {targetIssues.map((issue, index) => (
            <li key={index}>{issue.message}</li>
          ))}
        </ul>
      )}

      <HealthCheckFields profile={profile} onChange={onChange} />

      <FieldRow label="Rollback policy">
        <ChipSelect
          ariaLabel="Rollback policy"
          value={profile.rollback.kind}
          onChange={value =>
            onChange(
              updateProfile(profile, {
                rollback: value === 'keep-previous-artifact' ? { kind: 'keep-previous-artifact', retainCount: 1 } : { kind: 'none' }
              })
            )
          }
          options={[
            { value: 'none', label: 'None' },
            { value: 'keep-previous-artifact', label: 'Keep previous artifact' }
          ]}
        />
      </FieldRow>

      <CredentialsFields profile={profile} credentials={credentials} onChange={onChange} />
    </div>
  );
}

/**
 * A narrowed-by-prop-type field group, rather than reading `profile.target`
 * inside the `onChange` closures directly — TypeScript's discriminant
 * narrowing on `profile.target.kind === 'local-process'` does not survive
 * into a nested arrow function, so a fresh, genuinely narrowed `target`
 * prop is what makes spreading it (`{ ...target, executable: … }`) type-safe.
 */
function LocalProcessTargetFields({
  target,
  onChange
}: {
  target: Extract<TargetRef, { kind: 'local-process' }>;
  onChange: (next: Extract<TargetRef, { kind: 'local-process' }>) => void;
}) {
  return (
    <>
      <FieldRow label="Executable">
        <input
          value={target.executable}
          placeholder="/path/to/deploy.sh"
          onChange={e => onChange({ ...target, executable: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="Arguments (space-separated)">
        <input
          value={(target.args ?? []).join(' ')}
          onChange={e => onChange({ ...target, args: e.target.value.split(/\s+/).filter(Boolean) })}
        />
      </FieldRow>
      <FieldRow label="Working directory" description="Repo-relative; resolved against the project's own workspace folder at deploy time.">
        <input value={target.cwd ?? ''} onChange={e => onChange({ ...target, cwd: e.target.value || undefined })} />
      </FieldRow>
    </>
  );
}

function IisTargetFields({
  target,
  onChange
}: {
  target: Extract<TargetRef, { kind: 'iis' }>;
  onChange: (next: Extract<TargetRef, { kind: 'iis' }>) => void;
}) {
  return (
    <>
      <FieldRow label="Site name">
        <input value={target.siteName} onChange={e => onChange({ ...target, siteName: e.target.value })} />
      </FieldRow>
      <p className="hint">IIS targets are schema-valid but not yet implemented — Windows-only, tracked separately.</p>
    </>
  );
}

function HealthCheckFields({ profile, onChange }: { profile: DeploymentProfile; onChange: (next: DeploymentProfile) => void }) {
  return (
    <fieldset className="form-fieldset">
      <legend>Post-install health check</legend>
      <FieldRow label="Kind">
        <ChipSelect
          ariaLabel="Health check kind"
          value={profile.healthCheck?.kind ?? ''}
          onChange={kind => {
            if (!kind) {
              onChange(updateProfile(profile, { healthCheck: undefined }));
              return;
            }
            const healthCheck: RunReadinessProbe =
              kind === 'http' ? { kind: 'http', path: '/' } : kind === 'tcp' ? { kind: 'tcp', port: 0 } : { kind: 'log-line', match: '' };
            onChange(updateProfile(profile, { healthCheck }));
          }}
          options={[{ value: '', label: 'none' }, ...PROBE_KINDS.map(candidate => ({ value: candidate.kind, label: candidate.label }))]}
        />
      </FieldRow>
      {profile.healthCheck?.kind === 'http' && (
        <FieldRow label="Path">
          <input
            value={profile.healthCheck.path}
            onChange={e => onChange(updateProfile(profile, { healthCheck: { kind: 'http', path: e.target.value } }))}
          />
        </FieldRow>
      )}
      {profile.healthCheck?.kind === 'tcp' && (
        <FieldRow label="Port">
          <input
            type="number"
            value={profile.healthCheck.port}
            onChange={e => onChange(updateProfile(profile, { healthCheck: { kind: 'tcp', port: Number(e.target.value) } }))}
          />
        </FieldRow>
      )}
      {profile.healthCheck?.kind === 'log-line' && (
        <p className="hint">A log-line check is not supported for a directory or local-process target's health verification — it is accepted here for schema parity with a Run profile's probe, but a deploy will refuse it.</p>
      )}
    </fieldset>
  );
}

function CredentialsFields({
  profile,
  credentials,
  onChange
}: {
  profile: DeploymentProfile;
  credentials: { statuses: CredentialBindingStatus[]; allBound: boolean } | undefined;
  onChange: (next: DeploymentProfile) => void;
}) {
  const entries = Object.entries(profile.credentials ?? {});

  const addCredential = () => {
    const key = uniqueId('CREDENTIAL', new Set(entries.map(([k]) => k)));
    onChange(updateProfile(profile, { credentials: { ...(profile.credentials ?? {}), [key]: '${secret:}' } }));
  };

  const updateEntry = (key: string, value: string) => {
    onChange(updateProfile(profile, { credentials: { ...(profile.credentials ?? {}), [key]: value } }));
  };

  const removeEntry = (key: string) => {
    const next = { ...(profile.credentials ?? {}) };
    delete next[key];
    onChange(updateProfile(profile, { credentials: next }));
  };

  return (
    <fieldset className="form-fieldset">
      <legend>Credentials</legend>
      <p className="hint">
        Names only — a secret-shaped key must hold a <code>${'{secret:NAME}'}</code> reference resolved from the local
        secret store at deploy time, never a literal value. A credential the local machine has not bound is shown
        as missing; deploying elsewhere requires binding it again there — bindings are machine-local by design.
      </p>
      {entries.map(([key, value]) => {
        const status = credentials?.statuses.find(candidate => candidate.key === key);
        return (
          <div key={key} className="form-check" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={key}
              aria-label="Credential name"
              onChange={e => {
                const next = { ...(profile.credentials ?? {}) };
                delete next[key];
                next[e.target.value] = value;
                onChange(updateProfile(profile, { credentials: next }));
              }}
            />
            <input value={value} aria-label="Credential reference" onChange={e => updateEntry(key, e.target.value)} />
            {status && (
              <span className={`chip ${status.bound ? 'chip-success' : 'chip-warn'}`}>{status.bound ? 'bound' : 'missing'}</span>
            )}
            <button type="button" className="btn btn-compact" onClick={() => removeEntry(key)}>
              Remove
            </button>
          </div>
        );
      })}
      <button type="button" className="btn btn-compact" onClick={addCredential}>
        Add credential
      </button>
    </fieldset>
  );
}

// ── Review panel ─────────────────────────────────────────────────────────

/**
 * "Review artifact, environment, changes and checks before execution" —
 * this task's own review surface. An artifact reference is not yet
 * available here (publishing one is FX-BE-060's own later task,
 * TASK-160's "history and promotion"), so this panel shows what it can
 * today: environment, target summary, and both validity checks — leaving
 * an explicit placeholder rather than fabricating artifact/change data
 * that does not exist yet.
 */
function DeploymentReviewPanel({
  profile,
  preflight,
  credentials
}: {
  profile: DeploymentProfile;
  preflight: DeploymentProfileIssue[];
  credentials: { statuses: CredentialBindingStatus[]; allBound: boolean } | undefined;
}) {
  return (
    <div className="inspector-card">
      <div className="inspector-head">
        <h2>Review</h2>
      </div>
      <p>
        <span className="rail-sub">environment</span> {profile.environment || 'not set'}
      </p>
      <p>
        <span className="rail-sub">target</span> {profile.target.kind}
        {profile.target.kind === 'directory' && ` — ${profile.target.path || 'no path set'}`}
        {profile.target.kind === 'local-process' && ` — ${profile.target.executable || 'no executable set'}`}
      </p>
      <p>
        <span className="rail-sub">artifact</span> not yet published — see deployment history
      </p>
      {preflight.length > 0 && (
        <>
          <p className="rail-sub">capability checks</p>
          <ul className="issues">
            {preflight.map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
        </>
      )}
      {credentials && !credentials.allBound && (
        <p className="wf-stage-error">One or more credentials are not bound on this machine.</p>
      )}
    </div>
  );
}

// ── History and promotion (FX-BE-060 / TASK-160) ───────────────────────────

/**
 * A distinct label and tone per run status — in particular, `unknown` and
 * `rolled-back` must never look alike: `unknown` means a crash left the
 * outcome unconfirmed (still needs attention), `rolled-back` means the
 * previous version was successfully restored (a settled, understood
 * outcome). Collapsing the two into one generic "not running" chip would
 * hide exactly the distinction this task's acceptance criterion names.
 */
const STATUS_CHIP: Record<DeploymentRun['status'], { label: string; tone: string }> = {
  prepared: { label: 'Prepared', tone: 'chip-muted' },
  'awaiting-approval': { label: 'Awaiting approval', tone: 'chip-warn' },
  queued: { label: 'Queued', tone: 'chip-warn' },
  deploying: { label: 'Deploying', tone: 'chip-warn' },
  verifying: { label: 'Verifying', tone: 'chip-warn' },
  succeeded: { label: 'Succeeded', tone: 'chip-success' },
  failed: { label: 'Failed', tone: 'chip-danger' },
  cancelled: { label: 'Cancelled', tone: 'chip-muted' },
  unknown: { label: 'Unknown — outcome unconfirmed', tone: 'chip-danger' },
  'rolling-back': { label: 'Rolling back', tone: 'chip-warn' },
  'rolled-back': { label: 'Rolled back', tone: 'chip-muted' }
};

function shortDigest(digest: string): string {
  return digest.length > 19 ? `${digest.slice(0, 19)}…` : digest;
}

function DeploymentHistoryPanel({
  project,
  profile,
  allProfiles
}: {
  project: ProjectRecord;
  profile: DeploymentProfile;
  allProfiles: DeploymentProfile[];
}) {
  const [runs, setRuns] = useState<DeploymentRun[]>([]);
  const [artifacts, setArtifacts] = useState<Array<{ artifact: PublishedArtifact; manifest: PublishManifest }>>([]);
  const [rootDir, setRootDir] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [promoteTarget, setPromoteTarget] = useState<Record<string, string>>({});
  const [promoting, setPromoting] = useState<string | undefined>();

  const reload = () => {
    void window.praxis.deployments.listRuns(profile.id).then(setRuns);
    void window.praxis.deployments.listArtifacts(profile.id).then(setArtifacts);
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

  const pickFolder = async () => {
    const chosen = await window.praxis.dialog.pickFolder('Choose the built output to publish');
    if (chosen) setRootDir(chosen);
  };

  const publish = async () => {
    if (!rootDir.trim()) return;
    setPublishing(true);
    setError(undefined);
    try {
      await window.praxis.deployments.publishArtifact(`artifact-${Date.now()}`, profile.id, rootDir.trim());
      setRootDir('');
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPublishing(false);
    }
  };

  /** Promotes an already-published artifact to a different profile — a fresh run, a fresh approval, a fresh dispatch, sharing only the artifact digest. */
  const promote = async (artifact: PublishedArtifact) => {
    const targetProfileId = promoteTarget[artifact.id];
    const targetProfile = allProfiles.find(p => p.id === targetProfileId);
    if (!targetProfile) return;
    setPromoting(artifact.id);
    setError(undefined);
    try {
      const runId = `run-${Date.now()}`;
      await window.praxis.deployments.prepare(project.id, runId, targetProfile, artifact);
      const approved = await window.praxis.deployments.approve(project.id, runId, targetProfile, artifact, 'you');
      if (!approved.ok) throw new Error(approved.reason ?? 'Approval failed.');
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPromoting(undefined);
    }
  };

  const otherProfiles = allProfiles.filter(p => p.id !== profile.id);

  return (
    <div className="inspector-card">
      <div className="inspector-head">
        <h2>History</h2>
      </div>
      {error && <p className="wf-stage-error">{error}</p>}

      <fieldset className="form-fieldset">
        <legend>Publish an artifact</legend>
        <FieldRow label="Built output folder">
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={rootDir} onChange={e => setRootDir(e.target.value)} placeholder="/path/to/dist" />
            <button type="button" className="btn btn-compact" onClick={() => void pickFolder()}>
              Choose…
            </button>
          </div>
        </FieldRow>
        <button type="button" className="btn btn-compact" disabled={!rootDir.trim() || publishing} onClick={() => void publish()}>
          {publishing ? 'Publishing…' : 'Publish artifact'}
        </button>
      </fieldset>

      {artifacts.length > 0 && (
        <fieldset className="form-fieldset">
          <legend>Artifacts published under this profile</legend>
          {artifacts.map(({ artifact }) => (
            <div key={artifact.id} className="rail-sub" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <code>{shortDigest(artifact.digest)}</code>
              {otherProfiles.length > 0 && (
                <>
                  <ChipSelect
                    ariaLabel="Promote to profile"
                    value={promoteTarget[artifact.id] ?? ''}
                    onChange={value => setPromoteTarget(current => ({ ...current, [artifact.id]: value }))}
                    options={[
                      { value: '', label: 'promote to…' },
                      ...otherProfiles.map(p => ({ value: p.id, label: p.name || p.id, meta: p.environment || 'no environment' }))
                    ]}
                  />
                  <button
                    type="button"
                    className="btn btn-compact"
                    disabled={!promoteTarget[artifact.id] || promoting === artifact.id}
                    onClick={() => void promote(artifact)}
                  >
                    {promoting === artifact.id ? 'Promoting…' : 'Promote'}
                  </button>
                </>
              )}
            </div>
          ))}
        </fieldset>
      )}

      <p className="rail-sub">runs</p>
      {runs.length === 0 && <p className="hint">No deployment runs yet for this profile.</p>}
      <ul className="issues" style={{ listStyle: 'none', padding: 0 }}>
        {runs.map(run => {
          const chip = STATUS_CHIP[run.status];
          return (
            <li key={run.runId} style={{ marginBottom: 8 }}>
              <span className={`chip ${chip.tone}`}>{chip.label}</span>{' '}
              <code>{shortDigest(run.artifactDigest)}</code>
              {run.issueKey && <span className="rail-sub"> · {run.issueKey}</span>}
              {run.workflowRunId && <span className="rail-sub"> · workflow {run.workflowRunId}</span>}
              {run.targetUrl && (
                <>
                  {' · '}
                  <a href={run.targetUrl} target="_blank" rel="noreferrer">
                    {run.targetUrl}
                  </a>
                </>
              )}
              {run.approval && (
                <div className="rail-sub">
                  approved by {run.approval.approvedBy} for {run.approval.environment}
                </div>
              )}
              {run.endedReason && <div className="rail-sub">{run.endedReason}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
