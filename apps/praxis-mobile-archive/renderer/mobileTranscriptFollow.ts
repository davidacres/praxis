/**
 * Whether a conversation should keep following new output, and how many
 * messages arrived while the reader was scrolled up. The transcript is an
 * inverted list, so offset 0 is the newest message.
 */

/** Within this many points of the newest message counts as "at the bottom". */
export const FOLLOW_THRESHOLD = 48;

export interface TranscriptFollowState {
  following: boolean;
  /** Messages that arrived since the reader scrolled away from the bottom. */
  unseen: number;
  /** Message count when the reader last was at the bottom. */
  seenCount: number;
}

export function initialFollowState(count: number): TranscriptFollowState {
  return { following: true, unseen: 0, seenCount: count };
}

/** The reader scrolled: at the bottom they are following again and have seen everything. */
export function followOnScroll(state: TranscriptFollowState, offset: number, count: number): TranscriptFollowState {
  const atBottom = offset <= FOLLOW_THRESHOLD;
  if (atBottom) return state.following && state.unseen === 0 && state.seenCount === count ? state : { following: true, unseen: 0, seenCount: count };
  return state.following ? { ...state, following: false, seenCount: count } : state;
}

/** Messages changed: while following nothing is unseen; otherwise count the new ones. */
export function followOnMessages(state: TranscriptFollowState, count: number): TranscriptFollowState {
  if (state.following) return state.seenCount === count ? state : { ...state, seenCount: count };
  const unseen = Math.max(0, count - state.seenCount);
  return unseen === state.unseen ? state : { ...state, unseen };
}

export function jumpLabel(unseen: number): string {
  return unseen > 0 ? `${unseen} new · Jump to latest` : 'Jump to latest';
}
