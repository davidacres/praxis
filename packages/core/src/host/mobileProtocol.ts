/** Browser-safe protocol contracts for a mobile client controlling a running Praxis host. */
import type { AnyGadgetEnvelope, GadgetActionStatus, GadgetActionValue, GadgetLifecycleState } from '../ai/gadgets/contracts';
export const MOBILE_PROTOCOL_VERSION = 1 as const;
export type MobileCapability = 'view' | 'execute' | 'approve';
/**
 * Additive revision of the v1 read/command surface. Revision 1 is the original
 * set; revision 2 added `host.info`, `providers.list`, `models.list`,
 * `sessions.usage`, `access.get` and the `mode` / validated `provider` /
 * `model` fields of `sessions.create`; revision 3 added `sessions.configure`
 * (between-turn provider handover, model change and mode switch); revision 4 added `host.info`
 * `appearance` and the `host.appearance` event, so the phone wears the desktop's theme; revision 5 added
 * gadgets on session messages and `gadgets.submit`, `workflowGates.reject`, and a session's working-tree
 * changes through `changes.get` (`target.sessionId`, optionally `params.path` for one file's diff); revision 6
 * added `sessions.imagePreview` for images referenced by a reply or gadget; revision 7 made previews chunked
 * to fit the 1 MiB secure-record limit and added references for images attached to user messages. A phone
 * reads `host.info` first and treats a missing operation (an older desktop) as "unsupported", not an error.
 */
export const MOBILE_HOST_SURFACE_REVISION = 7 as const;
export type MobileReadOperation = 'hosts.list' | 'host.info' | 'projects.snapshot' | 'work.list' | 'sessions.list' | 'sessions.get' | 'sessions.usage' | 'workflows.list' | 'workflowRuns.list' | 'workflowRuns.get' | 'changes.get' | 'attention.list' | 'providers.list' | 'models.list' | 'access.get' | 'sessions.imagePreview';
export type MobileCommandOperation = 'sessions.create' | 'sessions.continue' | 'sessions.cancel' | 'sessions.configure' | 'workflowRuns.start' | 'workflowRuns.cancel' | 'workflowRuns.retryStage' | 'permissions.respond' | 'workflowGates.approve' | 'workflowGates.reject' | 'gadgets.submit';
export type MobileOperation = MobileReadOperation | MobileCommandOperation;
export interface MobileCaller { deviceId: string; subject?: string; capabilities: readonly MobileCapability[]; }
export interface MobileTarget { hostId: string; projectId?: string; sessionId?: string; runId?: string; requestId?: string; }
export interface MobileCommand<TPayload = unknown> { protocolVersion: typeof MOBILE_PROTOCOL_VERSION; commandId: string; issuedAt: string; caller: MobileCaller; target: MobileTarget; operation: MobileCommandOperation; expectedVersion?: number; payload: TPayload; }
/** Operation-specific read arguments for model, diff, and image-preview reads. */
export interface MobileReadParams {
  provider?: string;
  refresh?: boolean;
  path?: string;
  /** Base64 character offset for a chunked `sessions.imagePreview` response. */
  offset?: number;
  /** Source event and image index for an image attached to a user message. */
  eventIndex?: number;
  attachmentIndex?: number;
}
export interface MobileReadRequest { protocolVersion: typeof MOBILE_PROTOCOL_VERSION; requestId: string; caller: MobileCaller; target: MobileTarget; operation: MobileReadOperation; cursor?: string; limit?: number; params?: MobileReadParams; }
export interface MobileEventCursor { hostId: string; projectId?: string; sequence: number; }
export interface MobileEventEnvelope<TEvent = unknown> { protocolVersion: typeof MOBILE_PROTOCOL_VERSION; eventId: string; sequence: number; emittedAt: string; target: MobileTarget; event: TEvent; }
export type MobileProtocolErrorCode = 'unsupported-version' | 'invalid-envelope' | 'unauthenticated' | 'forbidden' | 'stale-version' | 'duplicate-command' | 'command-conflict' | 'not-found' | 'host-offline' | 'cursor-expired';
export interface MobileProtocolError { code: MobileProtocolErrorCode; message: string; retryable: boolean; commandId?: string; currentVersion?: number; }

/** `host.info`: what this desktop serves, and where its event stream currently ends. */
export interface MobileHostInfo {
  hostId: string;
  hostName: string;
  protocolVersion: typeof MOBILE_PROTOCOL_VERSION;
  surfaceRevision: number;
  readOperations: readonly MobileReadOperation[];
  commandOperations: readonly MobileCommandOperation[];
  /** Highest event sequence appended so far. Replay after this to follow live changes. */
  latestSequence: number;
  /** Changes whenever the desktop process restarts; event sequences restart with it. */
  hostEpoch: string;
  /** The desktop's current theme, once its window has applied one (revision 4). */
  appearance?: MobileAppearance;
}

/**
 * The desktop's theme resolved to plain colours, so the phone can wear it
 * without knowing any theme's definition. Every colour is `#rrggbb`.
 */
export interface MobileAppearance {
  themeId: string;
  themeName: string;
  mode: 'light' | 'dark';
  colors: MobileAppearanceColors;
  /** The surface motif (the hexagon watermark and friends) as the desktop paints it; absent when it paints none. */
  motif?: MobileMotif;
}
/**
 * A still rendering of the desktop's motif: the same SVG images the desktop
 * paints, with where each sits. A `corner` layer is anchored to that corner at
 * its own size; `center` layers repeat as a tile across the whole surface.
 */
export interface MobileMotif {
  /** Final strength of the layer, 0..1, after the desktop's intensity dial. */
  opacity: number;
  layers: MobileMotifLayer[];
  /** The desktop window the motif was laid out for, so a smaller screen can keep its proportions. */
  viewport?: { width: number; height: number };
}
export type MobileMotifAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
export interface MobileMotifLayer {
  svg: string;
  width: number;
  height: number;
  anchor: MobileMotifAnchor;
  repeat: boolean;
}
const MOTIF_ANCHORS: readonly MobileMotifAnchor[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
const MAX_MOTIF_SVG = 200_000;

function normalizeMobileMotif(value: unknown): MobileMotif | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<MobileMotif>;
  if (typeof candidate.opacity !== 'number' || !(candidate.opacity > 0) || !Array.isArray(candidate.layers)) return undefined;
  const layers: MobileMotifLayer[] = [];
  for (const layer of candidate.layers.slice(0, 4) as Partial<MobileMotifLayer>[]) {
    if (!layer || typeof layer.svg !== 'string' || !layer.svg.startsWith('<svg') || layer.svg.length > MAX_MOTIF_SVG) return undefined;
    if (!MOTIF_ANCHORS.includes(layer.anchor as MobileMotifAnchor)) return undefined;
    const size = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 4000;
    if (!size(layer.width) || !size(layer.height)) return undefined;
    layers.push({ svg: layer.svg, width: layer.width, height: layer.height, anchor: layer.anchor as MobileMotifAnchor, repeat: layer.repeat === true });
  }
  const viewport = candidate.viewport;
  const fits = viewport && [viewport.width, viewport.height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 100 && n <= 10_000);
  return layers.length
    ? { opacity: Math.min(1, candidate.opacity), layers, ...(fits ? { viewport: { width: viewport!.width, height: viewport!.height } } : {}) }
    : undefined;
}
export interface MobileAppearanceColors {
  bg: string;
  bgElevated: string;
  bgSunken: string;
  bgInput: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentContrast: string;
  success: string;
  warning: string;
  danger: string;
}
export const MOBILE_APPEARANCE_COLOR_KEYS: readonly (keyof MobileAppearanceColors)[] = [
  'bg', 'bgElevated', 'bgSunken', 'bgInput', 'border', 'borderStrong', 'text', 'textSecondary',
  'textTertiary', 'accent', 'accentContrast', 'success', 'warning', 'danger',
];
/** Host-wide events, delivered to every paired phone whatever projects it is granted. */
export type MobileHostEvent = { type: 'host.appearance'; appearance: MobileAppearance };

const HEX_COLOR = /^#[0-9a-f]{6}$/;
/** A well-formed appearance, or undefined: anything else is dropped rather than painted. */
export function normalizeMobileAppearance(value: unknown): MobileAppearance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<MobileAppearance>;
  if (typeof candidate.themeId !== 'string' || !candidate.themeId.trim()) return undefined;
  if (candidate.mode !== 'light' && candidate.mode !== 'dark') return undefined;
  if (!candidate.colors || typeof candidate.colors !== 'object') return undefined;
  const colors = {} as MobileAppearanceColors;
  for (const key of MOBILE_APPEARANCE_COLOR_KEYS) {
    const color = (candidate.colors as unknown as Record<string, unknown>)[key];
    if (typeof color !== 'string' || !HEX_COLOR.test(color.toLowerCase())) return undefined;
    colors[key] = color.toLowerCase();
  }
  const themeId = candidate.themeId.trim().slice(0, 120);
  const themeName = typeof candidate.themeName === 'string' && candidate.themeName.trim() ? candidate.themeName.trim().slice(0, 120) : themeId;
  const motif = normalizeMobileMotif(candidate.motif);
  return { themeId, themeName, mode: candidate.mode, colors, ...(motif ? { motif } : {}) };
}

export type MobileSessionMode = 'chat' | 'analysis' | 'review';
export type MobileProviderUnavailableReason = 'disabled' | 'not-configured' | 'cli-unavailable';
/**
 * A provider as the phone may see it. Deliberately omits every private desktop
 * detail the settings UI shows — API keys, key source, base URLs, CLI paths.
 */
export interface MobileProviderOption {
  provider: string;
  label: string;
  kind: 'api' | 'cli-agent';
  /** Configured and enabled on the desktop — the only providers a new session may use. */
  available: boolean;
  unavailableReason?: MobileProviderUnavailableReason;
  /** Human-readable reason, suitable to show as-is. */
  unavailableMessage?: string;
  /** The model a session uses when none is chosen, when the desktop has one configured. */
  defaultModel?: string;
}
export interface MobileSessionModeOption { mode: MobileSessionMode; available: boolean; toolAccess: 'full' | 'read-only'; unavailableMessage?: string; }
/** `providers.list`. */
export interface MobileProviderCatalog {
  defaultProvider: string;
  defaultModel?: string;
  providers: readonly MobileProviderOption[];
  sessionModes: readonly MobileSessionModeOption[];
}
export interface MobileModelOption { modelId: string; name: string; contextLength?: number; }
/** `models.list` (params.provider). `unavailable` means the list could not be read; only the provider default is then offered. */
export interface MobileModelCatalog {
  provider: string;
  status: 'ok' | 'unavailable' | 'provider-unavailable';
  message?: string;
  defaultModel?: string;
  models: readonly MobileModelOption[];
}
/**
 * Payload of `sessions.configure`, applied between turns with the desktop's own
 * rules: a different provider is a handover (the desktop sends that provider a
 * handover brief and starts a turn), a model on the same provider switches in
 * place, and a mode applies to the next turn.
 */
export interface MobileConfigureSessionPayload { provider?: string; model?: string; mode?: MobileSessionMode; }
/** Payload of `sessions.create`. provider/model/mode are validated against the desktop's catalog. */
export interface MobileCreateSessionPayload { title?: string; message: string; provider?: string; model?: string; mode?: MobileSessionMode; }

export interface MobileTokenUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
/**
 * `sessions.usage`. Running totals from the desktop's session record — never
 * estimated. `costStatus: 'not-reported'` means the provider reports no cost
 * (API providers do not); it is not zero.
 */
export interface MobileSessionUsage {
  sessionId: string;
  provider?: string;
  providerLabel?: string;
  model?: string;
  lifecycle: MobileSessionLifecycle;
  tokenUsage?: MobileTokenUsage;
  contextTokens?: number;
  contextLimit?: number;
  cost?: { currency: string; amount: number };
  costStatus: 'reported' | 'not-reported';
  sequence: number;
}

/** `access.get`: what the desktop has granted the calling device. */
export interface MobileDeviceAccess {
  deviceId: string;
  label?: string;
  capabilities: readonly MobileCapability[];
  /** Empty when the grant is not project-scoped. */
  projects: readonly { projectId: string; name: string }[];
  pairedAt?: string;
  lastSeenAt?: string;
  hostName: string;
  hostKeyFingerprint?: string;
  accessMode: 'off' | 'local-only' | 'internet';
  transport: 'noise-ik';
  protocolVersion: typeof MOBILE_PROTOCOL_VERSION;
  surfaceRevision: number;
}

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
  mode: MobileSessionMode;
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
  /**
   * Gadgets the message asked for, in order (revision 5). Their fenced JSON is removed from
   * `text`, so a phone that cannot draw one shows its `gadget.fallbackText` instead.
   */
  gadgets?: readonly MobileGadgetView[];
  /** Images attached to this user message; bytes are fetched in bounded chunks from the host. */
  attachments?: readonly MobileSessionImageAttachment[];
  tokenUsage?: MobileTokenUsage;
  cost?: { currency: string; amount: number };
}
export interface MobileSessionImageAttachment {
  eventIndex: number;
  attachmentIndex: number;
  mimeType: string;
}
/** A gadget as the host resolves it now: the envelope, whether it still accepts an answer, and the answer's outcome. */
export interface MobileGadgetView {
  gadget: AnyGadgetEnvelope;
  state: GadgetLifecycleState;
  result?: { status: GadgetActionStatus; message?: string };
}
/** `gadgets.submit` payload. Scope comes from the host's own record of the gadget, never from the phone. */
export interface MobileGadgetSubmitPayload {
  gadgetId: string;
  actionId: string;
  value: GadgetActionValue;
  /** Stable per logical answer, so a retried command cannot record it twice. */
  idempotencyKey: string;
}
/** A file in a session's working tree that differs from HEAD (`changes.get` with `target.sessionId`). */
export interface MobileChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'conflicted';
  additions?: number;
  deletions?: number;
  /** The session's own tools reported editing it; other changes were already in the tree. */
  reportedBySession: boolean;
}
/** `sessions.imagePreview`: a bounded base64 chunk from a local or attached image. */
export interface MobileImagePreview {
  mimeType?: string;
  /** A base64 slice aligned to a 4-character boundary. */
  dataBase64?: string;
  /** Character offset for the next request; equal to totalLength when complete. */
  nextOffset?: number;
  /** Length of the complete base64 payload in characters. */
  totalLength?: number;
}
export interface MobileSessionChanges {
  sessionId: string;
  /** False when the session's folder is not a git repository — nothing to compare. */
  repository: boolean;
  branch?: string;
  files: readonly MobileChangedFile[];
}
export interface MobileDiffLine { kind: 'context' | 'add' | 'delete'; text: string; oldLine?: number; newLine?: number }
/** One file's working-tree diff (`changes.get` with `params.path`), bounded for a phone. */
export interface MobileFileDiff {
  path: string;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: readonly { header: string; lines: readonly MobileDiffLine[] }[];
  /** Lines were dropped to stay within the phone's bound. */
  truncated: boolean;
}
export interface MobilePendingPermission {
  requestId: string;
  summary: string;
  detail?: string;
  createdAt: string;
}
export interface MobileSessionSnapshot extends MobileSessionSummary {
  /**
   * The host event sequence this snapshot is current as of (`host.info`
   * `latestSequence` for a read, the envelope sequence for an event). A client
   * keeps the snapshot with the higher sequence, so replay never regresses it.
   */
  sequence: number;
  messages: readonly MobileSessionMessage[];
  pendingPermissions: readonly MobilePendingPermission[];
  responseText?: string;
  reasoningText?: string;
  tokenUsage?: MobileTokenUsage;
  contextTokens?: number;
  contextLimit?: number;
  cost?: { currency: string; amount: number };
  canContinue: boolean;
  canCancel: boolean;
}
export type MobileSessionEvent =
  | { type: 'session.snapshot'; snapshot: MobileSessionSnapshot }
  | { type: 'session.removed'; sessionId: string; sessionKey: string };

/** How a stage stands, for the phone's step list: the desktop monitor's lane, not a raw outcome. */
export type MobileRunStageLane = 'idle' | 'ready' | 'running' | 'done' | 'failed' | 'skipped' | 'awaiting' | 'paused';
export interface MobileRunStage {
  nodeId: string;
  name: string;
  /** 'agent-task' | 'check' | 'approval' | 'deployment' | 'join'. */
  type: string;
  lane: MobileRunStageLane;
  attempts: number;
  /** The stage's session (agent stages), so the phone can show its conversation. */
  sessionId?: string;
  sessionKey?: string;
  /** The AI that ran the latest attempt, else the one it is set to use. */
  provider?: string;
  lastError?: string;
  /** Stopped without a verdict: the AI ran out of budget, or the stage's tooling could not run. */
  pause?: 'provider-limit' | 'environment';
  command?: string;
  exitCode?: number;
  gate?: string;
  metrics?: Record<string, number | string>;
  findingsSummary?: Record<string, number>;
  prompt?: string;
}
/**
 * A workflow run as the phone shows it (`workflowRuns.list`, `run.snapshot`): the steps and
 * where the run is, without the desktop monitor's graph, gates or event log.
 */
export interface MobileRunSnapshot {
  runId: string;
  projectId: string;
  workflowName: string;
  /** 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'cancelled'. */
  status: string;
  paused: boolean;
  /** One sentence: why the run is where it is. */
  explanation: string;
  startedAt: string;
  endedAt?: string;
  issueKey?: string;
  /** The run's own AI; a stage may use another. */
  aiProvider?: string;
  aiModel?: string;
  /** The stage the run is at — running, waiting on a person, paused, or the one it ended on. */
  currentNodeId?: string;
  stages: readonly MobileRunStage[];
  /** A person can approve the run's gate now. */
  canApprove: boolean;
  /** Host event sequence this snapshot is current as of; the higher one wins. */
  sequence: number;
}
export type MobileRunEvent =
  | { type: 'run.snapshot'; run: MobileRunSnapshot }
  | { type: 'run.removed'; runId: string };
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CAPABILITY_BY_OPERATION: Record<MobileOperation, MobileCapability> = {
  'hosts.list':'view','host.info':'view','sessions.usage':'view','providers.list':'view','models.list':'view','access.get':'view','projects.snapshot':'view','work.list':'view','sessions.list':'view','sessions.get':'view','workflows.list':'view','workflowRuns.list':'view','workflowRuns.get':'view','changes.get':'view','attention.list':'view','sessions.imagePreview':'view',
  'sessions.create':'execute','sessions.continue':'execute','sessions.configure':'execute','sessions.cancel':'execute','workflowRuns.start':'execute','workflowRuns.cancel':'execute','workflowRuns.retryStage':'execute','permissions.respond':'approve','workflowGates.approve':'approve','workflowGates.reject':'approve',
  // Answering a gadget is a turn in the conversation; an approval-effect answer additionally needs `approve`, checked by the host.
  'gadgets.submit':'execute',
};
export function mobileCapabilityFor(operation: MobileOperation): MobileCapability { return CAPABILITY_BY_OPERATION[operation]; }
export function mobileOperationRequiresMutation(operation: MobileOperation): boolean { return operation in {'sessions.create':true,'sessions.continue':true,'sessions.configure':true,'sessions.cancel':true,'workflowRuns.start':true,'workflowRuns.cancel':true,'workflowRuns.retryStage':true,'permissions.respond':true,'workflowGates.approve':true,'workflowGates.reject':true,'gadgets.submit':true}; }
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
