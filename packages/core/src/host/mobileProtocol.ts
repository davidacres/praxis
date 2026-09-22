/** Browser-safe protocol contracts for a mobile client controlling a running Praxis host. */
export const MOBILE_PROTOCOL_VERSION = 1 as const;
export type MobileCapability = 'view' | 'execute' | 'approve';
export type MobileReadOperation = 'hosts.list' | 'projects.snapshot' | 'work.list' | 'sessions.list' | 'sessions.get' | 'workflows.list' | 'workflowRuns.get' | 'changes.get' | 'attention.list';
export type MobileCommandOperation = 'sessions.create' | 'sessions.continue' | 'sessions.cancel' | 'workflowRuns.start' | 'workflowRuns.cancel' | 'workflowRuns.retryStage' | 'permissions.respond' | 'workflowGates.approve';
export type MobileOperation = MobileReadOperation | MobileCommandOperation;
export interface MobileCaller { deviceId: string; subject?: string; capabilities: readonly MobileCapability[]; }
export interface MobileTarget { hostId: string; projectId?: string; sessionId?: string; runId?: string; requestId?: string; }
export interface MobileCommand<TPayload = unknown> { protocolVersion: typeof MOBILE_PROTOCOL_VERSION; commandId: string; issuedAt: string; caller: MobileCaller; target: MobileTarget; operation: MobileCommandOperation; expectedVersion?: number; payload: TPayload; }
export interface MobileReadRequest { protocolVersion: typeof MOBILE_PROTOCOL_VERSION; requestId: string; caller: MobileCaller; target: MobileTarget; operation: MobileReadOperation; cursor?: string; limit?: number; }
export interface MobileEventCursor { hostId: string; projectId?: string; sequence: number; }
export interface MobileEventEnvelope<TEvent = unknown> { protocolVersion: typeof MOBILE_PROTOCOL_VERSION; eventId: string; sequence: number; emittedAt: string; target: MobileTarget; event: TEvent; }
export type MobileProtocolErrorCode = 'unsupported-version' | 'invalid-envelope' | 'unauthenticated' | 'forbidden' | 'stale-version' | 'duplicate-command' | 'command-conflict' | 'not-found' | 'host-offline' | 'cursor-expired';
export interface MobileProtocolError { code: MobileProtocolErrorCode; message: string; retryable: boolean; commandId?: string; currentVersion?: number; }

export type MobileSessionLifecycle = 'idle' | 'active' | 'awaiting-input' | 'completed' | 'failed' | 'stopped';
export interface MobileSessionSummary {
  sessionId: string;
  sessionKey: string;
  projectId?: string;
  workId?: string;
  runId?: string;
  parentSessionKey?: string;
  title: string;
  lifecycle: MobileSessionLifecycle;
  provider?: string;
  model?: string;
  mode: 'chat' | 'analysis' | 'review';
  archived: boolean;
  startedAt: string;
  completedAt?: string;
}
export interface MobileSessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  at: string;
  status: 'complete' | 'streaming' | 'failed' | 'stopped';
  reasoning?: string;
  model?: string;
  toolNames?: readonly string[];
}
export interface MobilePendingPermission {
  requestId: string;
  summary: string;
  detail?: string;
  createdAt: string;
}
export interface MobileSessionSnapshot extends MobileSessionSummary {
  sequence: number;
  messages: readonly MobileSessionMessage[];
  pendingPermissions: readonly MobilePendingPermission[];
  responseText?: string;
  reasoningText?: string;
  tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  contextTokens?: number;
  contextLimit?: number;
  cost?: { currency: string; amount: number };
  canContinue: boolean;
  canCancel: boolean;
}
export type MobileSessionEvent =
  | { type: 'session.snapshot'; snapshot: MobileSessionSnapshot }
  | { type: 'session.removed'; sessionId: string; sessionKey: string };
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CAPABILITY_BY_OPERATION: Record<MobileOperation, MobileCapability> = {
  'hosts.list':'view','projects.snapshot':'view','work.list':'view','sessions.list':'view','sessions.get':'view','workflows.list':'view','workflowRuns.get':'view','changes.get':'view','attention.list':'view',
  'sessions.create':'execute','sessions.continue':'execute','sessions.cancel':'execute','workflowRuns.start':'execute','workflowRuns.cancel':'execute','workflowRuns.retryStage':'execute','permissions.respond':'approve','workflowGates.approve':'approve',
};
export function mobileCapabilityFor(operation: MobileOperation): MobileCapability { return CAPABILITY_BY_OPERATION[operation]; }
export function mobileOperationRequiresMutation(operation: MobileOperation): boolean { return operation in {'sessions.create':true,'sessions.continue':true,'sessions.cancel':true,'workflowRuns.start':true,'workflowRuns.cancel':true,'workflowRuns.retryStage':true,'permissions.respond':true,'workflowGates.approve':true}; }
export function callerHasCapability(caller: MobileCaller, operation: MobileOperation): boolean { return caller.capabilities.includes(mobileCapabilityFor(operation)); }
export function createMobileCommand<TPayload>(input: Omit<MobileCommand<TPayload>, 'protocolVersion'>): MobileCommand<TPayload> { const command={protocolVersion:MOBILE_PROTOCOL_VERSION,...input}; const validation=validateMobileCommand(command); if(!validation.ok) throw new Error(validation.error.message); return command; }
export function validateMobileCommand(command: MobileCommand): {ok:true}|{ok:false;error:MobileProtocolError} {
 if(command.protocolVersion!==MOBILE_PROTOCOL_VERSION) return {ok:false,error:{code:'unsupported-version',message:`Protocol version ${String(command.protocolVersion)} is not supported.`,retryable:false,commandId:command.commandId}};
 if(!COMMAND_ID.test(command.commandId)||!ISO_DATE.test(command.issuedAt)) return {ok:false,error:{code:'invalid-envelope',message:'Command identity and issuedAt must be valid.',retryable:false,commandId:command.commandId}};
 if(!DEVICE_ID.test(command.caller.deviceId)||!command.target.hostId.trim()) return {ok:false,error:{code:'invalid-envelope',message:'Caller device and host identity are required.',retryable:false,commandId:command.commandId}};
 if(!callerHasCapability(command.caller,command.operation)) return {ok:false,error:{code:'forbidden',message:`The caller lacks the ${mobileCapabilityFor(command.operation)} capability.`,retryable:false,commandId:command.commandId}};
 if(mobileOperationRequiresMutation(command.operation)&&!command.target.projectId) return {ok:false,error:{code:'invalid-envelope',message:'Mutating commands must identify a project.',retryable:false,commandId:command.commandId}};
 return {ok:true};
}
export function validateMobileCursor(cursor: MobileEventCursor): MobileProtocolError|undefined { if(!cursor.hostId.trim()||!Number.isInteger(cursor.sequence)||cursor.sequence<0) return {code:'invalid-envelope',message:'Event cursors require a host and non-negative sequence.',retryable:false}; return undefined; }
