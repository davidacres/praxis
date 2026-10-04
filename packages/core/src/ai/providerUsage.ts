import type { AiProvider } from '../types';

/** A provider-neutral account usage window. Providers may omit fields they do not expose. */
export interface ProviderUsageWindow {
  period: 'hour' | 'day' | 'week' | 'month';
  /** Provider-reported rolling window length (for example Codex's 5 hours). */
  windowDurationMinutes?: number;
  /** Percentage consumed when the provider reports a quota rather than tokens. */
  usedPercent?: number;
  label?: string;
  usedTokens?: number;
  tokenLimit?: number;
  usedCost?: number;
  costLimit?: number;
  currency?: string;
  resetsAt?: string;
}

/**
 * Why a provider has no account data. The display layer must switch on this
 * rather than on `unavailableReason` prose: an optional credential that was
 * never added is not the same as a provider that exposes no usage API, and
 * neither is the same as a read that genuinely failed.
 *
 * Mirrors `MobileProviderUnavailableReason` in host/mobileProtocol.ts so the
 * desktop and mobile surfaces speak the same vocabulary.
 */
export type ProviderUsageUnavailableCode =
  /** An optional credential (for example an OpenAI Admin key) is not set up. The provider works. */
  | 'not-configured'
  /** The provider exposes no account usage API at all. This will not change on its own. */
  | 'not-supported'
  /** The provider's CLI is not installed, or Praxis cannot find it. */
  | 'cli-unavailable'
  /** The read was attempted and genuinely failed. The only case that is actually offline. */
  | 'fetch-failed';

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
  /** Optional provider-reported cumulative token total. */
  totalTokens?: number;
  /** Optional prepaid/account balance. Most providers do not expose this. */
  credits?: { remaining: number; currency: string };
  modelCosts?: ProviderModelCost[];
  /** Human-readable reason, suitable to show as-is. */
  unavailableReason?: string;
  /**
   * Machine-readable counterpart to `unavailableReason`. Always set alongside
   * it. UI status must derive from this, never from testing the message text.
   */
  unavailableReasonCode?: ProviderUsageUnavailableCode;
}

/**
 * Every enabled provider's account usage, read in one IPC round-trip
 * (FX-BF-050). The Overview dashboard shows all providers at once, and the
 * Codex adapter spawns a CLI process with a multi-second timeout, so the
 * renderer must not loop `providerSnapshot` per provider — that is N process
 * spawns per page load.
 */
export interface ProviderUsageSnapshotsResult {
  /** One entry per enabled provider, in settings order. Never shorter than the request. */
  snapshots: ProviderUsageSnapshot[];
  /** When this batch was read — for the panel's "last checked" line. */
  checkedAt: string;
}
