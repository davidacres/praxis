import type {
  AgentSessionRecord,
  CancelTurnCommand,
  ConversationControlCommand,
  ConversationTurn,
  DurableConversation,
  ResolveAttemptCommand,
  RetryParticipantCommand
} from '@praxis/core';

/**
 * The queue/recovery controls for one conversation turn, described as data.
 *
 * The panel used to decide labels, accessible names, enabled/disabled rules and which IPC command
 * to build inline in JSX, so the gating TASK-483 defined (an `outcome_unknown` attempt may only be
 * retried after the user records what they checked *and* accepts the duplicate-action risk) lived
 * in a render expression nobody could test. Everything a control needs — its visible label, its
 * accessible name, its `data-testid`, whether it is enabled and why not, its keyboard hint and the
 * fully fenced command it issues — is derived here, once, from the committed snapshot. The panel
 * renders this list and the e2e specs assert against the same test ids.
 *
 * Accessible names equal the visible labels on purpose: a screen reader already hears the card's
 * `role="group"` name (turn state plus member), and a second, longer name on the button would
 * disagree with what is printed on it.
 */

export type TurnControlKind =
  /** Stop the attempt in flight (`cancelTurn`). */
  | 'stop'
  /** Cancel a turn that has not started (`cancelTurn`). */
  | 'cancel-queued'
  /** Retry the member whose attempt failed or was interrupted (`retryParticipant`). */
  | 'retry'
  /** Re-check a page context the coordinator refused to dispatch without (`control: resume-context`). */
  | 'recheck-context'
  /** Record what the user checked before retrying an unknown outcome (`resolveAttempt: reconcile`). */
  | 'record-reconciliation'
  /** Retry an unknown outcome after acknowledgement + reconciliation (`resolveAttempt: retry`). */
  | 'resolve-retry'
  /** Stop an unknown-outcome turn; the outcome stays unresolved either way (`cancelTurn`). */
  | 'resolve-cancel'
  /** The duplicate-action-risk acknowledgement itself; carries no command. */
  | 'resolve-confirmed'
  /** The reconciliation note field; carries no command. */
  | 'reconciliation-note';

export type TurnControlCommand =
  | { method: 'cancelTurn'; payload: CancelTurnCommand }
  | { method: 'retryParticipant'; payload: RetryParticipantCommand }
  | { method: 'resolveAttempt'; payload: ResolveAttemptCommand }
  | { method: 'control'; payload: ConversationControlCommand };

export interface TurnControlField {
  kind: 'text' | 'checkbox';
  value: string;
  checked?: boolean;
}

export interface TurnControl {
  kind: TurnControlKind;
  /** Visible text for a button; the accessible name for a field. */
  label: string;
  ariaLabel: string;
  testId: string;
  disabled: boolean;
  /** Why a control is disabled, for `title`/screen readers. Never invented for an enabled one. */
  disabledReason?: string;
  /** Human-readable key hint, e.g. `⌘/Ctrl+.` — the binding that resolves to this control. */
  keyHint?: string;
  /** Set when this control is part of recovering a turn, so focus and keys can find it. */
  recovery: boolean;
  field?: TurnControlField;
  command?: TurnControlCommand;
}

/** Turn states that mean "the user has to decide something before this can continue". */
export const RECOVERY_TURN_STATES: readonly string[] = ['failed', 'interrupted', 'outcome_unknown', 'context_required'];

export const TURN_CONTROL_KEY_HINTS = {
  stop: '⌘/Ctrl+.',
  retry: '⌘/Ctrl+Shift+R',
  resolve: '⌘/Ctrl+Enter'
} as const;

/** UI state the panel owns per turn+attempt; the model gates on it rather than holding it. */
export interface TurnControlState {
  /** Keyed `${turnId}:${attemptId}` by the panel, so two interrupted turns never share a note. */
  reconciliationNote?: string;
  acknowledged?: boolean;
  /** The tool session the panel shows a permission card for; kept for callers that gate on it. */
  activeToolSession?: AgentSessionRecord;
}

export interface TurnCard {
  testId: string;
  ariaLabel: string;
  /** `Queued 2`, `Dev: outcome unknown`, … — the card's heading text. */
  heading: string;
  /** The member whose attempt is in flight or needs recovery, when one can be identified. */
  participantId?: string;
  participantRole?: string;
  /** The latest attempt's error, announced with `role="alert"`. */
  alert?: string;
  /** Why the coordinator needs context, announced with its own `role="alert"`. */
  contextAlert?: string;
  needsAttention: boolean;
  controls: TurnControl[];
}

/** The member a turn is waiting on: the first planned participant that has not completed. */
export function activeParticipant(turn: ConversationTurn): ConversationTurn['plan']['participants'][number] | undefined {
  return turn.plan.participants.find(participant => !turn.completedParticipantIds.includes(participant.id));
}

function roleLabel(turn: ConversationTurn): string {
  return activeParticipant(turn)?.role ?? 'Team';
}

function stateLabel(turn: ConversationTurn): string {
  return turn.state.replaceAll('_', ' ');
}

/**
 * Whether a given attempt already carries the reconciliation evidence an `outcome_unknown` retry
 * needs. Evidence is per attempt, so a note recorded against an earlier attempt never unlocks a
 * later one.
 */
export function hasReconciliationEvidence(turn: ConversationTurn, attemptId?: string): boolean {
  return turn.attempts.some(attempt =>
    (attemptId === undefined || attempt.id === attemptId) &&
    Boolean(attempt.recoveryEvidence?.some(evidence => evidence.kind === 'reconciliation')));
}

export interface DescribeTurnControlsOptions {
  /** Mints the command id; injectable so tests can assert an exact fenced payload. */
  commandId?: () => string;
}

/**
 * The controls for one turn, in the order they are rendered.
 *
 * Each command is fenced by `conversationId` + a fresh `commandId` + the revision on screen +
 * `turnId` (+ `attemptId` where the coordinator targets one), so a click against a stale snapshot
 * answers `conflict` with fresh state instead of acting on the wrong attempt.
 */
export function describeTurnControls(
  conversation: DurableConversation,
  turn: ConversationTurn,
  state: TurnControlState = {},
  options: DescribeTurnControlsOptions = {}
): TurnControl[] {
  const commandId = options.commandId ?? (() => crypto.randomUUID());
  const attempt = turn.attempts.at(-1);
  const fence = { conversationId: conversation.id, commandId: commandId(), expectedRevision: conversation.revision, turnId: turn.id };
  const withAttempt = { ...fence, ...(attempt ? { attemptId: attempt.id } : {}) };
  const role = roleLabel(turn);
  const controls: TurnControl[] = [];
  const cancelCommand: TurnControlCommand = { method: 'cancelTurn', payload: withAttempt as CancelTurnCommand };

  if (turn.state === 'queued') {
    controls.push({
      kind: 'cancel-queued',
      label: 'Cancel queued turn',
      ariaLabel: 'Cancel queued turn',
      testId: 'assistant-turn-cancel-queued',
      disabled: false,
      keyHint: TURN_CONTROL_KEY_HINTS.stop,
      recovery: false,
      command: cancelCommand
    });
    return controls;
  }

  if (turn.state === 'context_required') {
    controls.push({
      kind: 'recheck-context',
      label: 'Recheck context',
      ariaLabel: 'Recheck context',
      testId: 'assistant-turn-recheck-context',
      disabled: false,
      keyHint: TURN_CONTROL_KEY_HINTS.resolve,
      recovery: true,
      command: { method: 'control', payload: { ...withAttempt, action: 'resume-context' } as ConversationControlCommand }
    });
  }

  if (turn.state === 'outcome_unknown') {
    const reconciliation = attempt?.recoveryEvidence?.find(evidence => evidence.kind === 'reconciliation');
    const reconciled = Boolean(reconciliation);
    controls.push({
      kind: 'reconciliation-note',
      label: 'What did you check before retrying?',
      ariaLabel: 'What did you check before retrying?',
      testId: 'assistant-turn-reconciliation-note',
      disabled: false,
      recovery: true,
      field: { kind: 'text', value: state.reconciliationNote ?? '' }
    });
    controls.push({
      kind: 'record-reconciliation',
      label: 'Record reconciliation',
      ariaLabel: 'Record reconciliation',
      testId: 'assistant-turn-record-reconciliation',
      disabled: !(state.reconciliationNote ?? '').trim(),
      ...(reconciled ? { disabledReason: 'Reconciliation for this attempt is already recorded.' } : {}),
      keyHint: TURN_CONTROL_KEY_HINTS.resolve,
      recovery: true,
      command: {
        method: 'resolveAttempt',
        payload: {
          ...fence,
          attemptId: attempt?.id ?? '',
          resolution: 'reconcile',
          ...(state.reconciliationNote ? { reconciliationNote: state.reconciliationNote } : {})
        } as ResolveAttemptCommand
      }
    });
    controls.push({
      kind: 'resolve-confirmed',
      label: 'Retry may repeat external actions. I accept this risk.',
      ariaLabel: 'Retry may repeat external actions. I accept this risk.',
      testId: 'assistant-turn-acknowledge-risk',
      disabled: false,
      keyHint: TURN_CONTROL_KEY_HINTS.resolve,
      recovery: true,
      field: { kind: 'checkbox', value: '', checked: Boolean(state.acknowledged) }
    });
    controls.push({
      kind: 'resolve-retry',
      label: `Retry ${role}`,
      ariaLabel: `Retry ${role}`,
      testId: 'assistant-turn-resolve-retry',
      disabled: !state.acknowledged || !reconciled,
      ...(state.acknowledged && reconciled
        ? {}
        : { disabledReason: !reconciled
          ? 'Record what you checked before retrying an unknown outcome.'
          : 'Confirm you accept that a retry may repeat external actions.' }),
      keyHint: TURN_CONTROL_KEY_HINTS.retry,
      recovery: true,
      command: {
        method: 'resolveAttempt',
        payload: {
          ...fence,
          attemptId: attempt?.id ?? '',
          resolution: 'retry',
          acknowledgeDuplicateActionRisk: Boolean(state.acknowledged),
          ...(reconciliation ? { reconciliationEvidenceId: reconciliation.id } : {})
        } as ResolveAttemptCommand
      }
    });
    controls.push({
      kind: 'resolve-cancel',
      label: 'Stop',
      ariaLabel: 'Stop',
      testId: 'assistant-turn-resolve-cancel',
      disabled: false,
      keyHint: TURN_CONTROL_KEY_HINTS.stop,
      recovery: false,
      command: cancelCommand
    });
    return controls;
  }

  if (['failed', 'interrupted'].includes(turn.state)) {
    controls.push({
      kind: 'retry',
      label: `Retry ${role}`,
      ariaLabel: `Retry ${role}`,
      testId: 'assistant-turn-retry',
      disabled: !attempt,
      ...(attempt ? {} : { disabledReason: 'This turn has no attempt to retry.' }),
      keyHint: TURN_CONTROL_KEY_HINTS.retry,
      recovery: true,
      command: {
        method: 'retryParticipant',
        payload: { ...fence, attemptId: attempt?.id ?? '', participantId: attempt?.participantId ?? '' } as RetryParticipantCommand
      }
    });
  }

  controls.push({
    kind: 'stop',
    label: turn.state === 'cancelling' ? 'Stopping…' : 'Stop',
    ariaLabel: turn.state === 'cancelling' ? 'Stopping…' : 'Stop',
    testId: 'assistant-turn-stop',
    disabled: turn.state === 'cancelling',
    ...(turn.state === 'cancelling' ? { disabledReason: 'A stop command is already in flight.' } : {}),
    keyHint: TURN_CONTROL_KEY_HINTS.stop,
    recovery: false,
    command: cancelCommand
  });

  return controls;
}

/** One queue/recovery card: its accessible name, the alert line and its controls. */
export function describeTurnCard(
  conversation: DurableConversation,
  turn: ConversationTurn,
  queuePosition: number,
  state: TurnControlState = {},
  options: DescribeTurnControlsOptions = {}
): TurnCard {
  const participant = activeParticipant(turn);
  const attempt = turn.attempts.at(-1);
  const controls = describeTurnControls(conversation, turn, state, options);
  const alert = attempt?.error;
  return {
    testId: 'assistant-turn-status',
    ariaLabel: turn.state === 'queued'
      ? `Queued turn ${queuePosition}`
      : `Turn for ${participant?.role ?? 'the team'}: ${stateLabel(turn)}`,
    heading: turn.state === 'queued' ? `Queued ${queuePosition}` : `${participant?.role ?? 'Team'}: ${stateLabel(turn)}`,
    ...(participant ? { participantId: participant.id, participantRole: participant.role } : {}),
    ...(alert ? { alert } : {}),
    ...(turn.contextRequiredReason ? { contextAlert: turn.contextRequiredReason } : {}),
    needsAttention: RECOVERY_TURN_STATES.includes(turn.state),
    controls
  };
}

/** The cards a panel shows: every turn that is not settled, oldest first. */
export function describeTurnCards(
  conversation: DurableConversation | undefined,
  stateFor: (turn: ConversationTurn) => TurnControlState,
  options: DescribeTurnControlsOptions = {}
): Array<{ turn: ConversationTurn; card: TurnCard }> {
  if (!conversation) return [];
  const open = conversation.turns.filter(turn => !['completed', 'cancelled'].includes(turn.state));
  // The position is the turn's place among the unsettled turns, so "Queued 2" means "second in
  // this queue", matching what the panel has always printed.
  return open.map((turn, index) => ({
    turn,
    card: describeTurnCard(conversation, turn, index + 1, stateFor(turn), options)
  }));
}

export interface TurnKeyBinding {
  /** `mod` means Ctrl on Windows/Linux and Cmd on macOS. */
  combo: 'mod';
  key: string;
  kinds: readonly TurnControlKind[];
  /** `first` targets the turn already in flight; `last` the most recent retryable one. */
  select: 'first' | 'last';
  /** Whether Shift must be held; a binding never fires with the opposite Shift state. */
  shift?: boolean;
  /** When set, the binding only fires if it is the sole enabled recovery action on the panel. */
  onlyRecoveryAction?: boolean;
  /**
   * Whether the binding may fire from an editing surface (the composer, the reconciliation note).
   * Only Stop does: the composer sends on Enter, so a modified Enter from it is a send, not a
   * recovery decision.
   */
  whileEditing?: boolean;
  description: string;
}

/** The documented panel key bindings, in the order they are checked. */
export const TURN_KEY_BINDINGS: readonly TurnKeyBinding[] = [
  { combo: 'mod', key: '.', kinds: ['stop', 'cancel-queued', 'resolve-cancel'], select: 'first', whileEditing: true, description: 'Stop the turn in flight, or cancel the queued one' },
  // Shift+R, not R: ⌘/Ctrl+R is the conventional reload chord, and a binding that only sometimes
  // swallows it (when a retry happens to be actionable) would be surprising.
  { combo: 'mod', key: 'r', shift: true, kinds: ['retry', 'resolve-retry'], select: 'last', description: 'Retry the most recent retryable attempt' },
  { combo: 'mod', key: 'Enter', kinds: ['record-reconciliation', 'recheck-context'], select: 'last', onlyRecoveryAction: true, description: 'Record the reconciliation, or recheck the context, when it is the only recovery action available' }
];

export interface TurnKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** The press came from an input, textarea or contenteditable element. */
  fromEditingSurface?: boolean;
}

/** Whether a key event target is an editing surface, where only Stop may fire. */
export function isEditingSurface(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: string; isContentEditable?: boolean };
  const tag = (element.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true;
}

/**
 * The control a key press resolves to — the same one a click would issue, so the keyboard and
 * pointer paths cannot drift. `undefined` means "not ours", and the panel must not preventDefault.
 *
 * Every binding needs a modifier, so printable typing in the composer never reaches one. Presses
 * from an editing surface reach only the bindings marked `whileEditing` (Stop): the composer sends
 * on any unshifted Enter, so ⌘/Ctrl+Enter there must not also record a reconciliation.
 */
export function resolveTurnKeyBinding(event: TurnKeyEvent, cards: readonly TurnCard[]): TurnControl | undefined {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return undefined;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const binding = TURN_KEY_BINDINGS.find(candidate =>
    candidate.key.toLowerCase() === key.toLowerCase() && Boolean(candidate.shift) === Boolean(event.shiftKey));
  if (!binding) return undefined;
  if (event.fromEditingSurface && !binding.whileEditing) return undefined;
  const actionable = (control: TurnControl) => !control.disabled && Boolean(control.command);
  const ordered = cards.flatMap(card => card.controls);
  const matching = ordered.filter(control => binding.kinds.includes(control.kind) && actionable(control));
  if (matching.length === 0) return undefined;
  if (binding.onlyRecoveryAction) {
    const recovery = ordered.filter(control => control.recovery && actionable(control));
    if (recovery.length !== 1) return undefined;
  }
  return binding.select === 'first' ? matching[0] : matching.at(-1);
}
