import { useEffect, useRef, useState } from 'react';
import type { BrowserDiagnosticsBundle } from '@praxis/core';
import { Icon } from '../ui/Icon';

/**
 * The visible half of the Run preview surface (FX-BE-055/056 / TASK-146/147)
 * — same placeholder-rectangle-reporting pattern as `BrowserPane`, but
 * passive: no navigation controls, no editable URL. It opens exactly the
 * one granted `url` it's given and shows nothing else; closing it (unmount)
 * only ever hides the native view (`preview.setVisible(false)`), never
 * stops the service it was looking at.
 *
 * "Capture diagnostics" screenshots the current page and folds it together
 * with whatever console/network evidence has accumulated since `open()`
 * into a persisted bundle — the summary line here is a thin proof the round
 * trip works, not a diagnostics viewer; reading a bundle back is TASK-148's
 * "expose diagnostics to agents" territory.
 */
export function PreviewPane({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState<BrowserDiagnosticsBundle | undefined>();
  const [captureError, setCaptureError] = useState<string | undefined>();

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
    setCaptured(undefined);
    setCaptureError(undefined);
    // Re-runs only when the granted URL itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const captureDiagnostics = async () => {
    setCapturing(true);
    setCaptureError(undefined);
    try {
      const bundle = await window.praxis.preview.captureDiagnostics();
      setCaptured(bundle);
      if (!bundle) setCaptureError('Nothing to capture — the preview has no active grant.');
    } catch (reason) {
      setCaptureError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div className="run-preview-pane" data-testid="run-preview-pane">
      <div className="run-preview-toolbar">
        <Icon name="globe" size={13} />
        <span className="run-preview-title">{title}</span>
        <span className="placeholder-text">{url}</span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-compact" type="button" disabled={capturing} onClick={() => void captureDiagnostics()} data-testid="run-preview-capture">
          {capturing ? 'Capturing…' : 'Capture diagnostics'}
        </button>
        <button className="btn btn-icon" type="button" aria-label="Close preview" onClick={onClose} data-testid="run-preview-close">
          <Icon name="close" size={13} />
        </button>
      </div>
      {captureError && <div className="error-banner" data-testid="run-preview-capture-error">{captureError}</div>}
      {captured && (
        <div className="run-preview-capture-summary" data-testid="run-preview-capture-summary">
          Captured {captured.console.length} console line{captured.console.length === 1 ? '' : 's'}, {captured.network.length} failed
          request{captured.network.length === 1 ? '' : 's'}
          {captured.screenshots.some(shot => shot.presence === 'present') ? ', and a screenshot.' : '; no screenshot.'}
        </div>
      )}
      <div className="run-preview-surface" ref={surfaceRef} data-testid="run-preview-surface" />
    </div>
  );
}
