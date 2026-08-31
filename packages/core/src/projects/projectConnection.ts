import type { Connection } from '../types';
import type { ProjectRecord } from './projectTypes';
import { projectConnectionId } from './projectService';

/**
 * The connection row a project owns.
 *
 * Every board in the app is resolved through the connection list, so a project's
 * board needs a row there like any other. The row is a *projection* of the
 * project record — `projectIpc` rewrites it whenever the project changes, so
 * there is exactly one writer and the two cannot drift.
 *
 * The mode is always `project`, whatever the storage: a folder-backed project is
 * still a project, and the UI should present it as one. Where its work items
 * actually live is carried in the settings, which is also what the connections
 * screen shows the user.
 */
export function buildProjectConnection(project: ProjectRecord): Connection {
  const folderBacked = project.storage === 'folder' && Boolean(project.workspaceFolder);
  return {
    id: projectConnectionId(project.id),
    name: project.name,
    mode: 'project',
    settings: {
      projectId: project.id,
      projectKey: project.key,
      projectName: project.name,
      source: folderBacked ? 'folder' : 'app',
      ...(folderBacked ? { roots: [project.workspaceFolder as string] } : {}),
      // A project owns its board outright, so ticket creation is always on —
      // unlike a folder *connection*, which stays read-only until the user
      // opts in. `App.tsx` reads this to decide whether to offer "New ticket".
      allowIssueCreation: true
    }
  };
}

/** Whether a connection id addresses a project's own board rather than a stored backend. */
export function isProjectConnectionId(connectionId: string | undefined): boolean {
  return typeof connectionId === 'string' && connectionId.startsWith('project:');
}
