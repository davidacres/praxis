import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSessionRecord, Connection, ConnectionCheck, UsageBucket } from '@praxis/core';
import { Icon } from '../ui/Icon';

interface WorkspaceActivityHeatmapProps {
  sessions: AgentSessionRecord[];
  connections: Connection[];
  connectionChecks: Record<string, ConnectionCheck | undefined>;
  runtime?: { profiles: number; hosts: number; skills: number };
  onOpenConnections?: () => void;
}

interface CalendarSquare {
  date: Date;
  dateStr: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  isFuture: boolean;
  x: number;
  y: number;
}

interface MonthLabel {
  label: string;
  weekIndex: number;
  x: number;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const CELL_SIZE = 10;
const CELL_GAP = 3;
const STEP = CELL_SIZE + CELL_GAP; // 13px
const LEFT_PAD = 2;
const TOP_LABEL_HEIGHT = 18;
const NUM_WEEKS = 53;
const SVG_WIDTH = LEFT_PAD + NUM_WEEKS * STEP + 2; // 693px
const SVG_HEIGHT = TOP_LABEL_HEIGHT + 7 * STEP; // 109px

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getOrdinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function formatTooltip(date: Date, count: number): string {
  const month = FULL_MONTHS[date.getMonth()];
  const year = date.getFullYear();
  if (count === 0) {
    const weekday = WEEKDAYS[date.getDay()];
    return `No activities on ${weekday}, ${month} ${date.getDate()}, ${year}.`;
  }
  const dayWithOrdinal = getOrdinal(date.getDate());
  return `${count} ${count === 1 ? 'activity' : 'activities'} on ${month} ${dayWithOrdinal}.`;
}

export function WorkspaceActivityHeatmap({
  sessions,
  connections,
  connectionChecks,
  runtime,
  onOpenConnections
}: WorkspaceActivityHeatmapProps) {
  const [ledgerBuckets, setLedgerBuckets] = useState<UsageBucket[]>([]);
  const [hovered, setHovered] = useState<{
    date: Date;
    count: number;
    x: number;
    y: number;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Load 375 days of usage series from usage ledger
  useEffect(() => {
    let cancelled = false;
    window.praxis.aiUsage.series('day', 375)
      .then(buckets => {
        if (!cancelled) setLedgerBuckets(buckets);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Aggregate activity counts by calendar date YYYY-MM-DD
  const activityMap = useMemo(() => {
    const counts = new Map<string, number>();

    for (const session of sessions) {
      if (!session.startedAt) continue;
      const d = new Date(session.startedAt);
      if (Number.isNaN(d.getTime())) continue;
      const key = toDateKey(d);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const bucket of ledgerBuckets) {
      if (!bucket.periodStart) continue;
      const d = new Date(bucket.periodStart);
      if (Number.isNaN(d.getTime())) continue;
      const key = toDateKey(d);
      const val = counts.get(key) ?? 0;
      counts.set(key, val + (bucket.eventCount > 0 ? bucket.eventCount : 0));
    }

    return counts;
  }, [sessions, ledgerBuckets]);

  // Build exactly 53 weeks ending on current week's Saturday
  const { squares, months, totalCount, activeDays, currentStreak, longestStreak } = useMemo(() => {
    const now = new Date();
    const todayKey = toDateKey(now);

    const dayOfWeekToday = now.getDay(); // 0 = Sun, 6 = Sat
    const endSaturday = new Date(now);
    endSaturday.setDate(now.getDate() + (6 - dayOfWeekToday));
    endSaturday.setHours(23, 59, 59, 999);

    const startDate = new Date(endSaturday);
    startDate.setDate(endSaturday.getDate() - (NUM_WEEKS * 7 - 1));
    startDate.setHours(0, 0, 0, 0);

    const resultSquares: CalendarSquare[] = [];
    const monthList: MonthLabel[] = [];
    const curr = new Date(startDate);

    let total = 0;
    let active = 0;
    const flatDays: CalendarSquare[] = [];

    for (let w = 0; w < NUM_WEEKS; w++) {
      // Month labels: detect if this week contains the 1st of a month, or week 0
      for (let d = 0; d < 7; d++) {
        const dayDate = new Date(curr);
        dayDate.setDate(curr.getDate() + d);
        if (dayDate.getDate() === 1 || (w === 0 && d === 0)) {
          const label = SHORT_MONTHS[dayDate.getMonth()];
          // Prevent label overlap if within 2 weeks of the previous label
          const prev = monthList[monthList.length - 1];
          if (!prev || (w * STEP - prev.weekIndex * STEP) >= 28) {
            monthList.push({ label, weekIndex: w, x: LEFT_PAD + w * STEP });
          }
          break;
        }
      }

      for (let d = 0; d < 7; d++) {
        const date = new Date(curr);
        const dateStr = toDateKey(date);
        const isFuture = dateStr > todayKey;

        const count = isFuture ? 0 : (activityMap.get(dateStr) ?? 0);
        if (count > 0) {
          total += count;
          active += 1;
        }

        let level: CalendarSquare['level'] = 0;
        if (count >= 10) level = 4;
        else if (count >= 6) level = 3;
        else if (count >= 3) level = 2;
        else if (count >= 1) level = 1;

        const sq: CalendarSquare = {
          date,
          dateStr,
          count,
          level,
          isFuture,
          x: LEFT_PAD + w * STEP,
          y: TOP_LABEL_HEIGHT + d * STEP
        };

        resultSquares.push(sq);
        if (!isFuture) flatDays.push(sq);

        curr.setDate(curr.getDate() + 1);
      }
    }

    // Streaks calculation
    let curStreak = 0;
    let maxStreak = 0;
    let tempStreak = 0;

    for (const d of flatDays) {
      if (d.count > 0) {
        tempStreak++;
        if (tempStreak > maxStreak) maxStreak = tempStreak;
      } else {
        tempStreak = 0;
      }
    }

    for (let i = flatDays.length - 1; i >= 0; i--) {
      if (flatDays[i].count > 0) {
        curStreak++;
      } else {
        if (i === flatDays.length - 1) {
          continue;
        }
        break;
      }
    }

    return {
      squares: resultSquares,
      months: monthList,
      totalCount: total,
      activeDays: active,
      currentStreak: curStreak,
      longestStreak: maxStreak
    };
  }, [activityMap]);

  // Keep initial scroll at 0 for standard chronological reading
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
    }
  }, []);

  const healthyConnections = connections.filter(
    connection => connectionChecks[connection.id]?.status !== 'error'
  ).length;
  const hasError = connections.some(
    connection => connectionChecks[connection.id]?.status === 'error'
  );

  return (
    <section className="overview-panel overview-heatmap ContributionCalendar" data-testid="overview-activity-heatmap">
      <div className="overview-panel-heading ContributionCalendar-header">
        <div className="ContributionCalendar-title-group">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Icon name="graph" size={15} />
            <h2>Workspace health</h2>
          </div>
          <span className="ContributionCalendar-activity-summary">
            {totalCount.toLocaleString()} {totalCount === 1 ? 'activity' : 'activities'} in the last year
          </span>
        </div>
        {connections.length > 0 && onOpenConnections && (
          <button className="btn btn-quiet" type="button" onClick={onOpenConnections}>
            Connections <Icon name="chevron-right" size={13} />
          </button>
        )}
      </div>

      <div className="ContributionCalendar-meta">
        <span><strong>{currentStreak}</strong> {currentStreak === 1 ? 'day' : 'days'} current streak</span>
        <span className="ContributionCalendar-meta-separator">·</span>
        <span><strong>{longestStreak}</strong> {longestStreak === 1 ? 'day' : 'days'} longest streak</span>
        <span className="ContributionCalendar-meta-separator">·</span>
        <span><strong>{activeDays}</strong> active {activeDays === 1 ? 'day' : 'days'}</span>
      </div>

      <div className="ContributionCalendar-wrapper" ref={wrapperRef}>
        {/* Pinned weekday labels on the left */}
        <div className="ContributionCalendar-weekdays">
          <span className="ContributionCalendar-weekday-label" style={{ top: TOP_LABEL_HEIGHT + 1 * STEP }}>Mon</span>
          <span className="ContributionCalendar-weekday-label" style={{ top: TOP_LABEL_HEIGHT + 3 * STEP }}>Wed</span>
          <span className="ContributionCalendar-weekday-label" style={{ top: TOP_LABEL_HEIGHT + 5 * STEP }}>Fri</span>
        </div>

        {/* Scrollable calendar grid */}
        <div className="ContributionCalendar-grid-container" ref={scrollRef}>
          <svg
            width={SVG_WIDTH}
            height={SVG_HEIGHT}
            className="ContributionCalendar-svg"
            role="img"
            aria-label="Workspace activity calendar heatmap"
          >
            {/* Month labels along top */}
            {months.map((m, idx) => (
              <text
                key={idx}
                x={m.x}
                y={0}
                className="ContributionCalendar-month-label"
              >
                {m.label}
              </text>
            ))}

            {/* Contribution day squares */}
            {squares.map(sq => (
              <rect
                key={sq.dateStr}
                x={sq.x}
                y={sq.y}
                width={CELL_SIZE}
                height={CELL_SIZE}
                rx={2}
                ry={2}
                className="ContributionCalendar-day"
                data-level={sq.isFuture ? 0 : sq.level}
                opacity={sq.isFuture ? 0 : 1}
                onMouseEnter={e => {
                  if (sq.isFuture) return;
                  const target = e.currentTarget;
                  const rect = target.getBoundingClientRect();
                  const wrapRect = wrapperRef.current?.getBoundingClientRect();
                  if (wrapRect) {
                    setHovered({
                      date: sq.date,
                      count: sq.count,
                      x: rect.left - wrapRect.left + rect.width / 2,
                      y: rect.top - wrapRect.top
                    });
                  }
                }}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
          </svg>
        </div>

        {/* Tooltip hovering over day square */}
        {hovered && (
          <div
            className="ContributionCalendar-tooltip"
            style={{
              left: `${hovered.x}px`,
              top: `${hovered.y - 7}px`
            }}
          >
            {formatTooltip(hovered.date, hovered.count)}
          </div>
        )}
      </div>

      <div className="ContributionCalendar-footer">
        <div className="ContributionCalendar-health-status">
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className={`overview-health-dot ${hasError ? 'error' : 'ok'}`} />
            <span>
              {connections.length > 0
                ? `${healthyConnections}/${connections.length} connections available`
                : 'No external connections'}
            </span>
          </div>
          {runtime && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="overview-health-dot ok" />
              <span>Runtime: {runtime.profiles} profiles · {runtime.hosts} hosts</span>
            </div>
          )}
        </div>

        <div className="ContributionCalendar-legend">
          <span className="ContributionCalendar-legend-label">Less</span>
          <svg width={10} height={10}><rect width={10} height={10} rx={2} ry={2} className="ContributionCalendar-day" data-level={0} /></svg>
          <svg width={10} height={10}><rect width={10} height={10} rx={2} ry={2} className="ContributionCalendar-day" data-level={1} /></svg>
          <svg width={10} height={10}><rect width={10} height={10} rx={2} ry={2} className="ContributionCalendar-day" data-level={2} /></svg>
          <svg width={10} height={10}><rect width={10} height={10} rx={2} ry={2} className="ContributionCalendar-day" data-level={3} /></svg>
          <svg width={10} height={10}><rect width={10} height={10} rx={2} ry={2} className="ContributionCalendar-day" data-level={4} /></svg>
          <span className="ContributionCalendar-legend-label">More</span>
        </div>
      </div>
    </section>
  );
}
