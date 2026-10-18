import type { AgentSessionRecord, AiProvider, AiUsageEvent } from '@praxis/core';

type Cost = NonNullable<AgentSessionRecord['cost']>;
export interface SessionModelUsage {
  provider: AiProvider;
  model?: string;
  tokens?: number;
  partial: boolean;
  costs: Cost[];
}
export interface SessionProviderUsage {
  provider: AiProvider;
  models: SessionModelUsage[];
  tokens?: number;
  partial: boolean;
  costs: Cost[];
}

function sumTokens(values: Array<number | undefined>) {
  const reported = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return { tokens: reported.length ? reported.reduce((sum, value) => sum + value, 0) : undefined, partial: reported.length < values.length };
}

function sumCosts(values: Array<Cost | undefined>): Cost[] {
  const totals = new Map<string, number>();
  for (const value of values) {
    if (value && Number.isFinite(value.amount)) totals.set(value.currency, (totals.get(value.currency) ?? 0) + value.amount);
  }
  return [...totals].map(([currency, amount]) => ({ currency, amount }));
}

/** Runtime epochs attribute session tokens; the ledger attributes cost deltas. Neither is account quota. */
export function sessionUsageData(
  records: AgentSessionRecord[],
  selectedProvider: AiProvider | undefined,
  selectedModel: string | undefined,
  events: AiUsageEvent[]
) {
  const models = new Map<string, SessionModelUsage>();
  const contributions = new Map<string, Array<number | undefined>>();
  const costContributions = new Map<string, Cost[]>();
  const keyOf = (provider: AiProvider, model?: string) => JSON.stringify([provider, model]);
  const ensure = (provider: AiProvider, model?: string) => {
    const key = keyOf(provider, model);
    if (!models.has(key)) models.set(key, { provider, model, tokens: undefined, partial: false, costs: [] });
    return key;
  };
  const ids = new Set(records.map(record => record.sessionId));
  const ledger = events.filter(event => event.sessionId && ids.has(event.sessionId));
  for (const record of records) {
    const epochs = record.runtimeEpochs ?? [];
    const identities = new Set(epochs.map(epoch => JSON.stringify([epoch.provider, epoch.model])));
    // Older persisted records have a hydrated epoch with no usage. Their single-runtime total is still valid.
    if (record.provider && (epochs.length === 0 || (identities.size === 1 && epochs.every(epoch => epoch.provider === record.provider && epoch.model === record.model)))) {
      const key = ensure(record.provider, record.model);
      contributions.set(key, [...(contributions.get(key) ?? []), record.tokenUsage?.totalTokens]);
      if (record.cost) costContributions.set(key, [...(costContributions.get(key) ?? []), record.cost]);
    } else {
      for (const epoch of epochs) {
        if (!epoch.provider) continue;
        const key = ensure(epoch.provider, epoch.model);
        contributions.set(key, [...(contributions.get(key) ?? []), epoch.tokenUsage?.totalTokens]);
      }
      for (const event of ledger.filter(event => event.sessionId === record.sessionId)) {
        if (!event.provider) continue;
        const key = ensure(event.provider, event.model);
        if (event.cost) costContributions.set(key, [...(costContributions.get(key) ?? []), event.cost]);
      }
    }
    for (const participant of record.conversation?.participants ?? []) ensure(participant.provider, participant.model);
    if (record.provider) ensure(record.provider, record.model);
  }
  if (selectedProvider) ensure(selectedProvider, selectedModel);
  for (const [key, model] of models) {
    Object.assign(model, sumTokens(contributions.get(key) ?? [undefined]));
    model.costs = sumCosts(costContributions.get(key) ?? []);
  }
  const providers: SessionProviderUsage[] = [];
  for (const model of models.values()) {
    let provider = providers.find(item => item.provider === model.provider);
    if (!provider) {
      provider = { provider: model.provider, models: [], tokens: undefined, partial: false, costs: [] };
      providers.push(provider);
    }
    provider.models.push(model);
  }
  for (const provider of providers) {
    // A provider can have several models even if an old record only reports its overall total.
    const allRecordsHere = records.length > 0 && records.every(record => record.provider === provider.provider
      && (record.runtimeEpochs ?? []).every(epoch => epoch.provider === provider.provider));
    Object.assign(provider, sumTokens(allRecordsHere ? records.map(record => record.tokenUsage?.totalTokens) : provider.models.map(model => model.tokens)));
    // Missing model attribution does not make a known whole-provider total incomplete.
    if (!allRecordsHere) provider.partial ||= provider.models.some(model => model.partial);
    provider.costs = sumCosts(allRecordsHere ? records.map(record => record.cost) : provider.models.flatMap(model => model.costs));
  }
  return {
    providers,
    models: [...models.values()],
    current: selectedProvider ? models.get(keyOf(selectedProvider, selectedModel)) : undefined,
    total: { ...sumTokens(records.map(record => record.tokenUsage?.totalTokens)), costs: sumCosts(records.map(record => record.cost)) }
  };
}
