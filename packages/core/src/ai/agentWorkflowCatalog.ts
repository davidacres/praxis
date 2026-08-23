import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { IssueDetails } from '../types';
import type { AgentWorkflowReference } from './agentTypes';

/**
 * Workflow-pack catalog: discovery, parsing and issue→pack matching.
 * Host-agnostic (moved from the extension in Phase F); the interactive picker
 * stays in each host's UI layer — the extension's `showQuickPick` wrapper lives
 * in `vscode-extension/src/ai/agentWorkflowCatalog.ts`, the desktop renders a
 * React modal over `discoverWorkspaceAgentWorkflows`.
 */

interface ParsedWorkflowMetadata {
  id: string;
  name: string;
  description?: string;
}

export interface AgentWorkflowResolution {
  workflow?: AgentWorkflowReference;
  reason?: string;
  recommendations: string[];
}

const MATCH_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'about', 'after',
  'before', 'issue', 'ticket', 'work', 'task', 'story', 'user', 'when', 'then', 'than',
  'able', 'need', 'make', 'using', 'used', 'have', 'has', 'had', 'should', 'would', 'could',
  'will', 'your', 'our', 'their', 'them', 'they', 'are', 'was', 'were', 'been', 'being'
]);

const WORKFLOW_THEMES = [
  {
    key: 'dotnet-api',
    issueTerms: ['dotnet', 'net', 'aspnet', 'asp net', 'csharp', 'api', 'rest', 'endpoint', 'controller'],
    workflowTerms: ['dotnet', 'net', 'aspnet', 'api', 'rest', 'endpoint', 'controller'],
    recommendation: '.NET Web API or backend service workflow'
  },
  {
    key: 'frontend-ui',
    issueTerms: ['ui', 'ux', 'frontend', 'react', 'page', 'screen', 'layout', 'component', 'css'],
    workflowTerms: ['ui', 'ux', 'frontend', 'react', 'page', 'screen', 'layout', 'component', 'css'],
    recommendation: 'UI or frontend implementation workflow'
  },
  {
    key: 'data',
    issueTerms: ['database', 'sql', 'schema', 'migration', 'query', 'persistence'],
    workflowTerms: ['database', 'sql', 'schema', 'migration', 'query', 'persistence'],
    recommendation: 'database or migration workflow'
  },
  {
    key: 'integration',
    issueTerms: ['integration', 'sync', 'webhook', 'jira', 'gitlab', 'github', 'api client'],
    workflowTerms: ['integration', 'sync', 'webhook', 'jira', 'gitlab', 'github', 'client'],
    recommendation: 'integration or external-system workflow'
  },
  {
    key: 'testing',
    issueTerms: ['test', 'testing', 'coverage', 'spec', 'regression', 'qa'],
    workflowTerms: ['test', 'testing', 'coverage', 'spec', 'regression', 'qa'],
    recommendation: 'testing or verification workflow'
  }
] as const;

function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function stripMarkdown(value: string): string {
  return value.replaceAll(/[`*_>#]/g, '').trim();
}

function normalizeForMatching(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('.net', ' dotnet ')
    .replaceAll('asp.net', ' aspnet ')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function tokenizeForMatching(value: string): string[] {
  return normalizeForMatching(value)
    .split(' ')
    .filter(token => token.length >= 2 && !MATCH_STOP_WORDS.has(token));
}

function includesAnyTerm(text: string, terms: readonly string[]): boolean {
  return terms.some(term => text.includes(normalizeForMatching(term)));
}

function unique<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function titleFromSlug(value: string): string {
  return value
    .split(/[-_]+/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function extractFrontmatter(text: string): string | undefined {
  const normalized = normalizeLineEndings(text);
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  return match?.[1];
}

function extractFrontmatterValue(frontmatter: string | undefined, key: string): string | undefined {
  if (!frontmatter) {
    return undefined;
  }
  const match = new RegExp(String.raw`^${key}:\s*(.+)$`, 'm').exec(frontmatter);
  return match?.[1]?.trim() || undefined;
}

function extractHeading(text: string): string | undefined {
  const normalized = normalizeLineEndings(text);
  const match = /^#\s+(.+)$/m.exec(normalized);
  return match?.[1] ? stripMarkdown(match[1]) : undefined;
}

function extractFirstParagraph(text: string): string | undefined {
  const normalized = normalizeLineEndings(text);
  const withoutFrontmatter = normalized.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '');
  const lines = withoutFrontmatter.split('\n');
  const paragraph: string[] = [];
  let seenHeading = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    if (trimmed.startsWith('#')) {
      seenHeading = true;
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    if (seenHeading || paragraph.length > 0) {
      paragraph.push(stripMarkdown(trimmed));
    }
  }

  return paragraph.join(' ').trim() || undefined;
}

function parseWorkflowMetadata(markdown: string, fallbackId: string): ParsedWorkflowMetadata {
  const frontmatter = extractFrontmatter(markdown);
  const id = extractFrontmatterValue(frontmatter, 'name') ?? fallbackId;
  const name = extractHeading(markdown) ?? titleFromSlug(id);
  const description = extractFrontmatterValue(frontmatter, 'description') ?? extractFirstParagraph(markdown);
  return {
    id,
    name,
    description
  };
}

function toStoredInstructionsPath(workspaceRoot: string | undefined, absoluteInstructionsPath: string): string {
  if (!workspaceRoot) {
    return absoluteInstructionsPath;
  }

  const relativePath = path.relative(workspaceRoot, absoluteInstructionsPath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return toPosixPath(relativePath);
  }
  return absoluteInstructionsPath;
}

async function resolveInstructionsFilePath(configuredPath: string): Promise<string | undefined> {
  try {
    const stats = await stat(configuredPath);
    if (stats.isDirectory()) {
      const candidate = path.join(configuredPath, 'SKILL.md');
      const candidateStats = await stat(candidate);
      return candidateStats.isFile() ? candidate : undefined;
    }
    return stats.isFile() ? configuredPath : undefined;
  } catch {
    return undefined;
  }
}

/** Two references match when they share an instructions path or an id. */
export function matchesWorkflow(left: AgentWorkflowReference, right: AgentWorkflowReference | undefined): boolean {
  return Boolean(
    right && (left.instructionsPath === right.instructionsPath || left.id === right.id)
  );
}

function getWorkflowReferenceCandidates(workflow: AgentWorkflowReference): string[] {
  return [workflow.id, workflow.name, workflow.instructionsPath, workflow.link]
    .filter((value): value is string => Boolean(value?.trim()));
}

function buildWorkflowSearchText(workflow: AgentWorkflowReference): string {
  return [workflow.id, workflow.name, workflow.description, workflow.instructionsPath]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

function scoreWorkflow(
  issueText: string,
  issueTokens: Set<string>,
  workflow: AgentWorkflowReference
): { score: number; reasons: string[] } {
  const workflowText = normalizeForMatching(buildWorkflowSearchText(workflow));
  const workflowTokens = new Set(tokenizeForMatching(buildWorkflowSearchText(workflow)));
  const overlap = [...workflowTokens].filter(token => issueTokens.has(token));
  let score = overlap.length;
  const reasons = overlap.slice(0, 5);

  for (const theme of WORKFLOW_THEMES) {
    if (includesAnyTerm(issueText, theme.issueTerms) && includesAnyTerm(workflowText, theme.workflowTerms)) {
      score += 3;
      reasons.push(theme.recommendation);
    }
  }

  return {
    score,
    reasons: unique(reasons)
  };
}

function recommendWorkflowTypes(issue: Pick<IssueDetails, 'issueType' | 'summary' | 'description'>): string[] {
  const issueText = normalizeForMatching(
    [issue.issueType, issue.summary, issue.description].filter((value): value is string => Boolean(value)).join(' ')
  );
  const recommendations: string[] = WORKFLOW_THEMES
    .filter(theme => includesAnyTerm(issueText, theme.issueTerms))
    .map(theme => theme.recommendation);

  if (recommendations.length === 0) {
    recommendations.push('general implementation workflow for this project stack');
  }

  return unique(recommendations).slice(0, 3);
}

export function resolveRelevantAgentWorkflow(options: {
  issue: Pick<IssueDetails, 'issueType' | 'summary' | 'description'>;
  workflows: AgentWorkflowReference[];
}): AgentWorkflowResolution {
  const issueText = normalizeForMatching(
    [options.issue.issueType, options.issue.summary, options.issue.description]
      .filter((value): value is string => Boolean(value))
      .join(' ')
  );
  const issueTokens = new Set(tokenizeForMatching(issueText));
  const recommendations = recommendWorkflowTypes(options.issue);

  let bestMatch: { workflow: AgentWorkflowReference; score: number; reasons: string[] } | undefined;
  for (const workflow of options.workflows) {
    const scored = scoreWorkflow(issueText, issueTokens, workflow);
    if (!bestMatch || scored.score > bestMatch.score) {
      bestMatch = {
        workflow,
        score: scored.score,
        reasons: scored.reasons
      };
    }
  }

  if (!bestMatch || bestMatch.score < 3) {
    return {
      workflow: undefined,
      recommendations
    };
  }

  return {
    workflow: bestMatch.workflow,
    reason: bestMatch.reasons.length > 0
      ? `Matched on ${bestMatch.reasons.join(', ')}`
      : 'Matched from issue summary and workflow metadata',
    recommendations
  };
}

export function resolveWorkflowReference(
  reference: string | undefined,
  workflows: AgentWorkflowReference[]
): AgentWorkflowReference | undefined {
  const trimmedReference = reference?.trim();
  if (!trimmedReference) {
    return undefined;
  }

  const normalizedReference = normalizeForMatching(trimmedReference);
  const exactMatches = workflows.filter(workflow =>
    getWorkflowReferenceCandidates(workflow).some(candidate => normalizeForMatching(candidate) === normalizedReference)
  );
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  const partialMatches = workflows.filter(workflow =>
    getWorkflowReferenceCandidates(workflow).some(candidate => {
      const normalizedCandidate = normalizeForMatching(candidate);
      return normalizedReference.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedReference);
    })
  );
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  return undefined;
}

export async function resolveConfiguredAgentWorkflow(options: {
  workspaceRoot?: string;
  configuredPath?: string;
  workflowUrl?: string;
}): Promise<AgentWorkflowReference | undefined> {
  const rawPath = options.configuredPath?.trim();
  if (!rawPath) {
    return undefined;
  }

  const absolutePath = options.workspaceRoot && !path.isAbsolute(rawPath)
    ? path.join(options.workspaceRoot, rawPath)
    : rawPath;
  const instructionsFilePath = await resolveInstructionsFilePath(absolutePath);
  if (!instructionsFilePath) {
    return undefined;
  }

  const markdown = await readFile(instructionsFilePath, 'utf8');
  const metadata = parseWorkflowMetadata(
    markdown,
    path.basename(path.dirname(instructionsFilePath))
  );

  return {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    instructionsPath: toStoredInstructionsPath(options.workspaceRoot, instructionsFilePath),
    link: options.workflowUrl?.trim() || undefined
  };
}

export async function discoverWorkspaceAgentWorkflows(
  workspaceRoot: string | undefined
): Promise<AgentWorkflowReference[]> {
  if (!workspaceRoot) {
    return [];
  }

  const skillsRoot = path.join(workspaceRoot, '.github', 'skills');
  try {
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    const workflows = await Promise.all(
      entries
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
        .map(entry =>
          resolveConfiguredAgentWorkflow({
            workspaceRoot,
            configuredPath: path.join(skillsRoot, entry.name)
          })
        )
    );

    return workflows
      .filter((workflow): workflow is AgentWorkflowReference => Boolean(workflow))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}
