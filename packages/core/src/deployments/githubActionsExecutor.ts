/**
 * The `github-actions` pipeline-managed executor: workflow discovery,
 * declared-input parsing, dispatch-request validation, and the dispatch
 * call itself (FX-BE-061 / TASK-162).
 *
 * A standalone client, deliberately not sharing `GitHubApiService`'s or
 * `GitHubActionsEvidenceProvider`'s private request machinery — this
 * codebase's existing convention of one self-contained client per concern
 * (see `ci/githubActionsEvidenceProvider.ts`'s own module doc). This one
 * needs `actions:write` (to dispatch) in addition to the `actions:read`/
 * `contents:read` the evidence provider needs (to read the workflow file);
 * keeping them separate keeps that scope difference visible rather than
 * blurred behind a shared client whose token might have either.
 * `GitHubActionsConfig`'s *shape* is reused (imported as a type) since it
 * is genuinely identical — baseUrl/owner/repo/token — not a reason to
 * duplicate the interface, only the request code.
 *
 * **"Never claim a run ID from an unrelated latest run"** is structural
 * here, not a runtime check: `dispatchWorkflow`'s return type has no run-id
 * field at all — `workflow_dispatch` is a fire-and-forget POST that GitHub
 * answers with 204 No Content, so there is nothing to claim. Correlating
 * the dispatch with the run it actually produced is deliberately a
 * *separate* concern (TASK-163's own task, "observe existing continuous
 * deployments") — this module cannot get that wrong because it does not
 * attempt it.
 *
 * **"Persist intent before authenticated dispatch"** is this module's
 * caller's responsibility, not this module's: a caller drives
 * `applyDeploymentRunCommand`'s `start-deploying` (TASK-153) and
 * `DeploymentRunStore.save()` (TASK-154) *before* calling
 * `dispatchWorkflow`, the exact same "save before dispatch" discipline
 * `directDeploymentOrchestrator.ts` already follows for the direct-process
 * executor. A dispatch that dies mid-flight (network error, process
 * killed) leaves that persisted run with no `externalId` — TASK-154's own
 * "lost acknowledgement" reconciliation case already covers it, unchanged;
 * nothing pipeline-executor-specific was needed there. **"Lost dispatch
 * response"** is exactly this: `dispatchWorkflow` propagates a network
 * error rather than swallowing it, and never guesses at whether the
 * request actually reached GitHub.
 */

import { load as loadYaml } from 'js-yaml';
import type { GitHubActionsConfig } from '../ci/githubActionsEvidenceProvider';

const GITHUB_API_VERSION = '2022-11-28';

export interface GitHubActionsWorkflowSummary {
  id: number;
  name: string;
  /** Repo-relative, e.g. `.github/workflows/deploy.yml` — what `DeploymentProfile`'s `GitHubActionsExecutorRef.workflowFile` names. */
  path: string;
  /** `active`, `disabled_manually`, `disabled_inactivity`, … — a disabled workflow cannot be dispatched even though it still lists. */
  state: string;
}

export interface WorkflowDispatchInputDeclaration {
  name: string;
  description?: string;
  required: boolean;
  default?: string;
  /** GitHub's declared input type — `string` when the workflow does not say. */
  type: 'string' | 'boolean' | 'choice' | 'environment' | 'number';
  /** Only meaningful for `type: 'choice'`. */
  options?: string[];
}

/** Thrown by `dispatchWorkflow` for a request GitHub actively refused — distinguished from a network-level "lost dispatch response", which propagates as whatever error `fetchImpl` itself threw. */
export class GitHubActionsDispatchError extends Error {
  public constructor(
    message: string,
    public readonly kind: 'invalid-workflow' | 'insufficient-permission' | 'rate-limited' | 'other',
    public readonly status: number
  ) {
    super(message);
    this.name = 'GitHubActionsDispatchError';
  }
}

function classifyDispatchFailure(status: number, headers: { get(name: string): string | null }): GitHubActionsDispatchError['kind'] {
  if (status === 404 || status === 422) return 'invalid-workflow';
  if (status === 429) return 'rate-limited';
  if (status === 403) {
    return headers.get('x-ratelimit-remaining') === '0' ? 'rate-limited' : 'insufficient-permission';
  }
  return 'other';
}

export class GitHubActionsDeploymentExecutor {
  public constructor(
    private readonly config: GitHubActionsConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  /** Every workflow the repository declares, including disabled ones — a caller decides whether to surface or filter those; this method does not hide them. */
  public async listWorkflows(): Promise<GitHubActionsWorkflowSummary[]> {
    const response = await this.get(`/repos/${this.encodeOwnerRepo()}/actions/workflows`);
    const parsed = response.json as { workflows?: unknown[] };
    return (parsed.workflows ?? [])
      .map(raw => normalizeWorkflow(raw as Record<string, unknown>))
      .filter((workflow): workflow is GitHubActionsWorkflowSummary => !!workflow);
  }

  /**
   * Fetches and parses the workflow file's own `on.workflow_dispatch.inputs`
   * declaration. Returns an empty array — never throws — for a workflow
   * with no `workflow_dispatch` trigger at all, or one declared with no
   * inputs; a caller decides whether "this workflow cannot be dispatched
   * with inputs" is itself a problem.
   */
  public async getDeclaredInputs(workflowPath: string): Promise<WorkflowDispatchInputDeclaration[]> {
    const response = await this.get(`/repos/${this.encodeOwnerRepo()}/contents/${encodePathSegments(workflowPath)}`);
    const parsed = response.json as { content?: string; encoding?: string };
    if (!parsed.content || parsed.encoding !== 'base64') {
      throw new Error(`Could not read workflow file "${workflowPath}" — unexpected response shape.`);
    }
    const yamlText = Buffer.from(parsed.content, 'base64').toString('utf8');
    return parseDeclaredInputs(yamlText, workflowPath);
  }

  /**
   * The dispatch call itself. Returns only a timestamp — deliberately no
   * run id, see the module doc. Throws `GitHubActionsDispatchError` for a
   * response GitHub actively returned (invalid workflow/ref, insufficient
   * permission, rate limited); a network-level failure (the "lost dispatch
   * response" case) propagates as whatever `fetchImpl` itself threw,
   * unwrapped, so a caller cannot mistake it for a confirmed refusal.
   */
  public async dispatchWorkflow(input: { workflowId: number | string; ref: string; inputs: Record<string, string> }): Promise<{ dispatchedAt: string }> {
    const url = this.buildUrl(`/repos/${this.encodeOwnerRepo()}/actions/workflows/${encodeURIComponent(String(input.workflowId))}/dispatches`);
    const dispatchedAt = new Date().toISOString();
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      },
      body: JSON.stringify({ ref: input.ref, inputs: input.inputs })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const kind = classifyDispatchFailure(response.status, response.headers);
      throw new GitHubActionsDispatchError(
        `GitHub Actions dispatch failed (HTTP ${response.status} ${response.statusText})${text ? `: ${truncate(text)}` : ''}`,
        kind,
        response.status
      );
    }
    // A successful dispatch is 204 No Content — nothing further to read.
    return { dispatchedAt };
  }

  private encodeOwnerRepo(): string {
    const owner = this.config.owner.trim();
    const repo = this.config.repo.trim();
    if (!owner || !repo) throw new Error('No GitHub repository is configured for Actions deployment.');
    return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private buildUrl(pathname: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${pathname}`;
  }

  private async get(pathname: string): Promise<{ json: unknown }> {
    const response = await this.fetchImpl(this.buildUrl(pathname), {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.config.token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      }
    });
    const text = await response.text();
    if (response.status === 403 || response.status === 404) {
      throw new GitHubActionsDispatchError(
        `No permission to read Actions workflows for this repository (HTTP ${response.status}).`,
        response.status === 404 ? 'invalid-workflow' : 'insufficient-permission',
        response.status
      );
    }
    if (!response.ok) {
      throw new Error(`GitHub Actions request failed (HTTP ${response.status} ${response.statusText}).`);
    }
    return { json: text.trim() ? JSON.parse(text) : {} };
  }
}

function truncate(value: string, max = 400): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function encodePathSegments(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function normalizeWorkflow(raw: Record<string, unknown>): GitHubActionsWorkflowSummary | undefined {
  if (typeof raw.id !== 'number') return undefined;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : `workflow-${raw.id}`,
    path: typeof raw.path === 'string' ? raw.path : '',
    state: typeof raw.state === 'string' ? raw.state : 'unknown'
  };
}

// ── Declared-input parsing ──────────────────────────────────────────────

const INPUT_TYPES: ReadonlySet<string> = new Set(['string', 'boolean', 'choice', 'environment', 'number']);

/**
 * Extracts `on.workflow_dispatch.inputs` from a workflow file's raw YAML.
 * `on` may be a bare string (`on: push`), an array (`on: [push,
 * workflow_dispatch]`), or a map — only the map form can carry
 * `workflow_dispatch.inputs`, so the other two shapes simply mean "no
 * declared inputs," not an error.
 */
export function parseDeclaredInputs(yamlText: string, sourceLabel: string): WorkflowDispatchInputDeclaration[] {
  let parsed: unknown;
  try {
    parsed = loadYaml(yamlText);
  } catch (error) {
    throw new Error(`Could not parse "${sourceLabel}" as YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object') return [];

  const record = parsed as Record<string, unknown>;
  const onValue = record.on;
  if (!onValue || typeof onValue !== 'object' || Array.isArray(onValue)) return [];

  const dispatch = (onValue as Record<string, unknown>).workflow_dispatch;
  if (!dispatch || typeof dispatch !== 'object') return [];

  const inputs = (dispatch as Record<string, unknown>).inputs;
  if (!inputs || typeof inputs !== 'object') return [];

  return Object.entries(inputs as Record<string, unknown>)
    .map(([name, raw]) => normalizeDeclaredInput(name, raw))
    .filter((input): input is WorkflowDispatchInputDeclaration => !!input);
}

function normalizeDeclaredInput(name: string, raw: unknown): WorkflowDispatchInputDeclaration | undefined {
  if (!name) return undefined;
  const spec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const type = typeof spec.type === 'string' && INPUT_TYPES.has(spec.type) ? (spec.type as WorkflowDispatchInputDeclaration['type']) : 'string';
  return {
    name,
    ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
    required: spec.required === true,
    ...(typeof spec.default === 'string' ? { default: spec.default } : typeof spec.default === 'boolean' || typeof spec.default === 'number' ? { default: String(spec.default) } : {}),
    type,
    ...(type === 'choice' && Array.isArray(spec.options) ? { options: spec.options.filter((o): o is string => typeof o === 'string') } : {})
  };
}

// ── Dispatch request validation ─────────────────────────────────────────

export interface ValidateDispatchRequestInput {
  declaredInputs: WorkflowDispatchInputDeclaration[];
  ref: string;
  inputs: Record<string, string>;
  /** The declared input name a caller intends to use to correlate the dispatch with its resulting run (TASK-163) — validated as present and supplied, not merely declared, since dispatching without it means the run can never be confidently identified afterward. */
  correlationInputName?: string;
}

export interface DispatchValidationIssue {
  path: string;
  message: string;
}

export function validateDispatchRequest(input: ValidateDispatchRequestInput): DispatchValidationIssue[] {
  const issues: DispatchValidationIssue[] = [];

  if (!input.ref.trim()) {
    issues.push({ path: 'ref', message: 'A ref (branch, tag, or commit) is required to dispatch a workflow.' });
  }

  const declaredByName = new Map(input.declaredInputs.map(declaration => [declaration.name, declaration]));

  for (const declaration of input.declaredInputs) {
    if (declaration.required && !input.inputs[declaration.name]?.trim()) {
      issues.push({ path: `inputs.${declaration.name}`, message: `Required input "${declaration.name}" was not supplied.` });
    }
    const value = input.inputs[declaration.name];
    if (declaration.type === 'choice' && value && declaration.options && !declaration.options.includes(value)) {
      issues.push({ path: `inputs.${declaration.name}`, message: `"${value}" is not one of the declared options for "${declaration.name}".` });
    }
  }

  // An input the workflow never declared cannot be dispatched — GitHub
  // itself would refuse it; caught here so the caller sees why before
  // spending an API call finding out.
  for (const name of Object.keys(input.inputs)) {
    if (!declaredByName.has(name)) {
      issues.push({ path: `inputs.${name}`, message: `"${name}" is not a declared input for this workflow.` });
    }
  }

  if (input.correlationInputName) {
    const declaration = declaredByName.get(input.correlationInputName);
    if (!declaration) {
      issues.push({
        path: 'correlationInputName',
        message: `Correlation input "${input.correlationInputName}" is not declared by this workflow.`
      });
    } else if (!input.inputs[input.correlationInputName]?.trim()) {
      issues.push({
        path: `inputs.${input.correlationInputName}`,
        message: `Correlation input "${input.correlationInputName}" must be supplied — without it, the dispatched run cannot be reliably identified afterward.`
      });
    }
  }

  return issues;
}
