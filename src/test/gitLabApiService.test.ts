import * as assert from 'node:assert';
import {
  createGitLabHandledNoteState,
  diffGitLabDiscussionNotes,
  flattenGitLabDiscussionNotes,
  isTicketManagerManagedMergeRequestNote,
  mergeRequestMatchesIssueKey,
  parseGitLabRemoteUrl,
  shouldCreateMergeRequestForStatusChange,
  wrapTicketManagerManagedMergeRequestNote
} from '../gitlab/gitLabApiService';

suite('gitLabApiService', () => {
  test('parses SSH remotes into https base URLs and project paths', () => {
    assert.deepStrictEqual(
      parseGitLabRemoteUrl('git@git.tools.dev.assaabloyglobalsolutions.net:traka/software/ai/system-configurator.git'),
      {
        baseUrl: 'https://git.tools.dev.assaabloyglobalsolutions.net',
        projectPath: 'traka/software/ai/system-configurator'
      }
    );
  });

  test('matches issue keys against merge request metadata', () => {
    assert.strictEqual(
      mergeRequestMatchesIssueKey(
        {
          title: 'Standalone work',
          description: 'Implements KAMAI-45 for smoke testing.',
          sourceBranch: 'feature/no-match'
        },
        'KAMAI-45'
      ),
      true
    );
  });

  test('flattens and sorts GitLab discussion notes', () => {
    const notes = flattenGitLabDiscussionNotes([
      {
        notes: [
          { id: 2, body: 'Later', created_at: '2026-04-16T10:00:01Z', updated_at: '2026-04-16T10:00:01Z', author: { username: 'bob' } }
        ]
      },
      {
        notes: [
          { id: 1, body: 'Earlier', created_at: '2026-04-16T10:00:00Z', updated_at: '2026-04-16T10:00:00Z', author: { username: 'alice' } }
        ]
      }
    ]);

    assert.deepStrictEqual(notes.map(note => note.id), ['1', '2']);
  });

  test('diffs GitLab notes while suppressing the baseline snapshot', () => {
    const baseline = [{ id: '1', author: 'alice', body: 'Existing', createdAt: 'a', updatedAt: 'a', system: false }];
    assert.deepStrictEqual(diffGitLabDiscussionNotes({}, baseline, true), {
      newNotes: [],
      updatedNotes: []
    });

    const current = [
      ...baseline,
      { id: '2', author: 'bob', body: 'New note', createdAt: 'b', updatedAt: 'b', system: false }
    ];
    const diff = diffGitLabDiscussionNotes(createGitLabHandledNoteState(baseline), current, false);
    assert.strictEqual(diff.newNotes.length, 1);
    assert.strictEqual(diff.newNotes[0].id, '2');
  });

  test('detects Ticket Manager managed merge request notes', () => {
    const wrapped = wrapTicketManagerManagedMergeRequestNote('Reply body');
    assert.strictEqual(isTicketManagerManagedMergeRequestNote(wrapped), true);
    assert.strictEqual(isTicketManagerManagedMergeRequestNote('Human comment'), false);
  });

  test('creates merge requests only for in-review to done transitions', () => {
    assert.strictEqual(
      shouldCreateMergeRequestForStatusChange({
        previousStatus: 'In Review',
        currentStatus: 'Done',
        currentStatusCategory: 'done'
      }),
      true
    );
    assert.strictEqual(
      shouldCreateMergeRequestForStatusChange({
        previousStatus: 'In Progress',
        currentStatus: 'Done',
        currentStatusCategory: 'done'
      }),
      false
    );
  });
});