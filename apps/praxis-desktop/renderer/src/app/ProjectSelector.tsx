import type { ProjectRecord } from '@praxis/core';
import { ChipSelect } from '../ui/ChipSelect';
import type { IconName } from '../ui/Icon';

/** The workspace's project switcher, shared by both sidebar layouts. */
export function ProjectSelector({ projects, activeProjectId, onSelectProject }: {
  projects: ProjectRecord[];
  activeProjectId?: string;
  onSelectProject: (projectId: string) => void;
}) {
  if (projects.length === 0) return null;
  const activeProject = projects.find(project => project.id === activeProjectId);
  return (
    <ChipSelect
      data-testid="sidebar-project-select"
      className="sidebar-project-select"
      ariaLabel="Select project"
      value={activeProjectId ?? ''}
      placeholder="All projects"
      icon={(activeProject?.icon as IconName) ?? 'folder-open'}
      options={projects.map(project => ({ value: project.id, label: project.name, icon: (project.icon as IconName) ?? 'folder-open' }))}
      onChange={onSelectProject}
      block
      variant="plain"
    />
  );
}
