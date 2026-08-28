import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { AgentSessionRecord, TerminalCommandRecord, TerminalProfile, TerminalSessionInfo, TerminalSettings } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { getActiveTerminalId, setActiveTerminalId } from '../ai/terminalSelection';
import { useSettings } from '../settings/useSettings';
import { terminalColorsForTheme } from '../settings/themes';

export type PanelTab = 'output' | 'terminal';

export interface BottomPanelProps {
  onClose: () => void;
  workingDirectory?: string;
  terminalDisabledReason?: string;
  onTerminalAi?: (prompt: string, sessionId: string) => Promise<AgentSessionRecord>;
}

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: 'output', label: 'Output' },
  { id: 'terminal', label: 'Terminal' }
];
const MAX_RENDERED_LINES = 500;
type TerminalSessionOverrides = Partial<Omit<TerminalSettings, 'defaultProfileId'>>;

function xtermTheme() {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const light = document.documentElement.dataset.mode === 'light';
  const ansi = light ? {
    black: '#000000', red: '#cd3131', green: '#00a000', yellow: '#949800',
    blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
    brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00',
    brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5'
  } : {
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
    blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
    brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
    brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff'
  };
  const themedAnsi = terminalColorsForTheme(
    document.documentElement.getAttribute('data-theme') ?? 'praxis-dark',
    light ? 'light' : 'dark'
  );
  return {
    background: color('--bg', '#181818'), foreground: color('--text', '#cccccc'),
    cursor: color('--text', '#cccccc'), cursorAccent: color('--bg', '#181818'),
    selectionBackground: color('--accent-muted', '#264f78'),
    ...ansi,
    ...(themedAnsi ?? {})
  };
}

function terminalFontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--terminal-font').trim()
    || "Menlo, Monaco, 'SF Mono', 'Courier New', monospace";
}

export function BottomPanel({ onClose, workingDirectory, terminalDisabledReason, onTerminalAi }: BottomPanelProps) {
  const { settings } = useSettings();
  const terminalSettings = settings?.terminal;
  const [tab, setTab] = useState<PanelTab>('terminal');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [terminalAiOpen, setTerminalAiOpen] = useState(false);
  const [terminalAiPrompt, setTerminalAiPrompt] = useState('');
  const [terminalAiError, setTerminalAiError] = useState<string>();
  const [terminalAiSession, setTerminalAiSession] = useState<AgentSessionRecord>();
  const [sessionOverrides, setSessionOverrides] = useState<Record<string, TerminalSessionOverrides>>({});
  const [activeId, setActiveId] = useState<string | undefined>(() => getActiveTerminalId());
  const [terminalError, setTerminalError] = useState<string>();
  const [lastCommand, setLastCommand] = useState<TerminalCommandRecord>();
  const outputRef = useRef<HTMLDivElement>(null);
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<Terminal | undefined>(undefined);
  const terminalAiInputRef = useRef<HTMLInputElement>(null);
  const creatingTerminalRef = useRef(false);

  const selectTerminal = useCallback((sessionId: string | undefined) => {
    setActiveId(sessionId);
    setActiveTerminalId(sessionId);
  }, []);

  const activeSessionSettings = useMemo(() => ({
    ...(terminalSettings ?? {
      defaultProfileId: '', fontFamily: terminalFontFamily(), fontSize: 13, lineHeight: 1.1,
      cursorStyle: 'block' as const, cursorBlink: true, scrollback: 5000,
      copyOnSelection: false, confirmPaste: true, bellSound: false,
      shellIntegration: true, gpuAcceleration: true
    }),
    ...(activeId ? sessionOverrides[activeId] : {})
  }), [activeId, sessionOverrides, terminalSettings]);

  const updateSessionSettings = useCallback((patch: TerminalSessionOverrides) => {
    if (!activeId) return;
    setSessionOverrides(current => ({
      ...current,
      [activeId]: { ...current[activeId], ...patch }
    }));
  }, [activeId]);

  const createTerminal = useCallback(async (profileId?: string, reuseExisting = false) => {
    if (terminalDisabledReason || creatingTerminalRef.current) return;
    creatingTerminalRef.current = true;
    setTerminalError(undefined);
    try {
      const selectedProfile = profileId || terminalSettings?.defaultProfileId || undefined;
      const created = await window.praxis.terminal.create({ cwd: workingDirectory, cols: 100, rows: 24, profileId: selectedProfile, reuseExisting });
      setSessions(current => [...current.filter(item => item.id !== created.id), created]);
      selectTerminal(created.id);
    } catch (error) {
      setTerminalError(error instanceof Error ? error.message : String(error));
    } finally {
      creatingTerminalRef.current = false;
    }
  }, [selectTerminal, terminalDisabledReason, terminalSettings?.defaultProfileId, workingDirectory]);

  useEffect(() => {
    let cancelled = false;
    if (terminalDisabledReason) return undefined;
    void window.praxis.terminal.list().then(existing => {
      if (cancelled) return;
      setSessions(existing);
      const remembered = getActiveTerminalId();
      const selected = existing.find(item => item.id === remembered) ?? [...existing].reverse().find(item => !item.exited);
      if (selected) selectTerminal(selected.id);
      if (selected?.lastCommand) setLastCommand(selected.lastCommand);
      else void createTerminal(undefined, true);
    }).catch(error => setTerminalError(error instanceof Error ? error.message : String(error)));
    return () => { cancelled = true; };
  }, [createTerminal, selectTerminal, terminalDisabledReason]);

  useEffect(() => {
    if (terminalDisabledReason) return;
    void window.praxis.terminal.listProfiles().then(setProfiles)
      .catch(error => setTerminalError(error instanceof Error ? error.message : String(error)));
  }, [terminalDisabledReason]);

  useEffect(() => {
    if (!activeId || terminalDisabledReason) return undefined;
    void window.praxis.terminal.listCommands(activeId).then(commands => {
      setLastCommand(commands[commands.length - 1]);
    }).catch(() => undefined);
    const unsubscribe = window.praxis.terminal.onCommand(event => {
      if (event.sessionId === activeId) setLastCommand(event.command);
    });
    return unsubscribe;
  }, [activeId, terminalDisabledReason]);

  useEffect(() => {
    if (!terminalAiSession?.issueKey) return undefined;
    const unsubscribe = window.praxis.ai.onSessionChanged(record => {
      if (record.issueKey === terminalAiSession.issueKey) setTerminalAiSession(record);
    });
    return unsubscribe;
  }, [terminalAiSession?.issueKey]);

  useEffect(() => {
    let cancelled = false;
    void window.praxis.log.getRecent().then(recent => { if (!cancelled) setLogLines(recent); })
      .catch(error => console.error('Failed to load log output:', error));
    const unsubscribe = window.praxis.log.onAppended(line => {
      setLogLines(current => [...current.slice(-(MAX_RENDERED_LINES - 1)), line]);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (tab === 'output' && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [logLines, tab]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (tab !== 'terminal' || !activeId || !host || terminalDisabledReason) return undefined;
    const terminal = new Terminal({
      cursorBlink: activeSessionSettings.cursorBlink,
      cursorStyle: activeSessionSettings.cursorStyle, cursorWidth: 1,
      fontFamily: activeSessionSettings.fontFamily || terminalFontFamily(),
      fontSize: activeSessionSettings.fontSize, fontWeight: '400', fontWeightBold: '600',
      letterSpacing: 0, lineHeight: activeSessionSettings.lineHeight, minimumContrastRatio: 4.5,
      smoothScrollDuration: 100, scrollback: activeSessionSettings.scrollback,
      theme: xtermTheme()
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalInstanceRef.current = terminal;
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i' && onTerminalAi) {
        setTerminalAiOpen(true);
        setProfileMenuOpen(false);
        setSessionSettingsOpen(false);
        window.setTimeout(() => terminalAiInputRef.current?.focus(), 0);
        return false;
      }
      return true;
    });
    try {
      if (activeSessionSettings.gpuAcceleration) {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        terminal.loadAddon(webgl);
      }
    } catch {
      // VS Code also falls back when WebGL is unavailable (VMs/headless tests).
    }
    const fitTerminal = () => { try { fit.fit(); } catch { /* Panel is between layout frames. */ } };
    requestAnimationFrame(() => { fitTerminal(); terminal.focus(); });
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(host);
    const input = terminal.onData(data => {
      void window.praxis.terminal.write(activeId, data)
        .catch(error => terminal.writeln(`\r\n[terminal] ${String(error)}`));
    });
    const selection = terminal.onSelectionChange(() => {
      if (!activeSessionSettings.copyOnSelection) return;
      const selected = terminal.getSelection();
      if (selected) void navigator.clipboard?.writeText(selected).catch(() => undefined);
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      void window.praxis.terminal.resize(activeId, cols, rows).catch(() => undefined);
    });
    const unsubscribeOutput = window.praxis.terminal.onOutput(event => {
      if (event.sessionId === activeId) terminal.write(event.data);
      setSessions(current => current.map(item => item.id === event.sessionId ? { ...item, hasContext: true } : item));
    });
    const unsubscribeExit = window.praxis.terminal.onExit(event => {
      setSessions(current => current.map(item => item.id === event.sessionId ? { ...item, exited: true } : item));
      if (event.sessionId === activeId) terminal.writeln(`\r\n\x1b[90mProcess exited with code ${event.exitCode}.\x1b[0m`);
    });
    const updateTheme = () => {
      terminal.options.theme = xtermTheme();
      terminal.options.fontFamily = activeSessionSettings.fontFamily || terminalFontFamily();
      fitTerminal();
    };
    window.addEventListener('tm-theme-changed', updateTheme);
    void window.praxis.terminal.getBuffer(activeId).then(buffer => { if (buffer) terminal.write(buffer); })
      .catch(error => terminal.writeln(`[terminal] ${String(error)}`));
    return () => {
      observer.disconnect(); input.dispose(); selection.dispose(); resize.dispose(); unsubscribeOutput(); unsubscribeExit();
      window.removeEventListener('tm-theme-changed', updateTheme); terminal.dispose();
      terminalInstanceRef.current = undefined;
    };
  }, [activeId, activeSessionSettings, tab, terminalDisabledReason]);

  const killActive = async () => {
    if (!activeId) return;
    await window.praxis.terminal.kill(activeId).catch(error => setTerminalError(String(error)));
    const remaining = sessions.filter(item => item.id !== activeId);
    setSessions(remaining);
    const next = [...remaining].reverse().find(item => !item.exited);
    selectTerminal(next?.id);
    if (!next) void createTerminal();
  };

  const askTerminalAi = async (prompt: string) => {
    if (!activeId || !onTerminalAi) return;
    setTerminalAiError(undefined);
    try {
      const record = await onTerminalAi(prompt, activeId);
      setTerminalAiSession(record);
      setTerminalAiOpen(true);
      setTerminalAiPrompt('');
    } catch (error) {
      setTerminalAiError(error instanceof Error ? error.message : String(error));
    }
  };

  const suggestedCommand = useMemo(() => {
    const response = terminalAiSession?.responseText ?? terminalAiSession?.events.map(event => event.detail || event.summary).join('\n') ?? '';
    const fenced = response.match(/```(?:bash|sh|zsh|shell|powershell|pwsh|cmd)?\s*\n?([\s\S]*?)```/i);
    if (!fenced?.[1]) return undefined;
    return fenced[1].trim().split('\n').filter(line => !line.trim().startsWith('#')).join('\n').trim() || undefined;
  }, [terminalAiSession]);

  return (
    <section className="bottom-panel" data-testid="bottom-panel" aria-label="Panel">
      <div className="panel-tabs" role="tablist">
        {TABS.map(entry => (
          <button key={entry.id} role="tab" aria-selected={tab === entry.id} data-testid={`panel-tab-${entry.id}`}
            className={`panel-tab${tab === entry.id ? ' active' : ''}`} onClick={() => setTab(entry.id)}>{entry.label}</button>
        ))}
        <span className="spacer" />
        {tab === 'terminal' && !terminalDisabledReason && <>
          <Icon name="terminal" size={14} />
          <select className="terminal-session-select" aria-label="Active terminal" value={activeId ?? ''}
            onChange={event => selectTerminal(event.target.value || undefined)}>
            {sessions.map((session, index) => <option key={session.id} value={session.id}>
              {session.title} {index + 1}{session.exited ? ' (exited)' : ''}
            </option>)}
          </select>
          <button className="icon-btn icon-btn-sm" aria-label="New terminal" title="New terminal" onClick={() => void createTerminal()}><Icon name="plus" size={14} /></button>
          <button className={`icon-btn icon-btn-sm${profileMenuOpen ? ' active' : ''}`} aria-label="Launch terminal profile"
            aria-expanded={profileMenuOpen} title="Launch terminal profile" onClick={() => setProfileMenuOpen(open => !open)}>
            <Icon name="chevron-down" size={12} />
          </button>
          {profileMenuOpen && (
            <div className="terminal-profile-menu" role="menu" data-testid="terminal-profile-menu">
              <div className="terminal-profile-menu-title">New terminal with profile</div>
              {profiles.map(profile => (
                <button key={profile.id} role="menuitem" data-testid={`terminal-profile-${profile.id}`} onClick={() => {
                  setProfileMenuOpen(false);
                  void createTerminal(profile.id);
                }}>
                  <span className={`terminal-profile-icon terminal-profile-icon-${profile.id}`}><Icon name="terminal" size={14} /></span>
                  <span>{profile.name}</span>
                  {profile.isDefault && <span className="terminal-profile-default">Default</span>}
                </button>
              ))}
            </div>
          )}
          <button className={`icon-btn icon-btn-sm${sessionSettingsOpen ? ' active' : ''}`} aria-label="Terminal session settings"
            aria-expanded={sessionSettingsOpen} title="Terminal session settings" onClick={() => {
              setSessionSettingsOpen(open => !open);
              setProfileMenuOpen(false);
            }}>
            <Icon name="gear" size={13} />
          </button>
          {sessionSettingsOpen && activeId && (
            <div className="terminal-session-settings" role="dialog" aria-label="Terminal session settings" data-testid="terminal-session-settings">
              <div className="terminal-session-settings-title">Terminal session</div>
              <div className="terminal-session-settings-meta">
                <strong>{sessions.find(session => session.id === activeId)?.profileName ?? 'Terminal'}</strong>
                <span>{sessions.find(session => session.id === activeId)?.cwd}</span>
              </div>
              <label className="terminal-session-setting-row">
                <span>Font size</span>
                <input aria-label="Session font size" type="number" min={9} max={32} value={activeSessionSettings.fontSize}
                  onChange={event => updateSessionSettings({ fontSize: Number(event.target.value) })} />
              </label>
              <label className="terminal-session-setting-row">
                <span>Cursor</span>
                <select aria-label="Session cursor style" value={activeSessionSettings.cursorStyle}
                  onChange={event => updateSessionSettings({ cursorStyle: event.target.value as TerminalSettings['cursorStyle'] })}>
                  <option value="block">Block</option>
                  <option value="bar">Line</option>
                  <option value="underline">Underline</option>
                </select>
              </label>
              <label className="terminal-session-setting-row">
                <span>Scrollback</span>
                <input aria-label="Session scrollback" type="number" min={100} max={100000} step={100}
                  value={activeSessionSettings.scrollback}
                  onChange={event => updateSessionSettings({ scrollback: Number(event.target.value) })} />
              </label>
              <label className="terminal-session-check">
                <input type="checkbox" checked={activeSessionSettings.cursorBlink}
                  onChange={event => updateSessionSettings({ cursorBlink: event.target.checked })} />
                Blinking cursor
              </label>
              <label className="terminal-session-check">
                <input type="checkbox" checked={activeSessionSettings.copyOnSelection}
                  onChange={event => updateSessionSettings({ copyOnSelection: event.target.checked })} />
                Copy on selection
              </label>
              <label className="terminal-session-check">
                <input type="checkbox" checked={activeSessionSettings.gpuAcceleration}
                  onChange={event => updateSessionSettings({ gpuAcceleration: event.target.checked })} />
                GPU acceleration
              </label>
              <button className="terminal-session-reset" type="button" onClick={() => {
                setSessionOverrides(current => { const next = { ...current }; delete next[activeId]; return next; });
              }}>Reset to global defaults</button>
            </div>
          )}
          {onTerminalAi && <button className={`icon-btn icon-btn-sm${terminalAiOpen ? ' active' : ''}`} aria-label="Terminal AI"
            aria-expanded={terminalAiOpen} title="Terminal AI" onClick={() => {
              setTerminalAiOpen(open => !open);
              setProfileMenuOpen(false);
              setSessionSettingsOpen(false);
            }}>
            <Icon name="sparkles" size={13} />
          </button>}
          {terminalAiOpen && activeId && onTerminalAi && (
            <div className="terminal-ai-menu" role="dialog" aria-label="Terminal AI" data-testid="terminal-ai-menu">
              <div className="terminal-ai-title"><Icon name="sparkles" size={13} /> Terminal AI</div>
              <div className="terminal-ai-actions">
                <button type="button" onClick={() => void askTerminalAi('Explain the last terminal command and its output. Include the likely cause and the safest next step.')}>Explain using AI</button>
                <button type="button" onClick={() => void askTerminalAi('Fix the last failed terminal command. Suggest a corrected command, explain the change, and wait for confirmation before running it.')}>Fix using AI</button>
              </div>
              <div className="terminal-ai-divider" />
              <form onSubmit={event => { event.preventDefault(); void askTerminalAi(terminalAiPrompt.trim()); }}>
                <input ref={terminalAiInputRef} aria-label="Ask terminal AI" value={terminalAiPrompt} onChange={event => setTerminalAiPrompt(event.target.value)} placeholder="Ask about this terminal…" />
                <button type="submit" disabled={!terminalAiPrompt.trim()}>Ask</button>
              </form>
              {terminalAiError && <div className="terminal-ai-error">{terminalAiError}</div>}
              {terminalAiSession && (
                <div className="terminal-ai-result" data-testid="terminal-ai-result">
                  <div className="terminal-ai-result-status">{terminalAiSession.state === 'completed' ? 'Suggestion ready' : terminalAiSession.state === 'failed' ? 'AI request failed' : 'Working…'}</div>
                  {suggestedCommand && <>
                    <pre>{suggestedCommand}</pre>
                    <div className="terminal-ai-result-actions">
                      <button type="button" onClick={() => activeId && void window.praxis.terminal.write(activeId, suggestedCommand)}>Insert</button>
                      <button type="button" className="primary" onClick={() => activeId && void window.praxis.terminal.write(activeId, `${suggestedCommand}\r`)}>Run</button>
                    </div>
                  </>}
                  {!suggestedCommand && terminalAiSession.responseText && <p>{terminalAiSession.responseText}</p>}
                </div>
              )}
            </div>
          )}
          <button className="icon-btn icon-btn-sm" aria-label="Kill terminal" title="Kill terminal" disabled={!activeId} onClick={() => void killActive()}><Icon name="trash" size={14} /></button>
        </>}
        <span className="panel-divider" />
        <button className="icon-btn icon-btn-sm" aria-label="Close panel" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      <div className={`panel-body${tab === 'terminal' ? ' is-terminal' : ''}`} role="tabpanel">
        {tab === 'terminal' ? terminalDisabledReason ? (
          <div className="terminal-unavailable"><Icon name="terminal" size={20} /><span>{terminalDisabledReason}</span></div>
        ) : <><div
          className="xterm-host"
          ref={terminalHostRef}
          data-testid="integrated-terminal"
          onMouseDown={() => terminalInstanceRef.current?.focus()}
          onClick={() => terminalInstanceRef.current?.focus()}
        />
          {lastCommand?.status === 'failed' && onTerminalAi && (
            <div className="terminal-command-failure" data-testid="terminal-command-failure">
              <Icon name="sparkles" size={12} />
              <span>Command failed{lastCommand.command ? `: ${lastCommand.command}` : ''}</span>
              <button type="button" onClick={() => void askTerminalAi('Explain the last failed terminal command, identify the cause, and propose the safest fix.')}>Explain / fix</button>
            </div>
          )}
          {terminalError && <div className="terminal-error">{terminalError}</div>}</>
        : <div className="output-log" ref={outputRef} data-testid="output-log">
          {logLines.length === 0 ? <div className="panel-empty">No output yet.</div>
            : logLines.map((line, index) => <div className="output-line" key={index}>{line}</div>)}
        </div>}
      </div>
    </section>
  );
}
