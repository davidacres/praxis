import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';

/**
 * A drop-down in the session composer's chip idiom: a compact chip that opens
 * the same `.composer-provider-menu` list the provider/model chips use, with a
 * filter row once the list is long enough to need one.
 *
 * Use it in place of a native `<select>` — a native list ignores the theme and
 * surface pack. The menu portals into `document.body` (fixed, from the chip's
 * rect) so a scrolling pane never clips it, and flips above the chip when there
 * is no room below.
 */
export interface ChipSelectOption {
  value: string;
  label: string;
  /** A second, muted line — e.g. a skill's description. */
  description?: string;
  /** Short trailing text such as "project" or "untrusted". */
  meta?: string;
  icon?: IconName;
  disabled?: boolean;
}

export interface ChipSelectProps {
  value: string;
  options: ChipSelectOption[];
  onChange: (value: string) => void;
  /** Accessible name of the chip; the list is announced as "<label> options". */
  ariaLabel: string;
  /** Chip text when `value` matches no option (and is empty). */
  placeholder?: string;
  icon?: IconName;
  /** Show the filter row. Defaults to on once there are more than 7 options. */
  searchable?: boolean;
  /** Offer the typed filter text as a value when no option matches it exactly. */
  allowCustom?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  'data-testid'?: string;
  /** Extra controls in the filter row (e.g. refresh). */
  searchAction?: ReactNode;
  /** Fill the width of its container, as a form field would. */
  block?: boolean;
  /** `plain` drops the frame — for a chip sitting in a composer-style toolbar. */
  variant?: 'field' | 'plain';
  id?: string;
  'aria-describedby'?: string;
}

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 320;

export function ChipSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = 'Choose…',
  icon,
  searchable,
  allowCustom = false,
  disabled = false,
  title,
  className,
  'data-testid': testId,
  searchAction,
  block = false,
  variant = 'field',
  id,
  'aria-describedby': describedBy
}: ChipSelectProps) {
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | undefined>();
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);

  const showSearch = searchable ?? (options.length > 7 || allowCustom);
  const selected = options.find(option => option.value === value);
  const chipLabel = selected?.label ?? (value || placeholder);

  const q = filter.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? options.filter(
            option =>
              option.label.toLowerCase().includes(q) ||
              option.value.toLowerCase().includes(q) ||
              (option.description?.toLowerCase().includes(q) ?? false)
          )
        : options,
    [options, q]
  );
  const customValue = allowCustom && filter.trim() && !options.some(option => option.value === filter.trim()) ? filter.trim() : undefined;
  const rows: ChipSelectOption[] = customValue
    ? [...filtered, { value: customValue, label: `Use “${customValue}”`, icon: 'pencil' }]
    : filtered;

  const close = (refocus = true) => {
    setOpen(false);
    setFilter('');
    if (refocus) chipRef.current?.focus();
  };

  const choose = (option: ChipSelectOption) => {
    if (option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close();
  };

  // Place the menu under the chip, or above it when the viewport has no room below. It
  // follows the chip when anything scrolls (a smooth-scrolling pane keeps scrolling after the
  // click that opened it), and only closes once the chip has left the viewport.
  useLayoutEffect(() => {
    if (!open || !chipRef.current) return;
    const place = () => {
      if (!chipRef.current) return;
      const rect = chipRef.current.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        close(false);
        return;
      }
      const menuHeight = Math.min(menuRef.current?.offsetHeight ?? MENU_MAX_HEIGHT, MENU_MAX_HEIGHT);
      const menuWidth = Math.max(menuRef.current?.offsetWidth ?? 220, rect.width);
      const below = window.innerHeight - rect.bottom - MENU_GAP;
      const top = below >= menuHeight || below >= rect.top ? rect.bottom + MENU_GAP : Math.max(MENU_GAP, rect.top - MENU_GAP - menuHeight);
      const left = Math.max(MENU_GAP, Math.min(rect.left, window.innerWidth - menuWidth - MENU_GAP));
      setPos({ top, left, minWidth: rect.width });
    };
    place();
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      place();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows.length]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.max(0, rows.findIndex(option => option.value === value)));
    if (!showSearch) requestAnimationFrame(() => menuRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && q) setActiveIndex(0);
  }, [open, q]);

  // Keep the highlighted option in view by scrolling the menu itself. Not scrollIntoView:
  // that also scrolls every ancestor, and before the menu is placed it sits off-screen, so
  // it would scroll the page — which the close-on-scroll listener reads as "dismiss".
  useEffect(() => {
    const menu = menuRef.current;
    if (!open || activeIndex < 0 || !menu) return;
    const option = menu.querySelectorAll<HTMLElement>('[role="option"]')[activeIndex];
    if (!option) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
  }, [open, activeIndex, pos]);

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      // Stop here so the page (a dialog, the designer) does not also act on it.
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(index => (rows.length === 0 ? -1 : (index + step + rows.length) % rows.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = rows[activeIndex];
      if (option) choose(option);
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  const listboxId = useMemo(() => `chip-select-${Math.random().toString(36).slice(2, 9)}`, []);

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        id={id}
        className={`composer-chip chip-select${variant === 'plain' ? ' chip-select--plain' : ''}${block ? ' chip-select--block' : ''}${open ? ' active' : ''}${className ? ` ${className}` : ''}`}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        data-testid={testId}
        data-value={value}
        disabled={disabled}
        title={title ?? (selected?.description ? `${chipLabel} — ${selected.description}` : chipLabel)}
        onClick={event => {
          // Inside a <label>, a click on the chip's text would be re-dispatched by the
          // label as a second click on the chip and toggle the menu straight back shut.
          event.preventDefault();
          if (open) close();
          else setOpen(true);
        }}
        onKeyDown={event => {
          // Until the menu takes focus, keys land on the chip: let them drive the open menu.
          if (open && event.key !== 'Enter' && event.key !== ' ') {
            onMenuKeyDown(event);
            return;
          }
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {(selected?.icon ?? icon) && <Icon name={(selected?.icon ?? icon)!} size={13} />}
        <span className={`chip-select-label${selected || value ? '' : ' is-placeholder'}`}>{chipLabel}</span>
        {selected?.meta && <span className="composer-chip-meta">{selected.meta}</span>}
        <Icon name="chevron-down" size={11} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            className="composer-provider-menu chip-select-menu"
            role="listbox"
            aria-label={`${ariaLabel} options`}
            tabIndex={-1}
            aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
            style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, minWidth: pos?.minWidth, visibility: pos ? undefined : 'hidden' }}
            onKeyDown={event => {
              onMenuKeyDown(event);
              // The menu is portalled but React still bubbles its events to the chip's
              // ancestors — a row that selects on click, a dialog that submits on Enter.
              event.stopPropagation();
            }}
            onClick={event => event.stopPropagation()}
            onMouseDown={event => event.stopPropagation()}
            onPointerDown={event => event.stopPropagation()}
          >
            {showSearch && (
              <div className="model-menu-search-row">
                <input
                  type="text"
                  className="input"
                  placeholder={allowCustom ? 'Filter, or type a value…' : 'Filter…'}
                  aria-label={`Filter ${ariaLabel}`}
                  value={filter}
                  onChange={event => setFilter(event.target.value)}
                  autoFocus
                />
                {searchAction}
              </div>
            )}
            {rows.length === 0 && <div className="popover-label">No matches</div>}
            {rows.map((option, index) => (
              <button
                key={`${option.value}-${index}`}
                id={`${listboxId}-${index}`}
                type="button"
                role="option"
                data-value={option.value}
                tabIndex={-1}
                aria-selected={option.value === value}
                disabled={option.disabled}
                className={`composer-provider-option chip-select-option${option.value === value ? ' active' : ''}${index === activeIndex ? ' is-focused' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
              >
                {option.icon && <Icon name={option.icon} size={13} />}
                <span className="chip-select-option-text">
                  <span className="chip-select-option-label">{option.label}</span>
                  {option.description && <span className="chip-select-option-desc">{option.description}</span>}
                </span>
                {option.meta && <small>{option.meta}</small>}
                {option.value === value && <Icon name="check" size={12} className="chip-select-check" />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
