/**
 * Detects skills an AI tool loads on its own during a session.
 *
 * Praxis records the skills it attaches (`AgentSessionRecord.activeSkills`), but
 * CLI agents also pick up skills themselves: Claude Code calls its `Skill` tool,
 * Codex and others read `.../skills/<name>/SKILL.md`. This reads tool calls for
 * those two signals. It is best-effort: a skill applied from memory, or loaded
 * by a tool Praxis cannot see, leaves no trace.
 */

import type { AgentEventSummary } from './agentTypes';

export type SkillUseSource = 'skill-tool' | 'skill-file';

/** One skill the session's AI loaded itself, aggregated across the session. */
export interface DetectedSkillUse {
  skillId: string;
  via: SkillUseSource;
  firstAt: string;
  lastAt: string;
  count: number;
  /** The SKILL.md path, when the skill was loaded by reading its file. */
  path?: string;
}

export interface SkillUseSignal {
  skillId: string;
  via: SkillUseSource;
  at: string;
  path?: string;
}

const SKILL_NAME = /^[A-Za-z0-9][\w.:-]{0,127}$/;
/** `skills/<name>/SKILL.md`, optionally preceded by a path. Globs (`*`) never match a name. */
const SKILL_FILE = /((?:[^\s'"`<>|;&()]*\/)?skills\/([A-Za-z0-9][\w.-]*)\/SKILL\.md)(?![\w.])/gi;
const WRITE_TOOL = /\b(write|edit|create|apply_patch|patch|str_replace|multiedit|editing files)\b/i;

function skillToolName(toolName: string | undefined, args: Record<string, unknown> | undefined): string | undefined {
  const name = (toolName ?? '').trim();
  const isSkillTool = /^skill$/i.test(name) || /^(?:use_skill|load_skill|activate_skill)$/i.test(name);
  const titled = /^skill\s*[:(]\s*([^\s)]+)\)?$/i.exec(name);
  if (!isSkillTool && !titled) return undefined;
  const fromArgs = [args?.skill, args?.name, args?.command, args?.skill_name]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const candidate = (fromArgs ?? titled?.[1] ?? '').trim().replace(/^\//, '');
  return SKILL_NAME.test(candidate) ? candidate : undefined;
}

/** True when `text` writes to `filePath` with a shell redirect, i.e. authors the skill rather than loads it. */
function redirectsInto(text: string, filePath: string): boolean {
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`>>?\\s*['"]?${escaped}`).test(text);
}

/** The skill loads signalled by these events' tool calls. Only `tool_start` events are read. */
export function detectSkillUses(events: readonly AgentEventSummary[]): SkillUseSignal[] {
  const signals: SkillUseSignal[] = [];
  for (const event of events) {
    if (event.type !== 'tool_start') continue;
    const data = event.data ?? {};
    const at = event.timestamp;
    const fromTool = skillToolName(data.toolName, data.args);
    if (fromTool) {
      signals.push({ skillId: fromTool, via: 'skill-tool', at });
      continue;
    }
    if (data.kind === 'write' || WRITE_TOOL.test(data.toolName ?? '')) continue;
    const text = [data.toolName, data.argsSummary, data.args ? JSON.stringify(data.args) : undefined, event.summary]
      .filter((part): part is string => typeof part === 'string')
      .join('\n');
    const seen = new Set<string>();
    for (const match of text.matchAll(SKILL_FILE)) {
      const [, filePath, skillId] = match;
      if (seen.has(skillId) || redirectsInto(text, filePath)) continue;
      seen.add(skillId);
      signals.push({ skillId, via: 'skill-file', at, path: filePath });
    }
  }
  return signals;
}

/** Folds new signals into a session's aggregated list. Returns the same array when nothing changed. */
export function mergeDetectedSkillUses(
  existing: readonly DetectedSkillUse[] | undefined,
  signals: readonly SkillUseSignal[]
): DetectedSkillUse[] | undefined {
  if (signals.length === 0) return existing ? [...existing] : undefined;
  const byId = new Map<string, DetectedSkillUse>((existing ?? []).map(use => [use.skillId, { ...use }]));
  for (const signal of signals) {
    const current = byId.get(signal.skillId);
    if (!current) {
      byId.set(signal.skillId, {
        skillId: signal.skillId,
        via: signal.via,
        firstAt: signal.at,
        lastAt: signal.at,
        count: 1,
        ...(signal.path ? { path: signal.path } : {})
      });
      continue;
    }
    current.count += 1;
    if (signal.at < current.firstAt) current.firstAt = signal.at;
    if (signal.at > current.lastAt) current.lastAt = signal.at;
    // The skill tool is the stronger signal; keep it once seen.
    if (signal.via === 'skill-tool') current.via = 'skill-tool';
    if (!current.path && signal.path) current.path = signal.path;
  }
  return [...byId.values()];
}
