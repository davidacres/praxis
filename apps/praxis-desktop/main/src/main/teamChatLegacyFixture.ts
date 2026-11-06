/**
 * A pre-durable `team-chats.json`, byte-for-byte as the legacy store wrote it (`teamChats`
 * only, two-space JSON). A module rather than a `.json` file because `tsc` does not copy
 * JSON into `out/`. It covers what migration must keep: two projects and a projectless chat
 * (`projectId: ''`, as the legacy store wrote it), two chats sharing a
 * title, a ticket key, context titles, every proposed-action kind, choices, an error reply,
 * an orphan leading assistant message, and chats out of `updatedAt` order.
 */
export const LEGACY_TEAM_CHATS_V1 = JSON.stringify({
  teamChats: [
    {
      id: 'chat-alpha', projectId: 'project-one', title: 'Release planning', issueKey: 'ONE-12',
      createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-03T10:00:00.000Z',
      messages: [
        { id: 'alpha-orphan', role: 'lead', text: 'Picking up from the previous window.', createdAt: '2026-09-01T09:00:00.000Z' },
        { id: 'alpha-u1', role: 'user', text: 'What blocks the release?', createdAt: '2026-09-01T09:01:00.000Z', contextTitle: 'ONE-12 Release' },
        { id: 'alpha-dev1', role: 'dev', text: 'The migration ticket.', createdAt: '2026-09-01T09:02:00.000Z',
          choices: [{ label: 'Plan it', prompt: 'Plan the migration ticket' }, { label: 'Skip', prompt: 'Skip it' }],
          proposedAction: { kind: 'update-ticket', label: 'Update', summary: 'Add the blocker', description: 'Blocked by migration.' } },
        { id: 'alpha-qa1', role: 'qa', text: 'Provider unavailable.', createdAt: '2026-09-01T09:02:30.000Z', error: true },
        { id: 'alpha-u2', role: 'user', text: '@lead split it', createdAt: '2026-09-03T09:59:00.000Z' },
        { id: 'alpha-lead1', role: 'lead', text: 'Here is a subtask.', createdAt: '2026-09-03T10:00:00.000Z',
          proposedAction: { kind: 'create-subtask', label: 'Create', summary: 'Split', title: 'Migrate data', description: 'Copy the store.' } }
      ]
    },
    {
      id: 'chat-beta', projectId: 'project-one', title: 'Release planning',
      createdAt: '2026-09-02T08:00:00.000Z', updatedAt: '2026-09-02T08:05:00.000Z',
      messages: [
        { id: 'beta-u1', role: 'user', text: 'Same title, different chat.', createdAt: '2026-09-02T08:00:00.000Z' },
        { id: 'beta-product1', role: 'product', text: 'Adjust the workflow.', createdAt: '2026-09-02T08:01:00.000Z',
          proposedAction: { kind: 'update-workflow', label: 'Apply', summary: 'Add review', workflow: { stages: [{ id: 'review', name: 'Review', category: 'indeterminate' }] } } },
        { id: 'beta-security1', role: 'security', text: 'Delegate the audit.', createdAt: '2026-09-02T08:05:00.000Z',
          proposedAction: { kind: 'delegate-session', label: 'Delegate', summary: 'Audit', prompt: 'Audit the dependencies.' } }
      ]
    },
    {
      id: 'chat-gamma', projectId: 'project-two', title: 'Empty chat',
      createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z', messages: []
    },
    {
      id: 'chat-delta', projectId: '', title: 'No project yet',
      createdAt: '2026-09-04T07:00:00.000Z', updatedAt: '2026-09-04T07:01:00.000Z',
      messages: [
        { id: 'delta-u1', role: 'user', text: 'Before any project existed.', createdAt: '2026-09-04T07:00:00.000Z' },
        { id: 'delta-lead1', role: 'lead', text: 'Noted.', createdAt: '2026-09-04T07:01:00.000Z' }
      ]
    }
  ]
}, null, 2);
