import { useEffect, useState } from 'react';
import type {
  ProjectRecord,
  ProposedRunService,
  RunProfile,
  RunProfileIssue,
  RunProfileValidationResult,
  RunReadinessProbe,
  RunServiceDefinition
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { FieldRow } from '../ui/formControls';

/**
 * Project Run profile editor (FX-BE-054 / TASK-143).
 *
 * One `run.praxis.json` per project — loaded/saved through
 * `window.praxis.projects.{getRunProfile,saveRunProfile}` (TASK-143's IPC
 * layer over TASK-141's storage). The renderer never imports `@praxis/core`
 * values at runtime (AGENTS.md — it would pull chokidar and other Node-only
 * code into the browser bundle), so validation runs over IPC, debounced,
 * the same way `WorkflowDesignerPage` validates a workflow definition;
 * `saveRunProfile` re-validates independently before it writes, so the
 * live feedback here is a convenience, not the enforcement point.
 */

export interface RunProfileEditorProps {
  project: ProjectRecord;
}

type DiscoveredService = ProposedRunService & { relativeDir: string };

/** Mirrors `RUN_PROFILE_SCHEMA_VERSION` from `packages/core/src/projects/runProfile.ts` — kept
 *  a plain constant here rather than a value import, per the renderer's types-only core rule. */
const RUN_PROFILE_SCHEMA_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function emptyProfile(): RunProfile {
  const at = nowIso();
  return { schemaVersion: RUN_PROFILE_SCHEMA_VERSION, id: 'default', name: 'Default run', services: [], createdAt: at, updatedAt: at };
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'service';
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function newService(id: string): RunServiceDefinition {
  return { id, name: id, executable: '' };
}

function fromDiscovered(discovered: DiscoveredService, taken: ReadonlySet<string>): RunServiceDefinition {
  const base = slugify(discovered.relativeDir === '.' ? discovered.executable : discovered.relativeDir);
  const id = uniqueId(base, taken);
  return {
    id,
    name: discovered.relativeDir === '.' ? id : discovered.relativeDir,
    executable: discovered.executable,
    args: discovered.args,
    ...(discovered.relativeDir !== '.' ? { cwd: discovered.relativeDir } : {}),
    ...(discovered.port ? { port: discovered.port } : {})
  };
}

const PROBE_KINDS: Array<{ kind: RunReadinessProbe['kind']; label: string }> = [
  { kind: 'http', label: 'HTTP' },
  { kind: 'tcp', label: 'TCP' },
  { kind: 'log-line', label: 'Log line' }
];

function issuesFor(issues: RunProfileIssue[], prefix: string): RunProfileIssue[] {
  return issues.filter(issue => issue.path === prefix || issue.path.startsWith(`${prefix}.`));
}

export function RunProfileEditor({ project }: RunProfileEditorProps) {
  const [profile, setProfile] = useState<RunProfile | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadIssues, setLoadIssues] = useState<RunProfileIssue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const [discovered, setDiscovered] = useState<DiscoveredService[] | undefined>();
  const [discovering, setDiscovering] = useState(false);
  const [selectedDiscovered, setSelectedDiscovered] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProfile(undefined);
    setLoadIssues([]);
    setDirty(false);
    setError(undefined);
    setDiscovered(undefined);
    void window.praxis.projects.getRunProfile(project.id).then(result => {
      if (cancelled) return;
      setProfile(result.profile);
      setLoadIssues(result.issues);
      setSavedAt(result.profile?.updatedAt);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Validation runs in core over IPC, debounced — see the module comment on
  // why the renderer can't call `validateRunProfile` directly.
  const [validation, setValidation] = useState<RunProfileValidationResult | undefined>();
  useEffect(() => {
    if (!profile) {
      setValidation(undefined);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      void window.praxis.projects.validateRunProfile(profile).then(result => {
        if (!cancelled) setValidation(result);
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [profile]);

  const mutate = (next: RunProfile) => {
    setProfile(next);
    setDirty(true);
  };

  const updateService = (index: number, patch: Partial<RunServiceDefinition>) => {
    if (!profile) return;
    const services = profile.services.map((service, i) => (i === index ? { ...service, ...patch } : service));
    mutate({ ...profile, services });
  };

  const removeService = (index: number) => {
    if (!profile) return;
    mutate({ ...profile, services: profile.services.filter((_, i) => i !== index) });
  };

  const addService = () => {
    const base = profile ?? emptyProfile();
    const id = uniqueId('service', new Set(base.services.map(s => s.id)));
    mutate({ ...base, services: [...base.services, newService(id)] });
  };

  const save = async () => {
    if (!profile) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = { ...profile, updatedAt: nowIso() };
      await window.praxis.projects.saveRunProfile(project.id, next);
      setProfile(next);
      setSavedAt(next.updatedAt);
      setDirty(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const openDiscovery = async () => {
    setDiscovering(true);
    setSelectedDiscovered(new Set());
    try {
      const found = await window.praxis.projects.discoverRunServices(project.id);
      setDiscovered(found);
    } finally {
      setDiscovering(false);
    }
  };

  const importDiscovered = () => {
    if (!discovered) return;
    const base = profile ?? emptyProfile();
    const taken = new Set(base.services.map(s => s.id));
    const additions: RunServiceDefinition[] = [];
    discovered.forEach((candidate, index) => {
      if (!selectedDiscovered.has(index)) return;
      const service = fromDiscovered(candidate, taken);
      taken.add(service.id);
      additions.push(service);
    });
    mutate({ ...base, services: [...base.services, ...additions] });
    setDiscovered(undefined);
  };

  if (!project.workspaceFolder) {
    return (
      <div className="view-scroll run-page">
        <div className="empty-state" data-testid="run-no-workspace">
          <Icon name="server" size={28} />
          <span>Run needs a working folder.</span>
          <p>Set up this project&rsquo;s Git workspace first — Run profiles are stored alongside it.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="view-scroll run-page"><div className="empty-state"><Icon name="server" size={28} /><span>Loading run profile…</span></div></div>;
  }

  if (!profile) {
    return (
      <div className="view-scroll run-page">
        <div className="empty-state" data-testid="run-no-profile">
          <Icon name="server" size={28} />
          <span>No run profile yet.</span>
          <p>Define the services this project runs locally, or discover them from package.json / launchSettings.json.</p>
          {loadIssues.length > 0 && (
            <ul className="issues">{loadIssues.map((issue, i) => <li key={i}>{issue.path ? `${issue.path}: ` : ''}{issue.message}</li>)}</ul>
          )}
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="btn" type="button" onClick={() => mutate(emptyProfile())} data-testid="run-create-profile">
              <Icon name="plus" size={13} />Create run profile
            </button>
            <button className="btn" type="button" onClick={() => void openDiscovery()} disabled={discovering} data-testid="run-discover">
              <Icon name="search" size={13} />{discovering ? 'Scanning…' : 'Discover services'}
            </button>
          </div>
        </div>
        {discovered && renderDiscoveryPanel()}
      </div>
    );
  }

  function renderDiscoveryPanel() {
    return (
      <div className="run-discover-panel" data-testid="run-discover-panel">
        <div className="run-discover-header">
          <strong>Discovered services</strong>
          <button className="btn btn-icon" type="button" aria-label="Close" onClick={() => setDiscovered(undefined)}><Icon name="close" size={13} /></button>
        </div>
        {discovered!.length === 0 ? (
          <p className="placeholder-text">No package.json or launchSettings.json found in this project&rsquo;s root or immediate subdirectories.</p>
        ) : (
          <>
            {discovered!.map((candidate, index) => (
              <label className="run-discover-row" key={`${candidate.relativeDir}:${candidate.executable}`}>
                <input
                  type="checkbox"
                  checked={selectedDiscovered.has(index)}
                  onChange={e => {
                    const next = new Set(selectedDiscovered);
                    if (e.target.checked) next.add(index); else next.delete(index);
                    setSelectedDiscovered(next);
                  }}
                />
                <span className="run-discover-summary">
                  <strong>{candidate.relativeDir === '.' ? '(project root)' : candidate.relativeDir}</strong>
                  <span className="placeholder-text">{candidate.executable} {candidate.args.join(' ')}{candidate.port ? ` — port ${candidate.port}` : ''}</span>
                </span>
              </label>
            ))}
            <button className="btn btn-primary" type="button" disabled={selectedDiscovered.size === 0} onClick={importDiscovered} data-testid="run-discover-import">
              Add {selectedDiscovered.size || ''} selected
            </button>
          </>
        )}
      </div>
    );
  }

  const errors = validation && !validation.valid ? validation.errors : [];

  return (
    <div className="view-scroll run-page">
      <header className="view-header">
        <Icon name="server" size={16} />
        <h1 className="view-title">Run</h1>
        <span className="view-subtitle">{project.name}</span>
        <div style={{ flex: 1 }} />
        {savedAt && !dirty && <span className="placeholder-text" data-testid="run-saved-at">Saved</span>}
        <button className="btn" type="button" onClick={() => void openDiscovery()} disabled={discovering} data-testid="run-discover">
          <Icon name="search" size={13} />{discovering ? 'Scanning…' : 'Discover services'}
        </button>
        <button
          className="btn btn-primary"
          type="button"
          disabled={!dirty || saving || errors.length > 0}
          onClick={() => void save()}
          data-testid="run-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>
      <div className="run-body">
        {error && <div className="error-banner">{error}</div>}
        {discovered && renderDiscoveryPanel()}

        <FieldRow label="Name" description="How this run profile is labelled in Praxis.">
          <input
            className="input"
            value={profile.name}
            onChange={e => mutate({ ...profile, name: e.target.value })}
            data-testid="run-name"
          />
        </FieldRow>

        {errors.length > 0 && (
          <ul className="issues" data-testid="run-issues">
            {errors.map((issue, i) => <li key={i}>{issue.path ? `${issue.path}: ` : ''}{issue.message}</li>)}
          </ul>
        )}

        <div className="run-services">
          {profile.services.map((service, index) => {
            const serviceErrors = issuesFor(errors, `services[${index}]`);
            return (
              <div className="run-service-card" key={index} data-testid="run-service-card">
                <div className="run-service-header">
                  <Icon name="server" size={14} />
                  <strong>{service.name || service.id || 'New service'}</strong>
                  <div style={{ flex: 1 }} />
                  <button className="btn btn-icon" type="button" aria-label={`Remove ${service.name}`} onClick={() => removeService(index)} data-testid="run-service-remove">
                    <Icon name="trash" size={13} />
                  </button>
                </div>

                <FieldRow label="Id">
                  <input className="input" value={service.id} onChange={e => updateService(index, { id: e.target.value })} data-testid="run-service-id" />
                </FieldRow>
                <FieldRow label="Name">
                  <input className="input" value={service.name} onChange={e => updateService(index, { name: e.target.value })} />
                </FieldRow>
                <FieldRow label="Executable">
                  <input className="input" value={service.executable} onChange={e => updateService(index, { executable: e.target.value })} data-testid="run-service-executable" />
                </FieldRow>
                <FieldRow label="Arguments" description="One argument per line.">
                  <textarea
                    className="input"
                    rows={Math.max(2, service.args?.length ?? 0)}
                    value={(service.args ?? []).join('\n')}
                    onChange={e => updateService(index, { args: e.target.value.split('\n').filter(line => line.length > 0) })}
                  />
                </FieldRow>
                <FieldRow label="Working folder" description={'Repo-relative, e.g. "apps/api". Leave blank for the project root.'}>
                  <input
                    className="input"
                    value={service.cwd ?? ''}
                    onChange={e => updateService(index, { cwd: e.target.value.trim() ? e.target.value : undefined })}
                  />
                </FieldRow>
                <FieldRow label="Port">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={65535}
                    value={service.port ?? ''}
                    onChange={e => updateService(index, { port: e.target.value ? Number(e.target.value) : undefined })}
                  />
                </FieldRow>

                {profile.services.length > 1 && (
                  <FieldRow label="Depends on" description="Services that must be ready before this one starts.">
                    <div className="run-depends-list">
                      {profile.services
                        .filter((_, i) => i !== index)
                        .map(other => (
                          <label className="run-depends-row" key={other.id}>
                            <input
                              type="checkbox"
                              checked={(service.dependsOn ?? []).includes(other.id)}
                              onChange={e => {
                                const current = new Set(service.dependsOn ?? []);
                                if (e.target.checked) current.add(other.id); else current.delete(other.id);
                                updateService(index, { dependsOn: current.size > 0 ? [...current] : undefined });
                              }}
                            />
                            {other.name || other.id}
                          </label>
                        ))}
                    </div>
                  </FieldRow>
                )}

                <FieldRow label="Readiness probe" description="How Praxis knows this service is ready.">
                  <div className="run-probe-editor">
                    <select
                      className="select"
                      value={service.readinessProbe?.kind ?? ''}
                      onChange={e => {
                        const kind = e.target.value as RunReadinessProbe['kind'] | '';
                        if (!kind) { updateService(index, { readinessProbe: undefined }); return; }
                        if (kind === 'http') updateService(index, { readinessProbe: { kind: 'http', path: '/' } });
                        else if (kind === 'tcp') updateService(index, { readinessProbe: { kind: 'tcp', port: service.port ?? 0 } });
                        else updateService(index, { readinessProbe: { kind: 'log-line', match: '' } });
                      }}
                    >
                      <option value="">None</option>
                      {PROBE_KINDS.map(({ kind, label }) => <option key={kind} value={kind}>{label}</option>)}
                    </select>
                    {service.readinessProbe?.kind === 'http' && (
                      <input
                        className="input"
                        placeholder="/healthz"
                        value={service.readinessProbe.path}
                        onChange={e => updateService(index, { readinessProbe: { kind: 'http', path: e.target.value, expectedStatus: service.readinessProbe?.kind === 'http' ? service.readinessProbe.expectedStatus : undefined } })}
                      />
                    )}
                    {service.readinessProbe?.kind === 'tcp' && (
                      <input
                        className="input"
                        type="number"
                        min={1}
                        max={65535}
                        value={service.readinessProbe.port}
                        onChange={e => updateService(index, { readinessProbe: { kind: 'tcp', port: Number(e.target.value) } })}
                      />
                    )}
                    {service.readinessProbe?.kind === 'log-line' && (
                      <input
                        className="input"
                        placeholder="Server listening on"
                        value={service.readinessProbe.match}
                        onChange={e => updateService(index, { readinessProbe: { kind: 'log-line', match: e.target.value } })}
                      />
                    )}
                  </div>
                </FieldRow>

                <FieldRow label="Environment" description="Variable NAMES only. Secret-shaped keys must hold a ${secret:NAME} reference.">
                  <div className="run-env-list">
                    {Object.entries(service.env ?? {}).map(([key, value], envIndex) => (
                      <div className="run-env-row" key={envIndex}>
                        <input
                          className="input"
                          placeholder="NAME"
                          value={key}
                          onChange={e => {
                            const entries = Object.entries(service.env ?? {});
                            entries[envIndex] = [e.target.value, value];
                            updateService(index, { env: Object.fromEntries(entries) });
                          }}
                        />
                        <input
                          className="input"
                          placeholder="value"
                          value={value}
                          onChange={e => {
                            const entries = Object.entries(service.env ?? {});
                            entries[envIndex] = [key, e.target.value];
                            updateService(index, { env: Object.fromEntries(entries) });
                          }}
                        />
                        <button
                          className="btn btn-icon"
                          type="button"
                          aria-label={`Remove ${key || 'variable'}`}
                          onClick={() => {
                            const entries = Object.entries(service.env ?? {}).filter((_, i) => i !== envIndex);
                            updateService(index, { env: entries.length > 0 ? Object.fromEntries(entries) : undefined });
                          }}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    ))}
                    <button
                      className="btn"
                      type="button"
                      onClick={() => updateService(index, { env: { ...(service.env ?? {}), '': '' } })}
                    >
                      <Icon name="plus" size={12} />Add variable
                    </button>
                  </div>
                </FieldRow>

                {serviceErrors.length > 0 && (
                  <ul className="issues">{serviceErrors.map((issue, i) => <li key={i}>{issue.path}: {issue.message}</li>)}</ul>
                )}
              </div>
            );
          })}
        </div>

        <button className="btn" type="button" onClick={addService} data-testid="run-add-service">
          <Icon name="plus" size={13} />Add service
        </button>
      </div>
    </div>
  );
}
