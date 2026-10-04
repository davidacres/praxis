import { useEffect, useRef } from 'react';
import type { AgentSessionRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { providerIconName } from './modelProviders';
import { sessionLabel, sessionTitle } from './sessionNav';

export interface SessionFocusTabsProps {
  sessions: AgentSessionRecord[];
  selectedKey?: string;
  newSessionActive?: boolean;
  onSelectSession: (issueKey: string) => void;
}

/**
 * Focus-mode navigation for AI sessions. The ordinary session tree remains the
 * full management surface; this strip is deliberately just tabs plus an add
 * action, so closing both sidebars trades chrome for conversation space without
 * making existing sessions unreachable.
 */
export function SessionFocusTabs({
  sessions,
  selectedKey,
  newSessionActive = false,
  onSelectSession
}: SessionFocusTabsProps) {
  const activeTabRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [newSessionActive, selectedKey]);

  return (
    <div className="session-focus-tabs" data-testid="session-focus-tabs">
      <div className="session-focus-tab-list" role="tablist" aria-label="AI sessions">
        {sessions.map(session => {
          const active = !newSessionActive && session.issueKey === selectedKey;
          const title = sessionTitle(session);
          const provider = session.provider;
          return (
            <button
              key={session.issueKey}
              ref={active ? activeTabRef : undefined}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={`session-focus-tab${active ? ' active' : ''}${provider ? ` session-focus-tab-provider-${provider}` : ''}`}
              data-testid="session-focus-tab"
              data-session-key={session.issueKey}
              title={sessionLabel(session)}
              onClick={() => onSelectSession(session.issueKey)}
              onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                const tabList = event.currentTarget.parentElement;
                const tabs = tabList
                  ? Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
                  : [];
                const currentIndex = tabs.indexOf(event.currentTarget);
                if (currentIndex < 0 || tabs.length === 0) return;
                event.preventDefault();
                const nextIndex = event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : event.key === 'ArrowLeft'
                      ? (currentIndex - 1 + tabs.length) % tabs.length
                      : (currentIndex + 1) % tabs.length;
                tabs[nextIndex]?.focus();
                tabs[nextIndex]?.click();
              }}
            >
              <Icon name={provider ? providerIconName(provider) : 'robot'} size={13} />
              <span data-testid={active ? 'session-console-title' : undefined}>{title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
