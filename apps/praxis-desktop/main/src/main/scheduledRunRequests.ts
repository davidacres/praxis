import { lstat, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  SCHEDULED_RUN_REQUEST_FOLDER,
  ScheduledRunRequestError,
  composeScheduledRun,
  isScheduledRunRequestFile,
  parseScheduledRunRequest,
  resolveScheduledRunRequest,
  scheduledRunRequestHash,
  scheduledRunRequestRunId,
  scheduledRunRequestStatusFile,
  type IssueSummary,
  type ScheduledRun,
  type ScheduledRunRequestStatus,
  type ScheduledWorkflowChoice
} from '@praxis/core';

/**
 * Imports scheduled-run request files (`<workspace>/.praxis/scheduled-runs/*.json`)
 * as unarmed drafts. This is how the built-in `praxis-scheduled-runs` skill lets
 * an agent prepare a schedule without driving the app: it writes a request, and
 * Praxis answers with `<name>.status.json` beside it.
 *
 * A request is read again only when its bytes change (the status file records
 * the hash), so deleting the draft in the app does not bring it back. A request
 * never arms, starts or edits a schedule that is no longer a draft.
 */

const MAX_REQUEST_BYTES = 256 * 1024;

export interface ScheduledRunRequestDeps {
  projects(): Array<{ id: string; workspaceFolder?: string }>;
  issues(projectId: string): Promise<IssueSummary[]>;
  workflowChoices(projectId: string): Promise<ScheduledWorkflowChoice[]>;
  defaultWorkflow(choices: readonly ScheduledWorkflowChoice[]): string | undefined;
  store(): { get(id: string): ScheduledRun | undefined; save(run: ScheduledRun): Promise<unknown> };
  changed(projectId: string): void;
  now(): string;
}

export interface ScheduledRunRequestOutcome {
  file: string;
  status: ScheduledRunRequestStatus;
}

function problemsOf(error: unknown): string[] {
  if (error instanceof ScheduledRunRequestError) return error.problems;
  return [error instanceof Error ? error.message : String(error)];
}

async function readStatus(file: string): Promise<ScheduledRunRequestStatus | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as ScheduledRunRequestStatus;
  } catch {
    return undefined;
  }
}

async function writeStatus(file: string, status: ScheduledRunRequestStatus): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

async function importOne(
  deps: ScheduledRunRequestDeps,
  folderProjects: Array<{ id: string }>,
  file: string,
  text: string,
  requestHash: string
): Promise<ScheduledRunRequestStatus> {
  const checkedAt = deps.now();
  const base = { schemaVersion: 1 as const, requestHash, checkedAt };
  let projectId: string | undefined;
  try {
    const request = parseScheduledRunRequest(text);
    if (request.projectId) {
      if (!folderProjects.some(project => project.id === request.projectId)) {
        throw new ScheduledRunRequestError([`Project ${request.projectId} does not use this folder. Projects here: ${folderProjects.map(project => project.id).join(', ')}.`]);
      }
      projectId = request.projectId;
    } else if (folderProjects.length === 1) {
      projectId = folderProjects[0].id;
    } else {
      throw new ScheduledRunRequestError([`Several projects use this folder; set "projectId" to one of: ${folderProjects.map(project => project.id).join(', ')}.`]);
    }

    const runId = scheduledRunRequestRunId(projectId, path.basename(file));
    const existing = deps.store().get(runId);
    if (existing && existing.status !== 'draft') {
      throw new ScheduledRunRequestError([`The schedule this file created is now ${existing.status}, so a request can no longer change it. Hold it in Praxis first, or write a request with a new file name.`]);
    }

    const resolved = resolveScheduledRunRequest(request, await deps.issues(projectId), `project:${projectId}`);
    const choices = await deps.workflowChoices(projectId);
    let workflowId = request.workflowId;
    if (workflowId && !choices.some(choice => choice.workflowId === workflowId)) {
      throw new ScheduledRunRequestError([`Workflow "${workflowId}" is not available in this project. Available: ${choices.map(choice => choice.workflowId).join(', ') || 'none'}.`]);
    }
    workflowId ??= deps.defaultWorkflow(choices);
    const warnings = [...resolved.warnings];
    if (!workflowId) warnings.push('No workflow was chosen and the project has no default; pick one in Praxis before arming.');

    const composed = composeScheduledRun(existing, {
      projectId,
      name: request.name,
      date: request.date,
      time: request.time,
      timezone: request.timezone,
      tickets: resolved.tickets,
      ...(workflowId ? { workflowId } : {}),
      arm: false,
      at: checkedAt
    });
    const run = existing ? composed : { ...composed, id: runId };
    await deps.store().save(run);
    deps.changed(projectId);
    if (Date.parse(run.scheduledStartAt) <= Date.parse(checkedAt)) warnings.push('The start time has already passed; choose a later time before arming.');
    return {
      ...base,
      state: 'imported',
      runId: run.id,
      runStatus: run.status,
      projectId,
      ...(workflowId ? { workflowId } : {}),
      scheduledStartAt: run.scheduledStartAt,
      entries: resolved.entries,
      errors: [],
      warnings
    };
  } catch (error) {
    return { ...base, state: 'rejected', ...(projectId ? { projectId } : {}), errors: problemsOf(error), warnings: [] };
  }
}

/** Reads every project's request folder once and imports new or changed requests. */
export async function importScheduledRunRequests(deps: ScheduledRunRequestDeps): Promise<ScheduledRunRequestOutcome[]> {
  const byFolder = new Map<string, Array<{ id: string }>>();
  for (const project of deps.projects()) {
    const folder = project.workspaceFolder?.trim();
    if (!folder) continue;
    const key = path.resolve(folder);
    byFolder.set(key, [...(byFolder.get(key) ?? []), { id: project.id }]);
  }

  const outcomes: ScheduledRunRequestOutcome[] = [];
  for (const [folder, folderProjects] of byFolder) {
    const dir = path.join(folder, SCHEDULED_RUN_REQUEST_FOLDER);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter(isScheduledRunRequestFile).sort()) {
      const file = path.join(dir, name);
      const statusFile = path.join(dir, scheduledRunRequestStatusFile(name));
      try {
        const info = await lstat(file);
        if (!info.isFile()) continue;
        let text: string;
        let requestHash: string;
        if (info.size > MAX_REQUEST_BYTES) {
          text = '';
          requestHash = `oversize:${info.size}:${info.mtimeMs}`;
        } else {
          text = await readFile(file, 'utf8');
          requestHash = scheduledRunRequestHash(text);
        }
        if ((await readStatus(statusFile))?.requestHash === requestHash) continue;
        const status = info.size > MAX_REQUEST_BYTES
          ? { schemaVersion: 1 as const, state: 'rejected' as const, requestHash, checkedAt: deps.now(), errors: [`The request is larger than ${MAX_REQUEST_BYTES} bytes.`], warnings: [] }
          : await importOne(deps, folderProjects, file, text, requestHash);
        await writeStatus(statusFile, status);
        outcomes.push({ file, status });
      } catch (error) {
        console.error(`Scheduled-run request ${file} could not be processed:`, error);
      }
    }
  }
  return outcomes;
}
