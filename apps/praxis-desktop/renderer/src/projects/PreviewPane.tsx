import { useEffect, useRef } from 'react';
import { Icon } from '../ui/Icon';

/**
 * The visible half of the Run preview surface (FX-BE-055 / TASK-146) — same
 * placeholder-rectangle-reporting pattern as `BrowserPane`, but passive: no
 * navigation controls, no editable URL. It opens exactly the one granted
 * `url` it's given and shows nothing else; closing it (unmount) only ever
 * hides the native view (`preview.setVisible(false)`), never stops the
 * service it was looking at.
 */
export function PreviewPane({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.praxis.preview.attach();
    void window.praxis.preview.setVisible(true);
    void window.praxis.preview.open(url).catch(() => undefined);

    const pushBounds = () => {
      const el = surfaceRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      void window.praxis.preview.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
    };
    pushBounds();
    const ro = new ResizeObserver(pushBounds);
    if (surfaceRef.current) ro.observe(surfaceRef.current);
    window.addEventListener('resize', pushBounds);
    const poll = window.setInterval(pushBounds, 250);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', pushBounds);
      window.clearInterval(poll);
      void window.praxis.preview.setVisible(false);
    };
    // Re-runs only when the granted URL itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return (
    <div className="run-preview-pane" data-testid="run-preview-pane">
      <div className="run-preview-toolbar">
        <Icon name="globe" size={13} />
        <span className="run-preview-title">{title}</span>
        <span className="placeholder-text">{url}</span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-icon" type="button" aria-label="Close preview" onClick={onClose} data-testid="run-preview-close">
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="run-preview-surface" ref={surfaceRef} data-testid="run-preview-surface" />
    </div>
  );
}
