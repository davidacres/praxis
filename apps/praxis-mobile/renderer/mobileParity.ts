export const MOBILE_EXECUTION_ACTIONS=['sessions.continue','workflowRuns.start','workflowRuns.cancel','workflowRuns.retryStage','permissions.respond','workflowGates.approve'] as const;
export function hasDesktopParity(desktopOperations:readonly string[]):boolean{return MOBILE_EXECUTION_ACTIONS.every(x=>desktopOperations.includes(x));}
