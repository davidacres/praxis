export type MobileAttentionKind='permission'|'approval'|'failure';
export interface MobileAttentionItem{id:string;kind:MobileAttentionKind;hostId:string;projectId:string;sessionId?:string;runId?:string;createdAt:string;resolved:boolean;}
export function openMobileAttention(items:readonly MobileAttentionItem[],scope:{hostId:string;projectId:string}):readonly MobileAttentionItem[]{return items.filter(i=>!i.resolved&&i.hostId===scope.hostId&&i.projectId===scope.projectId);}
