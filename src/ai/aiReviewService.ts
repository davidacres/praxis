import type { IssueDetails } from '../types';

const REVIEW_SYSTEM_PROMPT = `You are a technical product manager reviewing tickets for completeness and quality.
Analyze the ticket and provide concise, actionable feedback on:
1. Clarity of the problem statement or goal
2. Completeness of requirements or acceptance criteria
3. Technical details or context that may be missing
4. Any ambiguities that should be resolved before work begins

Be constructive and specific. Format your response in markdown. If the ticket is well-defined, say so briefly.`;

const COPILOT_COMMENT_SYSTEM_PROMPT = `You are GitHub Copilot replying inside a ticket discussion.
Respond directly to the user's request using the ticket details and recent comments as context.
Be concise, practical, and collaborative.
Do not claim to have taken actions you did not take.
Format the response in markdown suitable for posting as a ticket comment.`;

const COPILOT_REPLY_COMMENT_LIMIT = 8;

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
  }
): Promise<string> {
  const sdk = await import('@github/copilot-sdk');
  const cliPath = options.cliPath?.trim();
  const client = new sdk.CopilotClient(cliPath ? { cliPath } : undefined);
  let session:
    | {
        disconnect(): Promise<void>;
        sendAndWait(args: { prompt: string }): Promise<{ data?: { content?: string } } | undefined>;
      }
    | undefined;
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

    const response = await session.sendAndWait({ prompt });
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
