import { useEffect, useRef, useState } from 'react';
import type { BoardColumnPreferences } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { DEFAULT_BOARD_PREFS } from './boardPreferences';
import { ChipSelect } from '../ui/ChipSelect';

/**
 * Per-board settings popover (the board toolbar's gear button). Covers
 * the desktop plan's Phase C rows: board/list layout, swim lanes, max-age,
 * column set + order, and status/type colors. Writes go through
 * `onChange` — the board view persists them via `boardPrefs:set` so they
 * survive relaunch.
 */

const MAX_AGE_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'All time' },
  { value: 1, label: 'Past week' },
  { value: 2, label: 'Past 2 weeks' },
  { value: 4, label: 'Past 4 weeks' },
  { value: 8, label: 'Past 8 weeks' }
];

/** Color inputs only accept #rrggbb, so an unset preference needs a neutral stand-in. */
const UNSET_COLOR = '#8a8a8a';

export interface BoardSettingsMenuProps {
  prefs: BoardColumnPreferences;
  onChange: (next: BoardColumnPreferences) => void;
  /** Statuses in the board's current (effective) order — the column list's row order. */
  statusOrder: string[];
  /** The backend's canonical order; an order matching it is stored as "no custom order". */
  baseStatusOrder: string[];
  issueTypeOptions: string[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function BoardSettingsMenu({
  prefs,
  onChange,
  statusOrder,
  baseStatusOrder,
  issueTypeOptions,
  open = false,
  onOpenChange
}: BoardSettingsMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!(open || internalOpen)) {
      return;
    }
    const onDocumentClick = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [open, internalOpen]);

  const isOpen = open || internalOpen;
  const setOpen = (next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  };

  const isCustomVisible = prefs.workflowStatuses.length > 0;
  const isVisible = (status: string) => !isCustomVisible || prefs.workflowStatuses.includes(status);

  const toggleStatus = (status: string) => {
    // With no custom set every column shows; the first uncheck materialises
    // "everything except this one", and re-checking the last hidden column
    // collapses back to the empty ("show all") form.
    const nextVisible = isVisible(status)
      ? statusOrder.filter(name => name !== status && isVisible(name))
      : statusOrder.filter(name => isVisible(name) || name === status);
    const showAll = nextVisible.length >= statusOrder.length;
    onChange({ ...prefs, workflowStatuses: showAll ? [] : nextVisible });
  };

  const moveStatus = (status: string, direction: -1 | 1) => {
    const order = [...statusOrder];
    const index = order.indexOf(status);
    const swap = index + direction;
    if (index < 0 || swap < 0 || swap >= order.length) {
      return;
    }
    [order[index], order[swap]] = [order[swap]!, order[index]!];
    const matchesBase =
      order.length === baseStatusOrder.length &&
      order.every((name, position) => name === baseStatusOrder[position]);
    onChange({ ...prefs, orderedStatuses: matchesBase ? [] : order });
  };

  const setColor = (
    field: 'statusColors' | 'issueTypeColors',
    key: string,
    color: string | undefined
  ) => {
    const next = { ...(prefs[field] ?? {}) };
    if (color) {
      next[key] = color;
    } else {
      delete next[key];
    }
    onChange({ ...prefs, [field]: next });
  };

  const colorRow = (
    field: 'statusColors' | 'issueTypeColors',
    key: string,
    testId: string
  ) => {
    const saved = prefs[field]?.[key];
    return (
      <div className="board-prefs-color-row" key={key} data-testid={testId}>
        <span
          className="board-prefs-color-dot"
          style={{ background: saved ?? 'var(--border)' }}
        />
        <span className="board-prefs-color-name">{key}</span>
        <input
          type="color"
          value={saved ?? UNSET_COLOR}
          aria-label={`Color for ${key}`}
          onChange={event => setColor(field, key, event.target.value)}
        />
        {saved && (
          <button
            type="button"
            className="chip"
            data-testid={`${testId}-clear`}
            title="Reset to the default color"
            onClick={() => setColor(field, key, undefined)}
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="filter-menu-wrap board-prefs-wrap" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn icon-btn-sm"
        data-testid="board-settings-btn"
        title="Board settings"
        aria-label="Board settings"
        aria-expanded={isOpen}
        onClick={() => setOpen(!isOpen)}
      >
        <Icon name="gear" size={14} />
      </button>
      {isOpen && (
        <div className="filter-menu-pop board-prefs-menu" data-testid="board-settings-menu">
          <div className="board-prefs-section">
            <div className="board-prefs-heading">Layout</div>
            <div className="board-prefs-row">
              <button
                type="button"
                className={`chip${prefs.viewMode !== 'list' ? ' filter-active' : ''}`}
                data-testid="board-prefs-view-board"
                onClick={() => onChange({ ...prefs, viewMode: 'board' })}
              >
                <Icon name="columns" size={11} />
                Board
              </button>
              <button
                type="button"
                className={`chip${prefs.viewMode === 'list' ? ' filter-active' : ''}`}
                data-testid="board-prefs-view-list"
                onClick={() => onChange({ ...prefs, viewMode: 'list' })}
              >
                <Icon name="list" size={11} />
                List
              </button>
            </div>
            {prefs.viewMode !== 'list' && (
              <label className="board-prefs-field">
                <span>Swim lanes</span>
                <ChipSelect
                  block
                  ariaLabel="Swim lanes"
                  data-testid="board-prefs-swimlane"
                  value={prefs.swimLaneGroupBy ?? 'none'}
                  onChange={value =>
                    onChange({
                      ...prefs,
                      swimLaneGroupBy: value as BoardColumnPreferences['swimLaneGroupBy']
                    })
                  }
                  options={[
                    { value: 'none', label: 'None' },
                    { value: 'assignee', label: 'By assignee' },
                    { value: 'epic', label: 'By epic' }
                  ]}
                />
              </label>
            )}
            <label className="board-prefs-field">
              <span>Hide issues older than</span>
              <ChipSelect
                block
                ariaLabel="Hide issues older than"
                data-testid="board-prefs-max-age"
                value={String(prefs.maxAgeWeeks ?? 0)}
                onChange={value => onChange({ ...prefs, maxAgeWeeks: Number(value) || undefined })}
                options={MAX_AGE_OPTIONS.map(option => ({ value: String(option.value), label: option.label }))}
              />
            </label>
          </div>

          <div className="board-prefs-section">
            <div className="board-prefs-heading">Appearance</div>
            <div className="board-prefs-row">
              <button
                type="button"
                className={`chip${prefs.plainSurface ? ' filter-active' : ''}`}
                data-testid="board-prefs-plain-surface"
                title="Hide the theme's surface texture behind this board when it hurts readability. The colour theme still applies."
                onClick={() => onChange({ ...prefs, plainSurface: prefs.plainSurface ? undefined : true })}
              >
                <Icon name="theme" size={11} />
                Plain background
              </button>
            </div>
          </div>

          <div className="board-prefs-section">
            <div className="board-prefs-heading">Columns</div>
            {statusOrder.map((status, index) => (
              <div className="board-prefs-column-row" key={status} data-testid="board-prefs-column-row">
                <label className="board-prefs-column-toggle">
                  <input
                    type="checkbox"
                    data-testid="board-prefs-column-toggle"
                    checked={isVisible(status)}
                    onChange={() => toggleStatus(status)}
                  />
                  <span>{status}</span>
                </label>
                <button
                  type="button"
                  className="chip"
                  data-testid="board-prefs-column-up"
                  title="Move column earlier"
                  disabled={index === 0}
                  onClick={() => moveStatus(status, -1)}
                >
                  <Icon name="chevron-up" size={11} />
                </button>
                <button
                  type="button"
                  className="chip"
                  data-testid="board-prefs-column-down"
                  title="Move column later"
                  disabled={index === statusOrder.length - 1}
                  onClick={() => moveStatus(status, 1)}
                >
                  <Icon name="chevron-down" size={11} />
                </button>
              </div>
            ))}
          </div>

          <div className="board-prefs-section">
            <div className="board-prefs-heading">Status colors</div>
            {statusOrder.map(status => colorRow('statusColors', status, 'board-prefs-status-color'))}
          </div>

          {issueTypeOptions.length > 0 && (
            <div className="board-prefs-section">
              <div className="board-prefs-heading">Issue type colors</div>
              {issueTypeOptions.map(type => colorRow('issueTypeColors', type, 'board-prefs-type-color'))}
            </div>
          )}

          <div className="board-prefs-section">
            <button
              type="button"
              className="chip"
              data-testid="board-prefs-reset"
              onClick={() => onChange({ ...DEFAULT_BOARD_PREFS, workflowStatuses: [], orderedStatuses: [] })}
            >
              <Icon name="close" size={11} />
              Reset board preferences
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
