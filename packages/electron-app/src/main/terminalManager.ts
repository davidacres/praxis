import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type {
  CreateTerminalInput,
  TerminalContext,
  TerminalContextAvailabilityEvent,
  TerminalCommandEvent,
  TerminalCommandRecord,
  TerminalExitEvent,
  TerminalOutputEvent,
  TerminalProfile,
  TerminalSessionInfo
} from '@ticket-manager/core';

const CONTEXT_LIMIT_BYTES = 5 * 1024;

interface ManagedTerminal {
  info: TerminalSessionInfo;
  process: pty.IPty;
  recent: Buffer;
  commands: TerminalCommandRecord[];
  commandRemainder: string;
  activeCommand?: TerminalCommandRecord;
  integrationDir?: string;
}

function findOnPath(executable: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function detectedProfiles(): TerminalProfile[] {
  const candidates: Array<{ id: string; name: string; paths: Array<string | undefined> }> = process.platform === 'win32'
    ? [
        { id: 'powershell', name: 'PowerShell', paths: [findOnPath('pwsh.exe'), findOnPath('powershell.exe')] },
        { id: 'command-prompt', name: 'Command Prompt', paths: [process.env.COMSPEC, findOnPath('cmd.exe')] },
        { id: 'git-bash', name: 'Git Bash', paths: [
          process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : undefined,
          findOnPath('bash.exe')
        ] },
        { id: 'wsl', name: 'WSL', paths: [findOnPath('wsl.exe')] }
      ]
    : [
        { id: 'zsh', name: 'zsh', paths: [findOnPath('zsh'), '/bin/zsh'] },
        { id: 'bash', name: 'bash', paths: [findOnPath('bash'), '/bin/bash'] },
        { id: 'fish', name: 'fish', paths: [findOnPath('fish'), '/opt/homebrew/bin/fish', '/usr/local/bin/fish'] },
        { id: 'powershell', name: 'PowerShell', paths: [findOnPath('pwsh')] }
      ];
  const configured = process.env.SHELL?.trim();
  const resolvedConfigured = configured && fs.existsSync(configured) ? fs.realpathSync(configured) : undefined;
  const found = candidates.flatMap(candidate => {
    const shell = candidate.paths.find(value => value && fs.existsSync(value) && fs.statSync(value).isFile());
    return shell ? [{ id: candidate.id, name: candidate.name, shell: path.resolve(shell), isDefault: false }] : [];
  });
  const defaultIndex = Math.max(0, found.findIndex(profile => {
    try { return resolvedConfigured !== undefined && fs.realpathSync(profile.shell) === resolvedConfigured; }
    catch { return false; }
  }));
  return found.map((profile, index) => ({ ...profile, isDefault: index === defaultIndex }));
}

function appendBounded(current: Buffer, data: string): Buffer {
  const combined = Buffer.concat([current, Buffer.from(data, 'utf8')]);
  return combined.length <= CONTEXT_LIMIT_BYTES
    ? combined
    : combined.subarray(combined.length - CONTEXT_LIMIT_BYTES);
}

/** Remove terminal control sequences and non-text controls before chat attachment. */
export function terminalOutputToPlainText(raw: string): string {
  return raw
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[PX^_][\s\S]*?\u001b\\/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private outputListener?: (event: TerminalOutputEvent) => void;
  private exitListener?: (event: TerminalExitEvent) => void;
  private contextListener?: (event: TerminalContextAvailabilityEvent) => void;
  private commandListener?: (event: TerminalCommandEvent) => void;

  public onOutput(listener: (event: TerminalOutputEvent) => void): void {
    this.outputListener = listener;
  }

  public onExit(listener: (event: TerminalExitEvent) => void): void {
    this.exitListener = listener;
  }

  public onContextAvailability(listener: (event: TerminalContextAvailabilityEvent) => void): void {
    this.contextListener = listener;
  }

  public onCommand(listener: (event: TerminalCommandEvent) => void): void {
    this.commandListener = listener;
  }

  public list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map(session => ({ ...session.info }));
  }

  public listProfiles(): TerminalProfile[] {
    return detectedProfiles();
  }

  public commands(sessionId: string): TerminalCommandRecord[] {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('The selected terminal no longer exists.');
    return session.commands.map(command => ({ ...command }));
  }

  public create(input: CreateTerminalInput): TerminalSessionInfo {
    const requestedCwd = input.cwd?.trim() || os.homedir();
    const cwd = path.resolve(requestedCwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`Terminal working directory does not exist: ${cwd}`);
    }
    const profiles = detectedProfiles();
    const profile = input.profileId
      ? profiles.find(candidate => candidate.id === input.profileId)
      : profiles.find(candidate => candidate.isDefault);
    if (!profile) throw new Error(input.profileId
      ? `Terminal profile '${input.profileId}' is not installed.`
      : 'No supported terminal shell was found.');
    if (input.reuseExisting) {
      const existing = [...this.sessions.values()].find(session =>
        !session.info.exited && session.info.cwd === cwd && session.info.profileId === profile.id
      );
      if (existing) return { ...existing.info };
    }
    const shell = profile.shell;
    const integration = this.prepareShellIntegration(profile.id);
    const id = randomUUID();
    const child = pty.spawn(shell, integration.args, {
      name: 'xterm-256color',
      cols: Math.max(2, Math.floor(input.cols || 80)),
      rows: Math.max(2, Math.floor(input.rows || 24)),
      cwd,
      env: {
        ...process.env,
        // Keep the child shell's identity aligned with the selected profile.
        // macOS's legacy Bash startup notice appears when Bash inherits a
        // parent SHELL value pointing at zsh.
        SHELL: shell,
        ...(process.platform === 'darwin' && profile.id === 'bash'
          ? { BASH_SILENCE_DEPRECATION_WARNING: '1' }
          : {}),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'Praxis',
        ...integration.env
      } as Record<string, string>
    });
    const title = profile.name;
    const session: ManagedTerminal = {
      info: {
        id, title, cwd, shell, profileId: profile.id, profileName: profile.name,
        hasContext: false, exited: false
      },
      process: child,
      recent: Buffer.alloc(0),
      commands: [], commandRemainder: '', integrationDir: integration.directory
    };
    this.sessions.set(id, session);

    child.onData(data => {
      session.recent = appendBounded(session.recent, data);
      this.consumeShellIntegration(session, data);
      if (!session.info.hasContext && terminalOutputToPlainText(session.recent.toString('utf8'))) {
        session.info.hasContext = true;
        this.contextListener?.({ sessionId: id, terminalHasContext: true });
      }
      this.outputListener?.({ sessionId: id, data });
    });
    child.onExit(({ exitCode, signal }) => {
      session.info.exited = true;
      this.cleanupIntegration(session);
      this.exitListener?.({ sessionId: id, exitCode, signal: signal || undefined });
    });
    return { ...session.info };
  }

  public write(sessionId: string, data: string): void {
    const session = this.requireLive(sessionId);
    session.process.write(data);
  }

  public resize(sessionId: string, cols: number, rows: number): void {
    const session = this.requireLive(sessionId);
    session.process.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
  }

  public kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!session.info.exited) session.process.kill();
    this.cleanupIntegration(session);
    this.sessions.delete(sessionId);
    this.contextListener?.({ sessionId, terminalHasContext: false });
  }

  public context(sessionId: string): TerminalContext {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('The selected terminal no longer exists.');
    return {
      sessionId,
      cwd: session.info.cwd,
      output: terminalOutputToPlainText(session.recent.toString('utf8')),
      capturedAt: new Date().toISOString()
    };
  }

  public buffer(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('The selected terminal no longer exists.');
    return session.recent.toString('utf8');
  }

  public dispose(): void {
    for (const session of this.sessions.values()) {
      if (!session.info.exited) session.process.kill();
      this.cleanupIntegration(session);
    }
    this.sessions.clear();
  }

  private requireLive(sessionId: string): ManagedTerminal {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.exited) throw new Error('The selected terminal is not running.');
    return session;
  }

  /** Install hooks through a per-session startup file, never by typing setup
   * commands into an already-echoing interactive prompt. */
  private prepareShellIntegration(profileId: string): { args: string[]; env: Record<string, string>; directory?: string } {
    const esc = '\\033';
    const bell = '\\007';
    if (profileId !== 'zsh' && profileId !== 'bash') return { args: [], env: {} };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-terminal-'));
    const hook = profileId === 'zsh'
      ? `function __tm_precmd(){ local s=$?; printf '${esc}]633;D;%s${bell}${esc}]633;A${bell}' $s; }; precmd_functions+=(__tm_precmd); function __tm_preexec(){ printf '${esc}]633;C${bell}${esc}]633;E;%s${bell}' "$1"; }; preexec_functions+=(__tm_preexec)`
      : `__tm_preexec(){ printf '${esc}]633;C${bell}${esc}]633;E;%s${bell}' "$1"; }; trap '__tm_preexec "$BASH_COMMAND"' DEBUG; __tm_prompt(){ local s=$?; printf '${esc}]633;D;%s${bell}${esc}]633;A${bell}' $s; }; PROMPT_COMMAND="__tm_prompt\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"`;
    const original = profileId === 'zsh'
      ? path.join(process.env.ZDOTDIR || os.homedir(), '.zshrc')
      : path.join(process.env.HOME || os.homedir(), '.bashrc');
    const rc = profileId === 'zsh' ? path.join(directory, '.zshrc') : path.join(directory, '.bashrc');
    const source = `if [ -f ${JSON.stringify(original)} ]; then source ${JSON.stringify(original)}; fi\n`;
    fs.writeFileSync(rc, `${source}${hook}\n`, { mode: 0o600 });
    return profileId === 'zsh'
      ? { args: [], env: { ZDOTDIR: directory }, directory }
      : { args: ['--rcfile', rc], env: {}, directory };
  }

  private cleanupIntegration(session: ManagedTerminal): void {
    if (!session.integrationDir) return;
    try { fs.rmSync(session.integrationDir, { recursive: true, force: true }); } catch { /* best effort */ }
    session.integrationDir = undefined;
  }

  private consumeShellIntegration(session: ManagedTerminal, data: string): void {
    const source = session.commandRemainder + data;
    const marker = /\u001b\]633;([A-Z])(?:;([^\u0007]*))?\u0007/g;
    let last = 0;
    let match: RegExpExecArray | null;
    let found = false;
    while ((match = marker.exec(source))) {
      found = true;
      this.appendCommandOutput(session, source.slice(last, match.index));
      this.handleShellMarker(session, match[1]!, match[2] ?? '');
      last = marker.lastIndex;
    }
    if (found) {
      session.commandRemainder = source.slice(last).slice(-512);
    } else if (source.includes('\u001b]633;')) {
      session.commandRemainder = source.slice(-512);
    } else {
      this.appendCommandOutput(session, source);
      session.commandRemainder = '';
    }
  }

  private appendCommandOutput(session: ManagedTerminal, data: string): void {
    if (!session.activeCommand || !data) return;
    session.activeCommand.output = appendBounded(Buffer.from(session.activeCommand.output), data).toString('utf8');
  }

  private handleShellMarker(session: ManagedTerminal, marker: string, payload: string): void {
    if (marker === 'P' && payload.startsWith('Cwd=')) {
      const cwd = payload.slice(4);
      if (cwd) session.info.cwd = cwd;
      return;
    }
    if (marker === 'C') {
      const command: TerminalCommandRecord = {
        id: randomUUID(), command: '', cwd: session.info.cwd,
        startedAt: new Date().toISOString(), output: '', status: 'running'
      };
      session.activeCommand = command;
      session.commands = [...session.commands.slice(-49), command];
      session.info.lastCommand = command;
      this.commandListener?.({ sessionId: session.info.id, command: { ...command } });
      return;
    }
    if (marker === 'E' && session.activeCommand) {
      session.activeCommand.command = payload.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      return;
    }
    if (marker === 'D' && session.activeCommand) {
      const exitCode = Number.parseInt(payload.split(';')[0] || '0', 10) || 0;
      session.activeCommand.exitCode = exitCode;
      session.activeCommand.finishedAt = new Date().toISOString();
      session.activeCommand.status = exitCode === 0 ? 'success' : 'failed';
      session.info.lastCommand = { ...session.activeCommand };
      this.commandListener?.({ sessionId: session.info.id, command: { ...session.activeCommand } });
      session.activeCommand = undefined;
    }
  }
}

let instance: TerminalManager | undefined;

export function getTerminalManager(): TerminalManager {
  instance ??= new TerminalManager();
  return instance;
}
