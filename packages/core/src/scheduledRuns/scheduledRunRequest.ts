/**
 * Scheduled-run request files: how an agent asks Praxis for a draft schedule
 * without driving the app.
 *
 * An agent writes `<workspace>/.praxis/scheduled-runs/<name>.json`. Praxis reads
 * it, resolves each listed ticket against the project's board, checks the order
 * against the plan's dependencies, and saves an unarmed draft. It then writes
 * `<name>.status.json` beside the request so the agent can confirm the result.
 *
 * Everything here is pure: parsing, ticket resolution, ordering and the status
 * record. File watching and saving live in the desktop main process. A request
 * can only ever create or update a *draft* — arming stays a person's decision.
 */

import { createHash } from 'node:crypto';
import type { IssueSummary } from '../types';
import type { ScheduledRun, ScheduledTicketRef } from './scheduledRun';

export const SCHEDULED_RUN_REQUEST_KIND = 'praxis.scheduledRunRequest';
export const SCHEDULED_RUN_REQUEST_FOLDER = '.praxis/scheduled-runs';
export const SCHEDULED_RUN_REQUEST_STATUS_SUFFIX = '.status.json';

/** `as-listed` keeps the file's order and fails if it breaks a dependency; `dependencies` sorts it. */
export type ScheduledRunRequestOrder = 'as-listed' | 'dependencies';

export interface ScheduledRunRequest {
  schemaVersion: 1;
  kind: typeof SCHEDULED_RUN_REQUEST_KIND;
  name: string;
  /** Needed only when several projects share the workspace folder. */
  projectId?: string;
  /** Defaults to the project's default schedule workflow. */
  workflowId?: string;
  /** Local wall-clock start in `timezone`: `YYYY-MM-DD` and `HH:mm`. */
  date: string;
  time: string;
  timezone: string;
  order: ScheduledRunRequestOrder;
  /** Board keys or plan IDs (e.g. `TASK-476`), in the wanted run order. */
  tickets: string[];
  /** Dependencies outside the queue that are known to be finished even though the board does not say so. */
  satisfiedDependencies: string[];
}

export interface ScheduledRunRequestEntry {
  sequence: number;
  issueKey: string;
  planningId?: string;
  title: string;
}

export interface ScheduledRunRequestStatus {
  schemaVersion: 1;
  state: 'imported' | 'rejected';
  /** SHA-256 of the request file this status describes; a changed request is read again. */
  requestHash: string;
  checkedAt: string;
  runId?: string;
  runStatus?: ScheduledRun['status'];
  projectId?: string;
  workflowId?: string;
  scheduledStartAt?: string;
  entries?: ScheduledRunRequestEntry[];
  errors: string[];
  warnings: string[];
}

export class ScheduledRunRequestError extends Error {
  public constructor(public readonly problems: string[]) {
    super(problems.join(' '));
    this.name = 'ScheduledRunRequestError';
  }
}

export function scheduledRunRequestHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The draft a request owns: stable across edits of the same file, distinct per project. */
export function scheduledRunRequestRunId(projectId: string, fileName: string): string {
  const digest = createHash('sha256').update(`${projectId}\u0000${fileName}`).digest('hex').slice(0, 20);
  return `run-request-${digest}`;
}

/** True for a request file name (not its status sidecar or a hidden/temp file). */
export function isScheduledRunRequestFile(fileName: string): boolean {
  return fileName.endsWith('.json')
    && !fileName.endsWith(SCHEDULED_RUN_REQUEST_STATUS_SUFFIX)
    && !fileName.startsWith('.');
}

export function scheduledRunRequestStatusFile(fileName: string): string {
  return `${fileName.replace(/\.json$/i, '')}${SCHEDULED_RUN_REQUEST_STATUS_SUFFIX}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function stringList(value: unknown, field: string, problems: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    problems.push(`"${field}" must be a list of non-empty strings.`);
    return [];
  }
  return value.map(item => (item as string).trim());
}

function optionalString(value: unknown, field: string, problems: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    problems.push(`"${field}" must be a non-empty string when present.`);
    return undefined;
  }
  return value.trim();
}

/** Parses and shape-checks a request file. Throws `ScheduledRunRequestError` listing every problem. */
export function parseScheduledRunRequest(text: string): ScheduledRunRequest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ScheduledRunRequestError([`The request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScheduledRunRequestError(['The request must be a JSON object.']);
  }
  const raw = value as Record<string, unknown>;
  const problems: string[] = [];
  if (raw.schemaVersion !== 1) problems.push('"schemaVersion" must be 1.');
  if (raw.kind !== SCHEDULED_RUN_REQUEST_KIND) problems.push(`"kind" must be "${SCHEDULED_RUN_REQUEST_KIND}".`);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) problems.push('"name" is required.');
  const date = typeof raw.date === 'string' ? raw.date.trim() : '';
  if (!DATE_RE.test(date)) problems.push('"date" must be YYYY-MM-DD.');
  const time = typeof raw.time === 'string' ? raw.time.trim() : '';
  if (!TIME_RE.test(time)) problems.push('"time" must be HH:mm (24-hour).');
  const timezone = typeof raw.timezone === 'string' ? raw.timezone.trim() : '';
  if (!timezone) problems.push('"timezone" is required (an IANA zone such as "Europe/London").');
  const order = raw.order === undefined ? 'as-listed' : raw.order;
  if (order !== 'as-listed' && order !== 'dependencies') problems.push('"order" must be "as-listed" or "dependencies".');
  const tickets = stringList(raw.tickets, 'tickets', problems);
  if (raw.tickets !== undefined && tickets.length === 0 && Array.isArray(raw.tickets)) problems.push('"tickets" must list at least one ticket.');
  if (raw.tickets === undefined) problems.push('"tickets" is required.');
  const satisfiedDependencies = stringList(raw.satisfiedDependencies, 'satisfiedDependencies', problems);
  const projectId = optionalString(raw.projectId, 'projectId', problems);
  const workflowId = optionalString(raw.workflowId, 'workflowId', problems);
  if (problems.length) throw new ScheduledRunRequestError(problems);
  return {
    schemaVersion: 1,
    kind: SCHEDULED_RUN_REQUEST_KIND,
    name,
    ...(projectId ? { projectId } : {}),
    ...(workflowId ? { workflowId } : {}),
    date,
    time,
    timezone,
    order: order as ScheduledRunRequestOrder,
    tickets,
    satisfiedDependencies
  };
}

export interface ResolvedScheduledRunRequest {
  tickets: ScheduledTicketRef[];
  entries: ScheduledRunRequestEntry[];
  warnings: string[];
}

function isDone(issue: IssueSummary): boolean {
  return (issue.statusCategory ?? '').toLowerCase() === 'done';
}

function label(issue: IssueSummary): string {
  return issue.planningId ? `${issue.planningId} (${issue.key})` : issue.key;
}

/**
 * Resolves the request's tickets against the board's issues and fixes the run
 * order. A reference matches a board key exactly, otherwise a plan ID; it must
 * match exactly one issue. Every dependency of a queued ticket must be queued
 * earlier, already done, or named in `satisfiedDependencies`.
 */
export function resolveScheduledRunRequest(
  request: Pick<ScheduledRunRequest, 'tickets' | 'order' | 'satisfiedDependencies'>,
  issues: readonly IssueSummary[],
  connectionId: string
): ResolvedScheduledRunRequest {
  const problems: string[] = [];
  const warnings: string[] = [];
  const byKey = new Map(issues.map(issue => [issue.key, issue] as const));
  const find = (ref: string): IssueSummary | undefined => {
    const exact = byKey.get(ref);
    if (exact) return exact;
    const matches = issues.filter(issue => issue.planningId === ref);
    if (matches.length > 1) {
      problems.push(`${ref} matches more than one board item (${matches.map(issue => issue.key).join(', ')}); use the board key.`);
      return undefined;
    }
    if (matches.length === 0) problems.push(`${ref} was not found on the project's board.`);
    return matches[0];
  };

  const selected: IssueSummary[] = [];
  const seen = new Set<string>();
  for (const ref of request.tickets) {
    const issue = find(ref);
    if (!issue) continue;
    if (seen.has(issue.key)) {
      problems.push(`${label(issue)} is listed more than once.`);
      continue;
    }
    seen.add(issue.key);
    selected.push(issue);
    if (isDone(issue)) warnings.push(`${label(issue)} is already done; the run will skip it.`);
  }

  const satisfied = new Set<string>();
  for (const ref of request.satisfiedDependencies) {
    const issue = byKey.get(ref) ?? issues.find(candidate => candidate.planningId === ref);
    satisfied.add(issue?.key ?? ref);
  }

  // Dependencies inside the queue become ordering edges; the rest must be finished.
  const queuedDeps = new Map<string, string[]>();
  for (const issue of selected) {
    const inQueue: string[] = [];
    for (const dep of issue.dependsOn ?? []) {
      if (seen.has(dep)) {
        inQueue.push(dep);
        continue;
      }
      const target = byKey.get(dep);
      if (satisfied.has(dep) || (target && isDone(target))) continue;
      problems.push(`${label(issue)} depends on ${target ? label(target) : dep}, which is not in the queue and not done. Queue it, or list it in "satisfiedDependencies" if it is finished.`);
    }
    queuedDeps.set(issue.key, inQueue);
  }

  let ordered = selected;
  if (request.order === 'as-listed') {
    const position = new Map(selected.map((issue, index) => [issue.key, index] as const));
    for (const issue of selected) {
      for (const dep of queuedDeps.get(issue.key) ?? []) {
        if ((position.get(dep) ?? -1) > (position.get(issue.key) ?? 0)) {
          problems.push(`${label(issue)} is listed before its dependency ${label(byKey.get(dep)!)}.`);
        }
      }
    }
  } else {
    // Stable topological sort: always take the earliest-listed ticket whose dependencies are placed.
    const placed = new Set<string>();
    const remaining = [...selected];
    ordered = [];
    while (remaining.length) {
      const index = remaining.findIndex(issue => (queuedDeps.get(issue.key) ?? []).every(dep => placed.has(dep)));
      if (index < 0) {
        problems.push(`These tickets depend on each other in a cycle: ${remaining.map(label).join(', ')}.`);
        break;
      }
      const [next] = remaining.splice(index, 1);
      placed.add(next.key);
      ordered.push(next);
    }
  }

  if (problems.length) throw new ScheduledRunRequestError(problems);
  const entries = ordered.map((issue, index) => ({
    sequence: index + 1,
    issueKey: issue.key,
    ...(issue.planningId ? { planningId: issue.planningId } : {}),
    title: issue.summary
  }));
  return {
    tickets: ordered.map(issue => ({ connectionId, issueKey: issue.key, title: issue.summary })),
    entries,
    warnings
  };
}
