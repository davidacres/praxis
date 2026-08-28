import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { AiSessionManager } from '@ticket-manager/core';
import type { IssueTrackerService } from '@ticket-manager/core';
import type { Board, CreateIssueInput, IssueDetails, Project } from '@ticket-manager/core';
import { IssueDetailPanelManager } from '../views/issueDetailPanelManager';

class MemoryMemento implements vscode.Memento {
  private readonly store = new Map<string, unknown>();

  public get<T>(key: string, defaultValue?: T): T {
    return (this.store.get(key) as T) ?? (defaultValue as T);
  }

  public async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
      return;
    }
    this.store.set(key, value);
  }

  public keys(): readonly string[] {
    return [...this.store.keys()];
  }

  public setKeysForSync(): void {
    // No-op for tests.
  }
}

function createIssue(): IssueDetails {
  return {
    key: 'APP-101',
    summary: 'Add delivery links to issue detail window',
    status: 'In Progress',
    issueType: 'Story',
    projectKey: 'APP',
    projectName: 'Application Platform',
    comments: [],
    linkedIssues: [
      {
        key: 'APP-77',
        summary: 'Implement delivery workflow',
        issueType: 'Task',
        status: 'Done',
        relationship: 'code implemented in',
        browseUrl: 'https://jira.example.com/browse/APP-77'
      },
      {
        key: 'APP-88',
        summary: 'Release package update',
        relationship: 'resolved in'
      }
    ]
  };
}

suite('IssueDetailPanelManager', () => {
  test('renders linked Jira items in the full issue details window', () => {
    const workspaceState = new MemoryMemento();
    const manager = new IssueDetailPanelManager(
      { mode: 'jiracloud' } as unknown as IssueTrackerService,
      new AiSessionManager(workspaceState),
      async () => {}
    );

    const html = (
      manager as unknown as {
        buildIssueBodyHtml: (issue: IssueDetails) => string;
      }
    ).buildIssueBodyHtml(createIssue());

    assert.match(html, /Linked Items/);
    assert.match(html, /code implemented in/i);
    assert.match(html, /resolved in/i);
    assert.match(html, /https:\/\/jira\.example\.com\/browse\/APP-77/);
    assert.match(html, /APP-77/);
    assert.match(html, /Implement delivery workflow/);

    manager.dispose();
  });
});

/** Exposes the private draft internals the routing tests need to drive. */
type DraftInternals = {
  draftDefaults?: { boardId?: string };
  resolveDraftService: () => Promise<IssueTrackerService>;
};

/** Exposes the private draft internals the project-preselection tests drive. */
type ProjectInternals = {
  draftProjects: Project[];
  deriveProjectsFromBoards: (boards: Board[]) => Project[];
  resolveDraftProjectKey: (
    defaults: Partial<CreateIssueInput> | undefined,
    boards: Board[]
  ) => string;
  buildDraftDetails: (
    defaults: Partial<CreateIssueInput> | undefined,
    projectKey: string
  ) => IssueDetails;
  buildDraftProjectField: (issue: IssueDetails) => string;
};

function board(id: string, projectKey?: string, projectName?: string): Board {
  return { id, name: `Board ${id}`, type: 'plan', projectKey, projectName };
}

suite('IssueDetailPanelManager draft project preselection', () => {
  const boards = [
    board('board-apex', 'APEX', 'Apex Platform'),
    board('board-zulu', 'ZULU', 'Zulu Services')
  ];

  function createInternals(): { manager: IssueDetailPanelManager; internals: ProjectInternals } {
    const manager = new IssueDetailPanelManager(
      { mode: 'jiracloud' } as unknown as IssueTrackerService,
      new AiSessionManager(new MemoryMemento()),
      async () => {}
    );
    const internals = manager as unknown as ProjectInternals;
    internals.draftProjects = internals.deriveProjectsFromBoards(boards);
    return { manager, internals };
  }

  test('preselects the project the caller passed', () => {
    const { manager, internals } = createInternals();

    const key = internals.resolveDraftProjectKey({ projectKey: 'ZULU' }, boards);
    const html = internals.buildDraftProjectField(internals.buildDraftDetails(undefined, key));

    assert.strictEqual(key, 'ZULU');
    assert.match(html, /<option value="ZULU" selected>/);
    assert.doesNotMatch(html, /<option value="APEX" selected>/);

    manager.dispose();
  });

  test("preselects the board's project when only the board id was passed", () => {
    const { manager, internals } = createInternals();

    // The board panel passes its Board through the command layer; this covers the
    // case where that object reached us without a projectKey on it.
    const key = internals.resolveDraftProjectKey({ boardId: 'board-zulu' }, boards);
    const html = internals.buildDraftProjectField(internals.buildDraftDetails(undefined, key));

    assert.strictEqual(key, 'ZULU');
    assert.match(html, /<option value="ZULU" selected>/);

    manager.dispose();
  });

  test('shows the project name without its key in the dropdown', () => {
    const { manager, internals } = createInternals();

    const html = internals.buildDraftProjectField(
      internals.buildDraftDetails(undefined, 'ZULU')
    );

    assert.match(html, /<option value="ZULU" selected>Zulu Services<\/option>/);
    assert.doesNotMatch(html, /ZULU\)/, 'the key must not appear in the label');

    manager.dispose();
  });

  test('falls back to the first project only when the draft has no board', () => {
    const { manager, internals } = createInternals();

    assert.strictEqual(internals.resolveDraftProjectKey(undefined, boards), 'APEX');
    assert.strictEqual(
      internals.resolveDraftProjectKey({ boardId: 'board-unknown' }, boards),
      'APEX'
    );

    manager.dispose();
  });

  test('boards without a project key are skipped, not offered as a choice', () => {
    const { manager, internals } = createInternals();

    const derived = internals.deriveProjectsFromBoards([
      board('board-none'),
      board('board-blank', '   '),
      board('board-apex', 'APEX', 'Apex Platform')
    ]);

    assert.deepStrictEqual(derived, [{ key: 'APEX', name: 'Apex Platform' }]);

    manager.dispose();
  });
});

suite('IssueDetailPanelManager draft service routing', () => {
  const defaultService = { mode: 'jiracloud' } as unknown as IssueTrackerService;
  const boardService = { mode: 'gitlab' } as unknown as IssueTrackerService;

  function createManager(
    resolver?: (boardId: string) => Promise<IssueTrackerService | undefined>
  ): IssueDetailPanelManager {
    return new IssueDetailPanelManager(
      defaultService,
      new AiSessionManager(new MemoryMemento()),
      async () => {},
      resolver
    );
  }

  test('routes a draft to the service owning its board', async () => {
    const requested: string[] = [];
    const manager = createManager(async boardId => {
      requested.push(boardId);
      return boardService;
    });
    const internals = manager as unknown as DraftInternals;
    internals.draftDefaults = { boardId: 'board-1' };

    assert.strictEqual(await internals.resolveDraftService(), boardService);
    assert.deepStrictEqual(requested, ['board-1']);

    manager.dispose();
  });

  test('uses the default service when the draft has no board', async () => {
    let called = false;
    const manager = createManager(async () => {
      called = true;
      return boardService;
    });
    const internals = manager as unknown as DraftInternals;
    internals.draftDefaults = {};

    assert.strictEqual(await internals.resolveDraftService(), defaultService);
    assert.strictEqual(called, false, 'no board id means nothing to resolve');

    manager.dispose();
  });

  test('falls back to the default service when the connection cannot be resolved', async () => {
    const unresolved = createManager(async () => undefined);
    const unresolvedInternals = unresolved as unknown as DraftInternals;
    unresolvedInternals.draftDefaults = { boardId: 'missing' };
    assert.strictEqual(await unresolvedInternals.resolveDraftService(), defaultService);
    unresolved.dispose();

    const throwing = createManager(async () => {
      throw new Error('connection unavailable');
    });
    const throwingInternals = throwing as unknown as DraftInternals;
    throwingInternals.draftDefaults = { boardId: 'board-1' };
    assert.strictEqual(await throwingInternals.resolveDraftService(), defaultService);
    throwing.dispose();
  });

  test('works without a resolver at all', async () => {
    const manager = createManager();
    const internals = manager as unknown as DraftInternals;
    internals.draftDefaults = { boardId: 'board-1' };

    assert.strictEqual(await internals.resolveDraftService(), defaultService);

    manager.dispose();
  });
});

/** Exposes the render internals the parent-rule serialization tests drive. */
type RenderInternals = {
  draftMode: boolean;
  draftServiceMode?: 'jiracloud' | 'livefolder' | 'userworkspace' | 'demo' | 'github' | 'gitlab';
  buildIssueBodyHtml: (issue: IssueDetails) => string;
};

function draftIssue(issueType: string): IssueDetails {
  return {
    key: '',
    summary: '',
    status: 'Not created',
    issueType,
    projectKey: 'LIVE',
    projectName: 'Live Folder',
    description: '',
    parentKey: '',
    priority: 'Medium',
    transitions: [],
    comments: [],
    linkedIssues: []
  };
}

function parseParentRules(html: string): Record<
  string,
  {
    canHaveParent: boolean;
    requiresParent: boolean;
    allowedParentTypes: string[];
    defaultLabel: string;
    helperText: string;
    placeholder: string;
  }
> {
  const match = html.match(/<script type="application\/json" id="parentRules">([\s\S]*?)<\/script>/);
  assert.ok(match, 'the draft form embeds the serialized parent rules');
  return JSON.parse(match[1]);
}

suite('IssueDetailPanelManager parent rule serialization', () => {
  function createDraftManager(mode: 'livefolder' | 'jiracloud'): IssueDetailPanelManager {
    const manager = new IssueDetailPanelManager(
      { mode } as unknown as IssueTrackerService,
      new AiSessionManager(new MemoryMemento()),
      async () => {}
    );
    const internals = manager as unknown as RenderInternals;
    internals.draftMode = true;
    return manager;
  }

  test('live folder drafts require a Feature parent and say so', () => {
    const manager = createDraftManager('livefolder');
    const html = (manager as unknown as RenderInternals).buildIssueBodyHtml(draftIssue('Story'));
    const rules = parseParentRules(html);

    assert.strictEqual(rules.Story.requiresParent, true);
    assert.strictEqual(rules.Story.defaultLabel, 'Feature');
    assert.deepStrictEqual(rules.Story.allowedParentTypes, ['Feature']);
    assert.match(rules.Story.helperText, /must belong to a Feature/);
    assert.match(
      rules.Story.helperText,
      /Select an existing feature or type a new name to create one\./,
      'drafts explain the inline-create combobox'
    );
    assert.strictEqual(rules.Feature.canHaveParent, false);
    // Every selectable type is present so the webview never falls back.
    for (const type of ['Epic', 'Feature', 'Idea', 'Story', 'Task', 'Subtask', 'Bug', 'Issue']) {
      assert.ok(rules[type], `rule serialized for ${type}`);
    }

    manager.dispose();
  });

  test('jira drafts keep the optional Epic rule', () => {
    const manager = createDraftManager('jiracloud');
    const html = (manager as unknown as RenderInternals).buildIssueBodyHtml(draftIssue('Story'));
    const rules = parseParentRules(html);

    assert.strictEqual(rules.Story.requiresParent, false);
    assert.strictEqual(rules.Story.defaultLabel, 'Epic');
    assert.doesNotMatch(rules.Story.helperText, /type a new name/);

    manager.dispose();
  });

  test('the draft form follows the board-owning service mode, not the active one', () => {
    // Active connection is Jira, but the draft targets a live folder board.
    const manager = createDraftManager('jiracloud');
    const internals = manager as unknown as RenderInternals;
    internals.draftServiceMode = 'livefolder';
    const html = internals.buildIssueBodyHtml(draftIssue('Task'));
    const rules = parseParentRules(html);

    assert.strictEqual(rules.Task.requiresParent, true);
    assert.strictEqual(rules.Task.defaultLabel, 'Feature');
    assert.match(html, /data-mode="livefolder"/);

    manager.dispose();
  });

  test('edit mode omits the inline-create hint', () => {
    const manager = new IssueDetailPanelManager(
      { mode: 'livefolder' } as unknown as IssueTrackerService,
      new AiSessionManager(new MemoryMemento()),
      async () => {}
    );
    // draftMode stays false: saved issues can reparent but cannot create features inline.
    const html = (manager as unknown as RenderInternals).buildIssueBodyHtml({
      ...draftIssue('Story'),
      key: 'LIVE-S01-1'
    });
    const rules = parseParentRules(html);

    assert.strictEqual(rules.Story.defaultLabel, 'Feature');
    assert.doesNotMatch(rules.Story.helperText, /type a new name/);

    manager.dispose();
  });
});
