import type { ProjectRecord } from '@praxis/core';
import { ChipSelect } from '../ui/ChipSelect';
import type { IconName } from '../ui/Icon';

/** The workspace's project switcher, hosted by the titlebar. */
export function ProjectSelector({ projects, activeProjectId, onSelectProject, includeConversations = false }: {
  includeConversations?: boolean;
  projects: ProjectRecord[];
  activeProjectId?: string;
  onSelectProject: (projectId: string) => void;
}) {
  if (projects.length === 0 && !includeConversations) return null;
  const activeProject = projects.find(project => project.id === activeProjectId);
  return (
    <ChipSelect
      data-testid="sidebar-project-select"
      className="sidebar-project-select"
      ariaLabel="Select project"
      value={activeProjectId ?? ''}
      placeholder="All projects"
      icon={activeProjectId === 'conversations' ? 'chats' : (activeProject?.icon as IconName) ?? 'folder-open'}
      options={[
        ...(includeConversations ? [{ value: 'conversations', label: 'General conversations', icon: 'chats' as IconName }] : []),
        ...projects.map(project => ({ value: project.id, label: project.name, icon: (project.icon as IconName) ?? 'folder-open' }))
      ]}
      onChange={onSelectProject}
      block
      variant="plain"
    />
  );
}
