/**
 * The frame every gadget renders inside.
 *
 * The frame owns what is common to all of them and must not be left to each
 * renderer to remember: the "this is Praxis, not the model" attribution, the
 * reason a gadget is inert, the redaction notice, the crash boundary, and the
 * live region the host's answer lands in. A renderer only draws its own body.
 */
import type { AnyGadgetEnvelope, ChatBlock, GadgetActionResult, GadgetActionValue } from '@praxis/core';
import { Icon } from '../../ui/Icon';
import { Markdown } from '../../ui/Markdown';
import { describeInertState, isGadgetActionable } from './gadgetContract';
import { GadgetErrorBoundary, GadgetFallback, resolveGadgetRenderer } from './registry';

export interface GadgetSurfaceProps {
  gadget: AnyGadgetEnvelope;
  busy?: boolean;
  result?: GadgetActionResult;
  onSubmit: (gadgetId: string, actionId: string, value: GadgetActionValue) => void;
}

export function GadgetSurface({ gadget, busy = false, result, onSubmit }: GadgetSurfaceProps) {
  const Renderer = resolveGadgetRenderer(gadget.kind, gadget.version);
  const inert = describeInertState(gadget.state);
  const actionable = isGadgetActionable(gadget.state) && !busy;

  if (!Renderer) {
    // Unknown kind, or a version older than anything registered. The decision
    // is still readable and answerable in the composer.
    return (
      <GadgetFallback
        testId="gadget-unsupported"
        text={gadget.fallbackText}
        detail={`This version of Praxis has no “${gadget.kind}” surface, so it is shown as text.`}
      />
    );
  }

  return (
    <section
      className={`gadget gadget-${gadget.kind}${actionable ? '' : ' is-inert'}`}
      data-testid={`gadget-${gadget.kind}`}
      data-gadget-id={gadget.gadgetId}
      data-gadget-state={gadget.state ?? 'active'}
      aria-busy={busy || undefined}
    >
      <div className="gadget-kicker">
        <Icon name="sparkles" size={12} />
        <span>Praxis</span>
        {gadget.redacted && (
          <span className="gadget-redaction-flag" title="A value that looked like a credential was masked before this was shown.">
            <Icon name="shield" size={11} />
            secrets masked
          </span>
        )}
      </div>

      <GadgetErrorBoundary gadget={gadget}>
        <Renderer
          gadget={gadget}
          actionable={actionable}
          busy={busy}
          result={result}
          onSubmit={(actionId, value) => onSubmit(gadget.gadgetId, actionId, value)}
        />
      </GadgetErrorBoundary>

      {inert && (
        <p className="gadget-inert-note" data-testid="gadget-inert-note">
          <Icon name="info" size={12} />
          {inert}
        </p>
      )}

      {/* The host's answer. `status` rather than `alert` so a screen reader
          announces it without interrupting whatever the user is doing. */}
      {result?.message && result.status !== 'rejected' && result.status !== 'failed' && (
        <p className="gadget-result" role="status" data-testid="gadget-result">
          <Icon name="check" size={12} />
          {result.message}
        </p>
      )}

      {/* A refusal *is* interrupting — the user's action did not happen and
          they need to know before they move on. */}
      {(result?.status === 'rejected' || result?.status === 'failed') && result.error && (
        <p className="gadget-error" role="alert" data-testid="gadget-error">
          <Icon name="warning" size={12} />
          {result.error.message}
        </p>
      )}
    </section>
  );
}

export interface GadgetBlockListProps {
  blocks: readonly ChatBlock[];
  busyGadgetId?: string;
  results?: Record<string, GadgetActionResult>;
  onSubmit: (gadgetId: string, actionId: string, value: GadgetActionValue) => void;
}

/** Render a response's blocks in order — markdown and gadgets interleaved. */
export function GadgetBlockList({ blocks, busyGadgetId, results, onSubmit }: GadgetBlockListProps) {
  if (blocks.length === 0) return null;
  return (
    <div className="gadget-block-list" data-testid="gadget-block-list">
      {blocks.map(block => {
        if (block.type === 'markdown') {
          return <Markdown key={block.blockId} text={block.markdown} testId="gadget-markdown" />;
        }
        if (block.type === 'fallback') {
          return (
            <GadgetFallback
              key={block.blockId}
              testId="gadget-block-fallback"
              text={block.text}
              // When the producer supplied no fallback text, the host uses the
              // refusal message as the body — repeating it underneath would
              // print the same sentence twice.
              detail={block.reason?.message === block.text ? undefined : block.reason?.message}
            />
          );
        }
        return (
          <GadgetSurface
            key={block.blockId}
            gadget={block.gadget}
            busy={busyGadgetId === block.gadget.gadgetId}
            result={results?.[block.gadget.gadgetId]}
            onSubmit={onSubmit}
          />
        );
      })}
    </div>
  );
}
