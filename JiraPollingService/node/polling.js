const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');

const SEARCH_FIELDS = ['summary', 'status', 'labels', 'updated'];

const DEFAULT_CONFIG = Object.freeze({
  BaseUrl: 'https://jira.example.com',
  InternalDns: 'internal-Atlassian-Prod-LB-Jira-Internal-195841951.eu-west-1.elb.amazonaws.com',
  PreferredResolveIp: '',
  Token: '',
  BoardUrl: 'https://jira.example.com/secure/RapidBoard.jspa?rapidView=9402&projectKey=KAMAI',
  RapidViewId: 9402,
  ProjectKey: 'KAMAI',
  LinkedEpicKey: '',
  RequiredLabel: 'syscfg',
  RequiredStatus: 'To Do',
  PollIntervalSeconds: 30,
  MaxResults: 50
});

class HttpStatusError extends Error {
  constructor(statusCode, statusMessage, responseBody) {
    super(
      `Jira search failed with HTTP ${statusCode} (${statusMessage ?? 'Unknown'}). Response: ${responseBody}`
    );
    this.name = 'HttpStatusError';
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.responseBody = responseBody;
  }
}

function createPollingConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    Token: process.env.JIRA_TOKEN ?? overrides.Token ?? DEFAULT_CONFIG.Token
  };
}

function loadPollingConfig(configPath, overrides = {}) {
  const resolvedPath = path.resolve(configPath);
  const rawText = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = JSON.parse(rawText);
  const configuredValues = parsed?.JiraPolling;
  const config = createPollingConfig(configuredValues ? { ...configuredValues, ...overrides } : overrides);
  validatePollingConfig(config);
  return config;
}

function getTokenOrThrow(config) {
  if (typeof config.Token !== 'string' || config.Token.trim().length === 0) {
    throw new Error(
      'JIRA_TOKEN must be supplied via environment variable or JiraPolling:Token configuration.'
    );
  }

  return config.Token.trim();
}

function escapeJql(value) {
  return String(value)
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`);
}

function resolvePort(url, isHttps) {
  if (url.port) {
    return Number(url.port);
  }

  return isHttps ? 443 : 80;
}

function buildJql(config) {
  return `(parent = "${escapeJql(config.LinkedEpicKey)}" OR "Epic Link" = "${escapeJql(config.LinkedEpicKey)}") ORDER BY updated DESC`;
}

function validatePollingConfig(config) {
  let baseUrl;
  try {
    baseUrl = new URL(config.BaseUrl);
  } catch {
    throw new Error('JiraPolling:BaseUrl must be a valid absolute URI.');
  }

  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error('JiraPolling:BaseUrl must use the http or https protocol.');
  }

  if (typeof config.InternalDns !== 'string' || config.InternalDns.trim().length === 0) {
    throw new Error('JiraPolling:InternalDns is required.');
  }

  if (typeof config.ProjectKey !== 'string' || config.ProjectKey.trim().length === 0) {
    throw new Error('JiraPolling:ProjectKey is required.');
  }

  if (typeof config.LinkedEpicKey !== 'string' || config.LinkedEpicKey.trim().length === 0) {
    throw new Error('JiraPolling:LinkedEpicKey is required.');
  }

  if (typeof config.RequiredStatus !== 'string' || config.RequiredStatus.trim().length === 0) {
    throw new Error('JiraPolling:RequiredStatus is required.');
  }

  if (!Number.isInteger(config.PollIntervalSeconds) || config.PollIntervalSeconds < 5) {
    throw new Error('JiraPolling:PollIntervalSeconds must be at least 5.');
  }

  if (!Number.isInteger(config.MaxResults) || config.MaxResults < 1) {
    throw new Error('JiraPolling:MaxResults must be greater than 0.');
  }
}

function createConsoleLogger(stdout = process.stdout, stderr = process.stderr) {
  return {
    info(message, ...args) {
      stdout.write(`${formatTimestamp(new Date())} info: ${util.format(message, ...args)}\n`);
    },
    error(message, ...args) {
      stderr.write(`${formatTimestamp(new Date())} error: ${util.format(message, ...args)}\n`);
    }
  };
}

function formatTimestamp(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

async function defaultResolveAddresses(hostname) {
  const addresses = await dns.lookup(hostname, {
    all: true,
    family: 4,
    order: 'verbatim'
  });

  return addresses.map(entry => entry.address);
}

function isPrivateTenNetAddress(address) {
  if (net.isIP(address) !== 4) {
    return false;
  }

  return address.split('.')[0] === '10';
}

async function resolveCandidateIps(config, options = {}) {
  const resolveAddresses = options.resolveAddresses ?? defaultResolveAddresses;
  const candidates = [];
  const seen = new Set();

  if (typeof config.PreferredResolveIp === 'string' && net.isIP(config.PreferredResolveIp.trim()) === 4) {
    const preferredIp = config.PreferredResolveIp.trim();
    candidates.push(preferredIp);
    seen.add(preferredIp);
  }

  const resolvedIps = await resolveAddresses(config.InternalDns);
  for (const resolvedIp of resolvedIps) {
    if (!isPrivateTenNetAddress(resolvedIp) || seen.has(resolvedIp)) {
      continue;
    }

    candidates.push(resolvedIp);
    seen.add(resolvedIp);
  }

  if (candidates.length === 0) {
    throw new Error(
      `No private IPv4 Jira addresses could be resolved from ${config.InternalDns}.`
    );
  }

  return candidates;
}

function normalizeIssueKey(issueKey) {
  return String(issueKey).trim().toUpperCase();
}

function normalizeStatusValue(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function issueMatchesFilter(issue, config) {
  const statusName = issue?.fields?.status?.name;
  const labels = Array.isArray(issue?.fields?.labels) ? issue.fields.labels : [];
  const requiredStatus = typeof config.RequiredStatus === 'string' ? config.RequiredStatus.trim() : '';
  const normalizedRequiredStatus = normalizeStatusValue(requiredStatus);
  const normalizedStatusName = normalizeStatusValue(statusName);

  const matchesStatus = requiredStatus.length > 0 && normalizedStatusName === normalizedRequiredStatus;

  const requiredLabel = typeof config.RequiredLabel === 'string' ? config.RequiredLabel.trim() : '';
  const matchesLabel =
    requiredLabel.length === 0 ||
    labels.some(
      label =>
        typeof label === 'string' &&
        label.localeCompare(requiredLabel, undefined, { sensitivity: 'accent' }) === 0
    );

  return matchesStatus && matchesLabel;
}

function buildIssueSignature(issue) {
  return JSON.stringify({
    updated: issue?.fields?.updated ?? '',
    status: issue?.fields?.status?.name ?? '',
    summary: issue?.fields?.summary ?? ''
  });
}

function buildCurrentIssueMap(issues) {
  const currentIssueMap = new Map();
  for (const issue of issues) {
    currentIssueMap.set(normalizeIssueKey(issue.key), {
      key: issue.key,
      signature: buildIssueSignature(issue)
    });
  }
  return currentIssueMap;
}

function diffIssueMaps(previousIssueMap, currentIssueMap) {
  const newKeys = [];
  const changedKeys = [];
  const removedKeys = [];

  for (const [normalizedKey, currentIssue] of currentIssueMap.entries()) {
    if (!previousIssueMap.has(normalizedKey)) {
      newKeys.push(currentIssue.key);
      continue;
    }

    const previousIssue = previousIssueMap.get(normalizedKey);
    if (previousIssue?.signature !== currentIssue.signature) {
      changedKeys.push(currentIssue.key);
    }
  }

  for (const [normalizedKey, previousIssue] of previousIssueMap.entries()) {
    if (!currentIssueMap.has(normalizedKey)) {
      removedKeys.push(previousIssue.key);
    }
  }

  return {
    newKeys,
    changedKeys,
    removedKeys
  };
}

function sortIssues(issues) {
  return [...issues].sort((left, right) => {
    const leftKey = normalizeIssueKey(left?.key ?? '');
    const rightKey = normalizeIssueKey(right?.key ?? '');
    return leftKey.localeCompare(rightKey, 'en', { sensitivity: 'base' });
  });
}

function buildSearchRequest(config) {
  return {
    jql: buildJql(config),
    startAt: 0,
    maxResults: config.MaxResults,
    fields: SEARCH_FIELDS
  };
}

function getResponseSnippet(text, maxLength = 200) {
  const normalized = String(text).replaceAll(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function getHeaderValue(headers, name) {
  const rawValue = headers?.[name];
  return Array.isArray(rawValue) ? rawValue[0] : rawValue;
}

function tryParseJsonResponse(text, contentType) {
  const trimmed = String(text).trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const normalizedContentType = typeof contentType === 'string' ? contentType.toLowerCase() : '';
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!looksLikeJson && normalizedContentType && !normalizedContentType.includes('json')) {
    return undefined;
  }

  return JSON.parse(trimmed);
}

function buildNonJsonSearchErrorMessage(statusCode, statusMessage, contentType, responseBody) {
  const normalizedContentType =
    typeof contentType === 'string' && contentType.trim().length > 0
      ? contentType.split(';', 1)[0].trim()
      : 'unknown';
  const snippet = getResponseSnippet(responseBody);
  const prefix = `Jira search returned non-JSON content (${normalizedContentType}) with HTTP ${statusCode} (${statusMessage ?? 'Unknown'}).`;
  return snippet ? `${prefix} Response: ${snippet}` : prefix;
}

async function postSearchRequest(config, candidateIp, options = {}) {
  const url = new URL(config.BaseUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const requestBody = Buffer.from(JSON.stringify(buildSearchRequest(config)), 'utf8');
  const timeoutMs = Math.max(config.PollIntervalSeconds, 10) * 1000;
  const requestOptions = {
    protocol: url.protocol,
    hostname: candidateIp,
    port: resolvePort(url, isHttps),
    path: '/rest/api/2/search',
    method: 'POST',
    family: net.isIP(candidateIp) === 6 ? 6 : 4,
    timeout: timeoutMs,
    agent: false,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${getTokenOrThrow(config)}`,
      'content-type': 'application/json',
      'content-length': requestBody.length,
      host: url.host
    },
    lookup(_hostname, _lookupOptions, callback) {
      callback(null, candidateIp, net.isIP(candidateIp));
    }
  };

  if (isHttps) {
    requestOptions.servername = url.hostname;
  }

  if (Object.hasOwn(options, 'ca')) {
    requestOptions.ca = options.ca;
  }

  if (Object.hasOwn(options, 'rejectUnauthorized')) {
    requestOptions.rejectUnauthorized = options.rejectUnauthorized;
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(requestOptions, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        responseBody += chunk;
      });
      response.on('end', () => {
        const contentType = getHeaderValue(response.headers, 'content-type');
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          reject(new HttpStatusError(response.statusCode ?? 0, response.statusMessage, responseBody));
          return;
        }

        try {
          const parsed = tryParseJsonResponse(responseBody, contentType);
          if (parsed === undefined) {
            reject(
              new Error(
                buildNonJsonSearchErrorMessage(
                  response.statusCode ?? 0,
                  response.statusMessage,
                  contentType,
                  responseBody
                )
              )
            );
            return;
          }

          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });

    request.on('timeout', () => {
      const error = new Error(`Request to Jira candidate ${candidateIp} timed out after ${timeoutMs} ms.`);
      error.code = 'ETIMEDOUT';
      error.isConnectionError = true;
      request.destroy(error);
    });

    request.on('error', error => {
      if (!(error instanceof HttpStatusError)) {
        error.isConnectionError = true;
      }
      reject(error);
    });

    request.write(requestBody);
    request.end();
  });
}

async function searchMatchingIssues(config, options = {}) {
  const logger = options.logger;
  const candidateIps = await resolveCandidateIps(config, options);
  const failures = [];

  for (const candidateIp of candidateIps) {
    try {
      const searchResponse = await postSearchRequest(config, candidateIp, options);
      const issues = Array.isArray(searchResponse?.issues) ? searchResponse.issues : [];
      const syncedIssues = sortIssues(issues);

      if (logger?.info) {
        logger.info(
          'Jira query returned %d issue(s) linked to epic %s.',
          syncedIssues.length,
          config.LinkedEpicKey
        );
      }

      return syncedIssues;
    } catch (error) {
      if (!error?.isConnectionError) {
        throw error;
      }

      failures.push(error);
    }
  }

  throw new AggregateError(failures, 'Failed to connect to Jira via all resolved internal IPs.');
}

class JiraPollingService {
  constructor(config, options = {}) {
    validatePollingConfig(config);
    this.config = config;
    this.logger = options.logger ?? createConsoleLogger();
    this.searchIssues = options.searchIssues ?? searchMatchingIssues;
    this.transportOptions = options.transportOptions ?? {};
    this.onSync = options.onSync;
    this.previousIssueMap = new Map();
  }

  async start(options = {}) {
    const once = options.once === true;
    const signal = options.signal;

    this.logger.info(
      'Starting Jira polling service for board %s. Polling every %d seconds with JQL: %s',
      this.config.BoardUrl,
      this.config.PollIntervalSeconds,
      buildJql(this.config)
    );

    await this.pollOnce(signal);
    if (once) {
      return;
    }

    while (!signal?.aborted) {
      await delay(this.config.PollIntervalSeconds * 1000, undefined, { signal });
      await this.pollOnce(signal);
    }
  }

  async pollOnce(signal) {
    if (signal?.aborted) {
      throw new Error('Polling aborted before request started.');
    }

    try {
      const issues = await this.searchIssues(this.config, {
        ...this.transportOptions,
        logger: this.logger,
        signal
      });

      const currentIssueMap = buildCurrentIssueMap(issues);
      const { newKeys, changedKeys, removedKeys } = diffIssueMaps(
        this.previousIssueMap,
        currentIssueMap
      );

      const eligibleIssueKeys = issues.filter(issue => issueMatchesFilter(issue, this.config)).map(issue => issue.key);

      this.logger.info(
        'Poll complete. %d synced issue(s) currently found on epic %s. %d eligible for AI execution.',
        issues.length,
        this.config.LinkedEpicKey,
        eligibleIssueKeys.length
      );

      for (const issue of issues) {
        this.logger.info(
          'Synced: %s | %s | %s | Updated %s',
          issue.key,
          issue.fields?.summary ?? '(No summary)',
          issue.fields?.status?.name ?? 'unknown',
          issue.fields?.updated ?? 'unknown'
        );
      }

      for (const issueKey of newKeys) {
        this.logger.info('New matching issue detected: %s', issueKey);
      }

      for (const issueKey of removedKeys) {
        this.logger.info('Issue no longer matches filter: %s', issueKey);
      }

      for (const issueKey of changedKeys) {
        this.logger.info('Issue changed on linked epic: %s', issueKey);
      }

      for (const issueKey of eligibleIssueKeys) {
        this.logger.info(
          'Eligible for AI execution: %s (status %s, label %s)',
          issueKey,
          this.config.RequiredStatus,
          this.config.RequiredLabel || '(none)'
        );
      }

      this.previousIssueMap = currentIssueMap;
      await this.onSync?.({
        issues,
        newKeys,
        removedKeys,
        changedKeys,
        eligibleIssueKeys
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }

      this.logger.error('Jira polling iteration failed. %s', error instanceof Error ? error.stack ?? error.message : String(error));
    }
  }
}

module.exports = {
  DEFAULT_CONFIG,
  HttpStatusError,
  JiraPollingService,
  buildJql,
  createConsoleLogger,
  createPollingConfig,
  escapeJql,
  getTokenOrThrow,
  issueMatchesFilter,
  loadPollingConfig,
  normalizeIssueKey,
  postSearchRequest,
  resolveCandidateIps,
  searchMatchingIssues,
  sortIssues,
  validatePollingConfig
};