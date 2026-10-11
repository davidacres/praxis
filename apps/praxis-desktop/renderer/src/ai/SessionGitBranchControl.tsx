import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { AgentSessionRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';

interface SessionGitBranchControlProps {
  session?: AgentSessionRecord;
  workingDirectory?: string;
  runInWorktree?: boolean;
  onToggleWorktree?: (active: boolean) => void;
  testId?: string;
  disabled?: boolean;
}

function basename(pathStr?: string): string {
  if (!pathStr) return '';
  const normalized = pathStr.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || pathStr;
}

export function SessionGitBranchControl({
  session,
  workingDirectory,
  runInWorktree = false,
  onToggleWorktree,
  testId = 'session',
  disabled = false
}: SessionGitBranchControlProps) {
  const { confirm, prompt } = useDialogs();
  const [menuPosition, setMenuPosition] = useState<{ bottom: number; left: number }>();
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [currentBranch, setCurrentBranch] = useState<string | undefined>(session?.worktreeBranch);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchFilter, setBranchFilter] = useState('');
  const [isGitRepo, setIsGitRepo] = useState<boolean>(Boolean(session?.worktreeBranch));
  const [loading, setLoading] = useState<boolean>(false);
  const [busyAction, setBusyAction] = useState<string | undefined>();

  const repositoryPath = session?.worktreePath || session?.workingDirectory || workingDirectory;
  const isWorktree = Boolean(session?.worktreePath || runInWorktree);

  const refreshGitInfo = useCallback(async () => {
    if (!repositoryPath) {
      setCurrentBranch(session?.worktreeBranch);
      setIsGitRepo(false);
      setBranches([]);
      return;
    }
    setLoading(true);
    try {
      const snapshot = await window.praxis.git.open(repositoryPath);
      setIsGitRepo(true);
      setCurrentBranch(snapshot.currentBranch || session?.worktreeBranch);
      setBranches(
        snapshot.branches
          .filter(b => !b.isRemote)
          .map(b => b.name)
      );
    } catch {
      if (session?.worktreeBranch) {
        setIsGitRepo(true);
        setCurrentBranch(session.worktreeBranch);
      } else {
        setIsGitRepo(false);
        setCurrentBranch(undefined);
      }
    } finally {
      setLoading(false);
    }
  }, [repositoryPath, session?.worktreeBranch]);

  useEffect(() => {
    void refreshGitInfo();
  }, [refreshGitInfo]);

  useEffect(() => {
    if (!menuPosition) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      setMenuPosition(undefined);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
  }, [menuPosition]);

  const handleCreateBranch = async (customName?: string) => {
    if (!repositoryPath) return;
    let name = customName?.trim();
    if (!name) {
      setMenuPosition(undefined);
      name = (await prompt({
        title: 'New git branch',
        label: 'Branch name',
        placeholder: 'feature/short-description',
        confirmLabel: 'Create branch',
        validate: value => (/^[a-z0-9][a-z0-9._/-]*$/i.test(value.trim()) ? undefined : 'Letters, digits, and . _ / - only.')
      }))?.trim();
    }
    if (!name) return;

    setBusyAction('Creating branch…');
    try {
      await window.praxis.git.createBranch(repositoryPath, name);
      setBranchFilter('');
      await refreshGitInfo();
    } catch (err) {
      console.error('Failed to create branch:', err);
    } finally {
      setBusyAction(undefined);
    }
  };

  const handleCheckoutBranch = async (branchName: string) => {
    if (!repositoryPath || branchName === currentBranch) return;
    setBusyAction(`Switching to ${branchName}…`);
    try {
      await window.praxis.git.checkout(repositoryPath, branchName);
      setBranchFilter('');
      await refreshGitInfo();
    } catch (err) {
      console.error('Failed to switch branch:', err);
    } finally {
      setBusyAction(undefined);
    }
  };

  const handleSetWorktree = async () => {
    if (session) {
      if (!repositoryPath) return;
      setMenuPosition(undefined);
      const defaultBranch = `session-${session.issueKey.toLowerCase()}`;
      const branchName = await prompt({
        title: 'Set up worktree for session',
        message: 'Creates an isolated git worktree so the agent works in a separate directory without modifying your main checkout.',
        label: 'Worktree branch name',
        initialValue: defaultBranch,
        confirmLabel: 'Create worktree',
        validate: value => (/^[a-z0-9][a-z0-9._/-]*$/i.test(value.trim()) ? undefined : 'Letters, digits, and . _ / - only.')
      });
      if (!branchName) return;

      setBusyAction('Creating worktree…');
      try {
        await window.praxis.ai.setWorktree(session.issueKey, { branchName: branchName.trim() });
        await refreshGitInfo();
      } catch (err) {
        console.error('Failed to create worktree:', err);
      } finally {
        setBusyAction(undefined);
      }
    } else if (onToggleWorktree) {
      onToggleWorktree(true);
    }
  };

  const handleRemoveWorktree = async () => {
    if (session) {
      if (!session.worktreePath) return;
      setMenuPosition(undefined);
      const ok = await confirm({
        title: 'Remove session worktree?',
        message: `${session.worktreePath}\n\nThe worktree checkout and branch ${session.worktreeBranch ?? ''} will be removed. The session will point back to the main checkout.`,
        confirmLabel: 'Remove worktree',
        danger: true
      });
      if (!ok) return;

      setBusyAction('Removing worktree…');
      try {
        await window.praxis.ai.removeWorktree(session.issueKey);
        await refreshGitInfo();
      } catch (err) {
        console.error('Failed to remove worktree:', err);
      } finally {
        setBusyAction(undefined);
      }
    } else if (onToggleWorktree) {
      onToggleWorktree(false);
    }
  };

  const displayBranch = currentBranch || (isGitRepo ? 'HEAD' : undefined);
  const chipLabel = busyAction || (loading && !displayBranch ? 'Reading git…' : displayBranch || (repositoryPath ? 'No git repository' : 'No folder'));

  const trimmedFilter = branchFilter.trim();
  const filteredBranches = useMemo(() => {
    if (!trimmedFilter) return branches;
    return branches.filter(b => b.toLowerCase().includes(trimmedFilter.toLowerCase()));
  }, [branches, trimmedFilter]);

  const exactMatchBranch = branches.find(b => b.toLowerCase() === trimmedFilter.toLowerCase());
  const canQuickCreate = trimmedFilter.length > 0 && !exactMatchBranch && /^[a-z0-9][a-z0-9._/-]*$/i.test(trimmedFilter);

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`composer-chip session-git-branch-chip${menuPosition ? ' active' : ''}${isWorktree ? ' is-worktree' : ''}`}
        data-testid={testId === 'session' ? 'session-git-branch-chip' : `${testId}-git-branch-chip`}
        aria-haspopup="listbox"
        aria-expanded={Boolean(menuPosition)}
        disabled={disabled || !repositoryPath}
        title={
          isWorktree
            ? session?.worktreePath
              ? `Branch: ${displayBranch ?? 'unknown'} (Worktree: ${session.worktreePath})`
              : `Branch: ${displayBranch ?? 'unknown'} (Isolated worktree)`
            : repositoryPath
              ? `Branch: ${displayBranch ?? 'none'} (${repositoryPath})`
              : 'Attach a working directory to view and manage git branches'
        }
        onClick={() => {
          if (menuPosition) {
            setMenuPosition(undefined);
            return;
          }
          const rect = chipRef.current?.getBoundingClientRect();
          if (rect) setMenuPosition({ bottom: window.innerHeight - rect.top + 6, left: rect.left });
        }}
      >
        <Icon name="git-branch" size={13} />
        <span className="session-git-branch-name">{chipLabel}</span>
        {isWorktree && <span className="session-git-worktree-tag" title="In isolated worktree">worktree</span>}
        {repositoryPath && isGitRepo && <Icon name="chevron-down" size={12} />}
      </button>

      {menuPosition && isGitRepo && createPortal(
        <div
          ref={menuRef}
          className="composer-provider-menu session-git-branch-menu"
          role="dialog"
          aria-label="Git branch management"
          data-testid={testId === 'session' ? 'session-git-branch-menu' : `${testId}-git-branch-menu`}
          style={{ position: 'fixed', bottom: menuPosition.bottom, left: menuPosition.left }}
        >
          <div className="popover-label">Git & Workspace</div>

          {/* Worktree Toggle Row */}
          {(session || onToggleWorktree) && (
            <>
              <div className="session-git-worktree-toggle-row" data-testid={testId === 'session' ? 'session-git-worktree-toggle-row' : `${testId}-git-worktree-toggle-row`}>
                <div className="session-git-worktree-toggle-info">
                  <div className="session-git-worktree-toggle-title">
                    <Icon name="folder" size={13} />
                    <strong>Isolated worktree</strong>
                    {isWorktree && <span className="session-git-worktree-tag">active</span>}
                  </div>
                  <div className="session-git-worktree-toggle-desc">
                    {isWorktree
                      ? session?.worktreePath
                        ? `${basename(session.worktreePath)} (from ${session.worktreeBaseBranch || 'main'})`
                        : 'Session will start in an isolated git worktree'
                      : 'Isolate session changes from your main checkout'}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isWorktree}
                  aria-label="Isolated worktree"
                  className="switch"
                  data-testid={testId === 'session' ? 'session-git-worktree-toggle' : `${testId}-git-worktree-toggle`}
                  disabled={busyAction !== undefined}
                  onClick={() => {
                    if (isWorktree) {
                      void handleRemoveWorktree();
                    } else {
                      void handleSetWorktree();
                    }
                  }}
                />
              </div>
              <div className="session-git-menu-divider" />
            </>
          )}

          {/* Branch Section Header & Inline Action */}
          <div className="session-git-branch-header">
            <span className="session-git-menu-subtitle">Branches</span>
            <span className="session-git-current-badge" title="Active checkout branch">
              Active: <code>{displayBranch || 'None'}</code>
            </span>
          </div>

          {/* Branch Search / Name Input linked to New Button */}
          <div className="session-git-branch-input-row">
            <div className="session-git-branch-search">
              <Icon name="search" size={12} className="session-git-search-icon" />
              <input
                type="text"
                className="session-git-branch-input"
                placeholder="Branch name or filter…"
                value={branchFilter}
                onChange={e => setBranchFilter(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (exactMatchBranch) {
                      void handleCheckoutBranch(exactMatchBranch);
                    } else if (canQuickCreate) {
                      void handleCreateBranch(trimmedFilter);
                    } else if (!trimmedFilter) {
                      void handleCreateBranch();
                    }
                  }
                }}
              />
            </div>
            <button
              type="button"
              className={`btn btn-xs session-git-branch-action-btn ${canQuickCreate ? 'btn-primary' : 'btn-ghost'}`}
              data-testid="session-git-create-branch-btn"
              disabled={busyAction !== undefined}
              title={
                canQuickCreate
                  ? `Create new branch "${trimmedFilter}" and checkout`
                  : exactMatchBranch
                    ? `Switch to "${exactMatchBranch}"`
                    : 'Create a new branch…'
              }
              onClick={() => {
                if (canQuickCreate) {
                  void handleCreateBranch(trimmedFilter);
                } else if (exactMatchBranch) {
                  void handleCheckoutBranch(exactMatchBranch);
                } else {
                  void handleCreateBranch();
                }
              }}
            >
              <Icon name="plus" size={11} />
              <span>{canQuickCreate ? 'Create' : 'New'}</span>
            </button>
          </div>

          {/* Tight and Clean Branch List */}
          <div className="session-git-branch-list" data-testid="session-git-branch-list">
            {filteredBranches.length === 0 ? (
              <div className="session-git-empty-branches">No matching branches</div>
            ) : (
              filteredBranches.map(branchName => {
                const isCurrent = branchName === currentBranch;
                return (
                  <button
                    key={branchName}
                    type="button"
                    className={`session-git-branch-item${isCurrent ? ' active' : ''}`}
                    data-testid={`session-git-branch-option-${branchName}`}
                    onClick={() => void handleCheckoutBranch(branchName)}
                  >
                    <Icon name="git-branch" size={12} className="session-git-branch-icon" />
                    <span className="session-git-branch-item__name" title={branchName}>{branchName}</span>
                    {isCurrent && <Icon name="check" size={12} className="session-git-branch-item__current" />}
                  </button>
                );
              })
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
