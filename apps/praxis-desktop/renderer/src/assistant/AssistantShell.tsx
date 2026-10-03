import { useEffect, useState } from 'react';
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
  return (
    <div className="assistant-floating-root">
      {showPanel && (
        <div
          className="assistant-floating"
          data-testid="assistant-floating"
          onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}
        >
          <AssistantPanel focusSignal={focusSignal} />
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
  const resize = useResizable({ storageKey: 'tm-assistant-width', initial: 380, min: 300, max: 640, side: 'right' });
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
