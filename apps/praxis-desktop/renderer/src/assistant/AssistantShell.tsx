import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Icon } from '../ui/Icon';
import { useResizable } from '../app/useResizable';
import { AssistantPanel } from './AssistantPanel';
import { useAssistant } from './AssistantProvider';

/** Counts up each time the assistant opens so the composer grabs focus. */
function useOpenFocusSignal(open: boolean): number {
  const [signal, setSignal] = useState(0);
  useEffect(() => { if (open) setSignal(current => current + 1); }, [open]);
  return signal;
}

/**
 * Floating mode: a bottom-right popover plus a launcher. The launcher stays while the
 * panel is closed; docked mode (see `AssistantDock`) owns the layout instead.
 */
export function AssistantFloating() {
  const { open, docked, toggle, setOpen } = useAssistant();
  const focusSignal = useOpenFocusSignal(open && !docked);
  const showPanel = open && !docked;
  const [bounds, setBounds] = useState(() => {
    const width = Math.min(640, window.innerWidth - 32);
    const height = Math.min(600, window.innerHeight - 130);
    return { x: window.innerWidth - width - 16, y: window.innerHeight - height - 62, width, height };
  });
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  useEffect(() => {
    const keepInView = () => setBounds(current => ({
      ...current,
      width: Math.min(current.width, window.innerWidth - 32),
      height: Math.min(current.height, window.innerHeight - 80),
      x: Math.max(16, Math.min(current.x, window.innerWidth - Math.min(current.width, window.innerWidth - 32) - 16)),
      y: Math.max(16, Math.min(current.y, window.innerHeight - Math.min(current.height, window.innerHeight - 80) - 16))
    }));
    window.addEventListener('resize', keepInView);
    return () => window.removeEventListener('resize', keepInView);
  }, []);

  const startPointerAction = (event: PointerEvent<HTMLDivElement>, action: 'move' | 'resize') => {
    if (event.button !== 0) return;
    if (action === 'move') {
      const target = event.target as HTMLElement;
      if (!target.closest('.assistant-header') || target.closest('button, input, select, textarea, a')) return;
    }
    event.preventDefault();
    const origin = { ...boundsRef.current, pointerX: event.clientX, pointerY: event.clientY };
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const onMove = (move: globalThis.PointerEvent) => {
      const dx = move.clientX - origin.pointerX;
      const dy = move.clientY - origin.pointerY;
      if (action === 'move') {
        setBounds(current => ({ ...current,
          x: Math.max(16, Math.min(origin.x + dx, window.innerWidth - current.width - 16)),
          y: Math.max(16, Math.min(origin.y + dy, window.innerHeight - current.height - 16))
        }));
      } else {
        const width = Math.max(Math.min(520, window.innerWidth - 32), Math.min(origin.width - dx, origin.x + origin.width - 16));
        setBounds(current => ({ ...current,
          x: origin.x + origin.width - width,
          width,
          height: Math.max(Math.min(320, window.innerHeight - origin.y - 16), Math.min(origin.height + dy, window.innerHeight - origin.y - 16))
        }));
      }
    };
    const onEnd = () => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  };
  return (
    <div className="assistant-floating-root">
      {showPanel && (
        <div
          className="assistant-floating"
          data-testid="assistant-floating"
          style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
          onPointerDown={event => startPointerAction(event, 'move')}
          onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}
        >
          <AssistantPanel focusSignal={focusSignal} />
          <div className="assistant-floating-resize" data-testid="assistant-floating-resize" role="separator" aria-label="Resize floating assistant" aria-orientation="vertical" tabIndex={0}
            onPointerDown={event => { event.stopPropagation(); startPointerAction(event, 'resize'); }}
            onKeyDown={event => {
              const step = event.shiftKey ? 40 : 10;
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                setBounds(current => ({ ...current,
                  x: event.key === 'ArrowRight' ? Math.max(16, current.x - step) : current.x,
                  width: event.key === 'ArrowRight' ? Math.min(current.width + step, current.x + current.width - 16) : current.width,
                  height: event.key === 'ArrowDown' ? Math.min(current.height + step, window.innerHeight - current.y - 16) : current.height
                }));
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                setBounds(current => ({ ...current,
                  x: event.key === 'ArrowLeft' ? current.x + Math.min(step, current.width - Math.min(520, window.innerWidth - 32)) : current.x,
                  width: event.key === 'ArrowLeft' ? Math.max(Math.min(520, window.innerWidth - 32), current.width - step) : current.width,
                  height: event.key === 'ArrowUp' ? Math.max(320, current.height - step) : current.height
                }));
              }
            }}
          />
        </div>
      )}
      {!(open && docked) && (
        <button
          type="button"
          className={`assistant-launcher${showPanel ? ' is-open' : ''}`}
          aria-label={showPanel ? 'Close virtual team assistant' : 'Open virtual team assistant'}
          aria-expanded={showPanel}
          data-testid="assistant-launcher"
          onClick={toggle}
        >
          <Icon name="sparkles" size={16} />
        </button>
      )}
    </div>
  );
}

/** Docked mode: a resizable column beside the workspace card, inside the pane row. */
export function AssistantDock() {
  const { open, docked } = useAssistant();
  const resize = useResizable({ storageKey: 'tm-assistant-width', initial: 600, min: 520, max: 760, side: 'right' });
  const focusSignal = useOpenFocusSignal(open && docked);
  if (!(open && docked)) return null;
  return (
    <>
      <div className={`splitter${resize.dragging ? ' dragging' : ''}`} aria-label="Resize assistant" {...resize.handleProps} />
      <aside className="assistant-docked" data-testid="assistant-docked" style={{ width: resize.size }}>
        <AssistantPanel focusSignal={focusSignal} />
      </aside>
    </>
  );
}
