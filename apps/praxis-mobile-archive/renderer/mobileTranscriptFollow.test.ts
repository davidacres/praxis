import assert from 'node:assert/strict';
import test from 'node:test';
import { followOnMessages, followOnScroll, initialFollowState, jumpLabel } from './mobileTranscriptFollow';

test('at the bottom the transcript follows and nothing is unseen', () => {
  let state = initialFollowState(3);
  state = followOnMessages(state, 5);
  assert.deepEqual(state, { following: true, unseen: 0, seenCount: 5 });
});

test('scrolled up, new messages are counted instead of pulling the reader down', () => {
  let state = initialFollowState(3);
  state = followOnScroll(state, 400, 3);
  assert.equal(state.following, false);
  state = followOnMessages(state, 4);
  state = followOnMessages(state, 6);
  assert.equal(state.unseen, 3);
  assert.equal(jumpLabel(state.unseen), '3 new · Jump to latest');
  // A streaming message growing does not change the count.
  assert.equal(followOnMessages(state, 6), state);
});

test('returning to the bottom resumes following and clears the count', () => {
  let state = followOnMessages(followOnScroll(initialFollowState(3), 400, 3), 5);
  state = followOnScroll(state, 10, 5);
  assert.deepEqual(state, { following: true, unseen: 0, seenCount: 5 });
  assert.equal(jumpLabel(0), 'Jump to latest');
});
