import { useCallback, useEffect, useRef, useState } from 'react';

export interface ResizableOptions {
  /** localStorage key so the pane width survives a restart. */
  storageKey: string;
  initial: number;
  min: number;
  max: number;
  /**
   * Which edge the pane is docked to. 'left' grows as the pointer moves right,
   * 'right' as it moves left, and 'bottom' as it moves up — so the splitter
   * always tracks the pointer rather than mirroring it.
   */
  side: 'left' | 'right' | 'bottom';
}

export interface Resizable {
  /** Width for a side pane, height for a bottom pane. */
  size: number;
  dragging: boolean;
  /** Spread onto the splitter element. */
  handleProps: {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    role: 'separator';
    'aria-orientation': 'vertical' | 'horizontal';
    tabIndex: number;
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStored(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Pointer-driven pane resizing. Pointer capture means the drag keeps tracking
 * even when the cursor outruns the 5px handle, and keyboard arrows give the
 * splitter a non-mouse path since it is exposed as a `separator`.
 */
export function useResizable({ storageKey, initial, min, max, side }: ResizableOptions): Resizable {
  const [size, setSize] = useState(() => clamp(readStored(storageKey, initial), min, max));
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ pointer: 0, size: 0 });
  const vertical = side === 'bottom';

  useEffect(() => {
    localStorage.setItem(storageKey, String(size));
  }, [storageKey, size]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      origin.current = { pointer: vertical ? event.clientY : event.clientX, size };
      setDragging(true);

      const target = event.currentTarget;

      const onMove = (move: PointerEvent) => {
        const delta = (vertical ? move.clientY : move.clientX) - origin.current.pointer;
        const next = side === 'left' ? origin.current.size + delta : origin.current.size - delta;
        setSize(clamp(next, min, max));
      };

      const onUp = () => {
        setDragging(false);
        target.releasePointerCapture(event.pointerId);
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
      };

      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
    },
    [max, min, side, size, vertical]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 40 : 10;
      const grow = side === 'left' ? 'ArrowRight' : vertical ? 'ArrowUp' : 'ArrowLeft';
      const shrink = side === 'left' ? 'ArrowLeft' : vertical ? 'ArrowDown' : 'ArrowRight';
      if (event.key === grow) {
        event.preventDefault();
        setSize(current => clamp(current + step, min, max));
      } else if (event.key === shrink) {
        event.preventDefault();
        setSize(current => clamp(current - step, min, max));
      }
    },
    [max, min, side, vertical]
  );

  return {
    size,
    dragging,
    handleProps: {
      onPointerDown,
      onKeyDown,
      role: 'separator',
      // A splitter that moves along X separates panes stacked horizontally, so
      // its own orientation is the perpendicular one.
      'aria-orientation': vertical ? 'horizontal' : 'vertical',
      tabIndex: 0
    }
  };
}
