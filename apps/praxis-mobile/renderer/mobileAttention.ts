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
