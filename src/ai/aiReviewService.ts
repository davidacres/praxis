import type { IssueDetails } from '../types';

const REVIEW_SYSTEM_PROMPT = `You are a technical product manager reviewing tickets for completeness and quality.
Analyze the ticket and provide concise, actionable feedback on:
1. Clarity of the problem statement or goal
2. Completeness of requirements or acceptance criteria
3. Technical details or context that may be missing
4. Any ambiguities that should be resolved before work begins

Be constructive and specific. Format your response in markdown. If the ticket is well-defined, say so briefly.`;

function buildTicketContext(issue: IssueDetails): string {
  const parts: string[] = [];
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
    const limit = Math.min(5, issue.comments.length);
    parts.push(`\n**Comments (${issue.comments.length} total, showing ${limit}):**`);
    for (const comment of issue.comments.slice(0, limit)) {
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
