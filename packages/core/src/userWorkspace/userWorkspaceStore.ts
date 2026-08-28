import type { KeyValueStore } from '../host/stateStore';
import { toStoredFolderPath } from '../livefolder/pathUtils';

const USER_WORKSPACE_BOARDS_KEY = 'praxis.userWorkspaceBoards';

export interface UserWorkspaceBoardDefinition {
  id: string;
  name: string;
  projectKey: string;
  projectName: string;
  liveFolderPath: string;
  createdAt: string;
}

interface CreateUserWorkspaceBoardInput {
  name: string;
  projectKey: string;
  projectName: string;
  liveFolderPath: string;
}

function normalizeValue(value: string): string {
  return value.trim();
}

function createBoardId(projectKey: string): string {
  const key = projectKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `user-workspace-${key || 'board'}-${Date.now()}-${randomPart}`;
}

export class UserWorkspaceStore {
  public constructor(private readonly globalState: KeyValueStore) {}

  public getBoards(): UserWorkspaceBoardDefinition[] {
    const stored = this.globalState.get<UserWorkspaceBoardDefinition[]>(USER_WORKSPACE_BOARDS_KEY) ?? [];
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored
      .filter(entry => {
        return (
          entry &&
          typeof entry.id === 'string' &&
          typeof entry.name === 'string' &&
          typeof entry.projectKey === 'string' &&
          typeof entry.projectName === 'string' &&
          typeof entry.liveFolderPath === 'string'
        );
      })
      .map(entry => ({
        ...entry,
        name: normalizeValue(entry.name),
        projectKey: normalizeValue(entry.projectKey),
        projectName: normalizeValue(entry.projectName),
        liveFolderPath: toStoredFolderPath(entry.liveFolderPath)
      }));
  }

  public getBoard(boardId: string): UserWorkspaceBoardDefinition | undefined {
    return this.getBoards().find(board => board.id === boardId);
  }

  public async createBoard(
    input: CreateUserWorkspaceBoardInput
  ): Promise<UserWorkspaceBoardDefinition> {
    const board: UserWorkspaceBoardDefinition = {
      id: createBoardId(input.projectKey),
      name: normalizeValue(input.name),
      projectKey: normalizeValue(input.projectKey),
      projectName: normalizeValue(input.projectName),
      liveFolderPath: toStoredFolderPath(input.liveFolderPath),
      createdAt: new Date().toISOString()
    };
    const boards = this.getBoards();
    boards.push(board);
    await this.globalState.update(USER_WORKSPACE_BOARDS_KEY, boards);
    return board;
  }

  public async updateBoardName(boardId: string, name: string): Promise<UserWorkspaceBoardDefinition> {
    const boards = this.getBoards();
    const index = boards.findIndex(board => board.id === boardId);
    if (index < 0) {
      throw new Error(`Board ${boardId} was not found in the user workspace.`);
    }
    boards[index] = {
      ...boards[index],
      name: normalizeValue(name)
    };
    await this.globalState.update(USER_WORKSPACE_BOARDS_KEY, boards);
    return boards[index];
  }

  public async deleteBoard(boardId: string): Promise<void> {
    const boards = this.getBoards();
    const nextBoards = boards.filter(board => board.id !== boardId);
    await this.globalState.update(USER_WORKSPACE_BOARDS_KEY, nextBoards);
  }
}
