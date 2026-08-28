import * as assert from 'node:assert';
import {
  GitLabApiService,
  createGitLabHandledNoteState,
  diffGitLabDiscussionNotes,
  flattenGitLabDiscussionNotes,
  isTicketManagerManagedMergeRequestNote,
  mergeRequestMatchesIssueKey,
  parseGitLabRemoteUrl,
  shouldCreateMergeRequestForStatusChange,
  wrapTicketManagerManagedMergeRequestNote
} from '@praxis/core';

type FetchInput = URL | Request | string;

function toUrlString(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

suite('gitLabApiService', () => {
  test('parses SSH remotes into https base URLs and project paths', () => {
    assert.deepStrictEqual(
      parseGitLabRemoteUrl('git@git.example.com:example/software/ai/system-configurator.git'),
      {
        baseUrl: 'https://git.example.com',
        projectPath: 'example/software/ai/system-configurator'
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
        id: 'disc-2',
        notes: [
          { id: 2, body: 'Later', created_at: '2026-04-16T10:00:01Z', updated_at: '2026-04-16T10:00:01Z', author: { username: 'bob' } }
        ]
      },
      {
        id: 'disc-1',
        notes: [
          { id: 1, body: 'Earlier', created_at: '2026-04-16T10:00:00Z', updated_at: '2026-04-16T10:00:00Z', author: { username: 'alice' } }
        ]
      }
    ]);

    assert.deepStrictEqual(notes.map(note => note.id), ['1', '2']);
    assert.strictEqual(notes[0].discussionId, 'disc-1');
    assert.strictEqual(notes[1].discussionId, 'disc-2');
  });

  test('diffs GitLab notes while suppressing the baseline snapshot', () => {
    const baseline = [{ id: '1', discussionId: 'd1', author: 'alice', body: 'Existing', createdAt: 'a', updatedAt: 'a', system: false }];
    assert.deepStrictEqual(diffGitLabDiscussionNotes({}, baseline, true), {
      newNotes: [],
      updatedNotes: []
    });

    const current = [
      ...baseline,
      { id: '2', discussionId: 'd2', author: 'bob', body: 'New note', createdAt: 'b', updatedAt: 'b', system: false }
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

  test('lists GitLab boards and board lists from the API', async () => {
    const fetchCalls: string[] = [];
    const service = new GitLabApiService(
      {
        baseUrl: 'https://gitlab.example.com',
        projectPath: 'group/project',
        token: 'token'
      },
      async (input: FetchInput) => {
        const url = toUrlString(input);
        fetchCalls.push(url);
        if (url.endsWith('/api/v4/projects/group%2Fproject/boards')) {
          return new Response(
            JSON.stringify([
              {
                id: 7,
                name: 'Delivery',
                hide_backlog_list: false,
                hide_closed_list: true,
                project: {
                  id: 5,
                  name: 'Project',
                  path: 'project',
                  path_with_namespace: 'group/project',
                  web_url: 'https://gitlab.example.com/group/project'
                },
                lists: [
                  {
                    id: 12,
                    position: 2,
                    label: { name: 'Ready' }
                  }
                ]
              }
            ]),
            { status: 200 }
          );
        }

        if (url.endsWith('/api/v4/projects/group%2Fproject/boards/7/lists')) {
          return new Response(
            JSON.stringify([
              { id: 21, position: 2, label: { name: 'Doing' } },
              { id: 20, position: 1, label: { name: 'To Do' } }
            ]),
            { status: 200 }
          );
        }

        return new Response('not found', { status: 404, statusText: 'Not Found' });
      }
    );

    const boards = await service.listBoards();
    const lists = await service.listBoardLists(7);

    assert.strictEqual(boards.length, 1);
    assert.strictEqual(boards[0].project.pathWithNamespace, 'group/project');
    assert.deepStrictEqual(lists.map(list => list.title), ['To Do', 'Doing']);
    assert.strictEqual(fetchCalls.length, 2);
  });

  test('lists accessible GitLab projects across paginated API responses', async () => {
    const service = new GitLabApiService(
      {
        baseUrl: 'https://gitlab.example.com',
        projectPath: '',
        token: 'token'
      },
      async (input: FetchInput) => {
        const url = new URL(toUrlString(input));
        const page = url.searchParams.get('page');
        if (url.pathname === '/api/v4/projects' && page === '1') {
          return new Response(
            JSON.stringify([
              {
                id: 1,
                name: 'First',
                path: 'first',
                path_with_namespace: 'group/first'
              }
            ]),
            {
              status: 200,
              headers: { 'x-next-page': '2' }
            }
          );
        }

        if (url.pathname === '/api/v4/projects' && page === '2') {
          return new Response(
            JSON.stringify([
              {
                id: 2,
                name: 'Second',
                path: 'second',
                path_with_namespace: 'group/second'
              }
            ]),
            {
              status: 200,
              headers: { 'x-next-page': '' }
            }
          );
        }

        return new Response('not found', { status: 404, statusText: 'Not Found' });
      }
    );

    const projects = await service.listAccessibleProjects();
    assert.deepStrictEqual(projects.map(project => project.pathWithNamespace), ['group/first', 'group/second']);
  });
});