import { randomUUID } from 'node:crypto';
import {
  isCustomProviderId,
  type CustomProviderConfig,
  type ProviderUsageSnapshot,
  type ProviderUsageWindow
} from '@praxis/core';

/**
 * Alibaba Cloud Model Studio Coding Plan quota (5-hour, weekly and monthly
 * request windows).
 *
 * Alibaba exposes no quota endpoint that accepts the plan's `sk-sp-` chat key:
 * the inference host has no usage route and sends no rate-limit headers, and
 * the console RPC answers a key with `ConsoleNeedLogin`. What does work — and
 * what the console's own Coding Plan page calls — is
 * `queryCodingPlanInstanceInfoV2` over the console gateway, authenticated by a
 * signed-in console session (its cookies plus the page's `sec_token`). Praxis
 * hosts that sign-in itself (`alibabaConsoleSession.ts`), so the session lives
 * in a Praxis-owned browser partition and no cookie is ever copied by hand.
 *
 * The request shape follows CodexBar's adapter for the same plan
 * (steipete/CodexBar, `AlibabaCodingPlanUsageFetcher.swift`). It is an
 * undocumented console API, so every failure is reported as such rather than
 * as a zero.
 */

export type AlibabaConsoleRegion = 'intl' | 'cn';

interface RegionConfig {
  /** The console origin a person signs in to. */
  gateway: string;
  /** The RPC host the Coding Plan page calls. */
  rpcBase: string;
  dashboard: string;
  referer: string;
  domain: string;
  site: string;
  rpcAction: string;
  commodityCode: string;
  regionId: string;
}

const QUOTA_API = 'zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2';

const REGIONS: Record<AlibabaConsoleRegion, RegionConfig> = {
  intl: {
    gateway: 'https://modelstudio.console.alibabacloud.com',
    rpcBase: 'https://bailian-singapore-cs.alibabacloud.com',
    dashboard: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan#/efm/coding_plan',
    referer: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan',
    domain: 'modelstudio.console.alibabacloud.com',
    site: 'MODELSTUDIO_ALIBABACLOUD',
    rpcAction: 'IntlBroadScopeAspnGateway',
    commodityCode: 'sfm_codingplan_public_intl',
    regionId: 'ap-southeast-1'
  },
  cn: {
    gateway: 'https://bailian.console.aliyun.com',
    rpcBase: 'https://bailian-cs.console.aliyun.com',
    dashboard: 'https://bailian.console.aliyun.com/cn-beijing/?tab=model#/efm/coding_plan',
    referer: 'https://bailian.console.aliyun.com/cn-beijing/?tab=model',
    domain: 'bailian.console.aliyun.com',
    site: 'BAILIAN_ALIYUN',
    rpcAction: 'BroadScopeAspnGateway',
    commodityCode: 'sfm_codingplan_public_cn',
    regionId: 'cn-beijing'
  }
};

/**
 * The console hosts for a region. `PRAXIS_ALIBABA_CONSOLE_ORIGIN` points every
 * one of them at a single origin — only the e2e suite sets it, to a mock
 * console on loopback.
 */
export function consoleHosts(region: AlibabaConsoleRegion, env: NodeJS.ProcessEnv = process.env): RegionConfig {
  const base = REGIONS[region];
  const override = env.PRAXIS_ALIBABA_CONSOLE_ORIGIN?.trim().replace(/\/$/, '');
  if (!override) return base;
  return {
    ...base,
    gateway: override,
    rpcBase: override,
    dashboard: `${override}/coding-plan`,
    referer: `${override}/coding-plan`
  };
}

/** The mainland plan is served from `coding.dashscope.aliyuncs.com`; everything else is international. */
export function regionForEndpoint(baseUrl: string): AlibabaConsoleRegion {
  try {
    return new URL(baseUrl).hostname === 'coding.dashscope.aliyuncs.com' ? 'cn' : 'intl';
  } catch {
    return 'intl';
  }
}

export function codingPlanQuotaUrl(hosts: RegionConfig): string {
  const query = new URLSearchParams({ action: hosts.rpcAction, product: 'sfm_bailian', api: QUOTA_API, _v: 'undefined' });
  return `${hosts.rpcBase}/data/api.json?${query.toString()}`;
}

export function codingPlanQuotaBody(hosts: RegionConfig, secToken: string, anonymousId: string | undefined, traceId: string = randomUUID()): string {
  const cornerstoneParam: Record<string, string> = {
    feTraceId: traceId,
    feURL: hosts.dashboard,
    protocol: 'V2',
    console: 'ONE_CONSOLE',
    productCode: 'p_efm',
    domain: hosts.domain,
    consoleSite: hosts.site,
    userNickName: '',
    userPrincipalName: '',
    xsp_lang: 'en-US'
  };
  if (anonymousId) cornerstoneParam['X-Anonymous-Id'] = anonymousId;
  const params = {
    Api: QUOTA_API,
    V: '1.0',
    Data: {
      queryCodingPlanInstanceInfoRequest: { commodityCode: hosts.commodityCode, onlyLatestOne: true },
      cornerstoneParam
    }
  };
  return new URLSearchParams({ params: JSON.stringify(params), region: hosts.regionId, sec_token: secToken }).toString();
}

// ---------------------------------------------------------------- parsing

type Json = Record<string, unknown>;

/** The console wraps payloads in JSON-encoded strings; unwrap them before searching. */
function expandEmbeddedJson(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return expandEmbeddedJson(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(expandEmbeddedJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Json).map(([key, nested]) => [key, expandEmbeddedJson(nested)]));
  }
  return value;
}

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Breadth-first: the first value under any of `keys`, at any depth. */
function findFirst(value: unknown, keys: readonly string[], accept: (candidate: unknown) => boolean = () => true): unknown {
  const wanted = new Set(keys.map(key => key.toLowerCase()));
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
    } else if (isObject(current)) {
      for (const [key, nested] of Object.entries(current)) {
        if (wanted.has(key.toLowerCase()) && accept(nested)) return nested;
      }
      queue.push(...Object.values(current));
    }
  }
  return undefined;
}

function findObjectWithAnyKey(value: unknown, keys: readonly string[]): Json | undefined {
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
    } else if (isObject(current)) {
      if (keys.some(key => key in current)) return current;
      queue.push(...Object.values(current));
    }
  }
  return undefined;
}

function numberAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringAt(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstOf<T>(source: Json, keys: readonly string[], read: (value: unknown) => T | undefined): T | undefined {
  for (const key of keys) {
    const value = read(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Epoch seconds or milliseconds, ISO, or the console's `yyyy-MM-dd HH:mm[:ss]`. */
function dateAt(value: unknown): Date | undefined {
  const numeric = numberAt(value);
  if (numeric !== undefined && numeric > 0) return new Date(numeric >= 1e12 ? numeric : numeric * 1000);
  const text = stringAt(value);
  if (!text) return undefined;
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(' ', 'T') : text);
  return Number.isNaN(parsed) ? undefined : new Date(parsed);
}

const INSTANCE_KEYS = ['codingPlanInstanceInfos', 'coding_plan_instance_infos'] as const;
const QUOTA_KEYS = ['codingPlanQuotaInfo', 'coding_plan_quota_info'] as const;
const QUOTA_FIELDS = ['per5HourUsedQuota', 'per5HourTotalQuota', 'perWeekUsedQuota', 'perWeekTotalQuota', 'perBillMonthUsedQuota', 'perBillMonthTotalQuota'] as const;

function activeScore(instance: Json, now: Date): number {
  const status = firstOf(instance, ['status', 'instanceStatus'], stringAt)?.toUpperCase();
  if (status === 'VALID' || status === 'ACTIVE') return 3;
  if (status && ['EXPIRED', 'INVALID', 'INACTIVE', 'DISABLED', 'TERMINATED', 'STOPPED'].includes(status)) return -1;
  const end = firstOf(instance, ['endTime', 'periodEndTime', 'expireTime', 'expirationTime'], dateAt);
  return end && end.getTime() > now.getTime() ? 1 : 0;
}

/** The active plan when there are several (a lapsed trial alongside a paid plan). */
function activeInstance(payload: unknown, now: Date): Json | undefined {
  const infos = findFirst(payload, INSTANCE_KEYS, Array.isArray) as unknown[] | undefined;
  const instances = (infos ?? []).filter(isObject);
  if (instances.length === 0) return undefined;
  let best = instances[0];
  let bestScore = activeScore(best, now);
  for (const instance of instances.slice(1)) {
    const score = activeScore(instance, now);
    if (score > bestScore) {
      best = instance;
      bestScore = score;
    }
  }
  return best;
}

function quotaInfo(source: unknown): Json | undefined {
  const named = findFirst(source, QUOTA_KEYS, isObject) as Json | undefined;
  return named ?? findObjectWithAnyKey(source, QUOTA_FIELDS);
}

function planName(instance: Json | undefined, payload: unknown): string | undefined {
  if (instance) {
    const fromInstance = firstOf(instance, ['planName', 'plan_name', 'instanceName', 'instance_name', 'packageName', 'package_name'], stringAt);
    if (fromInstance) return fromInstance;
  }
  return stringAt(findFirst(payload, ['planName', 'plan_name', 'packageName', 'package_name'], candidate => typeof candidate === 'string' && candidate.trim() !== ''));
}

const requestCount = new Intl.NumberFormat('en-US');

function mapWindow(
  quota: Json,
  keys: { used: readonly string[]; total: readonly string[]; reset: readonly string[] },
  shape: { period: ProviderUsageWindow['period']; name: string; durationMinutes?: number },
  now: Date
): ProviderUsageWindow | undefined {
  const used = firstOf(quota, keys.used, numberAt);
  const total = firstOf(quota, keys.total, numberAt);
  if (used === undefined || total === undefined || total <= 0) return undefined;
  const clamped = Math.max(0, Math.min(total, used));
  const reset = firstOf(quota, keys.reset, dateAt);
  return {
    period: shape.period,
    // No plan name here: the card already names the endpoint, and repeating it on
    // three rows wrapped every label and squeezed the reset countdowns.
    label: `${shape.name} · ${requestCount.format(clamped)} / ${requestCount.format(total)} requests`,
    usedPercent: Math.round((clamped / total) * 100),
    ...(shape.durationMinutes ? { windowDurationMinutes: shape.durationMinutes } : {}),
    // A reset already in the past is a stale figure, not a countdown.
    ...(reset && reset.getTime() > now.getTime() ? { resetsAt: reset.toISOString() } : {})
  };
}

export class AlibabaConsoleLoginRequired extends Error {
  constructor() {
    super('The Alibaba Cloud console session has expired or was never signed in.');
  }
}

/**
 * Pure part of the adapter: the console's `queryCodingPlanInstanceInfoV2`
 * payload → a provider-neutral snapshot. Throws `AlibabaConsoleLoginRequired`
 * for a session the console no longer accepts, so the caller can say "sign in"
 * rather than "failed". Exported for tests.
 */
export function parseCodingPlanQuota(provider: CustomProviderConfig['id'], body: unknown, now: Date = new Date()): ProviderUsageSnapshot {
  const fetchedAt = now.toISOString();
  const failed = (reason: string): ProviderUsageSnapshot => ({ provider, fetchedAt, windows: [], unavailableReason: reason, unavailableReasonCode: 'fetch-failed' });
  const payload = expandEmbeddedJson(body);
  if (!isObject(payload)) return failed('Alibaba returned a Coding Plan payload Praxis could not read.');

  const code = stringAt(findFirst(payload, ['code'], candidate => typeof candidate === 'string'));
  const message = stringAt(findFirst(payload, ['message', 'msg', 'statusMessage'], candidate => typeof candidate === 'string'));
  if ((code && /needlogin|login/i.test(code)) || (message && /log ?in/i.test(message))) throw new AlibabaConsoleLoginRequired();
  const statusCode = numberAt(findFirst(payload, ['statusCode', 'status_code'], candidate => numberAt(candidate) !== undefined));
  if (statusCode !== undefined && statusCode !== 0 && statusCode !== 200) {
    return failed(`Alibaba Coding Plan request failed: ${message ?? `status ${statusCode}`}`);
  }

  const instance = activeInstance(payload, now);
  const quota = (instance && quotaInfo(instance)) ?? quotaInfo(payload);
  const plan = planName(instance, payload);
  if (!quota) {
    return failed(plan
      ? `Alibaba reports ${plan} but no quota counters for it.`
      : 'Alibaba did not report a Coding Plan for this account. A pay-as-you-go key has no plan quota.');
  }

  const windows = [
    mapWindow(quota, { used: ['per5HourUsedQuota', 'perFiveHourUsedQuota'], total: ['per5HourTotalQuota', 'perFiveHourTotalQuota'], reset: ['per5HourQuotaNextRefreshTime', 'perFiveHourQuotaNextRefreshTime'] }, { period: 'hour', name: '5-hour', durationMinutes: 300 }, now),
    mapWindow(quota, { used: ['perWeekUsedQuota'], total: ['perWeekTotalQuota'], reset: ['perWeekQuotaNextRefreshTime'] }, { period: 'week', name: 'Weekly' }, now),
    mapWindow(quota, { used: ['perBillMonthUsedQuota', 'perMonthUsedQuota'], total: ['perBillMonthTotalQuota', 'perMonthTotalQuota'], reset: ['perBillMonthQuotaNextRefreshTime', 'perMonthQuotaNextRefreshTime'] }, { period: 'month', name: 'Monthly' }, now)
  ].filter((window): window is ProviderUsageWindow => Boolean(window));
  if (windows.length === 0) return failed('Alibaba returned the Coding Plan without any usable quota windows.');
  return { provider, fetchedAt, windows };
}

// ---------------------------------------------------------------- fetching

const SEC_TOKEN_PATTERNS = [
  /SEC_TOKEN\s*:\s*"([^"]+)"/,
  /SEC_TOKEN\s*:\s*'([^']+)'/,
  /secToken\s*:\s*"([^"]+)"/,
  /sec_token\s*:\s*"([^"]+)"/,
  /sec_token\s*:\s*'([^']+)'/,
  /"SEC_TOKEN"\s*:\s*"([^"]+)"/,
  /"sec_token"\s*:\s*"([^"]+)"/
];

/** The anti-CSRF token the console page embeds for its own RPC calls. */
export function extractSecToken(html: string): string | undefined {
  for (const pattern of SEC_TOKEN_PATTERNS) {
    const token = pattern.exec(html)?.[1]?.trim();
    if (token) return token;
  }
  return undefined;
}

export function cookieValue(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || undefined;
  }
  return undefined;
}

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

export interface AlibabaConsoleTransport {
  /** The console session's cookies for `url`, as a `Cookie` header; undefined when not signed in. */
  cookieHeader(region: AlibabaConsoleRegion): Promise<string | undefined>;
  fetch: typeof fetch;
}

async function resolveSecToken(hosts: RegionConfig, cookie: string, transport: AlibabaConsoleTransport): Promise<string> {
  try {
    const page = await transport.fetch(hosts.dashboard, { headers: { Cookie: cookie, 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html,*/*' } });
    if (page.ok) {
      const token = extractSecToken(await page.text());
      if (token) return token;
    }
  } catch {
    // Fall through to the user-info endpoint.
  }
  try {
    const info = await transport.fetch(`${hosts.gateway}/tool/user/info.json`, {
      headers: { Cookie: cookie, 'User-Agent': BROWSER_USER_AGENT, Accept: 'application/json', Referer: `${hosts.gateway}/` }
    });
    if (info.ok) {
      const token = stringAt(findFirst(expandEmbeddedJson(await info.json()), ['secToken', 'sec_token'], candidate => typeof candidate === 'string'));
      if (token) return token;
    }
  } catch {
    // Fall through to the cookie.
  }
  const fromCookie = cookieValue(cookie, 'sec_token');
  if (fromCookie) return fromCookie;
  throw new AlibabaConsoleLoginRequired();
}

async function fetchOnce(config: CustomProviderConfig, region: AlibabaConsoleRegion, transport: AlibabaConsoleTransport): Promise<ProviderUsageSnapshot> {
  const cookie = await transport.cookieHeader(region);
  if (!cookie) throw new AlibabaConsoleLoginRequired();
  const hosts = consoleHosts(region);
  const secToken = await resolveSecToken(hosts, cookie, transport);
  const csrf = cookieValue(cookie, 'login_aliyunid_csrf') ?? cookieValue(cookie, 'csrf');
  const response = await transport.fetch(codingPlanQuotaUrl(hosts), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: '*/*',
      Cookie: cookie,
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': BROWSER_USER_AGENT,
      Origin: hosts.gateway,
      Referer: hosts.referer,
      ...(csrf ? { 'x-xsrf-token': csrf, 'x-csrf-token': csrf } : {})
    },
    body: codingPlanQuotaBody(hosts, secToken, cookieValue(cookie, 'cna'))
  });
  if (response.status === 401 || response.status === 403) throw new AlibabaConsoleLoginRequired();
  if (!response.ok) {
    return { provider: config.id, fetchedAt: new Date().toISOString(), windows: [], unavailableReason: `Alibaba Coding Plan usage request failed (${response.status}).`, unavailableReasonCode: 'fetch-failed' };
  }
  return parseCodingPlanQuota(config.id, await response.json());
}

export const ALIBABA_SIGN_IN_REASON = 'Sign in to the Alibaba Cloud console to show Coding Plan quota — Settings → AI Provider → this endpoint → Sign in to Alibaba Cloud.';

/** Reads Coding Plan quota for one endpoint through the signed-in console session. */
export async function alibabaCodingPlanUsageSnapshot(config: CustomProviderConfig, transport: AlibabaConsoleTransport): Promise<ProviderUsageSnapshot> {
  const region = regionForEndpoint(config.baseUrl);
  const notSignedIn = (): ProviderUsageSnapshot => ({ provider: config.id, fetchedAt: new Date().toISOString(), windows: [], unavailableReason: ALIBABA_SIGN_IN_REASON, unavailableReasonCode: 'not-configured' });
  try {
    return await fetchOnce(config, region, transport);
  } catch (error) {
    if (error instanceof AlibabaConsoleLoginRequired) return notSignedIn();
    return { provider: config.id, fetchedAt: new Date().toISOString(), windows: [], unavailableReason: error instanceof Error ? `Alibaba Coding Plan usage is unavailable: ${error.message}` : 'Alibaba Coding Plan usage is unavailable.', unavailableReasonCode: 'fetch-failed' };
  }
}

/** Preset-derived, so an endpoint the user pointed at another host still matches. */
export function isAlibabaCodingPlanEndpoint(provider: string, config: CustomProviderConfig | undefined): config is CustomProviderConfig {
  return isCustomProviderId(provider) && config !== undefined && config.presetId === 'alibaba-coding-plan';
}
