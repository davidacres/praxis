/**
 * The composer's usage line, from desktop-recorded totals only. A session's
 * snapshot (streamed live) and an explicit `sessions.usage` read carry the
 * same running totals; whichever is newer (higher host sequence) wins. Cost is
 * shown only when the provider reported one — "not reported" is never zero.
 */
import type { MobileSessionSnapshot, MobileSessionUsage } from '@praxis/core';

export interface MobileUsageView {
  state: 'loading' | 'empty' | 'ready';
  /** Model, else provider, else a placeholder. */
  subject: string;
  /** e.g. "1.2k tokens" — absent until the desktop has recorded any. */
  tokens?: string;
  /** e.g. "US$0.04", or a sentence explaining why there is none. */
  cost: string;
  costReported: boolean;
  /** Expanded rows for the detail panel. */
  details: Array<{ label: string; value: string }>;
  summary: string;
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trim(value / 1_000)}k`;
  return String(Math.round(value));
}

function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}

export function formatCost(cost: { currency: string; amount: number }): string {
  const currency = cost.currency.toUpperCase();
  const prefix = currency === 'USD' ? 'US$' : '';
  const suffix = prefix ? '' : ` ${currency}`;
  if (cost.amount > 0 && cost.amount < 0.01) return `<${prefix}0.01${suffix}`;
  return `${prefix}${cost.amount.toFixed(2)}${suffix}`;
}

type UsageSource = Pick<MobileSessionUsage, 'provider' | 'model' | 'tokenUsage' | 'contextTokens' | 'contextLimit' | 'cost' | 'sequence'> & { providerLabel?: string };

/** The newer of a streamed snapshot and a usage read. */
export function latestUsage(snapshot: MobileSessionSnapshot | undefined, read: MobileSessionUsage | undefined): UsageSource | undefined {
  if (!snapshot) return read;
  if (read && read.sequence > snapshot.sequence) return read;
  return { ...snapshot, ...(read?.providerLabel ? { providerLabel: read.providerLabel } : {}) };
}

export function describeUsage(input: {
  source: UsageSource | undefined;
  loading: boolean;
  providerLabel?: string;
  /** A draft: nothing has run yet, so there is nothing to meter. */
  draft?: boolean;
}): MobileUsageView {
  const source = input.source;
  const providerLabel = source?.providerLabel ?? input.providerLabel ?? source?.provider;
  const subject = source?.model ?? providerLabel ?? 'This session';
  if (input.draft) {
    return { state: 'empty', subject: input.providerLabel ?? 'New chat', cost: 'No usage yet', costReported: false, details: [], summary: 'Usage appears after the first reply.' };
  }
  if (!source) {
    return input.loading
      ? { state: 'loading', subject, cost: '', costReported: false, details: [], summary: 'Loading usage from the desktop…' }
      : { state: 'empty', subject, cost: '', costReported: false, details: [], summary: 'The desktop has not reported usage for this session.' };
  }
  const usage = source.tokenUsage;
  const total = usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) || undefined);
  const tokens = total !== undefined ? `${formatTokenCount(total)} tokens` : undefined;
  const costReported = Boolean(source.cost);
  const cost = source.cost ? formatCost(source.cost) : `Cost not reported${providerLabel ? ` by ${providerLabel}` : ''}`;
  const details: Array<{ label: string; value: string }> = [];
  if (providerLabel) details.push({ label: 'Provider', value: providerLabel });
  details.push({ label: 'Model', value: source.model ?? 'Provider default' });
  if (usage?.inputTokens !== undefined) details.push({ label: 'Input tokens', value: formatTokenCount(usage.inputTokens) });
  if (usage?.outputTokens !== undefined) details.push({ label: 'Output tokens', value: formatTokenCount(usage.outputTokens) });
  if (total !== undefined) details.push({ label: 'Total tokens', value: formatTokenCount(total) });
  if (source.contextTokens !== undefined) {
    details.push({
      label: 'Context',
      value: source.contextLimit ? `${formatTokenCount(source.contextTokens)} of ${formatTokenCount(source.contextLimit)}` : formatTokenCount(source.contextTokens),
    });
  }
  details.push({ label: 'Cost', value: cost });
  if (!tokens && !costReported && source.contextTokens === undefined) {
    return { state: 'empty', subject, cost, costReported, details, summary: `${subject} · no usage recorded yet` };
  }
  return { state: 'ready', subject, ...(tokens ? { tokens } : {}), cost, costReported, details, summary: [subject, tokens, costReported ? cost : 'no cost data'].filter(Boolean).join(' · ') };
}
