import type { Connection } from '../types';
import type { ProjectRecord } from './projectTypes';
import { projectConnectionId } from './projectService';

/**
 * The connection row a project owns.
 *
 * Every project board has an ordinary connection record. Folder-backed projects
 * use the folder backend; app-owned projects use the local Praxis backend.
 * Projects merely own the association — they are not a backend mode.
 */
export function buildProjectConnection(project: ProjectRecord): Connection {
  const folderBacked = project.storage === 'folder' && Boolean(project.workspaceFolder);
  return {
    id: projectConnectionId(project.id),
    name: project.name,
    mode: folderBacked ? 'folder' : 'app',
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
