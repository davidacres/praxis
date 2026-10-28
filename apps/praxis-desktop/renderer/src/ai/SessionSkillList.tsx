import type { SessionSkillRow } from './sessionSkills';
import { skillUsageLabel, skillUsageTitle } from './sessionSkills';

/** The skills a session used, each marked attached or loaded by the AI. */
export function SessionSkillList({ rows, onOpenSkill }: { rows: SessionSkillRow[]; onOpenSkill?: (name: string) => void }) {
  if (rows.length === 0) return <span className="rail-sub">none</span>;
  return (
    <ul className="session-skill-list" data-testid="session-skill-list">
      {rows.map(row => (
        <li
          key={row.name}
          className={`session-skill${row.detected && !row.attached ? ' session-skill--detected' : ''}`}
          data-testid="session-skill"
          data-skill={row.name}
          data-usage={row.attached ? (row.detected ? 'attached-loaded' : 'attached') : 'detected'}
          title={skillUsageTitle(row)}
        >
          {onOpenSkill ? (
            <button type="button" className="btn-compact session-skill-name" onClick={() => onOpenSkill(row.name)}>{row.name}</button>
          ) : (
            <span className="session-skill-name">{row.name}</span>
          )}
          <span className="session-skill-usage">{skillUsageLabel(row)}</span>
        </li>
      ))}
    </ul>
  );
}
