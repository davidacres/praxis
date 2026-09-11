import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../ui/Icon';

type ChangeSection = {
  title: 'Features' | 'Improvements' | 'Fixes';
  icon: IconName;
  items: string[];
};

type Release = {
  version: string;
  label: string;
  summary: string;
  current?: boolean;
  sections: ChangeSection[];
};

const RELEASES: Release[] = [
  {
    version: '0.3.1',
    label: 'Marketplace and add-on packages now working',
    summary: 'Install themes, surfaces, agents and workflows from GitHub Packages marketplace.',
    current: true,
    sections: [
      {
        title: 'Features',
        icon: 'sparkles',
        items: [
          'Marketplace now loads add-on packages from GitHub Packages.',
          'Themes marketplace includes filter toggle for All/Installed items.',
          'Install themes directly from the marketplace section in Themes settings.',
          'Published add-on packages are now discoverable and installable.'
        ]
      },
      {
        title: 'Fixes',
        icon: 'check-square',
        items: [
          'Fixed marketplace package filtering to support scoped packages from GitHub.',
          'Marketplace now correctly loads @owner/praxis-addon-* packages.'
        ]
      }
    ]
  },
  {
    version: '0.2.1',
    label: 'A more complete desktop workflow',
    summary: 'Tickets, boards and AI sessions now work together as one continuous experience.',
    sections: [
      {
        title: 'Features',
        icon: 'sparkles',
        items: [
          'Edit ticket details directly from the board, including a live Markdown description.',
          'Start an AI session from a ticket using your chosen provider and model.',
          'Continue working with follow-up messages in the same session.',
          'Create a session by choosing a board and one of its open tickets.',
          'Open board search and filters by clicking the board name in the title bar.'
        ]
      },
      {
        title: 'Improvements',
        icon: 'star',
        items: [
          'Expand ticket details to fill the main window when you need more room.',
          'Rename or delete sessions directly from the sessions list.',
          'Session setup now uses clearer board, ticket, provider and model selectors.',
          'The new-session composer has been simplified to show only useful controls.'
        ]
      },
      {
        title: 'Fixes',
        icon: 'check-square',
        items: [
          'Ticket analysis now appears inside the related conversation instead of opening separately.',
          'AI actions now respect the provider and model selected for the ticket.',
          'Board filters no longer take permanent space away from the board.'
        ]
      }
    ]
  },
  {
    version: '0.2.0',
    label: 'Boards and connected work',
    summary: 'A stronger workspace for browsing boards and working with tickets from connected services.',
    sections: [
      {
        title: 'Features',
        icon: 'sparkles',
        items: [
          'Browse boards in classic and work views.',
          'Connect Jira, GitLab and local workspace boards.',
          'Group, reorder and personalise board columns.',
          'Create tickets and ideas from the board.'
        ]
      },
      {
        title: 'Improvements',
        icon: 'star',
        items: [
          'Board cards provide clearer status, priority and assignee information.',
          'Display preferences are remembered separately for each board.'
        ]
      },
      {
        title: 'Fixes',
        icon: 'check-square',
        items: [
          'Board changes refresh more reliably after editing or moving a ticket.',
          'Connection status is easier to understand from the workspace sidebar.'
        ]
      }
    ]
  },
  {
    version: '0.1.0',
    label: 'First desktop preview',
    summary: 'The first desktop home for Praxis boards, tickets and sessions.',
    sections: [
      {
        title: 'Features',
        icon: 'sparkles',
        items: [
          'Open and navigate Praxis boards in a dedicated desktop app.',
          'View ticket details alongside the active board.',
          'Use a resizable workspace with board, details and output panels.',
          'Choose an appearance theme and accent colour.'
        ]
      }
    ]
  }
];

export interface WhatsNewDialogProps {
  onClose: () => void;
  /** Replays the startup splash animation (worm-drawn "Praxis" wordmark) without restarting the app — a quick way to preview changes to it. */
  onReplaySplash: () => void;
}

export function WhatsNewDialog({ onClose, onReplaySplash }: WhatsNewDialogProps) {
  const [selectedVersion, setSelectedVersion] = useState(RELEASES[0].version);
  const selected = RELEASES.find(release => release.version === selectedVersion) ?? RELEASES[0];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay whats-new-overlay" data-testid="whats-new-dialog" onClick={onClose}>
      <section
        className="modal-card whats-new-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        onClick={event => event.stopPropagation()}
      >
        <header className="detail-header whats-new-header">
          <Icon name="sparkles" size={15} />
          <div className="whats-new-header-title">
            <h3 id="whats-new-title">What’s new</h3>
            <span>·</span>
            <span>Features, improvements and fixes</span>
          </div>
          <button
            className="icon-btn icon-btn-sm"
            type="button"
            aria-label="Replay startup splash"
            title="Replay startup splash"
            onClick={onReplaySplash}
          >
            <Icon name="play" size={14} />
          </button>
          <button
            className="icon-btn icon-btn-sm whats-new-close"
            type="button"
            aria-label="Close What's new"
            autoFocus
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="whats-new-layout">
          <nav className="whats-new-history" aria-label="Version history">
            <div className="whats-new-history-label">Version history</div>
            {RELEASES.map(release => (
              <button
                key={release.version}
                type="button"
                className={`settings-nav-item whats-new-version${release.version === selected.version ? ' active' : ''}`}
                data-testid={`whats-new-version-${release.version}`}
                aria-current={release.version === selected.version ? 'page' : undefined}
                onClick={() => setSelectedVersion(release.version)}
              >
                <span className="tree-icon"><Icon name="book" size={14} /></span>
                <span className="settings-nav-label">Version {release.version}</span>
                {release.current && <small>Current</small>}
              </button>
            ))}
          </nav>

          <main className="whats-new-content" data-testid="whats-new-content">
            <div className="whats-new-release-heading">
              <div className="whats-new-release-meta">
                Version {selected.version}{selected.current ? ' · Current release' : ''}
              </div>
              <h2>{selected.label}</h2>
              <p>{selected.summary}</p>
            </div>

            {selected.sections.map(section => (
              <section key={section.title} className="whats-new-section">
                <h3>
                  <Icon name={section.icon} size={15} />
                  {section.title}
                </h3>
                <ul>
                  {section.items.map(item => (
                    <li key={item}>
                      <Icon name="check" size={13} />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </main>
        </div>
      </section>
    </div>
  );
}
