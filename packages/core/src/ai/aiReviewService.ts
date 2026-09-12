import type { IssueDetails } from '../types';
import type { AgentWorkflowReference } from './agentTypes';
import { AnalysisCancelledError as GatewayAnalysisCancelledError, runGatewayPrompt } from './gatewayPrompt';
import {
  computeFindingFingerprint,
  type CheckFinding,
  type CheckFindings,
  type CheckFindingSeverity
} from '../workflows/workflowTypes';

const REVIEW_SYSTEM_PROMPT = `You are a technical product manager reviewing tickets for completeness and quality.
Analyze the ticket and provide concise, actionable feedback on:
1. Clarity of the problem statement or goal
2. Completeness of requirements or acceptance criteria
3. Technical details or context that may be missing
4. Any ambiguities that should be resolved before work begins

Be constructive and specific. Format your response in markdown. If the ticket is well-defined, say so briefly.`;

const CODE_REVIEW_SYSTEM_PROMPT = `You are a senior software engineer performing a code review.
Analyze the ticket requirements and any implementation context to provide feedback on:
1. Code quality, maintainability, and readability
2. Potential bugs, edge cases, or logic errors
3. Design patterns and architectural concerns
4. Test coverage gaps
5. Performance considerations

Be specific, reference code locations when possible, and rate severity (critical/major/minor/suggestion).
Format your response in markdown with clear sections.`;

export const STRUCTURED_CODE_REVIEW_SYSTEM_PROMPT = `You are a senior software engineer performing a structured code review.
Review the code changes and requirements. Return your review as exactly one fenced JSON code block in this format:

\`\`\`json
{
  "summary": "Concise summary of your overall assessment",
  "findings": [
    {
      "file": "path/to/file",
      "line": 42,
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "category": "bug" | "security" | "quality" | "performance" | "maintainability",
      "message": "Specific explanation of the issue",
      "suggestion": "Concrete actionable suggestion for how to fix"
    }
  ],
  "metrics": {
    "filesReviewed": 5,
    "issuesFound": 1
  }
}
\`\`\`

Rules:
- You must include the fenced JSON block with "findings" array, even if empty (0 findings).
- You may include concise prose summary outside the JSON block.
- Each finding must specify valid severity (critical/high/medium/low/info).
- Line numbers must be positive integers where applicable.
`;

const SECURITY_REVIEW_SYSTEM_PROMPT = `You are a security engineer performing a security review.
Analyze the ticket and its implementation context for:
1. OWASP Top 10 vulnerabilities (injection, XSS, CSRF, etc.)
2. Authentication and authorization issues
3. Data exposure or privacy risks
4. Input validation gaps
5. Dependency or supply chain concerns
6. Secrets or credential handling

Rate each finding by severity (critical/high/medium/low/info).
Format your response in markdown with clear sections. If no security issues are found, state that clearly.`;

const LPR_SUMMARY_SYSTEM_PROMPT = `You are a technical lead writing a concise peer review summary.
Given a code review and security review, provide:
1. Overall assessment (Ready / Needs Changes / Needs Major Rework)
2. Key findings summary (3-5 bullet points)
3. Recommended next steps

Be concise and actionable. Format in markdown.`;

const GATEWAY_COMMENT_SYSTEM_PROMPT = `You are an AI assistant replying inside a ticket discussion.
Respond directly to the user's request using the ticket details and recent comments as context.
Be concise, practical, and collaborative.
Do not claim to have taken actions you did not take.
Format the response in markdown suitable for posting as a ticket comment.`;

const GATEWAY_CLARIFICATION_SYSTEM_PROMPT = `You are an AI assistant reviewing a ticket before implementation starts.

Workflow packs are OPTIONAL. A ticket is allowed to proceed with no workflow pack assigned.
Never ask the user to assign a workflow pack, never suggest workflow packs, and never block
on workflow pack selection. Do not infer or auto-pick a workflow pack from the technical
content of the ticket.

Only populate "workflowReference" when one of these is true:
  (a) A workflow pack is already assigned in Praxis — echo its id.
  (b) The ticket description or a comment explicitly names one of the available workflow packs
      (e.g. a line like "Workflow pack: add-edit-dotnet-web-api"). Wording such as
      "use no workflow", "no workflow pack", or the absence of any such line means no workflow
      pack — leave "workflowReference" blank and still return status "ready" if the rest of
      the ticket is clear enough to implement.

Return exactly one JSON code block and nothing else.

Schema:
{
  "status": "ready" | "needs_clarification",
  "workflowReference": "optional — only set when the ticket or Praxis explicitly names a workflow pack",
  "comment": "required when status is needs_clarification"
}

Rules:
- status must be "ready" when the ticket is specific enough to implement safely, regardless
  of whether a workflow pack is assigned.
- status must be "needs_clarification" only when there are genuine missing technical or
  scope details that would force risky assumptions during implementation. Missing workflow
  pack assignment is NEVER by itself a reason for clarification.
- comment must be a concise Jira-ready plain-text comment body listing the missing
  non-workflow details. Do not mention workflow packs in the comment.
- Do not include markdown headings, code fences outside the single JSON block, rationale,
tool output, or claims that work has started.`;
const GATEWAY_TASK_DESIGNER_RECOMMENDATION_SYSTEM_PROMPT = `You are an execution-planning assistant for a task designer canvas.
Return exactly one JSON code block and nothing else.

Schema:
{
  "orderedNodeIds": ["required ordered list of canvas node ids"],
  "connectors": [
    {
      "sourceNodeId": "canvas node id",
      "targetNodeId": "canvas node id"
    }
  ],
  "rationale": "optional short explanation"
}

Rules:
- Include every known node id exactly once in orderedNodeIds.
- Keep connector directions forward according to orderedNodeIds.
- Do not create self-links.
- Prefer the minimum connectors needed for a clear start-to-finish flow.
- Never include markdown outside the single JSON code block.`;

const GATEWAY_REPLY_COMMENT_LIMIT = 8;

export interface ReviewStreamOptions {
  onUpdate?: (content: string) => void;
  model?: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  apiKey?: string;
  gatewayUrl?: string;
}

export const ANALYSIS_CANCELLED_MESSAGE = 'Analysis cancelled.';

export class AnalysisCancelledError extends GatewayAnalysisCancelledError {
  public constructor() {
    super(ANALYSIS_CANCELLED_MESSAGE);
  }
}

export function buildTicketContext(
  issue: IssueDetails,
  options?: { recentCommentLimit?: number; newestComments?: boolean; commentBodyLimit?: number }
): string {
  const parts: string[] = [];
  const recentCommentLimit = options?.recentCommentLimit ?? 5;
  const newestComments = options?.newestComments ?? false;
  const commentBodyLimit = options?.commentBodyLimit ?? 600;
  parts.push(`**Ticket:** ${issue.key}`);
  parts.push(`**Type:** ${issue.issueType}`);
  parts.push(`**Summary:** ${issue.summary}`);
  if (issue.status) {
    parts.push(`**Status:** ${issue.status}`);
  }
  if (issue.priority) {
    parts.push(`**Priority:** ${issue.priority}`);
  }
  if (issue.severity) {
    parts.push(`**Severity:** ${issue.severity}`);
  }
  if (issue.complexity) {
    parts.push(`**Complexity:** ${issue.complexity}`);
  }
  if (issue.assignee) {
    parts.push(`**Assignee:** ${issue.assignee}`);
  }
  if (issue.reporter) {
    parts.push(`**Reporter:** ${issue.reporter}`);
  } else if (issue.reportedBy) {
    parts.push(`**Reported By:** ${issue.reportedBy}`);
  }
  if (issue.created) {
    parts.push(`**Created:** ${issue.created}`);
  }
  if (issue.updated) {
    parts.push(`**Updated:** ${issue.updated}`);
  }
  if (issue.branch) {
    parts.push(`**Branch:** ${issue.branch}`);
  }
  if (issue.parentIssue) {
    parts.push(`**Parent:** ${issue.parentIssue.key}${issue.parentIssue.summary ? ` — ${issue.parentIssue.summary}` : ''}`);
  }
  if (issue.dependsOn && issue.dependsOn.length > 0) {
    parts.push(`**Depends On:** ${issue.dependsOn.join(', ')}`);
  }
  if (issue.description?.trim()) {
    parts.push(`\n**Description:**\n${issue.description.trim()}`);
  } else {
    parts.push('\n**Description:** *(none)*');
  }
  if (issue.ideaTranscript?.trim()) {
    const transcript = issue.ideaTranscript.trim();
    const truncatedTranscript = transcript.length > 2000 ? `${transcript.slice(0, 2000)}… *(truncated)*` : transcript;
    parts.push(`\n**Idea Transcript:**\n${truncatedTranscript}`);
  }
  if (issue.linkedIssues && issue.linkedIssues.length > 0) {
    parts.push(`\n**Linked Issues (${issue.linkedIssues.length}):**`);
    for (const link of issue.linkedIssues) {
      const statusPart = link.status ? ` [${link.status}]` : '';
      const summaryPart = link.summary ? ` — ${link.summary}` : '';
      parts.push(`- ${link.relationship} ${link.key}${summaryPart}${statusPart}`);
    }
  }
  if (issue.subTasks && issue.subTasks.length > 0) {
    parts.push(`\n**Sub-Tasks (${issue.subTasks.length}):**`);
    for (const task of issue.subTasks) {
      const assigneePart = task.assignee ? ` (${task.assignee})` : '';
      parts.push(`- ${task.key}: ${task.summary} [${task.status}]${assigneePart}`);
    }
  }
  if (issue.comments && issue.comments.length > 0) {
    const limit = Math.min(recentCommentLimit, issue.comments.length);
    const visibleComments = newestComments ? issue.comments.slice(-limit) : issue.comments.slice(0, limit);
    parts.push(`\n**${newestComments ? 'Recent comments' : 'Comments'} (${issue.comments.length} total, showing ${limit}):**`);
    for (const comment of visibleComments) {
      const author = comment.author ?? 'Unknown';
      const body = comment.body.length > commentBodyLimit ? `${comment.body.slice(0, commentBodyLimit)}…` : comment.body;
      parts.push(`- **${author}:** ${body}`);
    }
  }
  if (issue.attachments && issue.attachments.length > 0) {
    parts.push(`\n**Attachments (${issue.attachments.length}):**`);
    for (const attachment of issue.attachments) {
      const size = typeof attachment.sizeBytes === 'number'
        ? ` (${Math.round(attachment.sizeBytes / 1024)} KB)`
        : '';
      parts.push(`- ${attachment.fileName}${size}${attachment.mimeType ? ` [${attachment.mimeType}]` : ''}`);
    }
  }
  return parts.join('\n');
}

async function extractApiError(response: Response, providerLabel: string): Promise<string> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof (parsed as { error: unknown }).error === 'object' &&
      (parsed as { error: unknown }).error !== null
    ) {
      const msg = ((parsed as { error: Record<string, unknown> }).error).message;
      if (typeof msg === 'string' && msg.trim()) {
        return msg;
      }
    }
  } catch {
    // fall through to default
  }
  return `${providerLabel} API error (${response.status})`;
}

async function consumeSseStream(
  response: Response,
  onEvent: (eventName: string, data: string) => void
): Promise<void> {
  if (!response.body) {
    throw new Error('Streaming response body was unavailable.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      let eventName = 'message';
      const dataLines: string[] = [];
      for (const rawLine of rawEvent.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (!line || line.startsWith(':')) {
          continue;
        }
        if (line.startsWith('event:')) {
          eventName = line.slice('event:'.length).trim() || 'message';
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trimStart());
        }
      }

      if (dataLines.length > 0) {
        onEvent(eventName, dataLines.join('\n'));
      }

      separatorIndex = buffer.indexOf('\n\n');
    }

    if (done) {
      const trailing = buffer.trim();
      if (trailing.length > 0) {
        let eventName = 'message';
        const dataLines: string[] = [];
        for (const rawLine of trailing.split(/\r?\n/)) {
          const line = rawLine.trimEnd();
          if (!line || line.startsWith(':')) {
            continue;
          }
          if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim() || 'message';
            continue;
          }
          if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trimStart());
          }
        }
        if (dataLines.length > 0) {
          onEvent(eventName, dataLines.join('\n'));
        }
      }
      break;
    }
  }
}

async function runReviewGatewayPrompt(
  prompt: string,
  options: {
    apiKey?: string;
    gatewayUrl?: string;
    systemPrompt: string;
    onUpdate?: (content: string) => void;
    model?: string;
    signal?: AbortSignal;
  }
): Promise<string> {
  try {
    return await runGatewayPrompt(prompt, {
      apiKey: options.apiKey,
      gatewayUrl: options.gatewayUrl,
      systemPrompt: options.systemPrompt,
      onUpdate: options.onUpdate,
      model: options.model,
      signal: options.signal
    });
  } catch (error) {
    if (error instanceof GatewayAnalysisCancelledError) {
      throw new AnalysisCancelledError();
    }
    throw error;
  }
}

function normalizeClarificationText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll(/^#{1,6}\s*/gm, '')
    .replaceAll(/\*\*(.*?)\*\*/g, '$1')
    .replaceAll(/\*(.*?)\*/g, '$1')
    .replaceAll(/`([^`]+)`/g, '$1')
    .trim();
}

function buildWorkflowPromptContext(workflows: AgentWorkflowReference[]): string {
  if (workflows.length === 0) {
    return 'Available workflow packs: none currently discovered in the workspace.';
  }

  return [
    'Available workflow packs:',
    ...workflows.map(workflow => {
      const lines = [
        `- Name: ${workflow.name}`,
        `  Id: ${workflow.id}`,
        `  File: ${workflow.instructionsPath}`
      ];
      if (workflow.link) {
        lines.push(`  Link: ${workflow.link}`);
      }
      return lines.join('\n');
    })
  ].join('\n');
}

function extractJsonCodeBlock(text: string): string | undefined {
  const match = /```json\s*([\s\S]*?)```/i.exec(text);
  return match?.[1]?.trim();
}

function normalizeClarificationComment(text: string): string | undefined {
  const normalized = text
    .replaceAll('\r\n', '\n')
    .replaceAll(/^```(?:json|markdown|text)?\s*/gim, '')
    .replaceAll(/```$/gim, '')
    .trim();
  return normalized || undefined;
}

export interface CopilotImplementationReadinessAssessment {
  status: 'ready' | 'needs_clarification';
  workflowReference?: string;
  clarificationComment?: string;
}

export interface TaskDesignerRecommendationNode {
  id: string;
  issueKey: string;
  summary: string;
  issueType: string;
  status: string;
  assignee?: string;
  priority?: string;
  projectKey: string;
}

export interface TaskDesignerRecommendationConnector {
  sourceNodeId: string;
  targetNodeId: string;
}

export interface TaskDesignerFlowRecommendation {
  orderedNodeIds: string[];
  connectors: TaskDesignerRecommendationConnector[];
  rationale?: string;
}

function extractJsonPayload(text: string): string | undefined {
  const codeBlock = extractJsonCodeBlock(text);
  if (codeBlock) {
    return codeBlock;
  }

  const trimmed = text.trim();
  return trimmed.startsWith('{') ? trimmed : undefined;
}

export function parseTaskDesignerFlowRecommendation(
  text: string | undefined,
  nodes: readonly TaskDesignerRecommendationNode[]
): TaskDesignerFlowRecommendation | undefined {
  if (!text?.trim()) {
    return undefined;
  }

  const payload = extractJsonPayload(text);
  if (!payload) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  const byId = new Map(nodes.map(node => [node.id, node]));
  const originalNodeOrder = nodes.map(node => node.id);
  const candidate = parsed as {
    orderedNodeIds?: unknown;
    connectors?: unknown;
    rationale?: unknown;
  };

  const orderedNodeIds: string[] = [];
  const seenNodeIds = new Set<string>();
  if (Array.isArray(candidate.orderedNodeIds)) {
    for (const nodeId of candidate.orderedNodeIds) {
      if (typeof nodeId !== 'string') {
        continue;
      }
      const normalizedNodeId = nodeId.trim();
      if (!normalizedNodeId || seenNodeIds.has(normalizedNodeId) || !byId.has(normalizedNodeId)) {
        continue;
      }
      seenNodeIds.add(normalizedNodeId);
      orderedNodeIds.push(normalizedNodeId);
    }
  }
  for (const nodeId of originalNodeOrder) {
    if (!seenNodeIds.has(nodeId)) {
      seenNodeIds.add(nodeId);
      orderedNodeIds.push(nodeId);
    }
  }

  if (orderedNodeIds.length !== nodes.length) {
    return undefined;
  }

  const orderIndex = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index]));
  const connectors: TaskDesignerRecommendationConnector[] = [];
  const seenConnectors = new Set<string>();
  if (Array.isArray(candidate.connectors)) {
    for (const connector of candidate.connectors) {
      if (!connector || typeof connector !== 'object' || Array.isArray(connector)) {
        continue;
      }

      const sourceNodeId = typeof (connector as { sourceNodeId?: unknown }).sourceNodeId === 'string'
        ? (connector as { sourceNodeId: string }).sourceNodeId.trim()
        : '';
      const targetNodeId = typeof (connector as { targetNodeId?: unknown }).targetNodeId === 'string'
        ? (connector as { targetNodeId: string }).targetNodeId.trim()
        : '';
      if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
        continue;
      }
      if (!orderIndex.has(sourceNodeId) || !orderIndex.has(targetNodeId)) {
        continue;
      }
      if ((orderIndex.get(sourceNodeId) ?? 0) >= (orderIndex.get(targetNodeId) ?? 0)) {
        continue;
      }

      const key = `${sourceNodeId}\u0000${targetNodeId}`;
      if (seenConnectors.has(key)) {
        continue;
      }
      seenConnectors.add(key);
      connectors.push({ sourceNodeId, targetNodeId });
    }
  }

  if (connectors.length === 0) {
    for (let index = 0; index < orderedNodeIds.length - 1; index += 1) {
      connectors.push({
        sourceNodeId: orderedNodeIds[index],
        targetNodeId: orderedNodeIds[index + 1]
      });
    }
  }

  const rationale = typeof candidate.rationale === 'string' && candidate.rationale.trim().length > 0
    ? candidate.rationale.trim()
    : undefined;

  return {
    orderedNodeIds,
    connectors,
    rationale
  };
}

export function parseCopilotImplementationReadinessAssessment(
  text: string | undefined
): CopilotImplementationReadinessAssessment | undefined {
  if (!text?.trim()) {
    return undefined;
  }

  const jsonText = extractJsonCodeBlock(text);
  if (!jsonText) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const candidate = parsed as Record<string, unknown>;
  const status = candidate.status === 'ready' || candidate.status === 'needs_clarification'
    ? candidate.status
    : undefined;
  const workflowReference = typeof candidate.workflowReference === 'string'
    ? candidate.workflowReference.trim() || undefined
    : undefined;
  const clarificationComment = typeof candidate.comment === 'string'
    ? normalizeClarificationComment(candidate.comment)
    : undefined;

  if (!status) {
    return undefined;
  }
  if (status === 'needs_clarification' && !clarificationComment) {
    return undefined;
  }

  return {
    status,
    workflowReference,
    clarificationComment
  };
}

function isQuestionLikeLine(text: string): boolean {
  return /^(who|what|when|where|why|how|which|should|could|would|can|do|does|did|is|are|am|will|may)\b/i.test(text);
}

function isClarificationMetaLine(text: string): boolean {
  return /^(\*{0,2}this is an ai-generated message\.?\*{0,2}|copilot clarification request|questions?\s*:|analysis\s*:|reasoning\s*:|thoughts?\s*:|thinking\s*:|tool(?:\s+output|\s+call|\s+result)?\s*:|assistant\s*:|ready)$/i.test(text);
}

export function extractClarificationQuestions(text: string): string[] {
  const normalized = normalizeClarificationText(text);
  const lines = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const collected: string[] = [];
  let inQuestionSection = false;

  for (const line of lines) {
    if (/^questions?\s*:$/i.test(line)) {
      inQuestionSection = true;
      continue;
    }

    if (isClarificationMetaLine(line)) {
      continue;
    }

    const cleaned = line.replace(/^(?:\d+[.)]\s*|[-•]\s*)/, '').trim();
    if (!cleaned) {
      continue;
    }

    if (inQuestionSection || cleaned.includes('?') || isQuestionLikeLine(cleaned)) {
      const questionMatches = cleaned.match(/[^?]+\?/g);
      if (questionMatches && questionMatches.length > 0) {
        for (const match of questionMatches) {
          collected.push(match.trim());
        }
        continue;
      }

      collected.push(isQuestionLikeLine(cleaned) ? `${cleaned.replace(/[.\s]+$/, '')}?` : cleaned);
    }
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const question of collected) {
    const cleanedQuestion = question.replace(/^questions?\s*:\s*/i, '').trim();
    if (!cleanedQuestion) {
      continue;
    }

    const normalizedKey = cleanedQuestion.toLowerCase();
    if (seen.has(normalizedKey)) {
      continue;
    }

    seen.add(normalizedKey);
    deduped.push(cleanedQuestion);
  }

  return deduped.slice(0, 5);
}

export function normalizeClarificationCommentBody(text: string): string | undefined {
  const questions = extractClarificationQuestions(text);
  if (questions.length === 0) {
    return undefined;
  }

  return questions.map((question, index) => `${index + 1}. ${question}`).join('\n');
}

export async function reviewTicketWithOpenAi(
  issue: IssueDetails,
  apiKey: string,
  agentName: string,
  options?: ReviewStreamOptions
): Promise<string> {
  const ticketContext = buildTicketContext(issue);
  const userMessage = `Please review this ticket and provide feedback on its completeness and clarity:\n\n${ticketContext}`;
  const model = options?.model?.trim() || 'gpt-4o-mini';
  const systemPrompt = options?.systemPrompt?.trim() || REVIEW_SYSTEM_PROMPT;
  const endpoint = `${(options?.gatewayUrl?.trim() || 'https://api.openai.com').replace(/\/+$/, '')}/v1/chat/completions`;

  if (options?.onUpdate) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 16384
      }),
      signal: options.signal
    });

    if (!response.ok) {
      throw new Error(await extractApiError(response, 'OpenAI'));
    }

    let content = '';
    await consumeSseStream(response, (_eventName, data) => {
      if (data === '[DONE]') {
        return;
      }
      let parsed: { choices?: Array<{ delta?: { content?: string } }> } | undefined;
      try {
        parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      } catch {
        return;
      }
      const delta = parsed.choices?.[0]?.delta?.content ?? '';
      if (!delta) {
        return;
      }
      content += delta;
      options.onUpdate?.(`## AI Review by ${agentName}\n\n${content}`);
    });

    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('OpenAI returned an empty response.');
    }

    return `## AI Review by ${agentName}\n\n${trimmed}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 16384
    }),
    signal: options?.signal
  });

  if (!response.ok) {
    throw new Error(await extractApiError(response, 'OpenAI'));
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('OpenAI returned an empty response.');
  }

  return `## AI Review by ${agentName}\n\n${content}`;
}

export async function reviewTicketWithClaude(
  issue: IssueDetails,
  apiKey: string,
  agentName: string,
  options?: ReviewStreamOptions
): Promise<string> {
  const ticketContext = buildTicketContext(issue);
  const userMessage = `Please review this ticket and provide feedback on its completeness and clarity:\n\n${ticketContext}`;
  const model = options?.model?.trim() || 'claude-haiku-4-5-20251001';
  const systemPrompt = options?.systemPrompt?.trim() || REVIEW_SYSTEM_PROMPT;
  const endpoint = `${(options?.gatewayUrl?.trim() || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;

  if (options?.onUpdate) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 16384,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userMessage }
        ]
      }),
      signal: options.signal
    });

    if (!response.ok) {
      throw new Error(await extractApiError(response, 'Claude'));
    }

    let content = '';
    await consumeSseStream(response, (eventName, data) => {
      if (eventName !== 'content_block_delta') {
        return;
      }
      let parsed: { delta?: { text?: string } } | undefined;
      try {
        parsed = JSON.parse(data) as { delta?: { text?: string } };
      } catch {
        return;
      }
      const delta = parsed.delta?.text ?? '';
      if (!delta) {
        return;
      }
      content += delta;
      options.onUpdate?.(`## AI Review by ${agentName}\n\n${content}`);
    });

    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('Claude returned an empty response.');
    }

    return `## AI Review by ${agentName}\n\n${trimmed}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage }
      ]
    }),
    signal: options?.signal
  });

  if (!response.ok) {
    throw new Error(await extractApiError(response, 'Claude'));
  }

  const data = await response.json() as {
    content?: Array<{ type: string; text?: string }>;
  };
  const textBlock = data.content?.find(block => block.type === 'text');
  const text = textBlock?.text?.trim();
  if (!text) {
    throw new Error('Claude returned an empty response.');
  }

  return `## AI Review by ${agentName}\n\n${text}`;
}

export async function reviewTicketWithVercelGateway(
  issue: IssueDetails,
  apiKey: string | undefined,
  agentName: string,
  options?: ReviewStreamOptions
): Promise<string> {
  const ticketContext = buildTicketContext(issue);
  const systemPrompt = options?.systemPrompt?.trim() || REVIEW_SYSTEM_PROMPT;
  const content = await runReviewGatewayPrompt(
    `Please review this ticket and provide feedback on its completeness and clarity:\n\n${ticketContext}`,
    {
      apiKey: options?.apiKey ?? apiKey,
      gatewayUrl: options?.gatewayUrl,
      systemPrompt,
      onUpdate: options?.onUpdate,
      model: options?.model,
      signal: options?.signal
    }
  );

  return `## AI Review by ${agentName}\n\n${content}`;
}

/** @deprecated Use reviewTicketWithVercelGateway. */
export async function reviewTicketWithCopilot(
  issue: IssueDetails,
  apiKey: string | undefined,
  agentName: string,
  _workingDirectory?: string,
  options?: ReviewStreamOptions
): Promise<string> {
  return reviewTicketWithVercelGateway(issue, apiKey, agentName, options);
}

export async function respondToGatewayComment(
  issue: IssueDetails,
  apiKey: string | undefined,
  request: string,
  options?: { gatewayUrl?: string; agentMention?: string }
): Promise<string> {
  const mention = options?.agentMention?.trim() || '@agent';
  const ticketContext = buildTicketContext(issue, {
    recentCommentLimit: GATEWAY_REPLY_COMMENT_LIMIT,
    newestComments: true
  });
  const content = await runReviewGatewayPrompt(
    `Reply to the latest ${mention} mention in this ticket.\n\nUser request:\n${request}\n\nTicket context:\n${ticketContext}`,
    {
      apiKey,
      gatewayUrl: options?.gatewayUrl,
      systemPrompt: GATEWAY_COMMENT_SYSTEM_PROMPT
    }
  );

  return `## ${mention} reply\n\n${content}`;
}

/** @deprecated Use respondToGatewayComment. */
export async function respondToCopilotComment(
  issue: IssueDetails,
  apiKey: string | undefined,
  request: string,
  _workingDirectory?: string
): Promise<string> {
  return respondToGatewayComment(issue, apiKey, request);
}

export async function buildGatewayClarificationComment(
  issue: IssueDetails,
  apiKey: string | undefined,
  options?: { gatewayUrl?: string }
): Promise<string | undefined> {
  const ticketContext = buildTicketContext(issue, {
    recentCommentLimit: GATEWAY_REPLY_COMMENT_LIMIT,
    newestComments: true
  });
  const content = await runReviewGatewayPrompt(
    `Assess whether this ticket is specific enough to implement without making risky assumptions. Reply READY if no clarification is needed. Otherwise draft a concise Jira comment requesting the missing details.

Ticket context:
${ticketContext}`,
    {
      apiKey,
      gatewayUrl: options?.gatewayUrl,
      systemPrompt: GATEWAY_CLARIFICATION_SYSTEM_PROMPT
    }
  );

  const trimmed = content.trim();
  if (trimmed === 'READY') {
    return undefined;
  }

  const normalizedBody = normalizeClarificationCommentBody(trimmed);
  if (!normalizedBody) {
    throw new Error('Gateway clarification response did not contain any clarification questions.');
  }

  return `**THIS IS AN AI-GENERATED MESSAGE.**
AI clarification request

${normalizedBody}

_Reply to the bot by starting your comment with \`#AIbot\` (e.g. \`#AIbot use the production cluster\`). Comments without that prefix are ignored._`;
}

/** @deprecated Use buildGatewayClarificationComment. */
export async function buildCopilotClarificationComment(
  issue: IssueDetails,
  apiKey: string | undefined,
  _workingDirectory?: string
): Promise<string | undefined> {
  return buildGatewayClarificationComment(issue, apiKey);
}

export async function assessGatewayImplementationReadiness(
  issue: IssueDetails,
  apiKey: string | undefined,
  options?: {
    gatewayUrl?: string;
    availableWorkflows?: AgentWorkflowReference[];
    assignedWorkflow?: AgentWorkflowReference;
    stagedAttachments?: Array<{ fileName: string; localPath: string; mediaType?: string }>;
  }
): Promise<CopilotImplementationReadinessAssessment> {
  const ticketContext = buildTicketContext(issue, {
    recentCommentLimit: GATEWAY_REPLY_COMMENT_LIMIT,
    newestComments: true
  });
  const attachmentContext = options?.stagedAttachments?.length
    ? [
        '\nLocally staged issue attachments (downloaded from Jira before this analysis):',
        ...options.stagedAttachments.map(a =>
          `- ${a.fileName}: ${a.localPath}${a.mediaType ? ` [${a.mediaType}]` : ''}`
        ),
        'Review these files when they are relevant to the ticket (screenshots, mockups, specs).'
      ].join('\n')
    : '';
  const assignedWorkflowContext = options?.assignedWorkflow
    ? [
        'Currently assigned workflow pack in Praxis:',
        `- Name: ${options.assignedWorkflow.name}`,
        `- Id: ${options.assignedWorkflow.id}`,
        `- File: ${options.assignedWorkflow.instructionsPath}`,
        options.assignedWorkflow.link ? `- Link: ${options.assignedWorkflow.link}` : undefined
      ].filter((line): line is string => Boolean(line)).join('\n')
    : 'Currently assigned workflow pack in Praxis: none. (This is acceptable — workflow packs are optional.)';
  const workflowContext = buildWorkflowPromptContext(options?.availableWorkflows ?? []);

  const content = await runReviewGatewayPrompt(
    `Assess whether this ticket is specific enough to implement without making risky assumptions.

${assignedWorkflowContext}

${workflowContext}
${attachmentContext}

Ticket context:
${ticketContext}`,
    {
      apiKey,
      gatewayUrl: options?.gatewayUrl,
      systemPrompt: GATEWAY_CLARIFICATION_SYSTEM_PROMPT
    }
  );

  const assessment = parseCopilotImplementationReadinessAssessment(content);
  if (!assessment) {
    throw new Error('Gateway readiness assessment did not return a valid JSON result.');
  }

  return assessment;
}

/** @deprecated Use assessGatewayImplementationReadiness. */
export async function assessCopilotImplementationReadiness(
  issue: IssueDetails,
  apiKey: string | undefined,
  options?: {
    workingDirectory?: string;
    gatewayUrl?: string;
    availableWorkflows?: AgentWorkflowReference[];
    assignedWorkflow?: AgentWorkflowReference;
    stagedAttachments?: Array<{ fileName: string; localPath: string; mediaType?: string }>;
  }
): Promise<CopilotImplementationReadinessAssessment> {
  return assessGatewayImplementationReadiness(issue, apiKey, options);
}

export async function recommendTaskDesignerFlowWithGateway(
  nodes: readonly TaskDesignerRecommendationNode[],
  connectors: readonly TaskDesignerRecommendationConnector[],
  options?: {
    apiKey?: string;
    gatewayUrl?: string;
  }
): Promise<TaskDesignerFlowRecommendation> {
  if (nodes.length === 0) {
    return { orderedNodeIds: [], connectors: [] };
  }

  const prompt = [
    'Recommend a start-to-finish execution flow for this existing task-designer canvas.',
    'Prioritize dependency-safe sequencing and practical implementation order.',
    '',
    'Canvas nodes (JSON):',
    JSON.stringify(nodes, null, 2),
    '',
    'Existing directed connectors (JSON):',
    JSON.stringify(connectors, null, 2)
  ].join('\n');

  const content = await runReviewGatewayPrompt(prompt, {
    apiKey: options?.apiKey,
    gatewayUrl: options?.gatewayUrl,
    systemPrompt: GATEWAY_TASK_DESIGNER_RECOMMENDATION_SYSTEM_PROMPT
  });

  const parsed = parseTaskDesignerFlowRecommendation(content, nodes);
  if (!parsed) {
    throw new Error('Gateway flow recommendation did not return a valid JSON result.');
  }

  return parsed;
}

/** @deprecated Use recommendTaskDesignerFlowWithGateway. */
export async function recommendTaskDesignerFlowWithCopilot(
  nodes: readonly TaskDesignerRecommendationNode[],
  connectors: readonly TaskDesignerRecommendationConnector[],
  options?: {
    cliPath?: string;
    apiKey?: string;
    gatewayUrl?: string;
    workingDirectory?: string;
  }
): Promise<TaskDesignerFlowRecommendation> {
  return recommendTaskDesignerFlowWithGateway(nodes, connectors, {
    apiKey: options?.apiKey ?? options?.cliPath,
    gatewayUrl: options?.gatewayUrl
  });
}

// ── Local Peer Review (LPR) ──────────────────────────────────────

export interface LprResult {
  codeReview: string;
  securityReview: string;
  summary: string;
}

async function runLprSection(
  issue: IssueDetails,
  systemPrompt: string,
  userPrompt: string,
  options: {
    cliPath?: string;
    workingDirectory?: string;
    provider: string;
    credential?: string;
    agentName?: string;
    gatewayUrl?: string;
  }
): Promise<string> {
  const ticketContext = buildTicketContext(issue);

  if (options.provider === 'vercel-gateway' || options.provider === 'copilot-cli') {
    return runReviewGatewayPrompt(`${userPrompt}\n\n${ticketContext}`, {
      apiKey: options.credential ?? options.cliPath,
      gatewayUrl: options.gatewayUrl,
      systemPrompt
    });
  }

  if (options.provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${options.credential}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `${userPrompt}\n\n${ticketContext}` }
        ],
        max_tokens: 2048
      })
    });
    if (!response.ok) {
      throw new Error(await extractApiError(response, 'OpenAI'));
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  }

  if (options.provider === 'claude') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': options.credential ?? '',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: `${userPrompt}\n\n${ticketContext}` }]
      })
    });
    if (!response.ok) {
      throw new Error(await extractApiError(response, 'Claude'));
    }
    const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
    return data.content?.find(b => b.type === 'text')?.text?.trim() ?? '';
  }

  throw new Error(`LPR is not supported for provider: ${options.provider}`);
}

export async function runLocalPeerReview(
  issue: IssueDetails,
  options: {
    cliPath?: string;
    workingDirectory?: string;
    provider: string;
    credential?: string;
    agentName?: string;
    gatewayUrl?: string;
  }
): Promise<LprResult> {
  const codeReview = await runLprSection(
    issue,
    CODE_REVIEW_SYSTEM_PROMPT,
    'Perform a code review for this ticket:',
    options
  );

  const securityReview = await runLprSection(
    issue,
    SECURITY_REVIEW_SYSTEM_PROMPT,
    'Perform a security review for this ticket:',
    options
  );

  const summary = await runLprSection(
    issue,
    LPR_SUMMARY_SYSTEM_PROMPT,
    `Summarize the following peer review findings:\n\n## Code Review\n${codeReview}\n\n## Security Review\n${securityReview}`,
    options
  );

  return { codeReview, securityReview, summary };
}

// ── Structured Reviewer Contract (TASK-244 / TASK-245) ─────────────

export function parseReviewFindings(content: string): {
  findings: CheckFindings;
  summary?: string;
} {
  if (!content || !content.trim()) {
    throw new Error('Reviewer output is empty; expected structured JSON findings.');
  }

  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let jsonText = jsonMatch ? jsonMatch[1].trim() : content.trim();

  if (!jsonText.startsWith('{') && !jsonText.startsWith('[')) {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end > start) {
      jsonText = content.slice(start, end + 1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Reviewer output did not contain a valid structured JSON findings block: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Reviewer JSON findings must be an object.');
  }

  const candidate = parsed as Record<string, unknown>;
  if (!Array.isArray(candidate.findings)) {
    throw new Error('Reviewer JSON findings must contain a "findings" array.');
  }

  const validSeverities = new Set(['critical', 'high', 'medium', 'low', 'info']);
  const findings: CheckFinding[] = candidate.findings.map((f: unknown, idx: number) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      throw new Error(`Finding at index ${idx} is not an object.`);
    }
    const item = f as Record<string, unknown>;
    const rawSev = typeof item.severity === 'string' ? item.severity.toLowerCase() : 'medium';
    const severity: CheckFindingSeverity = validSeverities.has(rawSev)
      ? (rawSev as CheckFindingSeverity)
      : 'medium';
    const message = typeof item.message === 'string' && item.message.trim() ? item.message.trim() : 'Review finding';
    const file = typeof item.file === 'string' && item.file.trim() ? item.file.trim() : undefined;
    const line = typeof item.line === 'number' && Number.isFinite(item.line) ? Math.floor(item.line) : undefined;
    const ruleId = typeof item.ruleId === 'string' && item.ruleId.trim() ? item.ruleId.trim() : undefined;
    const category = typeof item.category === 'string' && item.category.trim() ? item.category.trim() : 'quality';
    const suggestion = typeof item.suggestion === 'string' && item.suggestion.trim() ? item.suggestion.trim() : undefined;

    const fingerprint = computeFindingFingerprint({ ruleId, file, line, message });
    return {
      fingerprint,
      ruleId,
      file,
      line,
      severity,
      category,
      message,
      suggestion
    };
  });

  const metrics: Record<string, number> = {};
  if (candidate.metrics && typeof candidate.metrics === 'object' && !Array.isArray(candidate.metrics)) {
    for (const [k, v] of Object.entries(candidate.metrics as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        metrics[k] = v;
      }
    }
  }
  if (metrics.findingsCount === undefined) {
    metrics.findingsCount = findings.length;
  }

  const summary = typeof candidate.summary === 'string' && candidate.summary.trim()
    ? candidate.summary.trim()
    : undefined;

  return {
    findings: { findings, metrics },
    summary
  };
}

export function deduplicateReviewFindings(
  currentFindings: CheckFinding[],
  previousFingerprints: Set<string>
): {
  newFindings: CheckFinding[];
  existingFindings: CheckFinding[];
} {
  const newFindings: CheckFinding[] = [];
  const existingFindings: CheckFinding[] = [];

  for (const finding of currentFindings) {
    if (previousFingerprints.has(finding.fingerprint)) {
      existingFindings.push(finding);
    } else {
      newFindings.push(finding);
    }
  }

  return { newFindings, existingFindings };
}

export function mapReviewFindingToInlineComment(finding: CheckFinding): string {
  const lines: string[] = [
    `**[${finding.severity.toUpperCase()}]** ${finding.category}`,
    '',
    finding.message
  ];

  if (finding.suggestion) {
    lines.push('', '**Suggestion:**', finding.suggestion);
  }

  return lines.join('\n');
}

export function formatTicketReviewSummaryComment(
  findings: CheckFinding[],
  summary?: string
): string {
  const lines: string[] = ['## Code Review Findings', ''];

  if (summary) {
    lines.push(summary, '');
  }

  if (findings.length === 0) {
    lines.push('✅ No issues found during code review.');
    return lines.join('\n');
  }

  const order: CheckFindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
  for (const sev of order) {
    const group = findings.filter(f => f.severity === sev);
    if (group.length === 0) continue;

    lines.push(`### ${sev.toUpperCase()} (${group.length})`, '');
    for (const finding of group) {
      const loc = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ''}\` — ` : '';
      lines.push(`- ${loc}**${finding.category}:** ${finding.message}`);
      if (finding.suggestion) {
        lines.push(`  - *Suggestion:* ${finding.suggestion}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

