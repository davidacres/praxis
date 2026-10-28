import type { AgentSessionRecord, DetectedSkillUse } from '@praxis/core';

/** One skill a session used: attached by Praxis at launch, loaded by the AI itself, or both. */
export interface SessionSkillRow {
  name: string;
  attached: boolean;
  detected?: DetectedSkillUse;
}

/**
 * The skills a session used, attached ones first. A plugin-qualified name the
 * AI loaded (`plugin:skill`) counts as the attached skill of the same base name.
 */
export function sessionSkillRows(session: Pick<AgentSessionRecord, 'activeSkills' | 'detectedSkills'>): SessionSkillRow[] {
  const rows = new Map<string, SessionSkillRow>();
  for (const name of session.activeSkills ?? []) rows.set(name, { name, attached: true });
  for (const use of session.detectedSkills ?? []) {
    const base = use.skillId.includes(':') ? use.skillId.slice(use.skillId.lastIndexOf(':') + 1) : use.skillId;
    const key = rows.has(use.skillId) ? use.skillId : rows.get(base)?.attached ? base : use.skillId;
    const row = rows.get(key);
    rows.set(key, row ? { ...row, detected: use } : { name: use.skillId, attached: false, detected: use });
  }
  return [...rows.values()];
}

/** True when the session used `skillName`, by attachment or detection. */
export function sessionUsedSkill(session: Pick<AgentSessionRecord, 'activeSkills' | 'detectedSkills'>, skillName: string): boolean {
  return sessionSkillRows(session).some(row => row.name === skillName || row.detected?.skillId === skillName);
}

/** Short words for how a skill reached the session. */
export function skillUsageLabel(row: SessionSkillRow): string {
  if (row.attached && row.detected) return 'attached · loaded by the AI';
  if (row.attached) return 'attached';
  return row.detected?.via === 'skill-tool' ? 'loaded by the AI' : 'read by the AI';
}

/** A tooltip explaining a detected use. */
export function skillUsageTitle(row: SessionSkillRow): string {
  const parts = [row.attached ? 'Attached by Praxis when the session started.' : 'Not attached by Praxis.'];
  if (row.detected) {
    const how = row.detected.via === 'skill-tool' ? 'called its skill tool for it' : `read ${row.detected.path ?? 'its SKILL.md'}`;
    parts.push(`The AI ${how} ${row.detected.count === 1 ? 'once' : `${row.detected.count} times`} (detected from tool calls; best-effort).`);
  }
  return parts.join(' ');
}
