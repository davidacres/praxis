/** True when a provider error message indicates a rate/usage/quota limit rather than a real failure. */
export function isProviderLimitError(message: string): boolean {
  return /(weekly limit|rate limit|quota|usage limit|insufficient[_ -]?quota|too many requests|credits? exhausted)/i.test(message);
}
