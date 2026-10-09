/**
 * Opt-in native hook adapter for CLI agents (FX-BF-048 / TASK-393).
 *
 * Run as the agent's before-tool / after-tool / stop hook command. Before a file-editing tool
 * it claims the files at the broker and, if another session holds one, denies the tool with
 * the holder and reason — before the edit happens. After the tool it releases; when the turn
 * stops it releases everything the session still holds.
 *
 *   node coordinationHook.js [--runtime claude|codex|copilot|gemini] [--event pre|post|stop]
 *
 * One adapter per runtime, because each speaks its own payload and denial format:
 *
 * | runtime | edit tools (files named) | denial |
 * | --- | --- | --- |
 * | claude (default) | Edit, Write, MultiEdit, NotebookEdit | `hookSpecificOutput.permissionDecision: "deny"` |
 * | codex | apply_patch (paths from the patch headers) | same shape as Claude Code |
 * | copilot | edit, create (`toolArgs.path`); needs `--event`, its payload has no event name | `permissionDecision: "deny"` |
 * | gemini | write_file, replace (`tool_input.file_path`) | `decision: "deny"` |
 *
 * Praxis never installs this into anyone's configuration. A person adds it themselves, or a
 * launcher passes it for one run (`claude --settings <file>`).
 *
 * Coverage stays **cooperative**: shell commands are not claimed (their effects cannot be
 * named up front). With no broker running at all (Praxis closed) the hook allows and says so
 * on stderr, rather than block every edit on a machine with no Praxis open. A broker that is
 * running but fails or does not answer in time, or the hook itself failing, is not
 * availability: the edit is denied, with why. (A hook process that crashes outright is the
 * runtime's to handle — Claude Code, for one, then runs the tool: see the capability matrix.)
 */

import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectToCoordination } from './coordinationHost';

export type HookRuntime = 'claude' | 'codex' | 'copilot' | 'gemini';
type Phase = 'before' | 'after' | 'stop' | 'other';

interface NormalisedHook {
  phase: Phase;
  sessionId: string;
  cwd?: string;
  tool: string;
  toolUseId?: string;
  /** Files the tool will change; undefined when it is not an editing tool. */
  files?: string[];
}

const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COPILOT_EDIT_TOOLS = new Set(['edit', 'create']);
const GEMINI_EDIT_TOOLS = new Set(['write_file', 'replace']);

/** The files an `apply_patch` patch touches: every Add/Update/Delete header, and a Move's target. */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim()) ?? /^\*\*\* Move to: (.+)$/.exec(line.trim());
    if (match) files.add(match[1].trim());
  }
  return [...files];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** Reads one runtime's payload into the common shape. */
export function normaliseHook(runtime: HookRuntime, payload: Record<string, unknown>, event?: string): NormalisedHook {
  if (runtime === 'copilot') {
    const tool = text(payload.toolName) ?? '';
    const args = record(payload.toolArgs);
    const phase: Phase = event === 'pre' ? 'before' : event === 'post' ? 'after' : event === 'stop' ? 'stop' : 'other';
    return {
      phase,
      sessionId: text(payload.sessionId) ?? 'unknown',
      cwd: text(payload.cwd),
      tool,
      ...(COPILOT_EDIT_TOOLS.has(tool) && text(args.path) ? { files: [text(args.path)!] } : {})
    };
  }
  const name = text(payload.hook_event_name) ?? '';
  const tool = text(payload.tool_name) ?? '';
  const input = record(payload.tool_input);
  const phase: Phase =
    name === 'PreToolUse' || name === 'BeforeTool' ? 'before'
      : name === 'PostToolUse' || name === 'AfterTool' ? 'after'
        // A subagent stopping is not its parent's turn ending: the parent may still be mid-edit.
        : ['Stop', 'SessionEnd', 'AfterAgent'].includes(name) ? 'stop'
          : 'other';
  let files: string[] | undefined;
  if (runtime === 'claude' && CLAUDE_EDIT_TOOLS.has(tool)) files = [text(input.file_path) ?? text(input.notebook_path) ?? ''].filter(Boolean);
  if (runtime === 'codex' && tool === 'apply_patch') files = patchFiles(text(input.command) ?? text(input.patch) ?? text(input.input) ?? '');
  if (runtime === 'gemini' && GEMINI_EDIT_TOOLS.has(tool)) files = [text(input.file_path) ?? ''].filter(Boolean);
  return { phase, sessionId: text(payload.session_id) ?? 'unknown', cwd: text(payload.cwd), tool, toolUseId: text(payload.tool_use_id), ...(files ? { files } : {}) };
}

/** The runtime's own way of saying "do not run this tool". */
export function denial(runtime: HookRuntime, reason: string): string {
  switch (runtime) {
    case 'copilot':
      return JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason });
    case 'gemini':
      return JSON.stringify({ decision: 'deny', reason });
    default:
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  }
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface HookOptions {
  runtime?: HookRuntime;
  event?: string;
}

export async function runHook(raw: string, options: HookOptions = {}): Promise<{ stdout?: string; stderr?: string }> {
  const runtime = options.runtime ?? 'claude';
  let payload: Record<string, unknown>;
  try {
    payload = record(JSON.parse(raw));
  } catch {
    return { stderr: 'praxis coordination hook: unreadable payload; allowing.' };
  }
  const hook = normaliseHook(runtime, payload, options.event);
  const sessionKey = `${runtime}:${hook.sessionId}`;
  // Only file edits are claimed; everything else (reads, shell, MCP) passes untouched.
  if ((hook.phase === 'before' || hook.phase === 'after') && !hook.files) return {};
  if (hook.phase === 'other') return {};

  const broker = await connectToCoordination();
  if (!broker) return { stderr: 'praxis coordination hook: no coordination broker is running (open Praxis); allowing.' };
  try {
    const owner = { sessionKey };
    const requestId = `${sessionKey}:${hook.toolUseId ?? `${hook.tool}:${(hook.files ?? []).join(',')}`}`;
    if (hook.phase === 'before') {
      const cwd = hook.cwd || process.cwd();
      const worktree = git(cwd, ['rev-parse', '--show-toplevel']) ?? cwd;
      const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const relative = (hook.files ?? []).map(entry => path.relative(worktree, path.resolve(cwd, entry)));
      if (relative.length === 0) return {};
      await broker.send({ kind: 'register', session: { sessionKey, runtime: `${runtime}-hook`, coverage: 'cooperative', worktree, ...(common ? { scope: common } : {}) } });
      const result = await broker.send({
        kind: 'acquire',
        requestId,
        owner,
        items: relative.map(entry => ({ resource: { kind: 'file' as const, worktree, path: entry }, mode: 'exclusive' as const })),
        reason: `${hook.tool} ${relative.join(', ')}`.slice(0, 200),
        lifetime: 'tool',
        wait: false
      });
      // A broker error is not a grant: refused, with the error, so it is never silent.
      if (!result.ok) return { stdout: denial(runtime, `Praxis coordination could not grant this edit: ${result.error} Try once more shortly; if it keeps happening, restart Praxis.`) };
      if (result.acquire?.status === 'granted') return {};
      const busy = result.acquire?.status === 'blocked' ? result.acquire.reason : 'Busy.';
      return { stdout: denial(runtime, `Praxis coordination: ${busy} Another session is editing this; work on something else, or wait for it to finish. Do not retry in a loop.`) };
    }
    if (hook.phase === 'after') {
      await broker.send({ kind: 'release', owner, requestId });
      return {};
    }
    await broker.send({ kind: 'end-turn', owner });
    return {};
  } finally {
    await broker.close();
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

if (require.main === module) {
  const runtimeArg = argument('runtime');
  const runtime: HookRuntime = runtimeArg === 'codex' || runtimeArg === 'copilot' || runtimeArg === 'gemini' ? runtimeArg : 'claude';
  const event = argument('event');
  const timeoutMs = Number(process.env.PRAXIS_HOOK_TIMEOUT_MS) || 8000;
  let input = '';
  /** Ends the hook having failed: an edit is refused (with why), anything else passes. */
  const failClosed = (why: string, advice: string) => {
    let edit = false;
    try {
      const hook = normaliseHook(runtime, record(JSON.parse(input)), event);
      edit = hook.phase === 'before' && !!hook.files?.length;
    } catch {
      /* unreadable: nothing to refuse */
    }
    process.stderr.write(`praxis coordination hook: ${why}${edit ? '; refusing the edit' : ''}.\n`);
    if (edit) process.stdout.write(denial(runtime, `Praxis coordination ${advice}`));
    process.exit(0);
  };
  // A broker that is running but does not answer is not availability: the edit is refused,
  // promptly, rather than let through or left to stall the agent until its own timeout.
  setTimeout(
    () => failClosed(`the broker did not answer within ${Math.round(timeoutMs / 1000)} s`, 'did not answer in time, so this edit was not granted. Try once more shortly; if it keeps happening, restart Praxis.'),
    timeoutMs
  ).unref();
  void readStdin()
    .then(raw => {
      input = raw;
      return runHook(raw, { runtime, event });
    })
    .then(({ stdout, stderr }) => {
      if (stderr) process.stderr.write(`${stderr}\n`);
      if (stdout) process.stdout.write(stdout);
      process.exit(0);
    })
    .catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      failClosed(`failed (${message})`, `failed (${message}), so this edit was not granted.`);
    });
}
