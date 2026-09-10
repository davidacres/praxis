import { Icon } from '../ui/Icon';

interface PriorityIndicatorProps {
  priority: string | undefined;
  title?: string;
}

export function PriorityIndicator({ priority, title }: PriorityIndicatorProps) {
  if (!priority) return null;

  const normalized = priority.trim().toLowerCase();

  // Map priority to arrow count and color token
  // Using P1, P2, P3, P4 or common priority names
  const config = normalized.match(/^p?[0-4]$/i)
    ? getPriorityConfig(parseInt(normalized.replace(/\D/g, '')) || 2)
    : getPriorityConfigByName(normalized);

  if (!config) {
    // Fallback: show the text if we don't recognize the priority
    return <span className="priority-indicator-text" title={title || priority}>{priority}</span>;
  }

  const arrows = Array.from({ length: config.count }, (_, i) => (
    <span key={i} className="priority-arrow" style={{ color: `var(${config.colorToken})` }}>
      {config.direction === 'up' ? '▲' : '▼'}
    </span>
  ));

  return (
    <span className="priority-indicator" title={title || priority}>
      {arrows}
    </span>
  );
}

interface PriorityConfig {
  count: number;
  direction: 'up' | 'down';
  colorToken: string;
}

function getPriorityConfig(level: number): PriorityConfig {
  switch (level) {
    case 0:
      return { count: 4, direction: 'up', colorToken: '--tone-critical' };
    case 1:
      return { count: 3, direction: 'up', colorToken: '--tone-warning' };
    case 2:
      return { count: 2, direction: 'up', colorToken: '--tone-info' };
    case 3:
      return { count: 1, direction: 'up', colorToken: '--accent' };
    case 4:
      return { count: 1, direction: 'down', colorToken: '--text-secondary' };
    default:
      return { count: 1, direction: 'up', colorToken: '--accent' };
  }
}

function getPriorityConfigByName(name: string): PriorityConfig | null {
  // Map common priority names
  const nameMap: Record<string, PriorityConfig> = {
    'critical': { count: 4, direction: 'up', colorToken: '--tone-critical' },
    'blocker': { count: 4, direction: 'up', colorToken: '--tone-critical' },
    'highest': { count: 4, direction: 'up', colorToken: '--tone-critical' },
    'p0': { count: 4, direction: 'up', colorToken: '--tone-critical' },

    'high': { count: 3, direction: 'up', colorToken: '--tone-warning' },
    'important': { count: 3, direction: 'up', colorToken: '--tone-warning' },
    'p1': { count: 3, direction: 'up', colorToken: '--tone-warning' },

    'medium': { count: 2, direction: 'up', colorToken: '--tone-info' },
    'normal': { count: 2, direction: 'up', colorToken: '--tone-info' },
    'standard': { count: 2, direction: 'up', colorToken: '--tone-info' },
    'p2': { count: 2, direction: 'up', colorToken: '--tone-info' },

    'low': { count: 1, direction: 'up', colorToken: '--accent' },
    'minor': { count: 1, direction: 'up', colorToken: '--accent' },
    'p3': { count: 1, direction: 'up', colorToken: '--accent' },

    'lowest': { count: 1, direction: 'down', colorToken: '--text-secondary' },
    'trivial': { count: 1, direction: 'down', colorToken: '--text-secondary' },
    'p4': { count: 1, direction: 'down', colorToken: '--text-secondary' },
  };

  return nameMap[name] || null;
}
