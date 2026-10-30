export type PromptCheckStage = 'provider-request' | 'response-validation' | 'cache-write';

/** Keep prompts, model replies and credentials out of diagnostics. */
export function promptCheckDiagnostic(stage: PromptCheckStage, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (stage === 'response-validation') {
    const detail = /^(The clarity check reply|Invalid evidence or fix|Ungrounded evidence|Missing suggestion)/.test(message)
      ? message : 'The reply was not valid JSON.';
    return `The model returned an invalid clarity assessment. ${detail} Retry the check or choose a different prompt-analysis model in Settings → AI Provider → Routing.`;
  }
  if (stage === 'cache-write') return 'The AI check completed, but Praxis could not save its result locally. Check available disk space and access to the app data folder.';
  if (/timeout|timed out|abort|AnalysisCancelledError/i.test(`${error instanceof Error ? error.name : ''} ${message}`)) {
    return 'The prompt check timed out after 20 seconds. The provider may be slow or a CLI agent may still be starting. Retry or choose a faster prompt-analysis model.';
  }
  if (/\b(401|403)\b|unauthori[sz]ed|authentication|invalid.*key/i.test(message)) return 'The prompt-check provider rejected authentication or access. Check its credentials and model access in Settings → AI Provider.';
  if (/\b429\b|rate.limit|quota|credit|allowance/i.test(message)) return 'The prompt-check provider reported a rate or usage limit. Check its allowance, wait, or choose another prompt-analysis provider.';
  if (/\b(400|404)\b|model.*(not found|unsupported|invalid)/i.test(message)) return 'The prompt-check provider rejected the request or selected model. Check the prompt-analysis model and endpoint in Settings → AI Provider → Routing.';
  if (/\b5\d{2}\b/i.test(message)) return 'The prompt-check provider returned a server error. Retry shortly or choose another prompt-analysis provider.';
  if (/fetch failed|ECONN|ENOTFOUND|network|connection refused/i.test(message)) return 'Praxis could not connect to the prompt-check provider. Check the endpoint and network connection.';
  return 'The prompt-check provider request failed. Check the provider configuration and selected prompt-analysis model in Settings → AI Provider → Routing.';
}

/** Short, actionable copy for the composer; technical detail stays in Output. */
export function promptCheckFailure(stage: PromptCheckStage, error: unknown, cliAgent = false): string {
  if (stage !== 'provider-request') {
    return stage === 'cache-write'
      ? 'Analysis unavailable. Check available disk space, then retry.'
      : 'Analysis unavailable. Please retry.';
  }
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/timeout|timed out|abort|AnalysisCancelledError/i.test(message)) return 'Analysis unavailable. Please retry.';
  if (/\b(401|403)\b|unauthori[sz]ed|authentication|invalid.*key/i.test(message)) {
    return cliAgent
      ? 'AI provider requires authentication. Open the selected CLI agent and sign in, then retry.'
      : 'AI provider requires authentication. Update its API key in Settings → AI Providers → Providers, then retry.';
  }
  if (/\b429\b|rate.limit|quota|credit|allowance/i.test(message)) return 'Rate limit reached.';
  return 'Analysis unavailable. Please retry.';
}
