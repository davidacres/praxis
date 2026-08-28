import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { GitLabBoardService } from '@ticket-manager/core';

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

suite('gitLabBoardService', () => {
  test('lists only explicitly selected GitLab boards when selected board refs are configured', async () => {
    const output = {
      appendLine: () => undefined
    } as unknown as vscode.OutputChannel;

    const configStore = {
      getDefaultPageSize: () => 25,
      getGitLabApiKey: () => 'token',
      getGitLabUrl: () => 'https://gitlab.example.com',
      getGitLabProjectPath: () => '',
      getGitLabListAllAccessibleBoards: () => false,
      getGitLabSelectedBoardRefs: () => ['group/first::10', 'group/second::20']
    } as never;

    const service = new GitLabBoardService(
      configStore,
      output,
      async (input: FetchInput) => {
        const url = new URL(toUrlString(input));

        if (url.pathname === '/api/v4/projects/group%2Ffirst/boards/10') {
          return new Response(
            JSON.stringify({
              id: 10,
              name: 'Board One',
              hide_backlog_list: false,
              hide_closed_list: false,
              project: {
                id: 1,
                name: 'First',
                path: 'first',
                path_with_namespace: 'group/first'
              },
              lists: []
            }),
            { status: 200 }
          );
        }

        if (url.pathname === '/api/v4/projects/group%2Fsecond/boards/20') {
          return new Response(
            JSON.stringify({
              id: 20,
              name: 'Board Two',
              hide_backlog_list: false,
              hide_closed_list: false,
              project: {
                id: 2,
                name: 'Second',
                path: 'second',
                path_with_namespace: 'group/second'
              },
              lists: []
            }),
            { status: 200 }
          );
        }

        return new Response('not found', { status: 404, statusText: 'Not Found' });
      },
      async () => {
        throw new Error('inferProjectRemote should not be called when selected board refs are configured');
      }
    );

    const boards = await service.getBoards({ projectKeys: [], types: [], searchText: '' });
    assert.deepStrictEqual(boards.map(board => board.name), ['Board One', 'Board Two']);
    assert.deepStrictEqual(boards.map(board => board.projectKey), ['group/first', 'group/second']);
  });

  test('lists boards across accessible GitLab projects when configured', async () => {
    const output = {
      appendLine: () => undefined
    } as unknown as vscode.OutputChannel;

    const configStore = {
      getDefaultPageSize: () => 25,
      getGitLabApiKey: () => 'token',
      getGitLabUrl: () => 'https://gitlab.example.com',
      getGitLabProjectPath: () => '',
      getGitLabListAllAccessibleBoards: () => true,
      getGitLabSelectedBoardRefs: () => []
    } as never;

    const service = new GitLabBoardService(
      configStore,
      output,
      async (input: FetchInput) => {
        const url = new URL(toUrlString(input));
        if (url.pathname === '/api/v4/projects') {
          return new Response(
            JSON.stringify([
              {
                id: 1,
                name: 'First',
                path: 'first',
                path_with_namespace: 'group/first'
              },
              {
                id: 2,
                name: 'Second',
                path: 'second',
                path_with_namespace: 'group/second'
              }
            ]),
            { status: 200, headers: { 'x-next-page': '' } }
          );
        }

        if (url.pathname === '/api/v4/projects/1/boards') {
          return new Response(
            JSON.stringify([
              {
                id: 10,
                name: 'Board One',
                hide_backlog_list: false,
                hide_closed_list: false,
                project: {
                  id: 1,
                  name: 'First',
                  path: 'first',
                  path_with_namespace: 'group/first'
                },
                lists: []
              }
            ]),
            { status: 200 }
          );
        }

        if (url.pathname === '/api/v4/projects/2/boards') {
          return new Response(
            JSON.stringify([
              {
                id: 20,
                name: 'Board Two',
                hide_backlog_list: false,
                hide_closed_list: false,
                project: {
                  id: 2,
                  name: 'Second',
                  path: 'second',
                  path_with_namespace: 'group/second'
                },
                lists: []
              }
            ]),
            { status: 200 }
          );
        }

        return new Response('not found', { status: 404, statusText: 'Not Found' });
      },
      async () => {
        throw new Error('inferProjectRemote should not be called in list-all mode');
      }
    );

    const boards = await service.getBoards({ projectKeys: [], types: [], searchText: '' });
    assert.deepStrictEqual(boards.map(board => board.name), ['Board One', 'Board Two']);
    assert.deepStrictEqual(boards.map(board => board.projectKey), ['group/first', 'group/second']);
  });

  test('loads GitLab board issues into backlog, list, and closed columns', async () => {
    const output = {
      appendLine: () => undefined
    } as unknown as vscode.OutputChannel;

    const configStore = {
      getDefaultPageSize: () => 25,
      getGitLabApiKey: () => 'token',
      getGitLabUrl: () => 'https://gitlab.example.com',
      getGitLabProjectPath: () => 'group/project',
      getGitLabListAllAccessibleBoards: () => false,
      getGitLabSelectedBoardRefs: () => []
    } as never;

    const service = new GitLabBoardService(
      configStore,
      output,
      async (input: FetchInput) => {
        const url = new URL(toUrlString(input));

        if (url.pathname === '/api/v4/projects/group%2Fproject/boards/10') {
          return new Response(
            JSON.stringify({
              id: 10,
              name: 'Delivery',
              hide_backlog_list: false,
              hide_closed_list: false,
              labels: ['Team A'],
              project: {
                id: 1,
                name: 'Project',
                path: 'project',
                path_with_namespace: 'group/project'
              },
              lists: []
            }),
            { status: 200 }
          );
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/boards/10/lists') {
          return new Response(
            JSON.stringify([
              {
                id: 101,
                position: 1,
                label: { name: 'Doing' }
              }
            ]),
            { status: 200 }
          );
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues') {
          assert.strictEqual(url.searchParams.get('state'), 'all');
          assert.strictEqual(url.searchParams.get('labels'), 'Team A');
          return new Response(
            JSON.stringify([
              {
                id: 1,
                iid: 11,
                project_id: 1,
                title: 'Backlog issue',
                state: 'opened',
                labels: ['Team A'],
                assignees: [],
                references: { full: 'group/project#11' },
                web_url: 'https://gitlab.example.com/group/project/-/issues/11',
                updated_at: '2026-05-11T10:00:00Z'
              },
              {
                id: 2,
                iid: 12,
                project_id: 1,
                title: 'Doing issue',
                state: 'opened',
                labels: ['Team A', 'Doing'],
                assignees: [],
                references: { full: 'group/project#12' },
                web_url: 'https://gitlab.example.com/group/project/-/issues/12',
                updated_at: '2026-05-11T11:00:00Z'
              },
              {
                id: 3,
                iid: 13,
                project_id: 1,
                title: 'Closed issue',
                state: 'closed',
                labels: ['Team A', 'Doing'],
                assignees: [],
                references: { full: 'group/project#13' },
                web_url: 'https://gitlab.example.com/group/project/-/issues/13',
                updated_at: '2026-05-11T12:00:00Z'
              }
            ]),
            { status: 200, headers: { 'x-next-page': '' } }
          );
        }

        return new Response('not found', { status: 404, statusText: 'Not Found' });
      }
    );

    const details = await service.getBoardDetails({
      id: 'gitlab:1:10',
      name: 'Delivery',
      type: 'issue-board',
      projectKey: 'group/project',
      raw: {
        id: 10,
        project: {
          id: 1
        }
      }
    });

    assert.deepStrictEqual(details.issues.map(issue => `${issue.key}:${issue.status}`), [
      'group/project#11:Backlog',
      'group/project#12:Doing',
      'group/project#13:Closed'
    ]);
    assert.deepStrictEqual(
      details.columns.map(column => ({ name: column.name, issues: column.issues.map(issue => issue.key) })),
      [
        { name: 'Backlog', issues: ['group/project#11'] },
        { name: 'Doing', issues: ['group/project#12'] },
        { name: 'Closed', issues: ['group/project#13'] }
      ]
    );
  });

  test('loads GitLab issue details and comments for a selected board card', async () => {
    const output = {
      appendLine: () => undefined
    } as unknown as vscode.OutputChannel;

    const configStore = {
      getDefaultPageSize: () => 25,
      getGitLabApiKey: () => 'token',
      getGitLabUrl: () => 'https://gitlab.example.com',
      getGitLabProjectPath: () => 'group/project',
      getGitLabListAllAccessibleBoards: () => false,
      getGitLabSelectedBoardRefs: () => []
    } as never;

    const service = new GitLabBoardService(
      configStore,
      output,
      async (input: FetchInput, init?: RequestInit) => {
        const url = new URL(toUrlString(input));

        if (url.pathname === '/api/v4/projects/group%2Fproject/boards/10') {
          return new Response(JSON.stringify({
            id: 10,
            name: 'Delivery',
            hide_backlog_list: false,
            hide_closed_list: false,
            project: { id: 1, name: 'Project', path: 'project', path_with_namespace: 'group/project' },
            lists: []
          }), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/boards/10/lists') {
          return new Response(JSON.stringify([{ id: 101, position: 1, label: { name: 'Doing' } }]), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues' && init?.method === 'GET') {
          return new Response(JSON.stringify([
            {
              id: 2,
              iid: 12,
              project_id: 1,
              title: 'Doing issue',
              state: 'opened',
              labels: ['Doing'],
              assignees: [],
              references: { full: 'group/project#12' },
              web_url: 'https://gitlab.example.com/group/project/-/issues/12',
              updated_at: '2026-05-11T11:00:00Z',
              description: 'Board copy'
            }
          ]), { status: 200, headers: { 'x-next-page': '' } });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues/12') {
          return new Response(JSON.stringify({
            id: 2,
            iid: 12,
            project_id: 1,
            title: 'Doing issue',
            state: 'opened',
            labels: ['Doing'],
            assignees: [],
            references: { full: 'group/project#12' },
            web_url: 'https://gitlab.example.com/group/project/-/issues/12',
            updated_at: '2026-05-11T11:00:00Z',
            created_at: '2026-05-11T09:00:00Z',
            description: 'Detailed copy'
          }), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues/12/notes') {
          return new Response(JSON.stringify([
            {
              id: 501,
              body: 'First comment',
              created_at: '2026-05-11T09:30:00Z',
              updated_at: '2026-05-11T09:30:00Z',
              author: { name: 'Alice' }
            }
          ]), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject') {
          return new Response(JSON.stringify({
            id: 1,
            name: 'Project',
            path: 'project',
            path_with_namespace: 'group/project'
          }), { status: 200 });
        }

        return new Response('not found', { status: 404, statusText: 'Not Found' });
      }
    );

    await service.getBoardDetails({
      id: 'gitlab:1:10',
      name: 'Delivery',
      type: 'issue-board',
      projectKey: 'group/project',
      raw: { id: 10, project: { id: 1 } }
    });

    const issue = await service.getIssue('group/project#12');

    assert.strictEqual(issue.description, 'Detailed copy');
    assert.deepStrictEqual(issue.comments?.map(comment => comment.body), ['First comment']);
    assert.deepStrictEqual(issue.transitions?.map(transition => transition.toStatus), ['Backlog', 'Closed']);
  });

  test('updates a GitLab issue assignee by resolving the entered user', async () => {
    const output = {
      appendLine: () => undefined
    } as unknown as vscode.OutputChannel;
    const updateBodies: string[] = [];

    const configStore = {
      getDefaultPageSize: () => 25,
      getGitLabApiKey: () => 'token',
      getGitLabUrl: () => 'https://gitlab.example.com',
      getGitLabProjectPath: () => 'group/project',
      getGitLabListAllAccessibleBoards: () => false,
      getGitLabSelectedBoardRefs: () => []
    } as never;

    const service = new GitLabBoardService(
      configStore,
      output,
      async (input: FetchInput, init?: RequestInit) => {
        const url = new URL(toUrlString(input));

        if (url.pathname === '/api/v4/users') {
          if (url.searchParams.get('username') === 'alice') {
            return new Response(JSON.stringify([
              {
                id: 9,
                username: 'alice',
                name: 'Alice Example',
                state: 'active'
              }
            ]), { status: 200 });
          }

          return new Response(JSON.stringify([]), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues/12' && init?.method === 'PUT') {
          updateBodies.push(typeof init.body === 'string' ? init.body : '');
          return new Response(JSON.stringify({
            id: 2,
            iid: 12,
            project_id: 1,
            title: 'Doing issue',
            state: 'opened',
            labels: ['Doing'],
            assignees: [{ username: 'alice', name: 'Alice Example' }],
            references: { full: 'group/project#12' },
            web_url: 'https://gitlab.example.com/group/project/-/issues/12',
            updated_at: '2026-05-11T11:00:00Z',
            created_at: '2026-05-11T09:00:00Z',
            description: 'Detailed copy'
          }), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues/12' && init?.method === 'GET') {
          return new Response(JSON.stringify({
            id: 2,
            iid: 12,
            project_id: 1,
            title: 'Doing issue',
            state: 'opened',
            labels: ['Doing'],
            assignees: [{ username: 'alice', name: 'Alice Example' }],
            references: { full: 'group/project#12' },
            web_url: 'https://gitlab.example.com/group/project/-/issues/12',
            updated_at: '2026-05-11T11:00:00Z',
            created_at: '2026-05-11T09:00:00Z',
            description: 'Detailed copy'
          }), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues/12/notes') {
          return new Response(JSON.stringify([]), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject') {
          return new Response(JSON.stringify({
            id: 1,
            name: 'Project',
            path: 'project',
            path_with_namespace: 'group/project'
          }), { status: 200 });
        }

        return new Response('not found', { status: 404, statusText: 'Not Found' });
      }
    );

    const issue = await service.updateIssue('group/project#12', {
      assignee: 'alice'
    });

    assert.strictEqual(updateBodies.length, 1);
    assert.match(updateBodies[0], /assignee_ids=9/);
    assert.strictEqual(issue.assignee, 'Alice Example');
  });

  test('moves a GitLab board card by updating issue state and labels', async () => {
    const output = {
      appendLine: () => undefined
    } as unknown as vscode.OutputChannel;
    const updateBodies: string[] = [];

    const configStore = {
      getDefaultPageSize: () => 25,
      getGitLabApiKey: () => 'token',
      getGitLabUrl: () => 'https://gitlab.example.com',
      getGitLabProjectPath: () => 'group/project',
      getGitLabListAllAccessibleBoards: () => false,
      getGitLabSelectedBoardRefs: () => []
    } as never;

    const service = new GitLabBoardService(
      configStore,
      output,
      async (input: FetchInput, init?: RequestInit) => {
        const url = new URL(toUrlString(input));

        if (url.pathname === '/api/v4/projects/group%2Fproject/boards/10') {
          return new Response(JSON.stringify({
            id: 10,
            name: 'Delivery',
            hide_backlog_list: false,
            hide_closed_list: false,
            project: { id: 1, name: 'Project', path: 'project', path_with_namespace: 'group/project' },
            lists: []
          }), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/boards/10/lists') {
          return new Response(JSON.stringify([{ id: 101, position: 1, label: { name: 'Doing' } }]), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues' && init?.method === 'GET') {
          return new Response(JSON.stringify([
            {
              id: 1,
              iid: 11,
              project_id: 1,
              title: 'Backlog issue',
              state: 'opened',
              labels: [],
              assignees: [],
              references: { full: 'group/project#11' },
              web_url: 'https://gitlab.example.com/group/project/-/issues/11',
              updated_at: '2026-05-11T10:00:00Z'
            }
          ]), { status: 200, headers: { 'x-next-page': '' } });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues/11' && init?.method === 'GET') {
          return new Response(JSON.stringify({
            id: 1,
            iid: 11,
            project_id: 1,
            title: 'Backlog issue',
            state: 'opened',
            labels: [],
            assignees: [],
            references: { full: 'group/project#11' },
            web_url: 'https://gitlab.example.com/group/project/-/issues/11'
          }), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues/11' && init?.method === 'PUT') {
          updateBodies.push(typeof init.body === 'string' ? init.body : '');
          return new Response(JSON.stringify({
            id: 1,
            iid: 11,
            project_id: 1,
            title: 'Backlog issue',
            state: 'opened',
            labels: ['Doing'],
            assignees: [],
            references: { full: 'group/project#11' },
            web_url: 'https://gitlab.example.com/group/project/-/issues/11'
          }), { status: 200 });
        }

        return new Response('not found', { status: 404, statusText: 'Not Found' });
      }
    );

    await service.getBoardDetails({
      id: 'gitlab:1:10',
      name: 'Delivery',
      type: 'issue-board',
      projectKey: 'group/project',
      raw: { id: 10, project: { id: 1 } }
    });

    const transitions = await service.getTransitions('group/project#11');
    assert.deepStrictEqual(transitions.map(transition => transition.toStatus), ['Doing', 'Closed']);

    await service.transitionIssue('group/project#11', 'gitlab:Doing');

    assert.strictEqual(updateBodies.length, 1);
    assert.match(updateBodies[0], /add_labels=Doing/);
  });

  test('moves a GitLab board card into an iteration list by updating iteration_id', async () => {
    const output = {
      appendLine: () => undefined
    } as unknown as vscode.OutputChannel;
    const updateBodies: string[] = [];

    const configStore = {
      getDefaultPageSize: () => 25,
      getGitLabApiKey: () => 'token',
      getGitLabUrl: () => 'https://gitlab.example.com',
      getGitLabProjectPath: () => 'group/project',
      getGitLabListAllAccessibleBoards: () => false,
      getGitLabSelectedBoardRefs: () => []
    } as never;

    const service = new GitLabBoardService(
      configStore,
      output,
      async (input: FetchInput, init?: RequestInit) => {
        const url = new URL(toUrlString(input));

        if (url.pathname === '/api/v4/projects/group%2Fproject/boards/10') {
          return new Response(JSON.stringify({
            id: 10,
            name: 'Delivery',
            hide_backlog_list: false,
            hide_closed_list: false,
            project: { id: 1, name: 'Project', path: 'project', path_with_namespace: 'group/project' },
            lists: []
          }), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/boards/10/lists') {
          return new Response(JSON.stringify([
            {
              id: 101,
              position: 1,
              iteration: { id: 77, title: 'Sprint 1' }
            }
          ]), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues' && init?.method === 'GET') {
          return new Response(JSON.stringify([
            {
              id: 1,
              iid: 11,
              project_id: 1,
              title: 'Backlog issue',
              state: 'opened',
              labels: [],
              assignees: [],
              references: { full: 'group/project#11' },
              web_url: 'https://gitlab.example.com/group/project/-/issues/11',
              updated_at: '2026-05-11T10:00:00Z'
            }
          ]), { status: 200, headers: { 'x-next-page': '' } });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues/11' && init?.method === 'GET') {
          return new Response(JSON.stringify({
            id: 1,
            iid: 11,
            project_id: 1,
            title: 'Backlog issue',
            state: 'opened',
            labels: [],
            assignees: [],
            references: { full: 'group/project#11' },
            web_url: 'https://gitlab.example.com/group/project/-/issues/11'
          }), { status: 200 });
        }

        if (url.pathname === '/api/v4/projects/group%2Fproject/issues/11' && init?.method === 'PUT') {
          updateBodies.push(typeof init.body === 'string' ? init.body : '');
          return new Response(JSON.stringify({
            id: 1,
            iid: 11,
            project_id: 1,
            title: 'Backlog issue',
            state: 'opened',
            labels: [],
            assignees: [],
            iteration: { id: 77, title: 'Sprint 1' },
            references: { full: 'group/project#11' },
            web_url: 'https://gitlab.example.com/group/project/-/issues/11'
          }), { status: 200 });
        }

        return new Response('not found', { status: 404, statusText: 'Not Found' });
      }
    );

    await service.getBoardDetails({
      id: 'gitlab:1:10',
      name: 'Delivery',
      type: 'issue-board',
      projectKey: 'group/project',
      raw: { id: 10, project: { id: 1 } }
    });

    const transitions = await service.getTransitions('group/project#11');
    assert.deepStrictEqual(transitions.map(transition => transition.toStatus), ['Sprint 1', 'Closed']);

    await service.transitionIssue('group/project#11', 'gitlab:Sprint 1');

    assert.strictEqual(updateBodies.length, 1);
    assert.match(updateBodies[0], /iteration_id=77/);
  });
});
