import * as assert from 'node:assert';
import { buildMissingWorkflowComment } from '../ai/deliveryWorkflow';
import {
  buildPollingAnalysisSignature,
  extractPendingCopilotReplyRequest,
  hasAnyAnalysisLifecycleComment,
  hasPendingAiBotTrigger,
  stripAiBotPrefix
} from '../extension';
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
        body: '#AIbot The device is already provisioned in the target environment.',
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

  test('ignores pending comments that do not start with the #AIbot trigger', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Dana',
        body: 'This is an AI-generated message.\nCopilot clarification request\n\nWhich environment should this target?',
        created: '2026-04-15T09:00:00.000Z'
      },
      {
        id: 'comment-2',
        author: 'Alex',
        body: 'FYI the deployment window shifted to tomorrow.',
        created: '2026-04-15T09:02:00.000Z'
      },
      {
        id: 'comment-3',
        author: 'Jamie',
        body: 'cc @dana — any thoughts on the rollout plan?',
        created: '2026-04-15T09:03:00.000Z'
      }
    ]);

    assert.strictEqual(extractPendingCopilotReplyRequest(issue), undefined);
  });

  test('only picks up #AIbot-prefixed comments and strips the trigger', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Dana',
        body: 'This is an AI-generated message.\nCopilot clarification request\n\nWhich environment should this target?',
        created: '2026-04-15T09:00:00.000Z'
      },
      {
        id: 'comment-2',
        author: 'Alex',
        body: 'just FYI this overlaps with KAMAI-12',
        created: '2026-04-15T09:01:00.000Z'
      },
      {
        id: 'comment-3',
        author: 'Dana',
        body: '#AIbot: use the production cluster.',
        created: '2026-04-15T09:02:00.000Z'
      }
    ]);

    assert.strictEqual(
      extractPendingCopilotReplyRequest(issue),
      'Dana: use the production cluster.'
    );
  });

  test('stripAiBotPrefix returns undefined when the trigger is absent', () => {
    assert.strictEqual(stripAiBotPrefix('No trigger here'), undefined);
    assert.strictEqual(stripAiBotPrefix('#AIbot'), undefined);
    assert.strictEqual(stripAiBotPrefix('   '), undefined);
  });

  test('stripAiBotPrefix accepts common separators after the trigger', () => {
    assert.strictEqual(stripAiBotPrefix('#AIbot do the thing'), 'do the thing');
    assert.strictEqual(stripAiBotPrefix('#aibot: do the thing'), 'do the thing');
    assert.strictEqual(stripAiBotPrefix('#AIbot, do the thing'), 'do the thing');
    assert.strictEqual(stripAiBotPrefix('#AIbot - do the thing'), 'do the thing');
    assert.strictEqual(stripAiBotPrefix('  #AIbot\n\nline two'), 'line two');
  });

  test('only includes human replies that arrive after the latest Copilot-generated comment', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-4',
        author: 'Dana',
        body: '#AIbot Use the internal production cluster and keep the current feature flag.',
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
        body: '#AIbot It should use the existing cluster setup.',
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
        body: '#AIbot Tenant is ASSA.',
        created: '2026-04-15T09:01:00.000Z'
      },
      {
        id: 'comment-3',
        author: 'Dana',
        body: '#AIbot Environment is production.',
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
        body: '#AIbot Use production.',
        created: '2026-04-15T09:02:00.000Z'
      }
    ]);

    assert.strictEqual(
      extractPendingCopilotReplyRequest(issue),
      'Dana: Use production.'
    );
  });

  test('tracks replies after a workflow assignment clarification comment', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Ticket Manager',
        body: buildMissingWorkflowComment(['Add/Edit .NET Web API Workflow (add-edit-dotnet-web-api) — .github/skills/add-edit-dotnet-web-api/SKILL.md']),
        created: '2026-04-15T09:00:00.000Z'
      },
      {
        id: 'comment-2',
        author: 'Dana',
        body: '#AIbot Workflow pack: add-edit-dotnet-web-api',
        created: '2026-04-15T09:01:00.000Z'
      }
    ]);

    assert.strictEqual(
      extractPendingCopilotReplyRequest(issue),
      'Dana: Workflow pack: add-edit-dotnet-web-api'
    );
  });

  test('polling analysis signature ignores analysis lifecycle comments', () => {
    const baseIssue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Dana',
        body: 'Base branch is release/2026.04.',
        created: '2026-04-15T09:00:00.000Z'
      }
    ]);

    const withLifecycleComments = createIssueWithComments([
      ...baseIssue.comments!,
      {
        id: 'comment-2',
        author: 'Ticket Manager',
        body: 'request analysis starting',
        created: '2026-04-15T09:01:00.000Z'
      },
      {
        id: 'comment-3',
        author: 'Ticket Manager',
        body: 'This is an AI-generated message.\nCopilot clarification request\n\n1. Which environment should this target?',
        created: '2026-04-15T09:02:00.000Z'
      },
      {
        id: 'comment-4',
        author: 'Ticket Manager',
        body: 'Copilot readiness analysis passed\n\nAnalysis result: READY\nThe ticket is specific enough to implement without making risky assumptions.\nTicket Manager is now preparing the delivery workflow.',
        created: '2026-04-15T09:03:00.000Z'
      }
    ]);

    assert.strictEqual(
      buildPollingAnalysisSignature(baseIssue),
      buildPollingAnalysisSignature(withLifecycleComments)
    );
  });

  test('polling analysis signature ignores workflow assignment clarification comments', () => {
    const baseIssue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Dana',
        body: 'This should use the system configurator workflow.',
        created: '2026-04-15T09:00:00.000Z'
      }
    ]);

    const withWorkflowClarification = createIssueWithComments([
      ...baseIssue.comments!,
      {
        id: 'comment-2',
        author: 'Ticket Manager',
        body: buildMissingWorkflowComment(['Add/Edit .NET Web API Workflow (add-edit-dotnet-web-api) — .github/skills/add-edit-dotnet-web-api/SKILL.md']),
        created: '2026-04-15T09:01:00.000Z'
      }
    ]);

    assert.strictEqual(
      buildPollingAnalysisSignature(baseIssue),
      buildPollingAnalysisSignature(withWorkflowClarification)
    );
  });

  test('polling analysis signature ignores non-#AIbot user comments', () => {
    const baseIssue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Ticket Manager',
        body: 'Copilot readiness analysis passed\n\nAnalysis result: READY\nThe ticket is specific enough to implement without making risky assumptions.',
        created: '2026-04-15T09:00:00.000Z'
      }
    ]);

    const withRandomUserChatter = createIssueWithComments([
      ...baseIssue.comments!,
      {
        id: 'comment-2',
        author: 'Dana',
        body: 'choose a mid blue you think would be good, use add/edit blazor component workflow',
        created: '2026-04-15T09:05:00.000Z'
      }
    ]);

    assert.strictEqual(
      buildPollingAnalysisSignature(baseIssue),
      buildPollingAnalysisSignature(withRandomUserChatter),
      'Random user chatter must not invalidate the analysis signature — only #AIbot comments should re-trigger analysis.'
    );
  });

  test('polling analysis signature changes when a #AIbot comment is added', () => {
    const baseIssue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Ticket Manager',
        body: 'Copilot readiness analysis passed',
        created: '2026-04-15T09:00:00.000Z'
      }
    ]);

    const withAiBotDirective = createIssueWithComments([
      ...baseIssue.comments!,
      {
        id: 'comment-2',
        author: 'Dana',
        body: '#AIbot use the blazor workflow',
        created: '2026-04-15T09:05:00.000Z'
      }
    ]);

    assert.notStrictEqual(
      buildPollingAnalysisSignature(baseIssue),
      buildPollingAnalysisSignature(withAiBotDirective)
    );
  });

  test('hasAnyAnalysisLifecycleComment detects readiness-passed comment', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Ticket Manager',
        body: 'Copilot readiness analysis passed\n\nAnalysis result: READY',
        created: '2026-04-15T09:00:00.000Z'
      }
    ]);
    assert.strictEqual(hasAnyAnalysisLifecycleComment(issue), true);
  });

  test('hasPendingAiBotTrigger is false when user posts a non-#AIbot comment after analysis', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Ticket Manager',
        body: 'Copilot readiness analysis passed\n\nAnalysis result: READY',
        created: '2026-04-15T09:00:00.000Z'
      },
      {
        id: 'comment-2',
        author: 'Dana',
        body: 'choose a mid blue you think would be good, use add/edit blazor component workflow',
        created: '2026-04-15T09:05:00.000Z'
      }
    ]);
    assert.strictEqual(
      hasPendingAiBotTrigger(issue),
      false,
      'Plain user chatter must never trigger the bot — only #AIbot-prefixed comments should.'
    );
  });

  test('hasPendingAiBotTrigger is true only when user posts #AIbot-prefixed comment after analysis', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Ticket Manager',
        body: 'Copilot readiness analysis passed',
        created: '2026-04-15T09:00:00.000Z'
      },
      {
        id: 'comment-2',
        author: 'Dana',
        body: '#AIbot please use the blazor workflow',
        created: '2026-04-15T09:05:00.000Z'
      }
    ]);
    assert.strictEqual(hasPendingAiBotTrigger(issue), true);
  });

  test('hasPendingAiBotTrigger ignores #AIbot comments posted BEFORE the latest bot activity', () => {
    const issue = createIssueWithComments([
      {
        id: 'comment-1',
        author: 'Dana',
        body: '#AIbot use the blazor workflow',
        created: '2026-04-15T09:00:00.000Z'
      },
      {
        id: 'comment-2',
        author: 'Ticket Manager',
        body: 'Copilot readiness analysis passed',
        created: '2026-04-15T09:05:00.000Z'
      }
    ]);
    assert.strictEqual(
      hasPendingAiBotTrigger(issue),
      false,
      'Only #AIbot comments posted AFTER the most recent bot activity should re-engage the agent.'
    );
  });
});