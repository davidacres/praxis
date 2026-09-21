/**
 * Patterns matching rate, usage, credit, and quota limits across providers:
 * - Claude Code CLI: "You've hit your session limit · resets 12:50pm (Europe/London)"
 * - Anthropic API: "Your credit balance is too low to continue", "rate_limit_error"
 * - OpenAI API: "You exceeded your current quota, please check your plan and billing details", "insufficient_quota"
 * - Gemini API: "RESOURCE_EXHAUSTED", "Quota exceeded for quota metric"
 * - GitHub Copilot CLI / Codex CLI: "rate limit reached", "usage limit reached"
 */
const LIMIT_REGEX =
  /(?:weekly|monthly|daily|hourly|session|usage|rate|spending|billing|plan|tier|budget)[_ -]?limit|(?:hit|reached|exceeded) (?:your |its |the )?(?:\w+ )?(?:limit|budget|quota)|quota|insufficient[_ -]?(?:quota|balance|funds|credits?|budget)|out of quota|too many requests|resource[_ -]?exhausted|(?:credits?|budget)[_ -]?(?:exhausted|depleted|empty|expired|zero|insufficient|out|exceeded)|out of (?:credits?|budget)|no (?:credits?|budget) remaining|run out of (?:credits?|budget)|\bover[_ -]?budget\b|credit balance (?:is )?too low|balance (?:is )?too low|no resource package|please recharge|\b1113\b|rate[_ -]?limit|rate[_ -]?limited/i;

/** True when an error or message indicates a rate, usage, session, credit, quota, or budget limit. */
export function isProviderLimitError(errorOrMessage: unknown): boolean {
  if (!errorOrMessage) return false;
  if (typeof errorOrMessage === 'string') {
    return LIMIT_REGEX.test(errorOrMessage);
  }
  if (typeof errorOrMessage === 'object') {
    const obj = errorOrMessage as Record<string, unknown>;
    // Check ACP RequestError data (e.g. { errorKind: 'rate_limit' })
    const data = obj.data as Record<string, unknown> | undefined;
    if (data && typeof data.errorKind === 'string' && /rate_limit|quota|usage_limit|budget/i.test(data.errorKind)) {
      return true;
    }
    // Check nested error object
    const errObj = obj.error as Record<string, unknown> | undefined;
    if (errObj && typeof errObj === 'object') {
      if (typeof errObj.message === 'string' && LIMIT_REGEX.test(errObj.message)) {
        return true;
      }
      if (typeof errObj.code === 'string' || typeof errObj.code === 'number') {
        if (errObj.code === 429 || errObj.code === 1113 || String(errObj.code) === '1113') return true;
      }
    }
    // Check HTTP status or API error codes
    if (
      obj.status === 429 ||
      obj.statusCode === 429 ||
      obj.code === 429 ||
      obj.code === '1113' ||
      obj.code === 1113 ||
      (typeof obj.code === 'string' && /quota|rate_limit|resource_exhausted|1113/i.test(obj.code))
    ) {
      return true;
    }
    if (typeof obj.message === 'string' && LIMIT_REGEX.test(obj.message)) {
      return true;
    }
  }
  return false;
}

/** Extracts a user-facing limit message explaining the quota, credit, or budget exhaustion. */
export function extractProviderLimitMessage(errorOrMessage: unknown): string {
  let raw = '';
  if (typeof errorOrMessage === 'string') {
    raw = errorOrMessage;
  } else if (errorOrMessage && typeof errorOrMessage === 'object') {
    const obj = errorOrMessage as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      raw = obj.message;
    } else {
      raw = String(errorOrMessage);
    }
  }

  // Strip generic transport/RPC wrappers like "The stage session failed: ", "RequestError: ", "Internal error: "
  let cleaned = raw.replace(/^(?:The stage session failed:\s*)?(?:RequestError:\s*)?(?:Internal error:\s*)?(?:Provider error:\s*)?(?:Gateway returned \d+:\s*)?/i, '').trim();

  // If cleaned is or contains JSON, extract the inner message
  try {
    const jsonMatch = cleaned.match(/\{.*\}$/s);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { error?: { message?: string } };
      if (parsed?.error?.message && typeof parsed.error.message === 'string') {
        cleaned = parsed.error.message;
      }
    }
  } catch {
    // not JSON
  }

  if (cleaned && LIMIT_REGEX.test(cleaned)) {
    return `Provider limit reached: ${cleaned}`;
  }

  return 'Provider usage limit, budget, or credits exhausted. The session was halted and will not retry automatically.';
}
