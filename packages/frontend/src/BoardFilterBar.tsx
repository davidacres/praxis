import { useEffect, useRef, useState } from 'react';
import type { AssigneeMode, IssueSummary } from '@ticket-manager/core';
import { Icon } from './Icon';

/**
 * The board's active filter state. `assigneeMode` defaults to 'all' (unlike
 * the extension's 'me') so the desktop board keeps showing every card until
 * the user narrows it.
 */
export interface BoardFilterValue {
  searchText: string;
  statuses: string[];
  issueTypes: string[];
  assigneeMode: AssigneeMode;
  parentKey: string | undefined;
}

export const EMPTY_BOARD_FILTER: BoardFilterValue = {
  searchText: '',
  statuses: [],
  issueTypes: [],
  assigneeMode: 'all',
  parentKey: undefined
};

function isFilterActive(value: BoardFilterValue): boolean {
  return (
    value.searchText.trim().length > 0 ||
    value.statuses.length > 0 ||
    value.issueTypes.length > 0 ||
    value.assigneeMode !== 'all' ||
    value.parentKey !== undefined
  );
}

interface FilterMenuProps {
  label: string;
  testId: string;
  options: string[];
  selected: string[];
  onToggle: (option: string) => void;
}

/** Chip button that opens a checkbox dropdown; toggles apply immediately. */
function FilterMenu({ label, testId, options, selected, onToggle }: FilterMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocumentClick = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [open]);

  return (
    <div className="filter-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`chip filter-menu-trigger${selected.length > 0 ? ' filter-active' : ''}`}
        data-testid={testId}
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        {label}
        {selected.length > 0 ? ` (${selected.length})` : ''}
        <Icon name="chevron-down" size={11} />
      </button>
      {open && (
        <div className="filter-menu-pop" data-testid={`${testId}-menu`}>
          {options.length === 0 && <div className="filter-menu-empty">No options available.</div>}
          {options.map(option => (
            <label key={option} className="filter-menu-option" data-testid={`${testId}-option`}>
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={() => onToggle(option)}
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export interface BoardFilterBarProps {
  value: BoardFilterValue;
  onChange: (next: BoardFilterValue) => void;
  /** Distinct statuses/types the backend reports for this board's scope. */
  statusOptions: string[];
  issueTypeOptions: string[];
  /** Candidate parents (Features/Epics); the parent select hides when empty. */
  parentOptions: IssueSummary[];
  /** Loaded vs. total matching issues, for the "x of y" readout. */
  shown: number;
  total: number | undefined;
}

export function BoardFilterBar({
  value,
  onChange,
  statusOptions,
  issueTypeOptions,
  parentOptions,
  shown,
  total
}: BoardFilterBarProps) {
  // The search box is debounced so each keystroke doesn't fire a backend query;
  // everything else (checkboxes, selects) applies immediately.
  const [searchDraft, setSearchDraft] = useState(value.searchText);

  useEffect(() => {
    setSearchDraft(value.searchText);
  }, [value.searchText]);

  useEffect(() => {
    if (searchDraft === value.searchText) {
      return;
    }
    const timer = setTimeout(() => onChange({ ...value, searchText: searchDraft }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  const toggle = (list: string[], option: string) =>
    list.includes(option) ? list.filter(entry => entry !== option) : [...list, option];

  return (
    <div className="board-filter-bar" data-testid="board-filter-bar">
      <div className="board-filter-search">
        <Icon name="search" size={13} />
        <input
          className="input"
          type="search"
          data-testid="board-filter-search-input"
          placeholder="Search issues…"
          value={searchDraft}
          onChange={event => setSearchDraft(event.target.value)}
        />
      </div>

      <FilterMenu
        label="Status"
        testId="board-filter-status"
        options={statusOptions}
        selected={value.statuses}
        onToggle={option => onChange({ ...value, statuses: toggle(value.statuses, option) })}
      />
      <FilterMenu
        label="Type"
        testId="board-filter-type"
        options={issueTypeOptions}
        selected={value.issueTypes}
        onToggle={option => onChange({ ...value, issueTypes: toggle(value.issueTypes, option) })}
      />

      <select
        className="select"
        data-testid="board-filter-assignee"
        aria-label="Assignee filter"
        value={value.assigneeMode}
        onChange={event =>
          onChange({ ...value, assigneeMode: event.target.value as AssigneeMode })
        }
      >
        <option value="all">All assignees</option>
        <option value="me">Assigned to me</option>
      </select>

      {parentOptions.length > 0 && (
        <select
          className="select"
          data-testid="board-filter-parent"
          aria-label="Parent filter"
          value={value.parentKey ?? ''}
          onChange={event =>
            onChange({ ...value, parentKey: event.target.value || undefined })
          }
        >
          <option value="">All parents</option>
          {parentOptions.map(parent => (
            <option key={parent.key} value={parent.key}>
              {parent.key} — {parent.summary}
            </option>
          ))}
        </select>
      )}

      {isFilterActive(value) && (
        <button
          type="button"
          className="chip"
          data-testid="board-filter-clear"
          onClick={() => onChange(EMPTY_BOARD_FILTER)}
        >
          <Icon name="close" size={11} />
          Clear
        </button>
      )}

      <span className="spacer" />
      {total !== undefined && (
        <span className="board-filter-count" data-testid="board-filter-count">
          {shown === total
            ? `${total} ${total === 1 ? 'item' : 'items'}`
            : `${shown} of ${total} items`}
        </span>
      )}
    </div>
  );
}
