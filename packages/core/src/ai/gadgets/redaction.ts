/**
 * Secret redaction for gadget payloads (TASK-278).
 *
 * A gadget payload is rendered verbatim and persisted to the ledger as
 * evidence, so a credential that reaches it is both displayed and durable. The
 * producer is often a model summarising a config file or a shell transcript,
 * which is exactly the situation that leaks keys. We mask rather than reject:
 * refusing the whole gadget because one cell looked like a token would hide a
 * useful surface, and the user still needs to see the rest of the table.
 */

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
  { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'openai-key', pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/gi },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Keyed assignment: `api_key = "…"`, `password: …`. Deliberately last so a
  // more specific pattern above claims the value first and names it properly.
  {
    name: 'keyed-secret',
    // The key and the separator are captured so the replacement can put them
    // back byte-for-byte — `api_key = x` and `api_key:x` both keep their own
    // spacing, which matters when the surrounding text is a config excerpt.
    pattern: /\b((?:api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret))\b(\s*[:=]\s*)["']?([A-Za-z0-9_\-./+]{12,})["']?/gi
  }
];

export const REDACTION_PLACEHOLDER = '[redacted]';

export interface RedactionOutcome {
  text: string;
  /** Pattern names that matched, for the audit record. Never the value itself. */
  hits: string[];
}

/** Mask every secret-shaped run in `text`. Returns the original when nothing matched. */
export function redactSecrets(text: string): RedactionOutcome {
  let result = text;
  const hits: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    // `lastIndex` persists on a global regex between calls; reset so a shared
    // module-level pattern cannot skip a match in the next string it sees.
    pattern.lastIndex = 0;
    if (!pattern.test(result)) continue;
    pattern.lastIndex = 0;
    hits.push(name);
    result = result.replace(pattern, (match, key: string, separator: string) => {
      // Keep the key name so the user can tell *what* was masked; only the
      // value is destroyed.
      if (name !== 'keyed-secret') return REDACTION_PLACEHOLDER;
      return `${key}${separator}${REDACTION_PLACEHOLDER}`;
    });
  }
  return { text: result, hits };
}

/**
 * Deep-copy `value`, masking every string it contains.
 *
 * Structure is preserved exactly — only string leaves change — so a redacted
 * payload still satisfies the schema it was validated against.
 */
export function redactDeep<T>(value: T, hits: Set<string>): T {
  if (typeof value === 'string') {
    const outcome = redactSecrets(value);
    for (const hit of outcome.hits) hits.add(hit);
    return outcome.text as unknown as T;
  }
  if (Array.isArray(value)) return value.map(entry => redactDeep(entry, hits)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(entry, hits);
    }
    return out as T;
  }
  return value;
}
