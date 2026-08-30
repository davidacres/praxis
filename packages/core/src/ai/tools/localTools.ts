import * as nodeFs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as nodeChildProcess from 'node:child_process';
import type { GatewayToolDefinition } from '../gateway';
import type { AgentToolEventData, AgentToolMode } from '../agentTypes';
import { PathSandboxError, resolveSandboxedPath } from './pathSandbox';
import { createUnifiedDiff } from './unifiedDiff';

export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';

export interface ToolPermissionRequest {
  kind: 'read' | 'write' | 'shell' | 'list';
  description: string;
  detail?: string;
  toolName: string;
}

export interface LocalToolContext {
  workingDirectory: string;
  toolMode?: AgentToolMode;
  requestPermission: (request: ToolPermissionRequest) => Promise<PermissionDecision>;
  /** Optional always-allow check before prompting (e.g. shell allowlist). */
  shouldAutoAllow?: (request: ToolPermissionRequest) => boolean;
}

export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  /** Structured metadata for the UI (diffs, shell output). The `content` string stays authoritative for the model. */
  data?: AgentToolEventData;
}

const SHELL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_READ_BYTES = 512 * 1024;
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

const READ_ONLY_LOCAL_TOOLS = new Set(['read_file', 'list_dir']);

export function localToolDefinitionsForMode(mode: AgentToolMode): GatewayToolDefinition[] {
  if (mode === 'project-only') return [];
  return mode === 'read-only'
    ? LOCAL_TOOL_DEFINITIONS.filter(tool => READ_ONLY_LOCAL_TOOLS.has(tool.name))
    : LOCAL_TOOL_DEFINITIONS;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function ensurePermission(
  ctx: LocalToolContext,
  request: ToolPermissionRequest,
  alwaysAllowed: Set<string>
): Promise<boolean> {
  const key = `${request.kind}:${request.detail ?? request.description}`;
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
        case 'write_file':
          return await this.writeFile(asString(args.path) ?? '', asString(args.content) ?? '');
        case 'list_dir':
          return await this.listDir(asString(args.path) ?? '.');
        case 'run_shell':
          return await this.runShell(asString(args.command) ?? '');
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
        detail: inputPath,
        description: `Permission requested: read ${inputPath}`
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
        detail: inputPath,
        description: `Permission requested: write ${inputPath}`
      },
      this.alwaysAllowed
    );
    if (!allowed) {
      return { ok: false, content: 'Permission denied for write_file' };
    }

    const previous = await nodeFs.readFile(absolute, 'utf8').catch(() => '');
    await nodeFs.mkdir(nodePath.dirname(absolute), { recursive: true });
    await nodeFs.writeFile(absolute, content, 'utf8');

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

  private async listDir(inputPath: string): Promise<ToolExecutionResult> {
    const absolute = resolveSandboxedPath(this.ctx.workingDirectory, inputPath || '.');
    const allowed = await ensurePermission(
      this.ctx,
      {
        kind: 'list',
        toolName: 'list_dir',
        detail: inputPath || '.',
        description: `Permission requested: list ${inputPath || '.'}`
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
        detail: command,
        description: `Permission requested: shell ${command}`
      },
      this.alwaysAllowed
    );
    if (!allowed) {
      return { ok: false, content: 'Permission denied for run_shell' };
    }

    return await new Promise<ToolExecutionResult>(resolve => {
      nodeChildProcess.exec(
        command,
        {
          cwd: this.ctx.workingDirectory,
          timeout: SHELL_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          const out = stdout?.toString() ?? '';
          const err = stderr?.toString() ?? '';
          const parts = [
            out,
            err,
            error ? `exit error: ${error.message}` : ''
          ].filter(part => part.trim().length > 0);
          const exitCode =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code)
              : error
                ? 1
                : 0;
          resolve({
            ok: !error,
            content: parts.join('\n').trim() || '(no output)',
            data: {
              toolName: 'run_shell',
              kind: 'shell',
              ok: !error,
              output: [out, err].filter(part => part.trim().length > 0).join('\n').trim(),
              exitCode
            }
          });
        }
      );
    });
  }
}

export { PathSandboxError };
