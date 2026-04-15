import * as assert from 'node:assert';
import { extractPendingCopilotReplyRequest } from '../extension';
import type { IssueDetails } from '../types';

function createIssueWithComments(
  comments: NonNullable<IssueDetails['comments']>
): IssueDetails {
  return {
    key: 'KAMAI-39',
    summary: 'Test issue',
    issueType: 'Story',
    projectKey: 'KAMAI',
    status: 'Selected for Development',
    comments
  };
}

suite('clarificationReplyTracking', () => {
  test('returns undefined when there is no Copilot-generated comment in the thread', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Dana',
        body: 'Here is some extra context.',
        created: '2026-04-15T09:00:00.000Z'
      }
    ]);

    assert.strictEqual(extractPendingCopilotReplyRequest(issue), undefined);
  });

  test('extracts a user reply that arrives after a Copilot clarification comment', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-2',
        author: 'Dana',
        body: 'The device is already provisioned in the target environment.',
        created: '2026-04-15T09:02:00.000Z'
      },
      {
        id: 'comment-1',
        author: 'Dana',
        body: 'This is an AI-generated message.\nCopilot clarification request\n\nWhich environment should this target?',
        created: '2026-04-15T09:00:00.000Z'
      }
    ]);

    assert.strictEqual(
      extractPendingCopilotReplyRequest(issue),
      'Dana: The device is already provisioned in the target environment.'
    );
  });

  test('only includes human replies that arrive after the latest Copilot-generated comment', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-4',
        author: 'Dana',
        body: 'Use the internal production cluster and keep the current feature flag.',
        created: '2026-04-15T09:06:00.000Z'
      },
      {
        id: 'comment-3',
        author: 'Dana',
        body: '## @copilot reply\n\nThanks. One more detail is still missing: which environment should this target?',
        created: '2026-04-15T09:04:00.000Z'
      },
      {
        id: 'comment-2',
        author: 'Dana',
        body: 'It should use the existing cluster setup.',
        created: '2026-04-15T09:02:00.000Z'
      },
      {
        id: 'comment-1',
        author: 'Dana',
        body: 'This is an AI-generated message.\nCopilot clarification request\n\nWhat cluster should this target?',
        created: '2026-04-15T09:00:00.000Z'
      }
    ]);

    assert.strictEqual(
      extractPendingCopilotReplyRequest(issue),
      'Dana: Use the internal production cluster and keep the current feature flag.'
    );
  });

  test('combines multiple human comments after the latest Copilot-generated comment', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Dana',
        body: 'This is an AI-generated message.\nCopilot clarification request\n\nWhich tenant and environment should this target?',
        created: '2026-04-15T09:00:00.000Z'
      },
      {
        id: 'comment-2',
        author: 'Dana',
        body: 'Tenant is ASSA.',
        created: '2026-04-15T09:01:00.000Z'
      },
      {
        id: 'comment-3',
        author: 'Dana',
        body: 'Environment is production.',
        created: '2026-04-15T09:02:00.000Z'
      }
    ]);

    assert.strictEqual(
      extractPendingCopilotReplyRequest(issue),
      'Dana: Tenant is ASSA.\n\nDana: Environment is production.'
    );
  });

  test('ignores analysis-start comments when tracking pending human replies', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Ticket Manager',
        body: 'request analysis starting',
        created: '2026-04-15T09:00:00.000Z'
      },
      {
        id: 'comment-2',
        author: 'Dana',
        body: 'This is an AI-generated message.\nCopilot clarification request\n\n1. Which environment should this target?',
        created: '2026-04-15T09:01:00.000Z'
      },
      {
        id: 'comment-3',
        author: 'Dana',
        body: 'Use production.',
        created: '2026-04-15T09:02:00.000Z'
      }
    ]);

    assert.strictEqual(
      extractPendingCopilotReplyRequest(issue),
      'Dana: Use production.'
    );
  });
});