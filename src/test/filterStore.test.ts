import * as assert from 'node:assert';
import type { Memento, ExtensionContext } from 'vscode';
import { FilterStore, shouldAdoptJiraCloudEpicIssueScope } from '../state/filterStore';

class MemoryMemento implements Memento {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.store.get(key) as T) ?? (defaultValue as T);
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
      return;
    }
    this.store.set(key, value);
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }

  setKeysForSync(): void {
    // No-op for tests.
  }
}

function createContext(): ExtensionContext {
  return {
    workspaceState: new MemoryMemento(),
    globalState: new MemoryMemento()
  } as unknown as ExtensionContext;
}

suite('FilterStore', () => {
  test('recognizes the untouched default issue scope for Jira Cloud epic migration', () => {
    assert.strictEqual(
      shouldAdoptJiraCloudEpicIssueScope({
        projectKeys: [],
        statuses: [],
        issueTypes: [],
        searchText: '',
        assigneeMode: 'me',
        parentKey: undefined,
        grouping: 'none'
      }),
      true
    );
  });

  test('does not override an explicitly broadened or narrowed issue scope', () => {
    assert.strictEqual(
      shouldAdoptJiraCloudEpicIssueScope({
        projectKeys: [],
        statuses: [],
        issueTypes: [],
        searchText: '',
        assigneeMode: 'all',
        parentKey: undefined,
        grouping: 'none'
      }),
      false
    );

    assert.strictEqual(
      shouldAdoptJiraCloudEpicIssueScope({
        projectKeys: [],
        statuses: ['In Progress'],
        issueTypes: [],
        searchText: '',
        assigneeMode: 'me',
        parentKey: undefined,
        grouping: 'none'
      }),
      false
    );
  });

  test('persists status filters across store instances', async () => {
    const context = createContext();
    const firstStore = new FilterStore(context);

    await firstStore.updateFilters({ statuses: ['Blocked', 'In Progress'] });

    const secondStore = new FilterStore(context);
    assert.deepStrictEqual(secondStore.getFilters().statuses, ['Blocked', 'In Progress']);
  });

  test('persists EPIC status filters independently from My Issues statuses', async () => {
    const context = createContext();
    const firstStore = new FilterStore(context);

    await firstStore.updateFilters({ statuses: ['Blocked'] });
    await firstStore.setEpicStatuses(['In Progress']);

    const secondStore = new FilterStore(context);
    assert.deepStrictEqual(secondStore.getFilters().statuses, ['Blocked']);
    assert.deepStrictEqual(secondStore.getEpicStatuses(), ['In Progress']);
  });

  test('clearing My Issues filters does not clear EPIC status filters', async () => {
    const context = createContext();
    const store = new FilterStore(context);

    await store.updateFilters({ statuses: ['Blocked'] });
    await store.setEpicStatuses(['In Progress']);
    await store.clearFilters();

    assert.deepStrictEqual(store.getFilters().statuses, []);
    assert.deepStrictEqual(store.getEpicStatuses(), ['In Progress']);
  });
});
