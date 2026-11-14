import { useState } from 'react';
import type { AgentSessionRecord, ChatBlock, GadgetActionResult, GadgetActionValue } from '@praxis/core';
import { Markdown } from '../ui/Markdown';
import { GadgetBlockList } from './gadgets/GadgetSurface';
import { sessionCommandEvidence } from './sessionReviewModel';
import './sessionReview.css';

/** A compact way back into a session; details stay available without crowding the conversation. */
export function SessionReview({ session, blocks = [], results, busyGadgetId, onSubmit }: { session: AgentSessionRecord; blocks?: ChatBlock[]; results?: Record<string, GadgetActionResult>; busyGadgetId?: string; onSubmit: (gadgetId: string, actionId: string, value: GadgetActionValue) => void }) {
  const [open, setOpen] = useState(false);
  const brief = session.handoverBrief;
  const commands = sessionCommandEvidence(session);
  const files = session.changeSummary?.files.map(file => file.path) ?? brief?.touchedFiles ?? [];
  const evidence = blocks.filter(block => block.type === 'gadget' && ['image', 'artifact'].includes(block.gadget.kind)).map(block => block.type === 'gadget' ? { ...block, blockId: `review-${block.blockId}`, gadget: { ...block.gadget, gadgetId: `review-${block.gadget.gadgetId}` } } : block);
  const reviewResults = results && Object.fromEntries(Object.entries(results).map(([id, value]) => [`review-${id}`, value]));
  const pending = session.taskList?.filter(task => task.status !== 'completed') ?? [];
  return <details className="session-review" data-testid="session-review" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Pick up where you left off <span>{files.length} file{files.length === 1 ? '' : 's'} · {commands.length} recorded commands</span>{brief?.nextSteps && <span className="session-review-next">Next: {brief.nextSteps.slice(0, 180)}{brief.nextSteps.length > 180 ? '…' : ''}</span>}</summary>
    {open && <div className="session-review-body">
      <div className="session-review-recap">
        <section><h4>Progress</h4><p>{brief?.progress || 'No handover brief recorded yet. Review the latest reply below.'}</p></section>
        <section><h4>Continue with</h4><p>{brief?.nextSteps || pending.map(task => task.content).join('\n') || 'No next step recorded.'}</p></section>
        <section><h4>Open questions and risks</h4><p>{[brief?.openQuestions, brief?.risks, session.lastError].filter(Boolean).join('\n') || 'None recorded.'}</p></section>
      </div>
      {brief && <p className="hint">Brief revision {brief.revision} · {brief.freshness} · {new Date(brief.updatedAt).toLocaleString()}{brief.sourceEventCount < (session.eventCount ?? session.events.length) ? ' · Newer activity may not be covered.' : ''}</p>}
      <details><summary>Changes · {files.length} file{files.length === 1 ? '' : 's'}</summary>
        <p>{brief?.changes || 'No change description recorded.'}</p>
        <p className="hint">Files reported by this session; review the Changes tab for the current working tree.</p>
        <ul>{files.map(path => <li key={path}><code>{path}</code></li>)}</ul>
      </details>
      <details data-testid="session-evidence"><summary>Verification evidence · {commands.length} commands</summary>
        <p className="hint">Recorded command outcomes only. A successful command does not establish full test coverage. Unrecorded and unrun checks remain unknown.</p>
        {session.eventsLoaded === false && <p role="status">The transcript is still loading; evidence may be incomplete.</p>}
        {!commands.length && <p>No command execution evidence was recorded.</p>}
        {commands.map(command => <details key={command.id} className="session-review-command"><summary>{command.outcome}{command.exitCode !== undefined ? ` (${command.exitCode})` : ''} · {command.command}</summary><time>{new Date(command.timestamp).toLocaleString()}</time><pre>{command.output || 'No output recorded.'}</pre></details>)}
      </details>
      {evidence.length > 0 && <details><summary>Pictures and reports · {evidence.length}</summary><GadgetBlockList blocks={evidence} results={reviewResults} busyGadgetId={busyGadgetId ? `review-${busyGadgetId}` : undefined} onSubmit={(id, action, value) => onSubmit(id.slice('review-'.length), action, value)} /></details>}
      {brief?.userNotes && <details><summary>Your notes</summary><Markdown text={brief.userNotes} /></details>}
    </div>}
  </details>;
}
