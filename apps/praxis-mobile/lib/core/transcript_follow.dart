// Whether a conversation should keep following new output, and how many
// messages arrived while the reader was scrolled up. Offset 0 is the newest
// message (the list is reversed). Port of `renderer/mobileTranscriptFollow.ts`.

const double followThreshold = 48;

class FollowState {
  const FollowState({required this.following, required this.unseen, required this.seenCount});
  factory FollowState.initial(int count) => FollowState(following: true, unseen: 0, seenCount: count);

  final bool following;
  final int unseen;
  final int seenCount;
}

FollowState followOnScroll(FollowState state, double offset, int count) {
  final atBottom = offset <= followThreshold;
  if (atBottom) {
    return state.following && state.unseen == 0 && state.seenCount == count ? state : FollowState(following: true, unseen: 0, seenCount: count);
  }
  return state.following ? FollowState(following: false, unseen: state.unseen, seenCount: count) : state;
}

FollowState followOnMessages(FollowState state, int count) {
  if (state.following) return state.seenCount == count ? state : FollowState(following: true, unseen: state.unseen, seenCount: count);
  final unseen = (count - state.seenCount).clamp(0, 1 << 30);
  return unseen == state.unseen ? state : FollowState(following: false, unseen: unseen, seenCount: state.seenCount);
}

String jumpLabel(int unseen) => unseen > 0 ? '$unseen new · Jump to latest' : 'Jump to latest';
