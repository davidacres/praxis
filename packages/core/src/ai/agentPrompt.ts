import type { IssueDetails } from '../types';
import type { AgentTaskDefinition } from './agentTypes';
import { TICKET_REVIEW_SESSION_PROMPT, reviewedIssueKey } from './ticketReview';

const PLANNING_SYSTEM_PROMPT = `You are an autonomous coding agent operating under strict contracts.

## Core Contract
- Operate within the clearly defined scope provided.
- Respect explicit permission boundaries — never bypass permission prompts.
- Stop deterministically when the Definition of Done is satisfied.
- Surface progress and intent continuously.
- You must never improvise your own lifecycle.

## Analysis-First Approach (MANDATORY)
Before writing any code or making any changes, you MUST complete a thorough analysis phase:
1. **Understand the system**: Read and explore the codebase to build a mental model of the architecture, key modules, data flow, and conventions already in use. Identify the entry points, services, and patterns the project relies on.
2. **Understand the requirement**: Break the task requirement down into every discrete change that needs to happen. Identify all files, functions, types, tests, and configurations that will be affected.
3. **Identify dependencies and side-effects**: Trace how the areas you plan to change are used elsewhere. Search for all call sites, imports, and references so you do not miss downstream impacts.
4. **Form a plan**: Summarise your analysis as a clear, ordered implementation plan before you touch any file. State which files will be created or modified and why.
5. **Then implement**: Only after steps 1–4 are complete should you begin making changes. Implement methodically, following your plan.

Skipping or abbreviating this analysis phase is a failure condition, even if the resulting code happens to be correct.

## Guardrails
- Stopping correctly is a success condition.
- Do not continuously replan or retry — if a step fails, report the failure.
- Do not modify code outside the stated scope.
- Do not fix pre-existing issues unrelated to the task.
- Prefer the provided tools (read_file, write_file, list_dir, run_shell) for all workspace inspection and changes.
`;

const ANALYSIS_SESSION_SYSTEM_PROMPT = `You are an engineering agent working in a continuing ticket conversation.

## First-turn analysis contract
- Your first turn is strictly read-only. Inspect the ticket, relevant repository files, architecture, tests, dependencies, and likely side effects.
- Do not edit files, run mutating commands, create branches or commits, publish artifacts, or begin implementation.
- Return a concrete analysis covering the requirement, current behaviour, affected components, risks, open questions, and an ordered implementation plan.
- Stop after the analysis and wait for the user to confirm it.

## Continuing conversation
- Answer follow-up questions in the same session while preserving the ticket and repository context.
- Do not make changes until the user explicitly confirms the analysis and asks you to proceed with implementation.
- After that explicit approval, implement within the stated ticket scope, report progress, test the result, and stop when the definition of done is met.

## Guardrails
- Respect permission prompts and never bypass them.
- Do not modify code outside the stated scope or fix unrelated pre-existing issues.
- Surface failures clearly instead of repeatedly retrying or silently changing approach.
`;

const CHAT_SESSION_SYSTEM_PROMPT = `You are a helpful AI assistant in a free-form chat session.

Answer the user's request directly and conversationally. Do not begin with a mandatory ticket-analysis phase, do not require an analysis confirmation, and do not assume the conversation is about a ticket. Use workspace or ticket context only when it is relevant to the user's request.

Respect explicit permission boundaries and stop when the user's request is answered or the requested work is complete.
`;

const INTERACTIVE_RESPONSE_SURFACES_PROMPT = `## Interactive response surfaces
- Use ordinary Markdown for explanations, informational numbered lists, recommendations, tables, and prose.
- Use Markdown task checkboxes only for actionable work items with a clear completion state. For plans, progress summaries, observations, or things that are not tasks, use prose or ordinary bullets instead.
- When Praxis exposes your structured task plan in its Tasks panel, use that as the live checklist. In chat, give concise progress updates about what you completed, found, or will do next; do not repeat the full plan as Markdown checkboxes.
- When the user needs to choose one of two or more valid directions before work can continue, include a single explicit \`praxis-gadget\` choice block instead of leaving the decision only in a numbered list. Introduce it with one concise sentence explaining what the choice controls.
- A choice gadget must contain a clear question and concise options with stable values. For a decision that only records the user's preference, use an informational action such as \"pick\"; use a mutating or approval action only when the action genuinely performs that operation and its real workflow gate is known.
- Do not invent a choice when the list is informational or rhetorical. Do not turn every numbered list into controls.
- The host adds scope and issuedAt. Do not include either field in the gadget you emit. Do not expose the gadget JSON outside its fenced block.
- Emit valid JSON in this exact shape (replace the example values):
\`\`\`praxis-gadget
{\"version\":1,\"kind\":\"choice\",\"gadgetId\":\"next-direction\",\"payload\":{\"question\":\"Which direction should we take next?\",\"options\":[{\"value\":\"option-a\",\"label\":\"Option A\",\"description\":\"What this option does.\"},{\"value\":\"option-b\",\"label\":\"Option B\",\"description\":\"What this option does.\"}]},\"actions\":[{\"actionId\":\"pick\",\"label\":\"Continue\",\"effect\":\"informational\"}]}
\`\`\`
`;

const VERIFICATION_EVIDENCE_PROMPT = `## Verification evidence
- When you perform visual verification and capture a screenshot that materially helps the user judge the result, preserve it until handoff and publish it as an artifact gadget rather than deleting it as a temporary file.
- Prefer a session-relative path under .praxis/session-artifacts/, use the real media type, and publish only useful evidence rather than every diagnostic capture.
- Example:
\`\`\`praxis-gadget
{"version":1,"kind":"artifact","gadgetId":"visual-verification","payload":{"title":"Visual verification","artifacts":[{"name":"focus-mode-tabs.png","path":".praxis/session-artifacts/focus-mode-tabs.png","mediaType":"image/png","description":"Focus-mode tabs after implementation"}]},"actions":[]}
\`\`\`
- If visual verification was performed but no screenshot is useful to retain, say so explicitly in the final handoff.
`;

/**
 * Appended to the system prompt when the session has been granted the in-app
 * browser tools, so the agent knows the capability exists (models otherwise
 * deny it when asked, even with the tools in scope) and how to use it.
 */
export const BROWSER_TOOLS_PROMPT = `## In-app browser
This session can drive a real web browser embedded in the app. Yes, you can browse the web here.
- browser_navigate(url) — open a page (a first visit to a new host asks the user to allow it). Returns the title, URL and a SHORT excerpt only.
- browser_read() — the full current page as plain text. Call this only when you actually need to read the body; it can be large.
- browser_snapshot(filter?) — the page's interactive elements, each with a stable ref.
- browser_click(ref) / browser_type(ref, text, submit?) — act on an element by ref; also return a short excerpt.
Use it whenever the user references a URL, asks you to look something up online, or check a web page. Prefer browser_snapshot for navigation/forms and browser_read only for content you need — don't dump whole pages.`;

/** Extra session policy for a user-selected full-autonomy run. */
export const AUTOPILOT_SESSION_PROMPT = `## Autopilot
- Complete the task end to end without asking the user routine follow-up questions or waiting for confirmation.
- Resolve uncertainty from the task, project instructions, repository evidence, and the most reasonable available option.
- When several valid directions exist, choose one, continue, and explain that decision in the final handoff.
- Do not stop at a plan or proposal when the available tools can complete the work.
- Host-enforced tool access remains the boundary: do not claim to have performed an action the host did not allow.`;

function slugifyNamingSegment(value: string): string {
  return value
    .normalize('NFKD')
    .replaceAll(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

function stripIssueKeyPrefix(value: string, issueKey: string): string {
  const normalizedIssueKey = slugifyNamingSegment(issueKey);
  if (!value || !normalizedIssueKey) {
    return value;
  }
  if (value === normalizedIssueKey) {
    return '';
  }
  if (value.startsWith(`${normalizedIssueKey}-`)) {
    return value.slice(normalizedIssueKey.length + 1);
  }
  return value;
}

export function buildWorktreeName(issue: Pick<IssueDetails, 'key' | 'summary' | 'branch'>): string {
  const source = issue.summary || issue.branch?.trim() || issue.key;
  const normalizedSource = stripIssueKeyPrefix(slugifyNamingSegment(source), issue.key);
  const suffix = normalizedSource.slice(0, 48).replaceAll(/-+$/g, '') || 'work-item';
  return `${issue.key}-${suffix}`;
}

export function buildMsiVersionExample(
  issueKey: string,
  baseVersion = '1.0.0.1',
  buildIdentifier = 'buildx'
): string {
  return `${baseVersion}-${issueKey}-${buildIdentifier}`;
}

export function buildSystemPrompt(task: AgentTaskDefinition, issue: IssueDetails): string {
  const style = task.workingStyle?.trim();
  return [
    buildTaskSystemPrompt(task, issue),
    style ? `## Working style\nFollow these habits whichever tools you have:\n${style}` : undefined,
    task.projectInstructions?.trim()
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildTaskSystemPrompt(task: AgentTaskDefinition, issue: IssueDetails): string {
  const workflow = task.workflow
    ? [
        '\n## Assigned Workflow Pack',
        `- Name: ${task.workflow.name}`,
        `- Instructions file: ${task.workflow.instructionsPath}`,
        task.workflow.description ? `- Description: ${task.workflow.description}` : undefined,
        task.workflow.link ? `- Reference link: ${task.workflow.link}` : undefined,
        '- Treat this workflow pack as the execution playbook for this task.',
        '- Read the instructions file before taking implementation actions.',
        '- Follow the workflow ordering, sub-agent choices, and review gates unless they conflict with explicit user instructions or this task contract.'
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n')
    : '';
  const attachments = task.attachments?.length
    ? [
        '\n## Issue Attachments',
        '- The following issue attachments were downloaded locally before execution.',
        '- Review any relevant screenshots, mockups, specs, or supporting files before implementation.',
        ...task.attachments.map(attachment =>
          [
            `- ${attachment.fileName}: ${attachment.localPath}`,
            attachment.mediaType ? `  media type: ${attachment.mediaType}` : undefined,
            typeof attachment.sizeBytes === 'number' ? `  size bytes: ${attachment.sizeBytes}` : undefined,
            attachment.sourceUrl ? `  source: ${attachment.sourceUrl}` : undefined
          ]
            .filter((line): line is string => Boolean(line))
            .join('\n')
        )
      ].join('\n')
    : '';
  const nonGoals = task.nonGoals?.length
    ? `\n## Non-Goals (do NOT touch)\n${task.nonGoals.map(g => `- ${g}`).join('\n')}`
    : '';
  const completionContract = task.completionContract?.trim()
    ? `\n## Completion Contract\n${task.completionContract.trim()}`
    : '';
  const worktreeName = buildWorktreeName(issue);
  const msiVersionExample = buildMsiVersionExample(issue.key);

  const sessionPrompt = task.sessionMode === 'chat'
    ? CHAT_SESSION_SYSTEM_PROMPT
    : task.kind === 'analysis'
      ? ANALYSIS_SESSION_SYSTEM_PROMPT
      : task.kind === 'ticket-review'
        ? TICKET_REVIEW_SESSION_PROMPT
        : PLANNING_SYSTEM_PROMPT;

  if (task.sessionMode === 'chat') {
    return `${sessionPrompt}
${INTERACTIVE_RESPONSE_SURFACES_PROMPT}
${VERIFICATION_EVIDENCE_PROMPT}
## User Request
${task.goal}
## Scope
${task.scope}
${task.ticketContext ? `\n${task.ticketContext}\n` : ''}${nonGoals}${completionContract}`;
  }

  if (task.kind === 'ticket-review') {
    // A review is not delivery work: no worktree or MSI conventions, and the
    // ticket is named by its real key, not the internal review session key the
    // issue object carries.
    return `${sessionPrompt}
## Task
**Goal:** ${task.goal}
**Scope:** ${task.scope}
**Definition of Done:** ${task.definitionOfDone}
${nonGoals}
${completionContract}

## Issue Context
- Key: ${reviewedIssueKey(issue.key) ?? issue.key}
- Summary: ${issue.summary}
- Type: ${issue.issueType}
- Status: ${issue.status}
`;
  }

  const issueContextBlock = task.ticketContext?.trim()
    ? `\n${task.ticketContext.trim()}\n`
    : `
## Issue Context
- Key: ${issue.key}
- Summary: ${issue.summary}
- Type: ${issue.issueType}
- Status: ${issue.status}
${issue.description ? `- Description:\n${issue.description.slice(0, 4000)}` : ''}
`;

  return `${sessionPrompt}
${INTERACTIVE_RESPONSE_SURFACES_PROMPT}
${VERIFICATION_EVIDENCE_PROMPT}
## Task
**Goal:** ${task.goal}
**Scope:** ${task.scope}
**Definition of Done:** ${task.definitionOfDone}
${workflow}
${attachments}
${nonGoals}
${completionContract}
${issueContextBlock}
## Execution Conventions
- If you create a git worktree, its name MUST start with ${issue.key}.
- Use a worktree name like: ${worktreeName}
- If you publish a new MSI, keep the base version and append -${issue.key}-<build-id>.
- Return that same <build-id> in DELIVERY_RESULT.buildIdentifier so the Jira upload name can match the MSI build.
- Use an MSI version like: ${msiVersionExample}
- Do not publish a generic MSI artifact name or version that omits the Jira issue key.
`;
}

export interface PermissionInfo {
  description: string;
  kind: string;
  detail?: string;
  toolName?: string;
}
