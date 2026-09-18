import type { AiProvider } from '../types';

/** A provider-neutral account usage window. Providers may omit fields they do not expose. */
export interface ProviderUsageWindow {
  period: 'hour' | 'day' | 'week' | 'month';
  usedTokens?: number;
  tokenLimit?: number;
  usedCost?: number;
  costLimit?: number;
  currency?: string;
  resetsAt?: string;
}

export interface ProviderModelCost {
  model: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  currency: string;
}

export interface ProviderUsageSnapshot {
  provider: AiProvider;
  fetchedAt: string;
  windows: ProviderUsageWindow[];
  /** Optional prepaid/account balance. Most providers do not expose this. */
  credits?: { remaining: number; currency: string };
  modelCosts?: ProviderModelCost[];
  unavailableReason?: string;
}
