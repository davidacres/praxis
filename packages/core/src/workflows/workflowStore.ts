/**
 * Workflow and policy storage with explicit precedence (FX-BE-018 / TASK-094).
 *
 * Definitions reach a project from three places, and they are allowed to
 * collide: the app ships built-in templates, the user saves global ones, and a
 * project can commit its own under `.praxis/workflows`. Project beats global
 * beats built-in.
 *
 * The rule that matters is that shadowing is **reported, never silent**. A
 * project workflow quietly overriding a global one with the same id is how a
 * team ends up running a pipeline nobody remembers writing — so resolution
 * returns what was hidden alongside what won, and the designer surfaces it.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { KeyValueStore } from '../host/stateStore';
import { migrateWorkflow, validateWorkflow, type WorkflowIssue } from './workflowValidation';
import { normalizeWorkflowRun, type WorkflowRun } from './workflowRun';
import type {
  GateThresholdCondition,
  MetricThresholdCondition,
  SeverityThresholdCondition,
  WorkflowDefinition,
  WorkflowGateKind,
  WorkflowPolicyProfile,
  WorkflowScope
} from './workflowTypes';

export type WorkflowSource = 'built-in' | 'marketplace' | 'global' | 'project';

/** Higher wins. Kept as data so the ordering is stated once, not implied. */
const PRECEDENCE: Record<WorkflowSource, number> = { 'built-in': 0, marketplace: 0.5, global: 1, project: 2 };

/** The scope a definition must declare to be legal in a given source. */
const EXPECTED_SCOPE: Record<WorkflowSource, WorkflowScope> = {
  'built-in': 'global',
  marketplace: 'global',
  global: 'global',
  project: 'project'
};

const WORKFLOWS_KEY = 'praxis.workflows.v1';
const POLICIES_KEY = 'praxis.workflowPolicies.v1';
const RUNS_KEY = 'praxis.workflowRuns.v1';

/** Project-committed definitions live here, relative to the workspace folder. */
export const PROJECT_WORKFLOWS_DIR = path.join('.praxis', 'workflows');

export interface StoredWorkflow {
  definition: WorkflowDefinition;
  source: WorkflowSource;
  /** Absolute file path, for project-sourced definitions only. */
  path?: string;
}

export interface WorkflowShadowReport {
  workflowId: string;
  /** The source that won. */
  effective: WorkflowSource;
  /** What it hid, nearest loser first. */
  shadowed: Array<{ source: WorkflowSource; path?: string }>;
}

export interface WorkflowLoadIssue {
  source: WorkflowSource;
  path?: string;
  workflowId?: string;
  issues: WorkflowIssue[];
}

export interface WorkflowCatalog {
  /** Resolved definitions, precedence applied, sorted by name. */
  workflows: StoredWorkflow[];
  shadowed: WorkflowShadowReport[];
  /** Definitions that failed to load or validate. Never silently dropped. */
  invalid: WorkflowLoadIssue[];
}

export interface ResolveWorkflowCatalogInput {
  builtIn?: WorkflowDefinition[];
  marketplace?: WorkflowDefinition[];
  global?: WorkflowDefinition[];
  project?: StoredWorkflow[];
}

/**
 * Applies precedence to candidates from every source.
 *
 * Pure on purpose — disk and app storage are read by the callers below, so the
 * precedence and shadowing rules can be tested without a filesystem.
 */
export function resolveWorkflowCatalog(input: ResolveWorkflowCatalogInput): WorkflowCatalog {
  const invalid: WorkflowLoadIssue[] = [];
  const candidates: StoredWorkflow[] = [];

  const consider = (stored: StoredWorkflow): void => {
    const { definition, source } = stored;
    const issues: WorkflowIssue[] = [];

    // A definition must declare the scope of the place it was found, or the
    // precedence table is describing something other than what is on disk.
    if (definition.scope !== EXPECTED_SCOPE[source]) {
      issues.push({
        path: 'scope',
        message: `A ${source} workflow must declare scope "${EXPECTED_SCOPE[source]}", not "${definition.scope}".`
      });
    }

    const result = validateWorkflow(definition);
    issues.push(...result.errors);

    if (issues.length > 0) {
      invalid.push({ source, workflowId: definition.id || undefined, ...(stored.path ? { path: stored.path } : {}), issues });
      return;
    }

    // Two definitions with one id inside a single source is a genuine
    // conflict, not a precedence question — neither can be said to win.
    const clash = candidates.find(
      candidate => candidate.source === source && candidate.definition.id === definition.id
    );
    if (clash) {
      invalid.push({
        source,
        workflowId: definition.id,
        ...(stored.path ? { path: stored.path } : {}),
        issues: [
          {
            path: 'id',
            message: `Duplicate workflow id "${definition.id}" within ${source} storage${clash.path ? ` (also ${clash.path})` : ''}.`
          }
        ]
      });
      return;
    }

    candidates.push(stored);
  };

  for (const definition of input.builtIn ?? []) consider({ definition, source: 'built-in' });
  for (const definition of input.marketplace ?? []) consider({ definition, source: 'marketplace' });
  for (const definition of input.global ?? []) consider({ definition, source: 'global' });
  for (const stored of input.project ?? []) consider({ ...stored, source: 'project' });

  const byId = new Map<string, StoredWorkflow[]>();
  for (const candidate of candidates) {
    byId.set(candidate.definition.id, [...(byId.get(candidate.definition.id) ?? []), candidate]);
  }

  const workflows: StoredWorkflow[] = [];
  const shadowed: WorkflowShadowReport[] = [];

  for (const [workflowId, group] of byId) {
    const ranked = [...group].sort((left, right) => PRECEDENCE[right.source] - PRECEDENCE[left.source]);
    const [winner, ...losers] = ranked;
    workflows.push(winner);
    if (losers.length > 0) {
      shadowed.push({
        workflowId,
        effective: winner.source,
        shadowed: losers.map(loser => ({ source: loser.source, ...(loser.path ? { path: loser.path } : {}) }))
      });
    }
  }

  workflows.sort((left, right) => left.definition.name.localeCompare(right.definition.name));
  shadowed.sort((left, right) => left.workflowId.localeCompare(right.workflowId));
  return { workflows, shadowed, invalid };
}

/**
 * Reads `<projectFolder>/.praxis/workflows/*.json`.
 *
 * A missing folder is not an error — most projects never commit a workflow.
 * A malformed one is: it comes back in `invalid` so the project sees that a
 * file it committed is being ignored.
 */
export async function loadProjectWorkflows(
  projectFolder: string
): Promise<{ workflows: StoredWorkflow[]; invalid: WorkflowLoadIssue[] }> {
  const root = path.resolve(projectFolder, PROJECT_WORKFLOWS_DIR);
  const workflows: StoredWorkflow[] = [];
  const invalid: WorkflowLoadIssue[] = [];

  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name)
      .sort();
  } catch {
    return { workflows, invalid };
  }

  for (const name of entries) {
    const filePath = path.join(root, name);
    // A symlinked or traversing name must not read outside the project.
    if (path.relative(root, filePath).startsWith('..')) {
      invalid.push({ source: 'project', path: filePath, issues: [{ path: '', message: 'Path escapes the project workflows folder.' }] });
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
      const migration = migrateWorkflow(parsed);
      if (!migration.definition) {
        invalid.push({ source: 'project', path: filePath, issues: migration.errors });
        continue;
      }
      workflows.push({ definition: migration.definition, source: 'project', path: filePath });
    } catch (error) {
      invalid.push({
        source: 'project',
        path: filePath,
        issues: [{ path: '', message: `Could not read workflow: ${(error as Error).message}` }]
      });
    }
  }

  return { workflows, invalid };
}

/**
 * A workflow id must be usable as a single, safe filename segment before it can
 * be committed to `.praxis/workflows`. Rejects traversal, separators, dotfiles,
 * and anything outside a conservative id alphabet.
 */
export function workflowFileName(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) throw new Error('A workflow id is required.');
  if (trimmed === '.' || trimmed === '..') throw new Error(`Unsafe workflow id: ${id}`);
  if (trimmed.startsWith('.')) throw new Error(`A workflow id may not start with a dot: ${id}`);
  if (/[/\\]/.test(trimmed) || trimmed.includes('\0')) throw new Error(`Unsafe workflow id: ${id}`);
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`A workflow id may only contain letters, digits, dot, underscore, and hyphen: ${id}`);
  }
  if (trimmed.length > 128) throw new Error(`Workflow id is too long: ${id}`);
  return `${trimmed}.json`;
}

/**
 * Writes a project-scoped definition to `<projectFolder>/.praxis/workflows/<id>.json`,
 * pretty-printed. Returns the absolute path. Refuses a non-project definition
 * and an unsafe id.
 */
export async function writeProjectWorkflow(
  projectFolder: string,
  definition: WorkflowDefinition
): Promise<string> {
  if (definition.scope !== 'project') {
    throw new Error('Only a project-scoped workflow can be committed to a project folder.');
  }
  const root = path.resolve(projectFolder, PROJECT_WORKFLOWS_DIR);
  const filePath = path.join(root, workflowFileName(definition.id));
  // Defence in depth: the name is already validated, but never write outside root.
  if (path.relative(root, filePath).startsWith('..')) {
    throw new Error(`Resolved path escapes the project workflows folder: ${filePath}`);
  }
  await mkdir(root, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
  return filePath;
}

/** Removes a committed project workflow file. A missing file is not an error. */
export async function deleteProjectWorkflow(projectFolder: string, workflowId: string): Promise<void> {
  const root = path.resolve(projectFolder, PROJECT_WORKFLOWS_DIR);
  const filePath = path.join(root, workflowFileName(workflowId));
  if (path.relative(root, filePath).startsWith('..')) return;
  await rm(filePath, { force: true });
}

/**
 * Global workflow definitions in app storage.
 *
 * Writes validate first: a definition that would come back as `invalid` on the
 * next read is refused now, while the author is still looking at it.
 */
export class WorkflowStore {
  public constructor(private readonly state: KeyValueStore) {}

  public list(): WorkflowDefinition[] {
    const value = this.state.get<unknown[]>(WORKFLOWS_KEY);
    if (!Array.isArray(value)) return [];
    return value
      .map(entry => migrateWorkflow(entry).definition)
      .filter((entry): entry is WorkflowDefinition => !!entry);
  }

  public get(workflowId: string): WorkflowDefinition | undefined {
    return this.list().find(candidate => candidate.id === workflowId);
  }

  public async save(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
    const result = validateWorkflow(definition);
    if (!result.valid) {
      throw new Error(`Workflow ${definition.id || '(unnamed)'} is invalid: ${describe(result.errors)}`);
    }
    if (definition.scope !== 'global') {
      throw new Error('WorkflowStore holds global workflows; a project workflow belongs in .praxis/workflows.');
    }

    const workflows = this.list();
    const index = workflows.findIndex(candidate => candidate.id === definition.id);
    // A saved edit is a new version, so a run already in flight keeps the
    // definition it started against.
    const next: WorkflowDefinition = {
      ...definition,
      version: index >= 0 ? workflows[index].version + 1 : definition.version,
      updatedAt: new Date().toISOString()
    };
    if (index >= 0) workflows[index] = next;
    else workflows.push(next);
    await this.state.update(WORKFLOWS_KEY, workflows);
    return next;
  }

  public async remove(workflowId: string): Promise<void> {
    const workflows = this.list();
    const next = workflows.filter(candidate => candidate.id !== workflowId);
    if (next.length === workflows.length) throw new Error(`Workflow ${workflowId} was not found.`);
    await this.state.update(WORKFLOWS_KEY, next);
  }
}

export interface EffectiveWorkflowPolicy {
  /** The composed profile actually enforced. */
  profile: WorkflowPolicyProfile;
  /** Profile ids that contributed, global first. */
  sources: string[];
  /**
   * Fields where the global profile made the project's stricter than it
   * declared. Empty when the project already met or exceeded org policy; the
   * designer shows these so an override that did not take is never silent.
   */
  tightenedByGlobal: string[];
}

/**
 * Composes a project profile over the global one, strictest wins.
 *
 * Governance has to be monotone: a project may tighten org policy but never
 * loosen it, or a global "security review required" disappears the moment a
 * project writes a profile that forgets to mention it. Every field has a
 * defined direction — gates union, requirements OR, permissions AND, caps
 * take the minimum — so the result is predictable rather than an arbitrary
 * merge.
 *
 * A genuine exemption is not expressed by weakening policy; it goes through
 * the attributed bypass recorded at approval time, where it has a name, a
 * timestamp, and a reason.
 */
export function composeWorkflowPolicies(
  global: WorkflowPolicyProfile,
  project: WorkflowPolicyProfile
): EffectiveWorkflowPolicy {
  const tightenedByGlobal: string[] = [];

  const requiredGates = [...new Set([...global.requiredGates, ...project.requiredGates])].sort();
  if (requiredGates.length > new Set(project.requiredGates).size) tightenedByGlobal.push('requiredGates');

  const requireHumanApproval = global.requireHumanApproval || project.requireHumanApproval;
  if (requireHumanApproval !== project.requireHumanApproval) tightenedByGlobal.push('requireHumanApproval');

  // Bypass is a permission, so the strict direction is to withhold it.
  const allowGateBypass = global.allowGateBypass && project.allowGateBypass;
  if (allowGateBypass !== project.allowGateBypass) tightenedByGlobal.push('allowGateBypass');

  const requireTrustedAgents = global.requireTrustedAgents || project.requireTrustedAgents;
  if (requireTrustedAgents !== project.requireTrustedAgents) tightenedByGlobal.push('requireTrustedAgents');

  const maxAttemptsPerNode = Math.min(global.maxAttemptsPerNode, project.maxAttemptsPerNode);
  if (maxAttemptsPerNode !== project.maxAttemptsPerNode) tightenedByGlobal.push('maxAttemptsPerNode');

  // Gate threshold composition — strictest wins
  const composedThresholds: Partial<Record<WorkflowGateKind, GateThresholdCondition[]>> = {};
  const allGateKinds = new Set<WorkflowGateKind>([
    ...(Object.keys(global.gateThresholds ?? {}) as WorkflowGateKind[]),
    ...(Object.keys(project.gateThresholds ?? {}) as WorkflowGateKind[])
  ]);

  const SEVERITY_RANK: Record<string, number> = {
    info: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4
  };

  for (const gate of allGateKinds) {
    const globalConds = global.gateThresholds?.[gate] ?? [];
    const projectConds = project.gateThresholds?.[gate] ?? [];
    const mergedConds: GateThresholdCondition[] = [];

    for (const gCond of globalConds) {
      if (gCond.type === 'metric') {
        const pCond = projectConds.find(c => c.type === 'metric' && c.metric === gCond.metric) as MetricThresholdCondition | undefined;
        if (pCond) {
          if (gCond.operator === '>=' && pCond.operator === '>=') {
            if (pCond.value < gCond.value) {
              throw new Error(`Cannot loosen org metric threshold for "${gCond.metric}": project requires >= ${pCond.value}, org requires >= ${gCond.value}.`);
            }
            if (pCond.value > gCond.value) {
              mergedConds.push(pCond);
            } else {
              mergedConds.push(gCond);
            }
          } else if (gCond.operator === '<=' && pCond.operator === '<=') {
            if (pCond.value > gCond.value) {
              throw new Error(`Cannot loosen org metric threshold for "${gCond.metric}": project requires <= ${pCond.value}, org requires <= ${gCond.value}.`);
            }
            if (pCond.value < gCond.value) {
              mergedConds.push(pCond);
            } else {
              mergedConds.push(gCond);
            }
          } else {
            mergedConds.push(gCond);
          }
        } else {
          mergedConds.push(gCond);
          tightenedByGlobal.push(`gateThresholds.${gate}.${gCond.metric}`);
        }
      } else if (gCond.type === 'severity') {
        const pCond = projectConds.find(c => c.type === 'severity') as SeverityThresholdCondition | undefined;
        if (pCond) {
          const gRank = SEVERITY_RANK[gCond.severityLevel ?? 'high'] ?? 3;
          const pRank = SEVERITY_RANK[pCond.severityLevel ?? 'high'] ?? 3;

          if (pRank > gRank) {
            throw new Error(`Cannot loosen org severity ceiling: project checks severity >= ${pCond.severityLevel}, org requires >= ${gCond.severityLevel}.`);
          }
          if (pCond.maxCount > gCond.maxCount) {
            throw new Error(`Cannot loosen org severity threshold: project allows ${pCond.maxCount} finding(s), org allows ${gCond.maxCount}.`);
          }
          mergedConds.push(pCond);
        } else {
          mergedConds.push(gCond);
          tightenedByGlobal.push(`gateThresholds.${gate}.severity`);
        }
      }
    }

    for (const pCond of projectConds) {
      if (pCond.type === 'metric' && !mergedConds.some(c => c.type === 'metric' && c.metric === pCond.metric)) {
        mergedConds.push(pCond);
      } else if (pCond.type === 'severity' && !mergedConds.some(c => c.type === 'severity')) {
        mergedConds.push(pCond);
      }
    }

    if (mergedConds.length > 0) {
      composedThresholds[gate] = mergedConds;
    }
  }

  return {
    profile: {
      ...project,
      requiredGates,
      requireHumanApproval,
      allowGateBypass,
      requireTrustedAgents,
      maxAttemptsPerNode,
      ...(Object.keys(composedThresholds).length > 0 ? { gateThresholds: composedThresholds } : {})
    },
    sources: [global.id, project.id],
    tightenedByGlobal
  };
}

/**
 * Policy profiles, global and per project.
 *
 * A project profile composes over the global one strictest-wins rather than
 * replacing it — see `composeWorkflowPolicies`.
 */
export class WorkflowPolicyStore {
  public constructor(private readonly state: KeyValueStore) {}

  public list(): WorkflowPolicyProfile[] {
    const value = this.state.get<WorkflowPolicyProfile[]>(POLICIES_KEY);
    return Array.isArray(value) ? value.filter(isPolicyProfile).map(profile => ({ ...profile })) : [];
  }

  /**
   * The policy governing a project: its own composed with the global default,
   * strictest wins. Returns undefined when neither exists — callers then run
   * unpoliced, which is a decision the UI must surface rather than assume.
   */
  public effectiveForProject(projectId: string): EffectiveWorkflowPolicy | undefined {
    const profiles = this.list();
    const global = profiles.find(profile => profile.scope === 'global');
    const project = profiles.find(profile => profile.scope === 'project' && profile.projectId === projectId);

    if (project && global) return composeWorkflowPolicies(global, project);
    const only = project ?? global;
    if (!only) return undefined;
    return { profile: { ...only }, sources: [only.id], tightenedByGlobal: [] };
  }

  public async save(profile: WorkflowPolicyProfile): Promise<WorkflowPolicyProfile> {
    if (profile.scope === 'project' && !profile.projectId?.trim()) {
      throw new Error('A project policy profile requires projectId.');
    }
    if (profile.scope === 'global' && profile.projectId) {
      throw new Error('A global policy profile must not carry projectId.');
    }
    if (profile.maxAttemptsPerNode < 1) {
      throw new Error('maxAttemptsPerNode must be 1 or greater.');
    }

    const profiles = this.list();
    const index = profiles.findIndex(candidate => candidate.id === profile.id);
    const next = { ...profile, updatedAt: new Date().toISOString() };
    if (index >= 0) profiles[index] = next;
    else profiles.push(next);
    await this.state.update(POLICIES_KEY, profiles);
    return next;
  }

  public async remove(profileId: string): Promise<void> {
    const profiles = this.list();
    const next = profiles.filter(candidate => candidate.id !== profileId);
    if (next.length === profiles.length) throw new Error(`Policy profile ${profileId} was not found.`);
    await this.state.update(POLICIES_KEY, next);
  }
}

/**
 * Persisted workflow runs (FX-BE-019 / TASK-095).
 *
 * Written after every transition rather than at stage boundaries: a run that
 * only persists when a stage completes loses exactly the information recovery
 * needs — which attempt was in flight when the process died.
 */
export class WorkflowRunStore {
  public constructor(private readonly state: KeyValueStore) {}

  public list(): WorkflowRun[] {
    const value = this.state.get<unknown[]>(RUNS_KEY);
    if (!Array.isArray(value)) return [];
    return value
      .map(entry => normalizeWorkflowRun(entry))
      .filter((entry): entry is WorkflowRun => !!entry);
  }

  public forProject(projectId: string): WorkflowRun[] {
    return this.list()
      .filter(run => run.projectId === projectId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  public get(runId: string): WorkflowRun | undefined {
    return this.list().find(run => run.runId === runId);
  }

  /** Inserts or replaces a run. The run itself is the unit of atomicity. */
  public async save(run: WorkflowRun): Promise<WorkflowRun> {
    const runs = this.list();
    const index = runs.findIndex(candidate => candidate.runId === run.runId);
    if (index >= 0) runs[index] = run;
    else runs.push(run);
    await this.state.update(RUNS_KEY, runs);
    return run;
  }

  public async remove(runId: string): Promise<void> {
    const runs = this.list();
    const next = runs.filter(run => run.runId !== runId);
    if (next.length === runs.length) throw new Error(`Run ${runId} was not found.`);
    await this.state.update(RUNS_KEY, next);
  }
}

function describe(issues: WorkflowIssue[]): string {
  return issues.map(issue => `${issue.path || '(root)'}: ${issue.message}`).join('; ');
}

function isPolicyProfile(value: unknown): value is WorkflowPolicyProfile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && Array.isArray(candidate.requiredGates);
}
