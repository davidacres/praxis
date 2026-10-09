/**
 * Opt-in Claude Code hook adapter (FX-BF-048 / TASK-393).
 *
 * Run as a `PreToolUse` / `PostToolUse` / `Stop` hook command. Before an Edit/Write/MultiEdit/
 * NotebookEdit it claims the file at the broker and, if another session holds it, denies the
 * tool with the holder and reason — before the edit happens. After the tool it releases;
 * when the turn stops it releases everything the session still holds.
 *
 * Praxis never installs this into anyone's configuration. A person adds it themselves (the
 * snippet is in Settings), or a launcher passes it with `claude --settings <file>`.
 *
 * Coverage stays **cooperative**: a Bash command is not claimed (its effects cannot be known
 * up front), and if the broker is not running the hook allows the tool and says so on
 * stderr rather than block every edit on a machine with no Praxis open.
 */

import * as path from 'node:path';
import { connectToCoordination } from './coordinationHost';

interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { file_path?: string; notebook_path?: string };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function worktreeOf(cwd: string): string {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd;
  } catch {
    return cwd;
  }
}

export async function runHook(raw: string): Promise<{ stdout?: string; stderr?: string }> {
  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    return { stderr: 'praxis coordination hook: unreadable payload; allowing.' };
  }
  const sessionKey = `claude:${payload.session_id ?? 'unknown'}`;
  const event = payload.hook_event_name;
  const tool = payload.tool_name ?? '';
  if ((event === 'PreToolUse' || event === 'PostToolUse') && !EDIT_TOOLS.has(tool)) return {};

  const broker = await connectToCoordination();
  if (!broker) return { stderr: 'praxis coordination hook: no coordination broker is running (open Praxis); allowing.' };
  try {
    const owner = { sessionKey };
    const requestId = `${sessionKey}:${payload.tool_use_id ?? `${tool}:${payload.tool_input?.file_path ?? payload.tool_input?.notebook_path ?? ''}`}`;
    if (event === 'PreToolUse') {
      const cwd = payload.cwd || process.cwd();
      const worktree = worktreeOf(cwd);
      const target = path.resolve(cwd, payload.tool_input?.file_path ?? payload.tool_input?.notebook_path ?? '');
      await broker.send({ kind: 'register', session: { sessionKey, runtime: 'claude-code-hook', coverage: 'cooperative', worktree } });
      const result = await broker.send({
        kind: 'acquire',
        requestId,
        owner,
        items: [{ resource: { kind: 'file', worktree, path: path.relative(worktree, target) }, mode: 'exclusive' }],
        reason: `${tool} ${path.relative(worktree, target)}`,
        lifetime: 'tool',
        wait: false
      });
      const refused = !result.ok ? result.error : result.acquire?.status !== 'granted' ? (result.acquire?.status === 'blocked' ? result.acquire.reason : 'busy') : undefined;
      if (!refused) return {};
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Praxis coordination: ${refused} Another session is editing this; work on something else, or wait for it to finish. Do not retry in a loop.`
          }
        })
      };
    }
    if (event === 'PostToolUse') {
      await broker.send({ kind: 'release', owner, requestId });
      return {};
    }
    if (event === 'Stop' || event === 'SubagentStop' || event === 'SessionEnd') {
      await broker.send({ kind: 'end-turn', owner });
      return {};
    }
    return {};
  } finally {
    await broker.close();
  }
}

if (require.main === module) {
  // A hook that hangs would stall the agent's every edit: it gives up, allows, and says so.
  setTimeout(() => {
    process.stderr.write('praxis coordination hook timed out waiting for the broker; allowing.\n');
    process.exit(0);
  }, 8000);
  void readStdin()
    .then(runHook)
    .then(({ stdout, stderr }) => {
      if (stderr) process.stderr.write(`${stderr}\n`);
      if (stdout) process.stdout.write(stdout);
      process.exit(0);
    })
    .catch(error => {
      // A broken hook must not pass silently as enforcement: it allows, and says why.
      process.stderr.write(`praxis coordination hook failed (${error instanceof Error ? error.message : String(error)}); allowing.\n`);
      process.exit(0);
    });
}
