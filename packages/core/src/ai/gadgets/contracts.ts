/**
 * Versioned, browser-safe contracts for interactive chat gadgets (FX-BE-097).
 *
 * Everything here is *data*. A gadget describes a surface and the actions it
 * offers; it never carries code, a callback or a provider credential. The
 * renderer picks an implementation by `kind` + `version`, and a client that
 * knows neither still has `fallbackText` to show. That is the whole reason the
 * fallback is a required field rather than something a renderer derives: an
 * older desktop build, a mobile client or a plain-text transcript must all be
 * able to represent a gadget they cannot draw.
 */

/**
 * Bumped only for a breaking change to the envelope or action shape. A renderer
 * registers per (kind, version), so two versions of one kind can coexist while
 * clients catch up.
 */
export const GADGET_CONTRACT_VERSION = 1;

/** The kinds Praxis ships. An unknown kind is not an error — it degrades to text. */
export const GADGET_KINDS = [
  'choice',
  'confirmation',
  'form',
  'table',
  'chart',
  'progress',
  'diff',
  'artifact',
  'handoff',
  'conflict',
  'approval'
] as const;

export type GadgetKind = (typeof GADGET_KINDS)[number];

// ── Scope ────────────────────────────────────────────────────────────────
//
// Every gadget is pinned to where it was issued. An action replayed against a
// different session, project or host is refused rather than applied to whatever
// happens to be open now — which is the failure mode that makes "approve" on a
// second device dangerous.

export interface GadgetScope {
  hostId: string;
  /** Absent for a gadget issued outside any project (a free-form session). */
  projectId?: string;
  sessionId: string;
  /** Issue key, workflow run, or another unit of work this gadget belongs to. */
  workId?: string;
  /** Monotonic marker for the scope's state; a mismatch means "stale", not "denied". */
  revision?: number;
}

// ── Actions ──────────────────────────────────────────────────────────────

/**
 * What submitting an action actually does.
 *
 * `informational` never mutates, so it needs no gate. `mutating` and `approval`
 * both pass through the workflow gate named by the descriptor — a gadget cannot
 * grant itself authority it was not issued with.
 */
export type GadgetActionEffect = 'informational' | 'mutating' | 'approval';

export interface GadgetActionDescriptor {
  actionId: string;
  label: string;
  effect: GadgetActionEffect;
  /** Required for `mutating` / `approval`: the workflow gate the action satisfies. */
  gate?: string;
  /** Renders the control as destructive and requires explicit confirmation. */
  danger?: boolean;
  description?: string;
}

export type GadgetActionValue =
  | { kind: 'none' }
  | { kind: 'choice'; selected: string }
  | { kind: 'confirmation'; confirmed: boolean }
  | { kind: 'form'; fields: Record<string, string | number | boolean> }
  | { kind: 'selection'; selected: readonly string[] };

/** A user's submission. `idempotencyKey` is what makes a retry safe. */
export interface GadgetAction {
  version: number;
  gadgetId: string;
  actionId: string;
  scope: GadgetScope;
  /** Stable per logical submission — a retry reuses it, a new decision does not. */
  idempotencyKey: string;
  /** Ties the submission, its result and any downstream evidence together. */
  correlationId: string;
  submittedAt: string;
  value: GadgetActionValue;
}

export type GadgetActionStatus = 'accepted' | 'rejected' | 'completed' | 'failed';

export interface GadgetActionResult {
  version: number;
  gadgetId: string;
  actionId: string;
  correlationId: string;
  idempotencyKey: string;
  status: GadgetActionStatus;
  at: string;
  /** True when this result was served from the ledger rather than freshly executed. */
  replay?: boolean;
  error?: GadgetError;
  /** Host-supplied outcome for a completed action (a diff applied, a run started…). */
  outcome?: unknown;
  /** Human-readable summary, always safe to show verbatim. */
  message?: string;
}

// ── Errors ───────────────────────────────────────────────────────────────

export type GadgetErrorCode =
  | 'unsupported-kind'
  | 'unsupported-version'
  | 'payload-too-large'
  | 'schema-invalid'
  | 'capability-denied'
  | 'scope-mismatch'
  | 'gadget-expired'
  | 'gadget-superseded'
  | 'gadget-not-found'
  | 'already-submitted'
  | 'duplicate-action'
  | 'gate-required'
  | 'unknown-action'
  | 'value-invalid';

export interface GadgetError {
  code: GadgetErrorCode;
  /** Written for the user, not the log — it is rendered in the gadget. */
  message: string;
  /** Dot path into the payload for a schema failure. */
  path?: string;
  retryable?: boolean;
}

// ── Lifecycle ────────────────────────────────────────────────────────────

/**
 * `active` is the only state that accepts an action. The rest all render the
 * gadget visibly inert, each for a different reason the user needs to see:
 * they already answered, it timed out, a newer gadget replaced it, or the
 * client lost the connection and cannot vouch for the state.
 */
export type GadgetLifecycleState =
  | 'active'
  | 'submitting'
  | 'submitted'
  | 'completed'
  | 'expired'
  | 'superseded'
  | 'revoked'
  | 'disconnected';

export const GADGET_ACTIONABLE_STATES: readonly GadgetLifecycleState[] = ['active'];

// ── Payloads ─────────────────────────────────────────────────────────────

export interface GadgetChoiceOption {
  value: string;
  label: string;
  description?: string;
  /** Renders the option as unavailable while keeping it visible and explained. */
  disabledReason?: string;
}

export interface ChoiceGadgetPayload {
  question: string;
  options: GadgetChoiceOption[];
  detail?: string;
  /** Allows more than one option; the action value becomes a `selection`. */
  multiple?: boolean;
  defaultValue?: string;
}

export interface ConfirmationGadgetPayload {
  question: string;
  detail?: string;
  /** Rendered as a bulleted list of what will change if confirmed. */
  consequences?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
}

export type GadgetFormFieldType = 'text' | 'textarea' | 'number' | 'boolean' | 'select';

export interface GadgetFormField {
  name: string;
  label: string;
  type: GadgetFormFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  defaultValue?: string | number | boolean;
  options?: GadgetChoiceOption[];
  maxLength?: number;
  min?: number;
  max?: number;
}

export interface FormGadgetPayload {
  title: string;
  description?: string;
  fields: GadgetFormField[];
}

export interface GadgetTableColumn {
  key: string;
  label: string;
  align?: 'start' | 'end';
  /** Renders the cell in the monospace ramp — paths, hashes, durations. */
  mono?: boolean;
}

export interface TableGadgetPayload {
  title?: string;
  columns: GadgetTableColumn[];
  rows: Record<string, string | number | boolean | null>[];
  caption?: string;
  /** Set when rows were trimmed to the bound, so the UI can say so honestly. */
  truncated?: boolean;
  emptyText?: string;
}

export interface GadgetChartSeries {
  label: string;
  points: { x: string | number; y: number }[];
}

export interface ChartGadgetPayload {
  title?: string;
  /** Deliberately a tiny set — a gadget is not a charting library. */
  chartKind: 'bar' | 'line';
  series: GadgetChartSeries[];
  xLabel?: string;
  yLabel?: string;
  /** Always present so a client that cannot draw still shows the numbers. */
  summary?: string;
}

export interface ProgressGadgetPayload {
  title: string;
  /** Omit for indeterminate work — the renderer shows an unbounded indicator. */
  percent?: number;
  status: 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';
  detail?: string;
  steps?: { label: string; state: 'pending' | 'running' | 'done' | 'failed' }[];
}

export interface GadgetDiffFile {
  path: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string;
  /** Bounded preview only. The full diff stays in the Changes workspace. */
  preview?: string;
}

export interface DiffGadgetPayload {
  title?: string;
  files: GadgetDiffFile[];
  summary?: string;
  truncated?: boolean;
  /** Opens the existing diff workspace rather than re-implementing it here. */
  openInChangesRef?: string;
}

export interface ArtifactGadgetPayload {
  title: string;
  artifacts: {
    name: string;
    /** Workspace-relative; an absolute path outside the scope is refused. */
    path: string;
    mediaType?: string;
    sizeBytes?: number;
    description?: string;
  }[];
}

export interface HandoffGadgetPayload {
  title: string;
  fromProvider: string;
  toProvider: string;
  /** What the receiving provider will be told — reviewable before approval. */
  contextSummary: string;
  includedItems?: { label: string; detail?: string }[];
  excludedItems?: { label: string; reason?: string }[];
  warning?: string;
}

export interface ConflictGadgetPayload {
  title: string;
  description?: string;
  conflicts: {
    id: string;
    label: string;
    /** Each side is presented as-is; Praxis never picks silently. */
    ours: string;
    theirs: string;
    path?: string;
  }[];
}

export interface ApprovalGadgetPayload {
  title: string;
  summary: string;
  /** The workflow gate this approval satisfies; mirrored on the action. */
  gate: string;
  requestedBy?: string;
  evidence?: { label: string; value: string }[];
  /** Rendered prominently — the user is told exactly what approving unblocks. */
  effect?: string;
  /**
   * The workflow run node this approval settles, when it was issued for a real
   * run rather than a fixture. Absent for a synthetic or standalone approval.
   */
  nodeId?: string;
}

export interface GadgetPayloadMap {
  choice: ChoiceGadgetPayload;
  confirmation: ConfirmationGadgetPayload;
  form: FormGadgetPayload;
  table: TableGadgetPayload;
  chart: ChartGadgetPayload;
  progress: ProgressGadgetPayload;
  diff: DiffGadgetPayload;
  artifact: ArtifactGadgetPayload;
  handoff: HandoffGadgetPayload;
  conflict: ConflictGadgetPayload;
  approval: ApprovalGadgetPayload;
}

// ── Envelope and blocks ──────────────────────────────────────────────────

export interface GadgetEnvelope<K extends GadgetKind = GadgetKind> {
  version: number;
  gadgetId: string;
  kind: K;
  scope: GadgetScope;
  issuedAt: string;
  /** ISO timestamp after which the gadget stops accepting actions. */
  expiresAt?: string;
  /** The gadget this one replaces, during a streaming update. */
  supersedes?: string;
  /** Required: what a client that cannot render this kind shows instead. */
  fallbackText: string;
  payload: GadgetPayloadMap[K];
  /** Empty for an informational gadget. */
  actions: GadgetActionDescriptor[];
  state?: GadgetLifecycleState;
  /** Set by validation when a secret-shaped string was masked in the payload. */
  redacted?: boolean;
}

export type AnyGadgetEnvelope = {
  [K in GadgetKind]: GadgetEnvelope<K>;
}[GadgetKind];

/**
 * A response is an ordered list of blocks. Markdown and gadgets interleave, so
 * a model can explain itself and then ask — which is the whole point.
 */
export type ChatBlock =
  | { type: 'markdown'; blockId: string; markdown: string }
  | { type: 'gadget'; blockId: string; gadget: AnyGadgetEnvelope }
  /** What a rejected or unrenderable gadget collapses to. Never silent. */
  | { type: 'fallback'; blockId: string; text: string; reason?: GadgetError };

/** What a client tells the host it can draw, so the host can pre-fall-back. */
export interface GadgetCapability {
  version: number;
  kinds: readonly GadgetKind[];
  /** A narrow client opts out of wide surfaces rather than rendering them badly. */
  maxTableRows?: number;
}

export const DESKTOP_GADGET_CAPABILITY: GadgetCapability = {
  version: GADGET_CONTRACT_VERSION,
  kinds: GADGET_KINDS
};

/**
 * Mobile renders the same contract, but a phone-width table past ~50 rows is a
 * scroll trap, so the host trims before sending rather than the client hiding.
 */
export const MOBILE_GADGET_CAPABILITY: GadgetCapability = {
  version: GADGET_CONTRACT_VERSION,
  kinds: GADGET_KINDS,
  maxTableRows: 50
};
