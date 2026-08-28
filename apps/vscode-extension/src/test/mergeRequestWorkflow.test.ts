import * as assert from 'node:assert';
import {
  buildMergeRequestFailureReplyComment,
  buildMergeRequestFeedbackTaskDefinition,
  buildMergeRequestReplyComment,
  parseMergeRequestFeedbackResult
} from '@praxis/core';

suite('mergeRequestWorkflow', () => {
  test('builds a merge request feedback task definition with a structured result contract', () => {
    const task = buildMergeRequestFeedbackTaskDefinition(
      {
        key: 'KAMAI-45',
        summary: 'Address review feedback',
        issueType: 'Story',
        status: 'Done',
        description: 'Follow up on review comments.'
      },
      {
        branchName: 'KAMAI-45-address-review-feedback',
        worktreePath: 'C:/worktrees/KAMAI-45-address-review-feedback',
        mergeRequestUrl: 'https://git.example/mr/1',
        sourceBranch: 'KAMAI-45-address-review-feedback',
        targetBranch: 'master',
        notes: [
          {
            author: 'reviewer',
            body: 'Please update the validation path.',
            updatedAt: '2026-04-16T10:00:00Z'
          }
        ]
      }
    );

    assert.strictEqual(task.kind, 'jira-delivery');
    assert.ok(task.goal.includes('merge request feedback'));
    assert.ok(task.completionContract?.includes('MERGE_REQUEST_FEEDBACK_RESULT'));
  });

  test('parses a structured merge request feedback result', () => {
    const result = parseMergeRequestFeedbackResult([
      'Done.',
      '',
      'MERGE_REQUEST_FEEDBACK_RESULT',
      '',
      '```json',
      '{',
      '  "status": "success",',
      '  "summary": "Updated validation to address the review note.",',
      '  "branch": "KAMAI-45-address-review-feedback",',
      '  "replyComment": "I updated the validation path and pushed the change.",',
      '  "commitHash": "abc123",',
      '  "pushedRef": "origin/KAMAI-45-address-review-feedback",',
      '  "didEditCode": true',
      '}',
      '```'
    ].join('\n'));

    assert.deepStrictEqual(result, {
      status: 'success',
      summary: 'Updated validation to address the review note.',
      branch: 'KAMAI-45-address-review-feedback',
      replyComment: 'I updated the validation path and pushed the change.',
      commitHash: 'abc123',
      pushedRef: 'origin/KAMAI-45-address-review-feedback',
      didEditCode: true,
      failureReason: undefined
    });
  });

  test('builds reply comments that include push metadata when code changed', () => {
    const comment = buildMergeRequestReplyComment({
      status: 'success',
      summary: 'Done.',
      branch: 'KAMAI-45-address-review-feedback',
      replyComment: 'I updated the validation path and pushed the change.',
      commitHash: 'abc123',
      pushedRef: 'origin/KAMAI-45-address-review-feedback',
      didEditCode: true
    });

    assert.ok(comment.includes('Updated branch: KAMAI-45-address-review-feedback'));
    assert.ok(comment.includes('Commit: abc123'));
  });

  test('builds a concise failure reply comment', () => {
    const comment = buildMergeRequestFailureReplyComment('The worktree could not be opened.');
    assert.ok(comment.includes('could not fully process'));
    assert.ok(comment.includes('The worktree could not be opened.'));
  });
});