import * as nodeFs from 'node:fs/promises';
import { COORDINATION_MAX_WAIT_MS, refusalForAgent, type CoordinationGate } from '../coordination/coordinationGate';
import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
import type { GatewayToolDefinition } from '../gateway';
import type { WireImageAttachment } from '../gateway/wire';
import type { AgentToolEventData, AgentToolMode } from '../agentTypes';
import { PathSandboxError, resolveSandboxedPath } from './pathSandbox';
import { createUnifiedDiff } from './unifiedDiff';
import { listeningPorts, processGroupMembers, runShellCommand, stopProcessGroup } from './processTree';

export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';

export interface ToolPermissionRequest {
  kind: 'read' | 'write' | 'shell' | 'list';
  description: string;
  detail?: string;
  /** Internal scope used for an Allow always decision; never shown in the UI. */
  permissionKey?: string;
  toolName: string;
}

export interface LocalToolContext {
  workingDirectory: string;
  toolMode?: AgentToolMode;
  requestPermission: (request: ToolPermissionRequest) => Promise<PermissionDecision>;
  /** Optional always-allow check before prompting (e.g. shell allowlist). */
  shouldAutoAllow?: (request: ToolPermissionRequest) => boolean;
  /**
   * Asked before a write or a shell command (FX-BF-048). A refusal means the side effect
   * does not happen. Absent, tools run as before.
   */
  coordination?: CoordinationGate;
  /** The turn's abort signal: a cancelled turn stops waiting for a resource. */
  signal?: AbortSignal;
}

export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  /** Structured metadata for the UI (diffs, shell output). The `content` string stays authoritative for the model. */
  data?: AgentToolEventData;
  /**
   * Images to show the model. Serialised as `image_url` parts (OpenAI) or
   * base64 image blocks (Anthropic) so a vision-capable model can actually
   * look at the file. Omitted for text tools.
   */
  images?: WireImageAttachment[];
}

const SHELL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_READ_BYTES = 512 * 1024;
/** Images are sent inline, so the cap is well under a provider's request limit. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};
const MAX_LIST_ENTRIES = 500;
/** Above this size a write is applied but no diff is computed (keeps event payloads bounded). */
const MAX_DIFF_BYTES = 256 * 1024;

export const LOCAL_TOOL_DEFINITIONS: GatewayToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file relative to the working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the working directory' }
      },
      required: ['path']
    }
  },
  {
    name: 'read_image',
    description:
      'Read an image file (png, jpg, gif, webp) and return it so it can be viewed. Use this to inspect screenshots or visual output rather than guessing at it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the working directory' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write a UTF-8 text file relative to the working directory (creates parents).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the working directory' },
        content: { type: 'string', description: 'Full file contents to write' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_dir',
    description: 'List files and directories under a path relative to the working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to the working directory (default ".")'
        }
      }
    }
  },
  {
    name: 'run_shell',
    description: 'Run a shell command in the working directory and return stdout/stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' }
      },
      required: ['command']
    }
  }
];

/** Offered only to a coordinated session that can change files (FX-BF-048 / TASK-394). */
export const WAIT_FOR_FILES_TOOL: GatewayToolDefinition = {
  name: 'wait_for_files',
  description:
    'Wait for files or folders another session is changing, after a write was refused because of it. Waits in turn, at most the seconds given (max 120), then either hands them to you until your turn ends or says what is still in the way. Use it once, not in a loop; do other work instead if you can.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders relative to the working directory' },
      reason: { type: 'string', description: 'What you will do with them, in a few words' },
      seconds: { type: 'number', description: 'How long to wait, 1-120 (default 60)' }
    },
    required: ['paths', 'reason']
  }
};

const READ_ONLY_LOCAL_TOOLS = new Set(['read_file', 'list_dir', 'read_image']);

export function localToolDefinitionsForMode(mode: AgentToolMode, options: { coordinated?: boolean } = {}): GatewayToolDefinition[] {
  if (mode === 'project-only') return [];
  if (mode === 'read-only') return LOCAL_TOOL_DEFINITIONS.filter(tool => READ_ONLY_LOCAL_TOOLS.has(tool.name));
  return options.coordinated ? [...LOCAL_TOOL_DEFINITIONS, WAIT_FOR_FILES_TOOL] : LOCAL_TOOL_DEFINITIONS;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function ensurePermission(
  ctx: LocalToolContext,
  request: ToolPermissionRequest,
  alwaysAllowed: Set<string>
): Promise<boolean> {
  const key = `${request.kind}:${request.permissionKey ?? request.detail ?? request.description}`;
  if (alwaysAllowed.has(key) || ctx.shouldAutoAllow?.(request)) {
    return true;
  }
  const decision = await ctx.requestPermission(request);
  if (decision === 'allow_always') {
    alwaysAllowed.add(key);
    return true;
  }
  return decision === 'allow_once';
}

export class LocalToolExecutor {
  private readonly alwaysAllowed = new Set<string>();

  constructor(private readonly ctx: LocalToolContext) {}

  public async execute(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (this.ctx.toolMode === 'project-only') {
      return { ok: false, content: `${name} is unavailable without a project workspace folder.` };
    }
    if (this.ctx.toolMode === 'read-only' && !READ_ONLY_LOCAL_TOOLS.has(name)) {
      return { ok: false, content: `${name} is unavailable in read-only tool mode.` };
    }
    try {
      switch (name) {
        case 'read_file':
          return await this.readFile(asString(args.path) ?? '');
        case 'read_image':
          return await this.readImage(asString(args.path) ?? '');
        case 'write_file':
          return await this.writeFile(asString(args.path) ?? '', asString(args.content) ?? '');
        case 'list_dir':
          return await this.listDir(asString(args.path) ?? '.');
        case 'run_shell':
          return await this.runShell(asString(args.command) ?? '');
        case 'wait_for_files':
          return await this.waitForFiles(args);
        default:
          return { ok: false, content: `Unknown tool: ${name}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, content: message };
    }
  }

  private async readFile(inputPath: string): Promise<ToolExecutionResult> {
    if (!inputPath.trim()) {
      return { ok: false, content: 'path is required' };
    }
    const absolute = resolveSandboxedPath(this.ctx.workingDirectory, inputPath);
    const allowed = await ensurePermission(
      this.ctx,
      {
        kind: 'read',
        toolName: 'read_file',
        permissionKey: inputPath,
        description: 'Permission requested: read_file',
        detail: 'The agent wants to read a file in the project workspace.'
      },
      this.alwaysAllowed
    );
    if (!allowed) {
      return { ok: false, content: 'Permission denied for read_file' };
    }

    const stat = await nodeFs.stat(absolute);
    if (!stat.isFile()) {
      return { ok: false, content: `Not a file: ${inputPath}` };
    }
    if (stat.size > MAX_READ_BYTES) {
      return {
        ok: false,
        content: `File too large (${stat.size} bytes). Max ${MAX_READ_BYTES} bytes.`
      };
    }
    const content = await nodeFs.readFile(absolute, 'utf8');
    return { ok: true, content };
  }

  private async readImage(inputPath: string): Promise<ToolExecutionResult> {
    if (!inputPath.trim()) {
      return { ok: false, content: 'path is required' };
    }
    const absolute = resolveSandboxedPath(this.ctx.workingDirectory, inputPath);
    const mediaType = IMAGE_MEDIA_TYPES[nodePath.extname(absolute).toLowerCase()];
    if (!mediaType) {
      return {
        ok: false,
        content: `Not a readable image: ${inputPath}. Supported: ${Object.keys(IMAGE_MEDIA_TYPES).join(', ')}`
      };
    }
    const allowed = await ensurePermission(
      this.ctx,
      {
        kind: 'read',
        toolName: 'read_image',
        permissionKey: inputPath,
        description: 'Permission requested: read_image',
        detail: 'The agent wants to view an image in the project workspace.'
      },
      this.alwaysAllowed
    );
    if (!allowed) {
      return { ok: false, content: 'Permission denied for read_image' };
    }

    const stat = await nodeFs.stat(absolute);
    if (!stat.isFile()) {
      return { ok: false, content: `Not a file: ${inputPath}` };
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      return { ok: false, content: `Image too large (${stat.size} bytes). Max ${MAX_IMAGE_BYTES} bytes.` };
    }
    const base64 = (await nodeFs.readFile(absolute)).toString('base64');
    return {
      ok: true,
      content: `Image: ${inputPath} (${mediaType}, ${stat.size} bytes).`,
      images: [{ mimeType: mediaType, dataBase64: base64 }]
    };
  }

  private async writeFile(inputPath: string, content: string): Promise<ToolExecutionResult> {
    if (!inputPath.trim()) {
      return { ok: false, content: 'path is required' };
    }
    const absolute = resolveSandboxedPath(this.ctx.workingDirectory, inputPath);
    const allowed = await ensurePermission(
      this.ctx,
      {
        kind: 'write',
        toolName: 'write_file',
        permissionKey: inputPath,
        description: 'Permission requested: write_file',
        detail: 'The agent wants to write a file in the project workspace.'
      },
      this.alwaysAllowed
    );
    if (!allowed) {
      return { ok: false, content: 'Permission denied for write_file' };
    }

    // Owned before it is written: a file another session holds is not touched.
    const gate = this.ctx.coordination;
    const decision = gate
      ? await gate.acquire({
          items: [{ resource: { kind: 'file', worktree: gate.worktree, path: nodePath.relative(gate.worktree, absolute) }, mode: 'exclusive' }],
          reason: `write ${inputPath}`,
          lifetime: 'tool'
        })
      : undefined;
    if (decision && !decision.ok) return { ok: false, content: refusalForAgent(decision.reason, this.waitTool()) };

    let previous = '';
    try {
      previous = await nodeFs.readFile(absolute, 'utf8').catch(() => '');
      await nodeFs.mkdir(nodePath.dirname(absolute), { recursive: true });
      await nodeFs.writeFile(absolute, content, 'utf8');
    } finally {
      if (decision?.ok) await decision.release();
    }

    const data: AgentToolEventData = { toolName: 'write_file', kind: 'write', ok: true };
    if (content.length > MAX_DIFF_BYTES || content.includes('\0')) {
      data.output = `File written (${content.length} bytes); too large or binary to diff.`;
    } else {
      const diff = createUnifiedDiff(inputPath, previous, content);
      data.diff = diff;
      data.fileChanges = [{ path: inputPath, diff, oldText: previous, newText: content }];
    }
    return { ok: true, content: `Wrote ${content.length} characters to ${inputPath}`, data };
  }

  private waitTool(): string | undefined {
    return this.ctx.coordination?.wait ? 'wait_for_files' : undefined;
  }

  private async waitForFiles(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const gate = this.ctx.coordination;
    if (!gate?.wait) return { ok: false, content: 'wait_for_files is only available to a coordinated session.' };
    const paths = Array.isArray(args.paths) ? args.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : [];
    if (paths.length === 0) return { ok: false, content: 'Name at least one path.' };
    if (paths.length > 50) return { ok: false, content: 'Wait for at most 50 paths at once; name a folder instead.' };
    const items = paths.map(entry => {
      const absolute = resolveSandboxedPath(this.ctx.workingDirectory, entry);
      return { resource: { kind: 'directory' as const, worktree: gate.worktree, path: nodePath.relative(gate.worktree, absolute) }, mode: 'exclusive' as const };
    });
    const seconds = typeof args.seconds === 'number' && Number.isFinite(args.seconds) ? args.seconds : 60;
    const timeoutMs = Math.min(COORDINATION_MAX_WAIT_MS, Math.max(1000, Math.round(seconds * 1000)));
    const reason = asString(args.reason)?.trim().slice(0, 200) || 'waiting to edit';
    const decision = await gate.wait({ items, reason, timeoutMs, signal: this.ctx.signal });
    if (!decision.ok) return { ok: false, content: `Not granted: ${decision.reason} Do other work, or stop and report what is blocking you; do not wait again in a loop.` };
    return { ok: true, content: `You now hold ${paths.join(', ')} until your turn ends. Re-read them before changing them: another session just finished with them.` };
  }

  private async listDir(inputPath: string): Promise<ToolExecutionResult> {
    const absolute = resolveSandboxedPath(this.ctx.workingDirectory, inputPath || '.');
    const allowed = await ensurePermission(
      this.ctx,
      {
        kind: 'list',
        toolName: 'list_dir',
        permissionKey: inputPath || '.',
        description: 'Permission requested: list_dir',
        detail: 'The agent wants to list a project directory.'
      },
      this.alwaysAllowed
    );
    if (!allowed) {
      return { ok: false, content: 'Permission denied for list_dir' };
    }

    const entries = await nodeFs.readdir(absolute, { withFileTypes: true });
    const lines = entries.slice(0, MAX_LIST_ENTRIES).map(entry => {
      const suffix = entry.isDirectory() ? '/' : '';
      return `${entry.name}${suffix}`;
    });
    if (entries.length > MAX_LIST_ENTRIES) {
      lines.push(`… ${entries.length - MAX_LIST_ENTRIES} more entries omitted`);
    }
    return { ok: true, content: lines.join('\n') || '(empty)' };
  }

  private async runShell(command: string): Promise<ToolExecutionResult> {
    if (!command.trim()) {
      return { ok: false, content: 'command is required' };
    }
    const allowed = await ensurePermission(
      this.ctx,
      {
        kind: 'shell',
        toolName: 'run_shell',
        permissionKey: command,
        description: 'Permission requested: run_shell',
        detail: 'The agent wants to execute a shell command in the project workspace.'
      },
      this.alwaysAllowed
    );
    if (!allowed) {
      return { ok: false, content: 'Permission denied for run_shell' };
    }

    // A shell command can touch anything in the checkout, so it owns the whole worktree while it runs.
    const gate = this.ctx.coordination;
    const decision = gate
      ? await gate.acquire({
          items: [{ resource: { kind: 'worktree', worktree: gate.worktree }, mode: 'exclusive' }],
          reason: `run \`${command.length > 80 ? `${command.slice(0, 80)}…` : command}\``,
          lifetime: 'tool'
        })
      : undefined;
    if (decision && !decision.ok) return { ok: false, content: refusalForAgent(decision.reason, this.waitTool()) };

    let run: Awaited<ReturnType<typeof runShellCommand>>;
    try {
      run = await runShellCommand(command, { cwd: this.ctx.workingDirectory, timeoutMs: SHELL_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
      if (decision?.ok) await decision.release();
      throw error;
    }
    const output = [run.stdout, run.stderr].filter(part => part.trim().length > 0).join('\n').trim();
    const parts = [output, run.error ? `exit error: ${run.error}` : ''].filter(part => part.length > 0);

    // Processes the command left running are a service: they keep a claim until they exit.
    let service = '';
    if (run.pgid && run.survivors.length > 0) service = await trackService(this.ctx, command, run.pgid, run.survivors);
    if (decision?.ok) await decision.release();
    if (service) parts.push(service);

    return {
      ok: !run.error,
      content: parts.join('\n').trim() || '(no output)',
      data: { toolName: 'run_shell', kind: 'shell', ok: !run.error, output, exitCode: run.exitCode }
    };
  }
}

/** A process group a shell command left running, and the claim that tracks it. */
export interface TrackedService {
  pgid: number;
  command: string;
  workingDirectory: string;
  ports: number[];
  startedAt: number;
}

const services = new Map<number, TrackedService & { releases: Array<(evidence?: string) => Promise<void>>; timer: NodeJS.Timeout; checking?: boolean }>();
const SERVICE_POLL_MS = 2000;

/** Services started by agent shell commands in this process that are still running. */
export function runningServices(): TrackedService[] {
  return [...services.values()].map(({ pgid, command, workingDirectory, ports, startedAt }) => ({ pgid, command, workingDirectory, ports: [...ports], startedAt }));
}

/** Stops one tracked service (only one this process started); its claims are released once it is gone. */
export async function stopService(pgid: number): Promise<boolean> {
  const service = services.get(pgid);
  if (!service) return false;
  const stopped = await stopProcessGroup(pgid);
  if (stopped) await settleService(pgid, 'stopped from Praxis');
  return stopped;
}

/** Stops every tracked service — the app is quitting and nothing would watch them. */
export async function stopAllServices(): Promise<void> {
  await Promise.all([...services.keys()].map(pgid => stopService(pgid)));
}

async function settleService(pgid: number, how: string): Promise<void> {
  const service = services.get(pgid);
  if (!service) return;
  services.delete(pgid);
  clearInterval(service.timer);
  for (const release of service.releases) await release(`its processes (group ${pgid}) ${how}`).catch(() => undefined);
}

const label = (command: string) => (command.length > 60 ? `${command.slice(0, 60)}…` : command);

/** Claims ports a service has started listening on since it was last looked at. */
async function claimNewPorts(gate: CoordinationGate | undefined, pgid: number, members: number[]): Promise<{ claimed: number[]; refused?: string }> {
  const service = services.get(pgid);
  if (!service) return { claimed: [] };
  const fresh = listeningPorts(members).filter(port => !service.ports.includes(port));
  if (fresh.length === 0) return { claimed: [] };
  service.ports.push(...fresh);
  if (!gate) return { claimed: fresh };
  const decision = await gate.acquire({
    items: fresh.map(port => ({ resource: { kind: 'port' as const, port }, mode: 'exclusive' as const })),
    reason: `service \`${label(service.command)}\` listening`,
    lifetime: 'service'
  });
  if (!decision.ok) return { claimed: [], refused: decision.reason };
  service.releases.push(decision.release);
  return { claimed: fresh };
}

/**
 * Tracks what a shell command left running: one claim on the process group for as long as it
 * lives, plus the ports it listens on — checked again on every poll, because a server is
 * usually still starting when the command that launched it returns.
 */
async function trackService(ctx: LocalToolContext, command: string, pgid: number, survivors: number[]): Promise<string> {
  const gate = ctx.coordination;
  // Claimed before the command's own tool claim is released, so nothing slips in between.
  const decision = gate
    ? await gate.acquire({
        items: [{ resource: { kind: 'process', host: nodeOs.hostname(), pgid }, mode: 'exclusive' }],
        reason: `service \`${label(command)}\``,
        lifetime: 'service'
      })
    : undefined;
  const timer = setInterval(() => {
    const service = services.get(pgid);
    if (!service || service.checking) return;
    const members = processGroupMembers(pgid);
    if (members.length === 0) {
      void settleService(pgid, 'exited');
      return;
    }
    service.checking = true;
    void claimNewPorts(gate, pgid, members).finally(() => {
      service.checking = false;
    });
  }, SERVICE_POLL_MS);
  timer.unref?.();
  services.set(pgid, { pgid, command, workingDirectory: ctx.workingDirectory, ports: [], startedAt: Date.now(), releases: decision?.ok ? [decision.release] : [], timer });
  const ports = await claimNewPorts(gate, pgid, survivors);
  const what = `${survivors.length} process${survivors.length === 1 ? '' : 'es'} (group ${pgid})${ports.claimed.length ? `, listening on port ${ports.claimed.join(', ')}` : ''}`;
  const refused = decision && !decision.ok ? decision.reason : ports.refused;
  if (refused) return `Still running in the background: ${what}. It could not be claimed — ${refused} Stop it with \`kill -- -${pgid}\` unless you meant to share it.`;
  return `Still running in the background: ${what}. It stays claimed for this session (with any port it opens) until it exits; stop it with \`kill -- -${pgid}\` when you are done.`;
}

export { PathSandboxError };
