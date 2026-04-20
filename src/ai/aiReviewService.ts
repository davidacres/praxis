import type { IssueDetails } from '../types';
import type { AgentWorkflowReference } from './agentTypes';
import { resolveCopilotClientOptions } from './copilotSdkRuntime';

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

const COPILOT_COMMENT_SYSTEM_PROMPT = `You are GitHub Copilot replying inside a ticket discussion.
Respond directly to the user's request using the ticket details and recent comments as context.
Be concise, practical, and collaborative.
Do not claim to have taken actions you did not take.
Format the response in markdown suitable for posting as a ticket comment.`;

const COPILOT_CLARIFICATION_SYSTEM_PROMPT = `You are GitHub Copilot reviewing a ticket before implementation starts.

Workflow packs are OPTIONAL. A ticket is allowed to proceed with no workflow pack assigned.
Never ask the user to assign a workflow pack, never suggest workflow packs, and never block
on workflow pack selection. Do not infer or auto-pick a workflow pack from the technical
content of the ticket.

Only populate "workflowReference" when one of these is true:
  (a) A workflow pack is already assigned in Ticket Manager — echo its id.
  (b) The ticket description or a comment explicitly names one of the available workflow packs
      (e.g. a line like "Workflow pack: add-edit-dotnet-web-api"). Wording such as
      "use no workflow", "no workflow pack", or the absence of any such line means no workflow
      pack — leave "workflowReference" blank and still return status "ready" if the rest of
      the ticket is clear enough to implement.

Return exactly one JSON code block and nothing else.

Schema:
{
  "status": "ready" | "needs_clarification",
  "workflowReference": "optional — only set when the ticket or Ticket Manager explicitly names a workflow pack",
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

const COPILOT_REPLY_COMMENT_LIMIT = 8;
const COPILOT_PROMPT_TIMEOUT_MS = 3 * 60 * 1000;

function buildTicketContext(
  issue: IssueDetails,
  options?: { recentCommentLimit?: number; newestComments?: boolean }
): string {
  const parts: string[] = [];
  const recentCommentLimit = options?.recentCommentLimit ?? 5;
  const newestComments = options?.newestComments ?? false;
  parts.push(`**Ticket:** ${issue.key}`);
  parts.push(`**Type:** ${issue.issueType}`);
  parts.push(`**Summary:** ${issue.summary}`);
  if (issue.status) {
    parts.push(`**Status:** ${issue.status}`);
  }
  if (issue.priority) {
    parts.push(`**Priority:** ${issue.priority}`);
  }
  if (issue.assignee) {
    parts.push(`**Assignee:** ${issue.assignee}`);
  }
  if (issue.parentIssue) {
    parts.push(`**Parent:** ${issue.parentIssue.key}${issue.parentIssue.summary ? ` — ${issue.parentIssue.summary}` : ''}`);
  }
  if (issue.description?.trim()) {
    parts.push(`\n**Description:**\n${issue.description.trim()}`);
  } else {
    parts.push('\n**Description:** *(none)*');
  }
  if (issue.comments && issue.comments.length > 0) {
    const limit = Math.min(recentCommentLimit, issue.comments.length);
    const visibleComments = newestComments ? issue.comments.slice(-limit) : issue.comments.slice(0, limit);
    parts.push(`\n**${newestComments ? 'Recent comments' : 'Comments'} (${issue.comments.length} total, showing ${limit}):**`);
    for (const comment of visibleComments) {
      const author = comment.author ?? 'Unknown';
      const body = comment.body.length > 300 ? `${comment.body.slice(0, 300)}…` : comment.body;
      parts.push(`- **${author}:** ${body}`);
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

async function runCopilotPrompt(
  prompt: string,
  options: {
    cliPath?: string;
    systemPrompt: string;
    workingDirectory?: string;
    timeoutMs?: number;
  }
): Promise<string> {
  const sdk = await import('@github/copilot-sdk');
  const { clientOptions } = resolveCopilotClientOptions(options.cliPath);
  const client = new sdk.CopilotClient(clientOptions);
  let session:
    | {
        disconnect(): Promise<void>;
        sendAndWait(
          args: { prompt: string },
          timeout?: number
        ): Promise<{ data?: { content?: string } } | undefined>;
      }
    | undefined;
  const timeoutMs = options.timeoutMs ?? COPILOT_PROMPT_TIMEOUT_MS;
  try {
    await client.start();
    session = await client.createSession({
      clientName: 'ticket-manager-extension',
      availableTools: [],
      infiniteSessions: { enabled: false },
      onPermissionRequest: sdk.approveAll,
      systemMessage: {
        content: options.systemPrompt
      },
      workingDirectory: options.workingDirectory
    });

    const response = await session.sendAndWait({ prompt }, timeoutMs);
    const content = response?.data?.content?.trim();
    if (!content) {
      throw new Error('Copilot returned an empty response.');
    }

    return content;
  } finally {
    if (session) {
      await session.disconnect();
    }
    await client.stop();
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
  agentName: string
): Promise<string> {
  const ticketContext = buildTicketContext(issue);
  const userMessage = `Please review this ticket and provide feedback on its completeness and clarity:\n\n${ticketContext}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: REVIEW_SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 1024
    })
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
  agentName: string
): Promise<string> {
  const ticketContext = buildTicketContext(issue);
  const userMessage = `Please review this ticket and provide feedback on its completeness and clarity:\n\n${ticketContext}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: REVIEW_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMessage }
      ]
    })
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

export async function reviewTicketWithCopilot(
  issue: IssueDetails,
  cliPath: string | undefined,
  agentName: string,
  workingDirectory?: string
): Promise<string> {
  const ticketContext = buildTicketContext(issue);
  const content = await runCopilotPrompt(
    `Please review this ticket and provide feedback on its completeness and clarity:\n\n${ticketContext}`,
    {
      cliPath,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      workingDirectory
    }
  );

  return `## AI Review by ${agentName}\n\n${content}`;
}

export async function respondToCopilotComment(
  issue: IssueDetails,
  cliPath: string | undefined,
  request: string,
  workingDirectory?: string
): Promise<string> {
  const ticketContext = buildTicketContext(issue, {
    recentCommentLimit: COPILOT_REPLY_COMMENT_LIMIT,
    newestComments: true
  });
  const content = await runCopilotPrompt(
    `Reply to the latest @copilot mention in this ticket.\n\nUser request:\n${request}\n\nTicket context:\n${ticketContext}`,
    {
      cliPath,
      systemPrompt: COPILOT_COMMENT_SYSTEM_PROMPT,
      workingDirectory
    }
  );

  return `## @copilot reply\n\n${content}`;
}

export async function buildCopilotClarificationComment(
  issue: IssueDetails,
  cliPath: string | undefined,
  workingDirectory?: string
): Promise<string | undefined> {
  const ticketContext = buildTicketContext(issue, {
    recentCommentLimit: COPILOT_REPLY_COMMENT_LIMIT,
    newestComments: true
  });
  const content = await runCopilotPrompt(
    `Assess whether this ticket is specific enough to implement without making risky assumptions. Reply READY if no clarification is needed. Otherwise draft a concise Jira comment requesting the missing details.

Ticket context:
${ticketContext}`,
    {
      cliPath,
      systemPrompt: COPILOT_CLARIFICATION_SYSTEM_PROMPT,
      workingDirectory
    }
  );

  const trimmed = content.trim();
  if (trimmed === 'READY') {
    return undefined;
  }

  const normalizedBody = normalizeClarificationCommentBody(trimmed);
  if (!normalizedBody) {
    throw new Error('Copilot clarification response did not contain any clarification questions.');
  }

  return `**THIS IS AN AI-GENERATED MESSAGE.**
Copilot clarification request

${normalizedBody}

_Reply to the bot by starting your comment with \`#AIbot\` (e.g. \`#AIbot use the production cluster\`). Comments without that prefix are ignored._`;
}

export async function assessCopilotImplementationReadiness(
  issue: IssueDetails,
  cliPath: string | undefined,
  options?: {
    workingDirectory?: string;
    availableWorkflows?: AgentWorkflowReference[];
    assignedWorkflow?: AgentWorkflowReference;
  }
): Promise<CopilotImplementationReadinessAssessment> {
  const ticketContext = buildTicketContext(issue, {
    recentCommentLimit: COPILOT_REPLY_COMMENT_LIMIT,
    newestComments: true
  });
  const assignedWorkflowContext = options?.assignedWorkflow
    ? [
        'Currently assigned workflow pack in Ticket Manager:',
        `- Name: ${options.assignedWorkflow.name}`,
        `- Id: ${options.assignedWorkflow.id}`,
        `- File: ${options.assignedWorkflow.instructionsPath}`,
        options.assignedWorkflow.link ? `- Link: ${options.assignedWorkflow.link}` : undefined
      ].filter((line): line is string => Boolean(line)).join('\n')
    : 'Currently assigned workflow pack in Ticket Manager: none. (This is acceptable — workflow packs are optional.)';
  const workflowContext = buildWorkflowPromptContext(options?.availableWorkflows ?? []);

  const content = await runCopilotPrompt(
    `Assess whether this ticket is specific enough to implement without making risky assumptions.

${assignedWorkflowContext}

${workflowContext}

Ticket context:
${ticketContext}`,
    {
      cliPath,
      systemPrompt: COPILOT_CLARIFICATION_SYSTEM_PROMPT,
      workingDirectory: options?.workingDirectory
    }
  );

  const assessment = parseCopilotImplementationReadinessAssessment(content);
  if (!assessment) {
    throw new Error('Copilot readiness assessment did not return a valid JSON result.');
  }

  return assessment;
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
  options: { cliPath?: string; workingDirectory?: string; provider: string; credential?: string; agentName?: string }
): Promise<string> {
  const ticketContext = buildTicketContext(issue);

  if (options.provider === 'copilot-cli') {
    return runCopilotPrompt(`${userPrompt}\n\n${ticketContext}`, {
      cliPath: options.cliPath,
      systemPrompt,
      workingDirectory: options.workingDirectory
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
  options: { cliPath?: string; workingDirectory?: string; provider: string; credential?: string; agentName?: string }
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
