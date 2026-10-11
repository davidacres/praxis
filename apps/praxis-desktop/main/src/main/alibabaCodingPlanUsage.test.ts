import assert from 'node:assert/strict';
import test from 'node:test';
import type { CustomProviderConfig } from '@praxis/core';
import {
  AlibabaConsoleLoginRequired,
  ALIBABA_SIGN_IN_REASON,
  alibabaCodingPlanUsageSnapshot,
  codingPlanQuotaBody,
  consoleHosts,
  extractSecToken,
  isAlibabaCodingPlanEndpoint,
  parseCodingPlanQuota,
  regionForEndpoint
} from './alibabaCodingPlanUsage';

const ENDPOINT = 'custom:alibaba-model-studio-coding-plan' as const;
const NOW = new Date(1_700_000_000_000);

const config: CustomProviderConfig = {
  id: ENDPOINT,
  label: 'Alibaba Model Studio Coding Plan',
  presetId: 'alibaba-coding-plan',
  protocol: 'openai-chat',
  baseUrl: 'https://coding-intl.dashscope.aliyuncs.com',
  apiPath: '/v1',
  auth: { kind: 'bearer' }
};

const quotaPayload = {
  data: {
    codingPlanInstanceInfos: [{ planName: 'Coding Plan Pro', status: 'VALID' }],
    codingPlanQuotaInfo: {
      per5HourUsedQuota: 52,
      per5HourTotalQuota: 6000,
      per5HourQuotaNextRefreshTime: 1_700_000_300_000,
      perWeekUsedQuota: 9000,
      perWeekTotalQuota: 45000,
      perWeekQuotaNextRefreshTime: 1_700_100_000_000,
      perBillMonthUsedQuota: 18000,
      perBillMonthTotalQuota: 90000,
      perBillMonthQuotaNextRefreshTime: 1_701_000_000_000
    }
  },
  status_code: 0
};

test('maps the 5-hour, weekly and monthly request windows with counts and resets', () => {
  const snapshot = parseCodingPlanQuota(ENDPOINT, quotaPayload, NOW);
  assert.equal(snapshot.unavailableReason, undefined);
  assert.deepEqual(snapshot.windows.map(window => [window.period, window.usedPercent]), [['hour', 1], ['week', 20], ['month', 20]]);
  assert.equal(snapshot.windows[0].label, '5-hour · 52 / 6,000 requests');
  assert.equal(snapshot.windows[0].windowDurationMinutes, 300);
  assert.equal(snapshot.windows[0].resetsAt, new Date(1_700_000_300_000).toISOString());
  assert.equal(snapshot.windows[2].label, 'Monthly · 18,000 / 90,000 requests');
});

test('reads quota wrapped in a JSON-encoded string, as the console gateway sends it', () => {
  const wrapped = { code: '200', data: { successResponse: true, DataV2: JSON.stringify(quotaPayload) } };
  const snapshot = parseCodingPlanQuota(ENDPOINT, wrapped, NOW);
  assert.equal(snapshot.windows.length, 3);
});

test('uses the active plan when an expired one is listed first', () => {
  const payload = {
    data: {
      codingPlanInstanceInfos: [
        { planName: 'Expired Lite', status: 'EXPIRED', codingPlanQuotaInfo: { per5HourUsedQuota: 7, per5HourTotalQuota: 100 } },
        { planName: 'Active Pro', status: 'VALID', codingPlanQuotaInfo: { per5HourUsedQuota: 300, per5HourTotalQuota: 6000 } }
      ]
    }
  };
  const snapshot = parseCodingPlanQuota(ENDPOINT, payload, NOW);
  assert.equal(snapshot.windows.length, 1);
  // 300 / 6000 — the active plan's counters, not the expired one's 7 / 100.
  assert.equal(snapshot.windows[0].usedPercent, 5);
});

test('a reset time already past is dropped rather than shown as a countdown', () => {
  const payload = { codingPlanQuotaInfo: { per5HourUsedQuota: 1, per5HourTotalQuota: 10, per5HourQuotaNextRefreshTime: NOW.getTime() - 1000 } };
  assert.equal(parseCodingPlanQuota(ENDPOINT, payload, NOW).windows[0].resetsAt, undefined);
});

test('ConsoleNeedLogin is a sign-in requirement, not a zero', () => {
  assert.throws(() => parseCodingPlanQuota(ENDPOINT, { code: 'ConsoleNeedLogin', message: 'Please log in', successResponse: false }, NOW), AlibabaConsoleLoginRequired);
});

test('no plan reports a reason instead of inventing windows', () => {
  const snapshot = parseCodingPlanQuota(ENDPOINT, { data: { codingPlanInstanceInfos: [] } }, NOW);
  assert.deepEqual(snapshot.windows, []);
  assert.equal(snapshot.unavailableReasonCode, 'fetch-failed');
});

test('extracts the console page sec_token in its embedded forms', () => {
  assert.equal(extractSecToken('<script>window.ALIYUN_CONSOLE_CONFIG = { SEC_TOKEN: "abc123" }</script>'), 'abc123');
  assert.equal(extractSecToken(`{"sec_token":"xyz"}`), 'xyz');
  assert.equal(extractSecToken('<html></html>'), undefined);
});

test('the region follows the endpoint host', () => {
  assert.equal(regionForEndpoint('https://coding-intl.dashscope.aliyuncs.com'), 'intl');
  assert.equal(regionForEndpoint('https://coding.dashscope.aliyuncs.com'), 'cn');
  assert.equal(regionForEndpoint('not a url'), 'intl');
});

test('the request body carries the plan commodity, region and sec_token', () => {
  const body = new URLSearchParams(codingPlanQuotaBody(consoleHosts('intl', {}), 'tok', 'anon', 'trace'));
  assert.equal(body.get('sec_token'), 'tok');
  assert.equal(body.get('region'), 'ap-southeast-1');
  const params = JSON.parse(body.get('params') ?? '{}');
  assert.equal(params.Api, 'zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2');
  assert.equal(params.Data.queryCodingPlanInstanceInfoRequest.commodityCode, 'sfm_codingplan_public_intl');
  assert.equal(params.Data.cornerstoneParam['X-Anonymous-Id'], 'anon');
});

test('fetches through the console session: page sec_token, then the quota RPC with cookies', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const snapshot = await alibabaCodingPlanUsageSnapshot(config, {
    cookieHeader: async () => 'login_aliyunid_ticket=t; cna=anon-1; login_aliyunid_csrf=c1',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/data/api.json')) return new Response(JSON.stringify(quotaPayload), { status: 200 });
      return new Response('<script>SEC_TOKEN: "page-token"</script>', { status: 200 });
    }) as typeof fetch
  });
  assert.equal(snapshot.windows.length, 3);
  const rpc = calls.find(call => call.url.includes('/data/api.json'))!;
  assert.match(rpc.url, /^https:\/\/bailian-singapore-cs\.alibabacloud\.com\/data\/api\.json\?action=IntlBroadScopeAspnGateway/);
  const headers = rpc.init?.headers as Record<string, string>;
  assert.equal(headers.Cookie, 'login_aliyunid_ticket=t; cna=anon-1; login_aliyunid_csrf=c1');
  assert.equal(headers['x-csrf-token'], 'c1');
  assert.equal(new URLSearchParams(String(rpc.init?.body)).get('sec_token'), 'page-token');
});

test('no console session asks the person to sign in', async () => {
  const snapshot = await alibabaCodingPlanUsageSnapshot(config, {
    cookieHeader: async () => undefined,
    fetch: (async () => { throw new Error('must not be called'); }) as typeof fetch
  });
  assert.equal(snapshot.unavailableReason, ALIBABA_SIGN_IN_REASON);
  assert.equal(snapshot.unavailableReasonCode, 'not-configured');
});

test('matches on the preset, not the label or URL', () => {
  assert.equal(isAlibabaCodingPlanEndpoint(ENDPOINT, config), true);
  assert.equal(isAlibabaCodingPlanEndpoint(ENDPOINT, { ...config, presetId: 'alibaba-token-plan' }), false);
  assert.equal(isAlibabaCodingPlanEndpoint('openai', config), false);
});
