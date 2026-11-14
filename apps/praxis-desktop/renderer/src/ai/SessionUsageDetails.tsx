import type { ReportedModelUsage, TokenUsage } from '@praxis/core';
import './sessionPresentation.css';

export function SessionUsageDetails({ usage, models, label = 'Token details' }: {
  usage?: TokenUsage;
  models?: readonly ReportedModelUsage[];
  label?: string;
}) {
  if (!usage && !models?.length) return null;
  const counters: Array<[keyof TokenUsage, string]> = [['inputTokens','Input (reported)'],['cachedInputTokens','Cache read'],['cachedWriteTokens','Cache write'],['outputTokens','Output'],['reasoningTokens','Reasoning (reported)']];
  return <details className="session-reported-usage" data-testid="session-reported-usage">
    <summary>{label}</summary>
    {usage && <dl>{counters.map(([key,name]) => <div key={key}><dt>{name}</dt><dd>{usage[key]?.toLocaleString() ?? 'Not reported'}</dd></div>)}
      <div><dt>Primary total</dt><dd>{usage.totalTokens?.toLocaleString() ?? 'Not reported'}</dd></div>
    </dl>}
    {models && models.length > 0 && <>
      <p className="hint">Model usage is reported separately. Additional models are not added to the primary total.</p>
      <ul>{models.map(row => <li key={row.model} data-testid="session-reported-model"><strong>{row.model}</strong> · {row.role === 'reply' ? 'Main reported model' : 'Additional model'} · {row.tokenUsage.totalTokens?.toLocaleString() ?? 'Not reported'} tokens</li>)}</ul>
    </>}
    <p className="hint">Token categories follow provider reporting and may overlap. Context occupancy and account limits are separate.</p>
  </details>;
}
