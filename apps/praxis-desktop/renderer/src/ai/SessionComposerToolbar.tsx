import { Children, Fragment, isValidElement, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ComposerPresentationContext } from '../ui/composerPresentation';
import { Icon } from '../ui/Icon';
import { useAmbientControls } from './AmbientComposerControls';

/** Shared toolbar shell for draft and active-session composers. */
export function SessionComposerToolbar({ children }: { children: ReactNode }) {
  const style = useContext(ComposerPresentationContext);
  if (style === 'ambient-canvas') return <AmbientToolbar>{children}</AmbientToolbar>;
  return <div className="composer-controls" data-composer-part="controls" data-composer-slot="toolbar">{children}</div>;
}

function flatten(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap(child => isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
    ? flatten(child.props.children) : [child]);
}

function AmbientToolbar({ children }: { children: ReactNode }) {
  const { target, setTarget } = useAmbientControls();
  const row = useRef<HTMLDivElement>(null);
  const runtime = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const keyboardOpen = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const [overflow, setOverflow] = useState(false);
  const [open, setOpen] = useState(false);
  const primary: ReactNode[] = [], secondary: ReactNode[] = [], sends: ReactNode[] = [];
  for (const child of flatten(children)) {
    const props = isValidElement<{ className?: string; 'data-testid'?: string }>(child) ? child.props : undefined;
    if (props?.className?.split(' ').includes('spacer')) continue;
    if (props?.className?.includes('composer-send')) sends.push(child);
    else if (props?.className?.includes('session-provider-chip') || props?.className?.includes('session-model-chip')) primary.push(child);
    else secondary.push(child);
  }
  useLayoutEffect(() => {
    if (!target || !row.current) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const widths = (element: Element): number[] => [...element.children].flatMap(child => {
          const style = getComputedStyle(child);
          return style.display === 'none' ? [] : style.display === 'contents' ? widths(child) : [child.getBoundingClientRect().width];
        });
        const items = widths(target);
        const scope = row.current!.closest('[data-composer-part="scope"]')!;
        row.current!.style.setProperty('--ambient-menu-offset', `${row.current!.getBoundingClientRect().top - scope.getBoundingClientRect().top + 8}px`);
        const extraWidth = items.reduce((sum, width) => sum + width, 0) + Math.max(0, items.length - 1) * 6;
        const required = extraWidth + (runtime.current?.scrollWidth ?? 0) + (actions.current?.scrollWidth ?? 0) + 24;
        setOverflow(items.length > 0 && required > row.current!.clientWidth);
      });
    };
    const resize = new ResizeObserver(measure);
    resize.observe(row.current); resize.observe(target);
    const changes = new MutationObserver(measure);
    changes.observe(target, { childList: true, subtree: true, characterData: true });
    measure();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); changes.disconnect(); };
  }, [target, children]);
  useLayoutEffect(() => () => clearTimeout(closeTimer.current), []);
  return <div ref={row} className="composer-controls ambient-toolbar" data-composer-part="controls" data-composer-slot="toolbar"
    data-overflow={overflow} data-expanded={overflow && open}
    onMouseEnter={() => { clearTimeout(closeTimer.current); setOpen(true); }}
    onMouseLeave={() => { if (!keyboardOpen.current) closeTimer.current = setTimeout(() => setOpen(false), 180); }}
    onPointerDown={() => { keyboardOpen.current = false; }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { keyboardOpen.current = false; setOpen(false); } }}
    onKeyDown={event => { if (event.key === 'Escape') { keyboardOpen.current = false; setOpen(false); } }}>
    <div ref={runtime} className="ambient-runtime-controls">{primary}</div>
    <button type="button" className="icon-btn ambient-more-controls" aria-label="More composer controls" title="More composer controls"
      aria-expanded={overflow && open} hidden={!overflow} onFocus={event => { keyboardOpen.current = event.currentTarget.matches(':focus-visible'); setOpen(true); }} onClick={() => { keyboardOpen.current = true; setOpen(true); }}>
      <Icon name="ellipsis" size={14} />
    </button>
    <div ref={setTarget} className="ambient-toolbar-extras" role={overflow ? 'group' : undefined} aria-label={overflow ? 'More composer controls' : undefined}>
      {secondary}
    </div>
    <div ref={actions} className="ambient-send-controls">{sends}</div>
  </div>;
}
