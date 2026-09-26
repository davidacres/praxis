export type MobileAttentionKind='permission'|'approval'|'failure';
export interface MobileAttentionItem{id:string;kind:MobileAttentionKind;hostId:string;projectId:string;sessionId?:string;runId?:string;requestId?:string;summary?:string;detail?:string;createdAt:string;resolved:boolean;}
export function openMobileAttention(items:readonly MobileAttentionItem[],scope:{hostId:string;projectId:string}):readonly MobileAttentionItem[]{return items.filter(i=>!i.resolved&&i.hostId===scope.hostId&&i.projectId===scope.projectId);}
/** What an attention item is about, by name — a run's workflow or a session's title — never a raw id. */
export function attentionSubject(
  item: Pick<MobileAttentionItem, 'kind' | 'sessionId' | 'runId' | 'summary'>,
  work: ReadonlyArray<{ sessionId?: string; runId?: string; title: string }>,
  runs: Readonly<Record<string, { workflowName?: string } | undefined>>
): string {
  if (item.runId) {
    // A run's item carries its workflow name from the desktop; a permission's summary is the request, not a name.
    const named = item.kind === 'permission' ? undefined : item.summary;
    return runs[item.runId]?.workflowName || named || work.find(entry => entry.runId === item.runId)?.title || 'A workflow run';
  }
  if (item.sessionId) return work.find(entry => entry.sessionId === item.sessionId)?.title || 'A session';
  return item.kind === 'approval' ? 'A workflow run' : 'A session';
}

/**
 * Approval and failure items straight from the runs the phone already follows
 * live (`run.snapshot` events), with the same ids the desktop's
 * `attention.list` gives them — so they appear the moment a run changes, not on
 * the next poll.
 */
export function runAttentionItems(
  hostId: string,
  projectId: string,
  runs: ReadonlyArray<{ runId: string; projectId: string; workflowName: string; status: string; startedAt: string; stages: ReadonlyArray<{ nodeId: string; name: string; lane: string }> }>
): MobileAttentionItem[] {
  const items: MobileAttentionItem[] = [];
  for (const run of runs) {
    if (run.projectId !== projectId) continue;
    if (run.status === 'awaiting-approval') {
      items.push({ id: `approval:${run.runId}`, kind: 'approval', hostId, projectId, runId: run.runId, summary: run.workflowName, createdAt: run.startedAt, resolved: false });
    }
    for (const stage of run.stages) {
      if (stage.lane === 'failed') {
        items.push({ id: `failure:${run.runId}:${stage.nodeId}`, kind: 'failure', hostId, projectId, runId: run.runId, summary: `${run.workflowName} — ${stage.name}`, createdAt: run.startedAt, resolved: false });
      }
    }
  }
  return items;
}

/**
 * The attention list the phone shows. Permissions come from live session
 * snapshots and run items from live run snapshots; the desktop's polled list
 * adds only what neither covers (and everything, against a desktop too old to
 * list runs). Items acted on here stay hidden until the desktop's next word.
 */
export function combineAttention(input: {
  polled: readonly MobileAttentionItem[];
  permissions: readonly MobileAttentionItem[];
  fromRuns: readonly MobileAttentionItem[] | undefined;
  resolvedIds: ReadonlySet<string>;
}): MobileAttentionItem[] {
  const live = [...input.permissions, ...(input.fromRuns ?? [])];
  const covered = new Set<MobileAttentionKind>(['permission', ...(input.fromRuns ? (['approval', 'failure'] as const) : [])]);
  const liveIds = new Set(live.map(item => item.id));
  const extra = input.polled.filter(item => !covered.has(item.kind) && !liveIds.has(item.id));
  return [...live, ...extra].map(item => (input.resolvedIds.has(item.id) ? { ...item, resolved: true } : item));
}
