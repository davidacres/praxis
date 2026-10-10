import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { AgentSessionRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';

interface SessionGitBranchControlProps {
  session: AgentSessionRecord;
  disabled?: boolean;
}

function basename(pathStr?: string): string {
  if (!pathStr) return '';
  const normalized = pathStr.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || pathStr;
}

export function SessionGitBranchControl({ session, disabled = false }: SessionGitBranchControlProps) {
  const { confirm, prompt } = useDialogs();
  const [menuPosition, setMenuPosition] = useState<{ bottom: number; left: number }>();
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [currentBranch, setCurrentBranch] = useState<string | undefined>(session.worktreeBranch);
  const [branches, setBranches] = useState<string[]>([]);
  const [isGitRepo, setIsGitRepo] = useState<boolean>(Boolean(session.worktreeBranch));
  const [loading, setLoading] = useState<boolean>(false);
  const [busyAction, setBusyAction] = useState<string | undefined>();

  const repositoryPath = session.worktreePath || session.workingDirectory;
  const isWorktree = Boolean(session.worktreePath);

  const refreshGitInfo = useCallback(async () => {
    if (!repositoryPath) {
      setCurrentBranch(session.worktreeBranch);
      setIsGitRepo(false);
      setBranches([]);
      return;
    }
    setLoading(true);
    try {
      const snapshot = await window.praxis.git.open(repositoryPath);
      setIsGitRepo(true);
      setCurrentBranch(snapshot.currentBranch || session.worktreeBranch);
      setBranches(
        snapshot.branches
          .filter(b => !b.isRemote)
          .map(b => b.name)
      );
    } catch {
      if (session.worktreeBranch) {
        setIsGitRepo(true);
        setCurrentBranch(session.worktreeBranch);
      } else {
        setIsGitRepo(false);
        setCurrentBranch(undefined);
      }
    } finally {
      setLoading(false);
    }
  }, [repositoryPath, session.worktreeBranch]);

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

  const handleCreateBranch = async () => {
    if (!repositoryPath) return;
    setMenuPosition(undefined);
    const name = await prompt({
      title: 'New git branch',
      label: 'Branch name',
      placeholder: 'feature/short-description',
      confirmLabel: 'Create branch',
      validate: value => (/^[a-z0-9][a-z0-9._/-]*$/i.test(value.trim()) ? undefined : 'Letters, digits, and . _ / - only.')
    });
    if (!name) return;

    setBusyAction('Creating branch…');
    try {
      await window.praxis.git.createBranch(repositoryPath, name.trim());
      await refreshGitInfo();
    } catch (err) {
      console.error('Failed to create branch:', err);
    } finally {
      setBusyAction(undefined);
    }
  };

  const handleCheckoutBranch = async (branchName: string) => {
    if (!repositoryPath || branchName === currentBranch) return;
    setMenuPosition(undefined);
    setBusyAction(`Switching to ${branchName}…`);
    try {
      await window.praxis.git.checkout(repositoryPath, branchName);
      await refreshGitInfo();
    } catch (err) {
      console.error('Failed to switch branch:', err);
    } finally {
      setBusyAction(undefined);
    }
  };

  const handleSetWorktree = async () => {
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
  };

  const handleRemoveWorktree = async () => {
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
  };

  const displayBranch = currentBranch || (isGitRepo ? 'HEAD' : undefined);
  const chipLabel = busyAction || (loading && !displayBranch ? 'Reading git…' : displayBranch || (repositoryPath ? 'No git repository' : 'No folder'));

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`composer-chip session-git-branch-chip${menuPosition ? ' active' : ''}${isWorktree ? ' is-worktree' : ''}`}
        data-testid="session-git-branch-chip"
        aria-haspopup="listbox"
        aria-expanded={Boolean(menuPosition)}
        disabled={disabled || !repositoryPath}
        title={
          isWorktree
            ? `Branch: ${displayBranch ?? 'unknown'} (Worktree: ${session.worktreePath})`
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
          data-testid="session-git-branch-menu"
          style={{ position: 'fixed', bottom: menuPosition.bottom, left: menuPosition.left }}
        >
          <div className="popover-label">Git Branch & Worktree</div>

          <div className="session-git-menu-info">
            <div className="session-git-menu-info__row">
              <span className="session-git-menu-info__label">Current:</span>
              <strong className="session-git-menu-info__value">{displayBranch || 'None'}</strong>
            </div>
            {isWorktree ? (
              <div className="session-git-menu-info__row">
                <span className="session-git-menu-info__label">Worktree:</span>
                <span className="session-git-menu-info__path" title={session.worktreePath}>
                  {basename(session.worktreePath)}
                </span>
                {session.worktreeBaseBranch && (
                  <span className="session-git-menu-info__base">from {session.worktreeBaseBranch}</span>
                )}
              </div>
            ) : (
              <div className="session-git-menu-info__row">
                <span className="session-git-menu-info__label">Repo:</span>
                <span className="session-git-menu-info__path" title={repositoryPath}>
                  {basename(repositoryPath)}
                </span>
              </div>
            )}
          </div>

          <div className="session-git-menu-divider" />

          {/* Branch Actions */}
          <button
            type="button"
            className="composer-provider-option session-git-menu-action"
            data-testid="session-git-create-branch-btn"
            onClick={() => void handleCreateBranch()}
          >
            <Icon name="plus" size={14} />
            <span className="heading-option-body">
              <strong>New branch…</strong>
              <small>Create and switch to a new git branch</small>
            </span>
          </button>

          {/* Worktree Actions */}
          {!isWorktree ? (
            <button
              type="button"
              className="composer-provider-option session-git-menu-action"
              data-testid="session-git-set-worktree-btn"
              onClick={() => void handleSetWorktree()}
            >
              <Icon name="folder" size={14} />
              <span className="heading-option-body">
                <strong>Set up worktree…</strong>
                <small>Run this session in an isolated git checkout</small>
              </span>
            </button>
          ) : (
            <button
              type="button"
              className="composer-provider-option session-git-menu-action session-git-menu-action--danger"
              data-testid="session-git-remove-worktree-btn"
              onClick={() => void handleRemoveWorktree()}
            >
              <Icon name="close" size={14} />
              <span className="heading-option-body">
                <strong>Remove worktree…</strong>
                <small>Return to main repository and delete worktree</small>
              </span>
            </button>
          )}

          {/* Other branches to switch to */}
          {branches.length > 1 && (
            <>
              <div className="session-git-menu-divider" />
              <div className="session-git-menu-subtitle">Switch branch</div>
              <div className="session-git-branch-list">
                {branches.map(branchName => {
                  const isCurrent = branchName === currentBranch;
                  return (
                    <button
                      key={branchName}
                      type="button"
                      className={`composer-provider-option session-git-branch-item${isCurrent ? ' active' : ''}`}
                      data-testid={`session-git-branch-option-${branchName}`}
                      onClick={() => void handleCheckoutBranch(branchName)}
                    >
                      <Icon name="git-branch" size={13} />
                      <span className="session-git-branch-item__name">{branchName}</span>
                      {isCurrent && <Icon name="check" size={13} />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
