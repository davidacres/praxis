import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

/**
 * A short, non-blocking walkthrough of the shell.
 *
 * It annotates the user's *real* first project rather than seeding a demo one:
 * each stop rings a control that already exists and says what it does. Kept
 * deliberately small — a handful of stops, skippable at every one, and the
 * highlighted control stays clickable, because a tour that traps the user is
 * worse than no tour.
 *
 * A stop whose target is not on screen is skipped rather than shown empty, so
 * the tour degrades instead of breaking when a surface is absent.
 */

export interface WalkthroughStop {
  id: string;
  /** CSS selector for the control to ring. First match wins. */
  selector: string;
  title: string;
  body: string;
}

interface Rect { top: number; left: number; width: number; height: number }

const GAP = 12;
const CALLOUT_WIDTH = 304;

function readRect(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return { top: box.top, left: box.left, width: box.width, height: box.height };
}

export function Walkthrough({ stops, onDone }: { stops: WalkthroughStop[]; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect>();

  /** The stops whose targets are actually present, resolved once per index move. */
  const resolve = useCallback((from: number): { at: number; element: Element } | undefined => {
    for (let i = from; i < stops.length; i += 1) {
      const element = document.querySelector(stops[i].selector);
      if (element) return { at: i, element };
    }
    return undefined;
  }, [stops]);

  useLayoutEffect(() => {
    const found = resolve(index);
    if (!found) {
      onDone();
      return;
    }
    if (found.at !== index) {
      setIndex(found.at);
      return;
    }
    found.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    setRect(readRect(found.element));

    const sync = () => {
      const current = document.querySelector(stops[found.at].selector);
      if (current) setRect(readRect(current));
    };
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
    };
  }, [index, onDone, resolve, stops]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDone();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onDone]);

  const stop = stops[index];
  if (!stop || !rect) return null;

  const isLast = resolve(index + 1) === undefined;
  // Prefer below the target; flip above when there is no room.
  const below = rect.top + rect.height + GAP;
  const placeAbove = below + 150 > window.innerHeight;
  const calloutTop = placeAbove ? Math.max(GAP, rect.top - GAP - 150) : below;
  const calloutLeft = Math.min(
    Math.max(GAP, rect.left + rect.width / 2 - CALLOUT_WIDTH / 2),
    Math.max(GAP, window.innerWidth - CALLOUT_WIDTH - GAP)
  );

  return (
    <>
      <div
        className="walkthrough-ring"
        aria-hidden="true"
        style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
      />
      <div
        className="walkthrough-callout"
        role="dialog"
        aria-live="polite"
        aria-label={`Walkthrough: ${stop.title}`}
        data-testid="walkthrough-callout"
        style={{ top: calloutTop, left: calloutLeft, width: CALLOUT_WIDTH }}
      >
        <span className="walkthrough-step">Step {index + 1}</span>
        <strong>{stop.title}</strong>
        <p>{stop.body}</p>
        <div className="walkthrough-actions">
          <button type="button" className="btn-quiet" data-testid="walkthrough-skip" onClick={onDone}>
            {isLast ? 'Close' : 'Skip tour'}
          </button>
          {!isLast && (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="walkthrough-next"
              onClick={() => setIndex(current => current + 1)}
            >
              Next
            </button>
          )}
          {isLast && (
            <button type="button" className="btn btn-primary" data-testid="walkthrough-done" onClick={onDone}>
              Got it
            </button>
          )}
        </div>
      </div>
    </>
  );
}
