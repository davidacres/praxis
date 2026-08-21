import type {
  BoardColumn,
  IssueAttachment,
  IssueComment,
  IssueSummary,
  LinkedIssueReference,
  ParentIssueReference,
  Project,
  WorkflowTransition
} from '../types';
import { buildBoardColumns as coreBuildBoardColumns } from '../board/boardColumns';

export { commonStatusRank } from '../board/boardColumns';

/**
 * Recursive JSON value type used across the codebase for tool result
 * normalisation. The MCP tools the Jira servers emit are typed loosely so each
 * helper walks the shape defensively.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

export function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function deriveBrowseUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/$/, '')}/browse/${key}`;
}

/**
 * Walk an Atlassian Document Format payload (or a plain string) and produce a
 * flat, human-readable description. Strings are returned untouched. Arrays and
 * ADF nodes are visited recursively, collecting `text` and `content` arrays.
 */
export function extractDescription(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractDescription).filter((item): item is string => Boolean(item)).join(' ');
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const parts: string[] = [];
  if (typeof value.text === 'string') {
    parts.push(value.text);
  }
  if (Array.isArray(value.content)) {
    for (const child of value.content) {
      const text = extractDescription(child);
      if (text) {
        parts.push(text);
      }
    }
  }

  const joined = parts.join(' ').replaceAll(/\s+/g, ' ').trim();
  return joined.length > 0 ? joined : undefined;
}

function normalizeUserDisplayName(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  return asString(raw.displayName) ?? asString(raw.name) ?? asString(raw.key);
}

function buildJiraMention(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const accountId = asString(raw.accountId)?.trim();
  if (accountId) {
    return `[~accountid:${accountId}]`;
  }

  const userName = asString(raw.name)?.trim() || asString(raw.key)?.trim();
  if (userName) {
    return `[~${userName}]`;
  }

  return undefined;
}

export function normalizeParentIssue(raw: unknown): ParentIssueReference | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const key = asString(raw.key);
  if (!key) {
    return undefined;
  }

  const fields = isRecord(raw.fields) ? raw.fields : raw;
  const issueType = isRecord(fields.issuetype)
    ? asString(fields.issuetype.name)
    : asString(fields.issuetype);

  return {
    key,
    summary: asString(fields.summary),
    issueType,
    description: extractDescription(fields.description)
  };
}

export function normalizeProject(raw: unknown): Project | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const key = asString(raw.key);
  const name = asString(raw.name) ?? key;
  if (!key || !name) {
    return undefined;
  }
  return {
    id: asString(raw.id),
    key,
    name
  };
}

export function normalizeIssue(raw: unknown, baseUrl: string): IssueSummary | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const fields = isRecord(raw.fields) ? raw.fields : raw;
  const project = isRecord(fields.project) ? fields.project : {};
  const status = isRecord(fields.status) ? fields.status : {};
  const issueType = isRecord(fields.issuetype) ? fields.issuetype : {};
  const parent = isRecord(fields.parent) ? fields.parent : {};
  const assignee = isRecord(fields.assignee) ? fields.assignee : {};
  const reporter = isRecord(fields.reporter) ? fields.reporter : {};
  const priority = isRecord(fields.priority) ? fields.priority : {};
  const key = asString(raw.key);

  if (!key) {
    return undefined;
  }

  return {
    id: asString(raw.id),
    key,
    summary: asString(fields.summary) ?? '(No summary)',
    status: asString(status.name) ?? asString(fields.status) ?? 'Unknown',
    statusCategory: isRecord(status.statusCategory)
      ? asString(status.statusCategory.name)
      : undefined,
    issueType: asString(issueType.name) ?? asString(fields.issuetype) ?? 'Issue',
    projectKey: asString(project.key) ?? '',
    projectName: asString(project.name),
    parentKey: asString(parent.key),
    parentIssue: normalizeParentIssue(parent),
    assignee: normalizeUserDisplayName(assignee),
    reporter: normalizeUserDisplayName(reporter),
    reporterMention: buildJiraMention(reporter),
    priority: asString(priority.name),
    created: asString(fields.created),
    updated: asString(fields.updated),
    selfUrl: asString(raw.self),
    browseUrl: deriveBrowseUrl(baseUrl, key),
    description: extractDescription(fields.description),
    raw
  };
}

export function normalizeTransition(raw: unknown): WorkflowTransition | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const to = isRecord(raw.to) ? raw.to : {};
  const id = asString(raw.id);
  const name = asString(raw.name);
  if (!id || !name) {
    return undefined;
  }
  return {
    id,
    name,
    toStatus: asString(to.name),
    raw
  };
}

export function normalizeComment(raw: unknown): IssueComment | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const author = isRecord(raw.author) ? raw.author : {};
  const body = extractDescription(raw.body) ?? asString(raw.body);
  if (!body?.trim()) {
    return undefined;
  }
  return {
    id: asString(raw.id),
    author: asString(author.displayName) ?? asString(author.name),
    body: body.trim(),
    created: asString(raw.created),
    updated: asString(raw.updated),
    raw
  };
}

export function normalizeAttachment(raw: unknown): IssueAttachment | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const fileName = asString(raw.filename) ?? asString(raw.fileName);
  if (!fileName?.trim()) {
    return undefined;
  }

  const author = isRecord(raw.author) ? raw.author : {};
  const sizeValue = typeof raw.size === 'number'
    ? raw.size
    : typeof raw.size === 'string'
      ? Number(raw.size)
      : undefined;

  return {
    id: asString(raw.id),
    fileName: fileName.trim(),
    mimeType: asString(raw.mimeType),
    sizeBytes: typeof sizeValue === 'number' && Number.isFinite(sizeValue) ? sizeValue : undefined,
    contentUrl: asString(raw.content),
    thumbnailUrl: asString(raw.thumbnail),
    created: asString(raw.created),
    author: asString(author.displayName) ?? asString(author.name),
    raw
  };
}

function deriveLinkedReferenceKey(title: string | undefined, url: string | undefined): string | undefined {
  const trimmedTitle = title?.trim();
  if (trimmedTitle) {
    const issueKeyMatch = /\b[A-Z][A-Z0-9_]+-\d+\b/.exec(trimmedTitle);
    return issueKeyMatch?.[0] ?? trimmedTitle;
  }

  const trimmedUrl = url?.trim();
  if (!trimmedUrl) {
    return undefined;
  }

  const browseMatch = /\/browse\/([^/?#]+)/i.exec(trimmedUrl);
  if (browseMatch?.[1]) {
    return decodeURIComponent(browseMatch[1]);
  }

  try {
    const parsed = new URL(trimmedUrl);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
    return lastSegment ? decodeURIComponent(lastSegment) : trimmedUrl;
  } catch {
    return trimmedUrl;
  }
}

export function normalizeIssueLink(raw: unknown, baseUrl: string): LinkedIssueReference | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const type = isRecord(raw.type) ? raw.type : {};
  const outwardIssue = isRecord(raw.outwardIssue) ? raw.outwardIssue : undefined;
  const inwardIssue = isRecord(raw.inwardIssue) ? raw.inwardIssue : undefined;
  const linkedIssue = outwardIssue ?? inwardIssue;
  if (!linkedIssue) {
    return undefined;
  }

  const key = asString(linkedIssue.key)?.trim();
  if (!key) {
    return undefined;
  }

  const fields = isRecord(linkedIssue.fields) ? linkedIssue.fields : {};
  const status = isRecord(fields.status) ? fields.status : {};
  const issueType = isRecord(fields.issuetype) ? fields.issuetype : {};
  const relationship = outwardIssue
    ? asString(type.outward)?.trim() || asString(type.name)?.trim() || 'Linked issue'
    : asString(type.inward)?.trim() || asString(type.name)?.trim() || 'Linked issue';

  return {
    key,
    summary: asString(fields.summary)?.trim(),
    issueType: asString(issueType.name)?.trim(),
    status: asString(status.name)?.trim(),
    relationship,
    browseUrl: deriveBrowseUrl(baseUrl, key),
    raw
  };
}

export function normalizeRemoteIssueLink(raw: unknown): LinkedIssueReference | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const object = isRecord(raw.object) ? raw.object : {};
  const url = asString(object.url)?.trim();
  const title = asString(object.title)?.trim();
  const summary = asString(object.summary)?.trim();
  const relationship = asString(raw.relationship)?.trim() || 'Remote link';
  const key = deriveLinkedReferenceKey(title, url);

  if (!key && !summary && !url) {
    return undefined;
  }

  const status = isRecord(object.status)
    ? asString(object.status.title)?.trim() || asString(object.status.resolved)?.trim()
    : undefined;
  const effectiveKey = key ?? summary ?? url ?? 'Remote link';
  const effectiveSummary = summary && summary !== effectiveKey
    ? summary
    : title && title !== effectiveKey
      ? title
      : undefined;

  return {
    key: effectiveKey,
    summary: effectiveSummary,
    status,
    relationship,
    browseUrl: url,
    raw
  };
}

export function normalizeLinkedIssueReferences(
  fieldsObject: unknown,
  remoteLinksResponse: unknown,
  baseUrl: string
): LinkedIssueReference[] {
  const classicLinks = (isRecord(fieldsObject) ? toArray(fieldsObject.issuelinks) : [])
    .map(link => normalizeIssueLink(link, baseUrl))
    .filter((item): item is LinkedIssueReference => Boolean(item));
  const remoteLinks = toArray(remoteLinksResponse)
    .map(normalizeRemoteIssueLink)
    .filter((item): item is LinkedIssueReference => Boolean(item));

  const merged = [...classicLinks, ...remoteLinks];
  const seen = new Set<string>();

  return merged.filter(link => {
    const dedupeKey = `${link.relationship.toLowerCase()}|${link.browseUrl ?? ''}|${link.key.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      return false;
    }
    seen.add(dedupeKey);
    return true;
  });
}

/**
 * Some MCP servers wrap arrays inside an object payload (e.g. the
 * `atlassian-jira_search` response uses `{ issues, total, isLast }`). This
 * helper pulls the array out of the most common shapes.
 */
export function extractArray(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  for (const key of keys) {
    const candidate = isRecord(payload) ? payload[key] : undefined;
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  if (isRecord(payload) && Array.isArray(payload.values)) {
    return payload.values;
  }

  return [];
}

/**
 * Resolve the most likely lookup key for a raw Jira issue returned by either
 * the community `atlassian-jira_*` tools (root-level `key`) or the official
 * `mcp_com_atlassian_*` tools (which sometimes omit `key` from search hits).
 * Falls back to `id` when no key is present.
 */
export function extractIssueKey(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  return asString(raw.key) ?? asString(raw.id);
}

export function statusCategoryRank(statusCategory: string | undefined): number {
  const normalized = (statusCategory ?? '').trim().toLowerCase();
  if (normalized === 'to do' || normalized === 'todo') {
    return 0;
  }
  if (normalized === 'in progress' || normalized === 'indeterminate') {
    return 1;
  }
  if (normalized === 'done') {
    return 2;
  }
  return 3;
}

function appendUniqueStatusName(
  orderedStatuses: string[],
  seen: Set<string>,
  statusName: string | undefined
): void {
  const trimmed = statusName?.trim();
  if (!trimmed || seen.has(trimmed)) {
    return;
  }
  seen.add(trimmed);
  orderedStatuses.push(trimmed);
}

function isBacklogStatusName(statusName: string | undefined): boolean {
  const normalized = (statusName ?? '').trim().toLowerCase().replaceAll(/[\s_-]+/g, ' ');
  return normalized === 'backlog';
}

function normalizeFieldName(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replaceAll(/[\s_-]+/g, ' ');
}

/**
 * Match `getBackendBoardStatusOrder` from the renderer: the workflow statuses
 * are returned in the order they appear in the options array, falling back to
 * alphabetical sort by `statusCategory` then `name`.
 */
export function buildBoardStatusOrder(
  boardConfiguredStatuses: string[],
  workflowStatuses: string[],
  issueStatuses: string[]
): string[] {
  if (boardConfiguredStatuses.length > 0) {
    return [...boardConfiguredStatuses];
  }

  const orderedStatuses: string[] = [];
  const seen = new Set<string>();
  const backlogStatus = [...workflowStatuses, ...issueStatuses].find(statusName =>
    isBacklogStatusName(statusName)
  );

  if (backlogStatus) {
    appendUniqueStatusName(orderedStatuses, seen, backlogStatus);
  }

  for (const statusName of workflowStatuses) {
    appendUniqueStatusName(orderedStatuses, seen, statusName);
  }

  for (const statusName of issueStatuses) {
    appendUniqueStatusName(orderedStatuses, seen, statusName);
  }

  return orderedStatuses;
}

/**
 * Builds the columns shown in a Jira board. When `columnStatusOrder` is
 * supplied and non-empty, one column is emitted per canonical workflow status
 * (with an empty `issues: []` placeholder for statuses that have no current
 * issues) so drag-and-drop targets stay on screen even after the user moves
 * every ticket into a single status. When `columnStatusOrder` is omitted the
 * helper falls back to {@link coreBuildBoardColumns}'s rank-sorted behaviour
 * keyed off {@link statusCategoryRank}.
 */
export function buildBoardColumns(
  issues: IssueSummary[],
  columnStatusOrder?: readonly string[]
): BoardColumn[] {
  return coreBuildBoardColumns(issues, {
    columnStatusOrder,
    rankStatus: statusCategoryRank
  });
}

export { normalizeFieldName };
