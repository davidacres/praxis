export interface MobileRunnableChoice{workflowId:string;workflowName:string;agentId?:string;agentName?:string;projectId:string;enabled:boolean;}
export function runnableChoicesForProject(choices:readonly MobileRunnableChoice[],projectId:string):readonly MobileRunnableChoice[]{return choices.filter(c=>c.projectId===projectId&&c.enabled);}
