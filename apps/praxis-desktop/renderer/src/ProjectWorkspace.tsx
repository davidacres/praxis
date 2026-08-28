import type { Board, ProjectRecord } from '@praxis/core';
import { Icon } from './Icon';

export function ProjectWorkspace({ project, boards, onOpenBoard, onOpenGit }: { project: ProjectRecord; boards: Board[]; onOpenBoard: (boardId: string) => void; onOpenGit: () => void }) {
  const projectBoards = boards.filter(board => board.connectionId === `project:${project.id}` || project.linkedBoards.some(link => link.connectionId === board.connectionId && link.boardId === board.id));
  const defaultBoard = projectBoards.find(board => board.id === project.defaultBoardId);
  const linkedBoards = projectBoards.filter(board => board.id !== defaultBoard?.id);
  const hasWorkspace = Boolean(project.workspaceFolder);
  const hasGit = project.folderInspection?.hasGit;
  return <main className="project-workspace" data-testid="project-workspace">
    <header className="project-workspace-header"><div><span className="project-type-badge">{project.type}</span><h1>{project.name}</h1><p>{project.key} · {hasWorkspace ? project.workspaceFolder : 'No workspace folder attached'}</p></div><button className="btn" onClick={onOpenGit} title={!hasWorkspace ? 'Set up a Git workspace for this project' : undefined}><Icon name="git-branch" size={14} /> Git Graph</button></header>
    <section className="project-workspace-section" aria-labelledby="project-work-heading"><div className="section-heading"><div><span className="git-eyebrow">PROJECT WORK</span><h2 id="project-work-heading">Boards</h2></div><span className="project-workspace-count">{projectBoards.length}</span></div><div className="project-board-grid">
      {defaultBoard && <button className="project-board-card project-board-card-primary" data-testid="project-work-board" onClick={() => onOpenBoard(defaultBoard.id)}><span className="project-board-card-icon"><Icon name="columns" size={20} /></span><span><strong>{defaultBoard.name}</strong><small>Default board · {project.workItems.length} starter items</small></span><Icon name="chevron-right" size={16} /></button>}
      {linkedBoards.map(board => <button className="project-board-card" data-testid="project-linked-board" key={`${board.connectionId}:${board.id}`} onClick={() => onOpenBoard(board.id)}><span className="project-board-card-icon"><Icon name="link" size={18} /></span><span><strong>{board.name}</strong><small>Linked board</small></span><Icon name="chevron-right" size={16} /></button>)}
      {projectBoards.length === 0 && <div className="project-workspace-empty">This project does not have a board yet.</div>}
    </div></section>
    <section className="project-workspace-section" aria-labelledby="project-git-heading"><div className="section-heading"><div><span className="git-eyebrow">REPOSITORY TOOLS</span><h2 id="project-git-heading">Git</h2></div></div><button className="project-git-card" data-testid="project-git-card" onClick={onOpenGit}><span className="project-git-card-icon"><Icon name="git-branch" size={21} /></span><span><strong>{!hasWorkspace ? 'Attach a workspace to enable Git' : hasGit ? 'Open Git Graph and diffs' : 'Set up Git for this workspace'}</strong><small>{!hasWorkspace ? 'Repository history belongs to a project folder.' : hasGit ? 'Branches, history, changes, and conflicts' : 'Praxis will check the folder and offer to initialize Git.'}</small></span><Icon name="chevron-right" size={17} /></button></section>
  </main>;
}
