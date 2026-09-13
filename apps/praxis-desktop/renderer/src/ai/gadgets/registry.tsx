/**
 * Version-aware gadget renderer registry (TASK-279).
 *
 * Browser-safe by construction: nothing here imports Electron, Node or a value
 * from `@praxis/core`. A renderer is registered per `(kind, version)` so two
 * contract versions can coexist while clients catch up, and *any* gap — an
 * unknown kind, a version nobody registered, a renderer that throws — resolves
 * to the same readable text fallback rather than an empty space in the chat.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { AnyGadgetEnvelope, GadgetKind } from '@praxis/core';
import type { GadgetRenderer, GadgetRendererProps } from './gadgetContract';

const renderers = new Map<string, GadgetRenderer>();

function key(kind: string, version: number): string {
  return `${kind}@${version}`;
}

export function registerGadgetRenderer(kind: GadgetKind, version: number, renderer: GadgetRenderer): void {
  renderers.set(key(kind, version), renderer);
}

/**
 * Find a renderer for this envelope.
 *
 * An exact `(kind, version)` match wins. Failing that we fall back to the
 * highest registered version *below* the requested one: a v2 envelope is a
 * superset of v1 by contract, so a v1 renderer draws it correctly minus the new
 * parts — visibly degraded beats nothing at all. We never render *up*, because
 * a newer renderer may require fields an older envelope simply does not carry.
 */
export function resolveGadgetRenderer(kind: string, version: number): GadgetRenderer | undefined {
  const exact = renderers.get(key(kind, version));
  if (exact) return exact;

  let best: { version: number; renderer: GadgetRenderer } | undefined;
  for (const [registered, renderer] of renderers) {
    const separator = registered.lastIndexOf('@');
    if (registered.slice(0, separator) !== kind) continue;
    const candidate = Number(registered.slice(separator + 1));
    if (candidate > version) continue;
    if (!best || candidate > best.version) best = { version: candidate, renderer };
  }
  return best?.renderer;
}

/** Test seam — the registry is module-level singleton state. */
export function clearGadgetRenderers(): void {
  renderers.clear();
}

export function registeredGadgetKinds(): string[] {
  return [...new Set([...renderers.keys()].map(entry => entry.slice(0, entry.lastIndexOf('@'))))];
}

/**
 * Plain-text presentation of a gadget the app cannot draw.
 *
 * This is not an error state in the user's eyes — the decision is still
 * readable and they can answer in the composer — so it is styled as a quiet
 * note rather than a failure banner.
 */
export function GadgetFallback({ text, detail, testId }: { text: string; detail?: string; testId?: string }) {
  return (
    <section className="gadget-fallback" data-testid={testId ?? 'gadget-fallback'}>
      <pre className="gadget-fallback-text">{text}</pre>
      {detail && <p className="gadget-fallback-detail">{detail}</p>}
    </section>
  );
}

interface BoundaryProps {
  gadget: AnyGadgetEnvelope;
  children: ReactNode;
}

/**
 * Contain a renderer crash to its own gadget.
 *
 * Without this, one malformed payload that slipped past validation takes down
 * the whole Sessions page — the transcript, the composer and every other
 * gadget with it. The fallback text is always available on the envelope, so
 * the decision itself survives the crash.
 */
export class GadgetErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  public state = { failed: false };

  public static getDerivedStateFromError() {
    return { failed: true };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaced in the renderer console and the app's log pane; a gadget that
    // cannot draw is a real defect even though the user has a way forward.
    console.error(`[gadget] renderer for "${this.props.gadget.kind}" threw`, error, info.componentStack);
  }

  public render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <GadgetFallback
        testId="gadget-renderer-error"
        text={this.props.gadget.fallbackText}
        detail="This interactive surface could not be displayed, so it is shown as text."
      />
    );
  }
}

/** Props a caller passes to render one gadget, minus what the shell supplies. */
export type GadgetSurfaceProps = GadgetRendererProps;
