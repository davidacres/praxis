import { useEffect, useRef, useState } from 'react';
import { useDialogs } from '../ui/dialogs';
import type { GitConflictFile } from '@praxis/core';

interface GitConflictWorkspaceProps {
  repositoryPath: string;
  path: string;
  onClose: () => void;
  onResolved: () => void | Promise<void>;
  onAbort: () => void | Promise<void>;
  canAbort?: boolean;
}

function ConflictSource({ title, subtitle, content, onUseAll, onUseLine }: { title: string; subtitle: string; content: string; onUseAll: () => void; onUseLine: (line: string) => void }) {
  const lines = content.split('\n');
  return <section className="git-conflict-source">
    <header><div><strong>{title}</strong><small>{subtitle}</small></div><button onClick={onUseAll}>Use all</button></header>
    <div>{lines.map((line, index) => <div className="git-conflict-source-line" key={`${title}-${index}`}><span>{index + 1}</span><code>{line || ' '}</code><button aria-label={`Use line ${index + 1} from ${title}`} onClick={() => onUseLine(line)}>+</button></div>)}</div>
  </section>;
}

export function GitConflictWorkspace({ repositoryPath, path, onClose, onResolved, onAbort, canAbort }: GitConflictWorkspaceProps) {
  const { confirm } = useDialogs();
  const [conflict, setConflict] = useState<GitConflictFile>();
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setLoading(true);
    window.praxis.git.getConflict(repositoryPath, path).then(next => {
      setConflict(next);
      setResult(next.result);
      setError(undefined);
    }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setLoading(false));
  }, [repositoryPath, path]);

  const appendLine = (line: string) => {
    const editor = editorRef.current;
    if (!editor) { setResult(current => `${current}${current.endsWith('\n') || !current ? '' : '\n'}${line}\n`); return; }
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const insert = `${line}\n`;
    setResult(current => `${current.slice(0, start)}${insert}${current.slice(end)}`);
    requestAnimationFrame(() => { editor.focus(); editor.setSelectionRange(start + insert.length, start + insert.length); });
  };

  const resolve = async (strategy: 'current' | 'incoming' | 'manual') => {
    if (!conflict) return;
    if (strategy === 'manual' && /^(?:<<<<<<<|=======|>>>>>>>)/m.test(result)) {
      setError('Remove every conflict marker before saving the resolved file.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await window.praxis.git.resolveConflict(repositoryPath, path, strategy === 'manual' ? { strategy, content: result } : { strategy });
      await onResolved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const abort = async () => {
    if (!(await confirm({ title: 'Abort the in-progress Git operation?', message: 'Praxis will restore the repository to its pre-operation state when Git provides a safe abort action.', confirmLabel: 'Abort operation', danger: true }))) return;
    setBusy(true);
    try { await onAbort(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };

  return <section className="git-conflict-workspace" aria-label="Merge conflict editor" data-testid="git-conflict-workspace">
    <header className="git-conflict-commandbar">
      <button onClick={onClose} aria-label="Back to Git graph">←</button>
      <div><span>MERGE CONFLICT</span><strong>{path}</strong><small>Choose the lines that should remain, then save one clear result.</small></div>
      {canAbort && <button className="git-conflict-abort" disabled={busy} onClick={() => void abort()}>Abort operation</button>}
    </header>
    {error && <div className="git-diff-error" role="alert"><span>{error}</span><button onClick={() => setError(undefined)}>Dismiss</button></div>}
    {loading ? <div className="git-diff-state"><span className="git-spinner" /><strong>Preparing conflict choices</strong></div>
      : conflict?.isBinary ? <div className="git-conflict-binary"><strong>Binary conflict</strong><p>Choose the complete current or incoming file. Binary content cannot be combined line by line.</p><div><button disabled={busy} onClick={() => void resolve('current')}>Keep current file</button><button disabled={busy} onClick={() => void resolve('incoming')}>Keep incoming file</button></div></div>
      : conflict && <div className="git-conflict-layout">
        <div className="git-conflict-inputs">
          <ConflictSource title="Current branch" subtitle="Your checked-out branch" content={conflict.current} onUseAll={() => setResult(conflict.current)} onUseLine={appendLine} />
          <ConflictSource title="Incoming branch" subtitle="The changes being merged" content={conflict.incoming} onUseAll={() => setResult(conflict.incoming)} onUseLine={appendLine} />
        </div>
        <section className="git-conflict-result">
          <header><div><strong>Resolved output</strong><small>Edit directly or add individual lines using + above.</small></div><div><button disabled={busy} onClick={() => setResult(conflict.base)}>Start from base</button><button className="primary" disabled={busy || !result} onClick={() => void resolve('manual')}>{busy ? 'Saving…' : 'Save resolved file'}</button></div></header>
          <textarea ref={editorRef} value={result} onChange={event => setResult(event.target.value)} spellCheck={false} aria-label="Resolved file content" />
        </section>
      </div>}
  </section>;
}
