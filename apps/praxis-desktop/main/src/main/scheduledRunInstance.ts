import * as path from 'node:path';
import { app } from 'electron';
import {
  ScheduledRunStore,
  assessScheduledRunReadiness,
  instantToZonedParts,
  type BackendMode,
  type ScheduledRun,
  type ScheduledRunView,
  type ScheduledTicketProbe,
  type ScheduledTicketRef
} from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { getServiceForConnection } from './serviceRegistry';
import { getConnectionStore } from './connectionStoreInstance';
import { getProjectStore } from './projectStoreInstance';
import { usableProviders } from './providerFallback';
import { describeLiveEntry, readProviderUsage } from './scheduledRunLive';
import { getWorkflowBackingStore } from './workflowStoreInstance';
import { projectWorkflowTrust } from './workflowProjectTrust';
import { projectFolder, runnableDefinition } from './workflowIpc';
import { workflowBlockingFiles } from './workflowWorkspace';

/**
 * Scheduled ticket runs live in `scheduled-runs.json` under `userData` (FX-BF-047
 * / FX-BE-147), so `--user-data-dir` isolates the e2e suite the way it does for
 * workflows. The store is cheap to rebuild; the file-backed key/value store is
 * the singleton.
 */
let backing: JsonKeyValueStore | undefined;

export function getScheduledRunStore(): ScheduledRunStore {
  if (!backing) backing = new JsonKeyValueStore(path.join(app.getPath('userData'), 'scheduled-runs.json'));
  return new ScheduledRunStore(backing);
}

export function resetScheduledRunStore(): void {
  backing = undefined;
}

const ACCEPTANCE_RE = /acceptance|\[[ xX]\]|definition of done/i;

/**
 * What the live board says about one queued ticket. A ticket whose connection or
 * issue cannot be read is reported missing rather than guessed at: readiness is
 * a prompt to look, not a verdict, and the editor says which ticket to check.
 *
 * `hasFolder` is only asserted when it can be known — a project-linked ticket
 * reads its project's folder, a folder-backed connection always has one. For any
 * other tracker it is left undefined, which readiness treats as "not assessed".
 * The workflow is the schedule's own (`policy.workflowId`), so it is checked once for
 * the run in `buildScheduledRunView`, not per ticket.
 */
export async function probeScheduledTicket(
  ref: ScheduledTicketRef,
  context: { otherSchedules: ScheduledRun[]; selfId: string }
): Promise<ScheduledTicketProbe> {
  let issue;
  try {
    const service = await getServiceForConnection(ref.connectionId);
    issue = await service.getIssue(ref.issueKey);
  } catch {
    return { state: 'missing' };
  }

  const probe: ScheduledTicketProbe = {
    state: 'found',
    closed: (issue.statusCategory ?? '').toLowerCase() === 'done',
    hasAcceptanceCriteria: ACCEPTANCE_RE.test(issue.description ?? '')
  };

  const folder = folderFor(ref.connectionId);
  if (folder !== undefined) probe.hasFolder = folder;

  const other = context.otherSchedules.find(
    run =>
      run.id !== context.selfId &&
      run.status === 'scheduled' &&
      run.entries.some(entry => entry.ticket.connectionId === ref.connectionId && entry.ticket.issueKey === ref.issueKey)
  );
  if (other) probe.inOtherSchedule = other.name;
  return probe;
}

function folderFor(connectionId: string): boolean | undefined {
  if (connectionId.startsWith('project:')) {
    return !!getProjectStore().get(connectionId.slice('project:'.length))?.workspaceFolder?.trim();
  }
  const mode: BackendMode | undefined = getConnectionStore().getConnection(connectionId)?.mode;
  if (mode === 'folder') return true;
  const linked = getProjectStore().list().find(project => project.linkedBoards.some(link => link.connectionId === connectionId));
  return linked ? !!linked.workspaceFolder?.trim() : undefined;
}

/** A schedule with its derived readiness and editable start parts. */
export async function buildScheduledRunView(run: ScheduledRun, all: ScheduledRun[] = getScheduledRunStore().list()): Promise<ScheduledRunView> {
  const probes = new Map<string, ScheduledTicketProbe>();
  await Promise.all(
    run.entries.map(async entry => {
      probes.set(entry.id, await probeScheduledTicket(entry.ticket, { otherSchedules: all, selfId: run.id }));
    })
  );
  const byTicket = new Map(run.entries.map(entry => [`${entry.ticket.connectionId}\u0000${entry.ticket.issueKey}`, probes.get(entry.id)!] as const));

  const usage = await readProviderUsage().catch(() => undefined);
  const usable = usage?.usable ?? (await usableProviders());
  const lowAllowance = usage ? usage.usable.find(provider => (usage.used[provider] ?? 0) >= 0.95) : undefined;
  const readiness = assessScheduledRunReadiness(run, {
    now: new Date().toISOString(),
    usableProviderCount: usable.length,
    ...(await workflowFacts(run)),
    ...(lowAllowance ? { lowAllowanceProvider: lowAllowance } : {}),
    probe: ticket => byTicket.get(`${ticket.connectionId}\u0000${ticket.issueKey}`) ?? { state: 'missing' }
  });
  const start = instantToZonedParts(run.scheduledStartAt, run.timezone) ?? { date: '', time: '' };
  const liveEntry = run.status === 'running' || run.status === 'paused' ? describeLiveEntry(run) : undefined;
  const live = liveEntry
    ? { ...liveEntry, headroom: (usage?.usable ?? []).map(provider => ({ provider, ...(usage?.used[provider] !== undefined ? { usedFraction: usage.used[provider] } : {}) })) }
    : undefined;
  return { run, readiness, start, ...(live ? { live } : {}) };
}

/** Whether the schedule's workflow is trusted and whether the project's base is clean, as readiness facts. */
async function workflowFacts(run: ScheduledRun): Promise<{ workflowTrusted?: boolean; baseDirty?: boolean }> {
  if (!run.projectId || !run.policy.workflowId) return {};
  try {
    const definition = await runnableDefinition(run.projectId, run.policy.workflowId);
    if (!definition) return {};
    const trust = await projectWorkflowTrust(getWorkflowBackingStore(), await projectFolder(run.projectId), run.policy.workflowId, definition);
    const blocking = await workflowBlockingFiles(run.projectId).catch(() => []);
    return { workflowTrusted: trust.trusted, baseDirty: blocking.length > 0 };
  } catch {
    return {};
  }
}
