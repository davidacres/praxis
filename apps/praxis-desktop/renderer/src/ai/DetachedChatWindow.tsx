import { useEffect, useState } from 'react';
import type { AgentSessionRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { SessionsPage } from './SessionsPage';

/**
 * Root view of the floating chat window (FX-BE-143) — the same session
 * console/composer a standalone conversation uses inside the main window,
 * scoped to the one session it was popped out for. `main.tsx` renders this
 * instead of `<App/>` when the window was opened at `?detachedSession=<key>`.
 */
export function DetachedChatWindow({ issueKey }: { issueKey: string }) {
  const [session, setSession] = useState<AgentSessionRecord | undefined>();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.praxis.ai.listSessions().then(sessions => {
      if (cancelled) return;
      setSession(sessions.find(candidate => candidate.issueKey === issueKey));
      setLoaded(true);
    });
    const offChanged = window.praxis.ai.onSessionChanged(record => {
      if (record.issueKey === issueKey) setSession(record);
    });
    const offDeleted = window.praxis.ai.onSessionDeleted(deletedKey => {
      if (deletedKey === issueKey) setSession(undefined);
    });
    return () => {
      cancelled = true;
      offChanged();
      offDeleted();
    };
  }, [issueKey]);

  const popIn = () => {
    void window.praxis.detachedChat.close(issueKey);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      {session ? (
        <SessionsPage
          sessions={[session]}
          selectedKey={issueKey}
          onNewSession={() => undefined}
          onSelectSession={() => undefined}
          onOpenAiSettings={() => undefined}
          onPopIn={popIn}
        />
      ) : (
        loaded && (
          <div className="empty-state" style={{ flex: 1 }} data-testid="detached-chat-gone">
            <Icon name="chats" size={28} />
            <span>This conversation is no longer available.</span>
            <button type="button" className="btn" onClick={popIn}>
              <Icon name="window-restore" size={13} />
              Close this window
            </button>
          </div>
        )
      )}
    </div>
  );
}
