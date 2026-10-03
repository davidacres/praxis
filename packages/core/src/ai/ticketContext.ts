import type { IssueDetails, WorkflowTransition } from '../types';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { AgentToolMode } from './agentTypes';

export interface ResolveTicketContextOptions {
  issue: IssueDetails;
  backendService?: IssueTrackerService;
  toolMode?: AgentToolMode;
  /** Max description characters for related tickets (defaults to 1200). */
  relatedDescriptionLimit?: number;
  /** Max comments to show from the main ticket (defaults to 5). */
  recentCommentLimit?: number;
}

/**
 * Resolves comprehensive ticket details, parent, dependencies, sibling tasks,
 * and available transitions, formatting them into a structured markdown block
 * with explicit lifecycle and progress-reporting directives.
 */
export async function resolveTicketContext(options: ResolveTicketContextOptions): Promise<string> {
  const { issue, backendService, toolMode } = options;
  const relatedDescLimit = options.relatedDescriptionLimit ?? 1200;
  const commentLimit = options.recentCommentLimit ?? 5;

  // 1. Fetch parent issue details if available
  let parentIssueDetails: IssueDetails | undefined;
  const parentKey = issue.parentKey || issue.parentIssue?.key;
  if (parentKey && backendService) {
    try {
      parentIssueDetails = await backendService.getIssue(parentKey);
    } catch {
      // best-effort
    }
  }

  // 2. Fetch dependencies (dependsOn)
  const dependencyDetails: IssueDetails[] = [];
  if (issue.dependsOn && issue.dependsOn.length > 0 && backendService) {
    for (const depKey of issue.dependsOn.slice(0, 5)) {
      try {
        const dep = await backendService.getIssue(depKey);
        dependencyDetails.push(dep);
      } catch {
        // best-effort
      }
    }
  }

  // 3. Fetch linked issues details
  const linkedDetails: Array<{ relationship: string; issue: IssueDetails }> = [];
  if (issue.linkedIssues && issue.linkedIssues.length > 0 && backendService) {
    for (const link of issue.linkedIssues.slice(0, 5)) {
      try {
        const resolved = await backendService.getIssue(link.key);
        linkedDetails.push({ relationship: link.relationship, issue: resolved });
      } catch {
        // best-effort fallback to reference
        linkedDetails.push({
          relationship: link.relationship,
          issue: {
            key: link.key,
            summary: link.summary ?? '',
            status: link.status ?? '',
            issueType: 'Task',
            projectKey: ''
          } as IssueDetails
        });
      }
    }
  }

  // 4. Fetch available transitions
  let availableTransitions: WorkflowTransition[] = issue.transitions ?? [];
  if (backendService && (!availableTransitions || availableTransitions.length === 0)) {
    try {
      availableTransitions = await backendService.getTransitions(issue.key);
    } catch {
      // best-effort
    }
  }

  const sections: string[] = [];

  // Active Ticket Section
  const mainHeader = [
    `## Active Ticket: ${issue.key} — ${issue.summary}`,
    `- Key: ${issue.key}`,
    `- Summary: ${issue.summary}`,
    `- Type: ${issue.issueType}`,
    `- Status: ${issue.status}`,
    issue.priority ? `- Priority: ${issue.priority}` : undefined,
    issue.assignee ? `- Assignee: ${issue.assignee}` : undefined,
    issue.branch ? `- Branch: ${issue.branch}` : undefined,
    '',
    '### Description',
    issue.description?.trim() ? issue.description.trim() : '*(No description provided)*'
  ].filter((line): line is string => line !== undefined);

  if (issue.comments && issue.comments.length > 0) {
    mainHeader.push('');
    const visibleComments = issue.comments.slice(-commentLimit);
    mainHeader.push(`### Recent Comments (${issue.comments.length} total, latest ${visibleComments.length})`);
    for (const c of visibleComments) {
      const author = c.author || 'User';
      const body = c.body.length > 600 ? `${c.body.slice(0, 600)}…` : c.body;
      mainHeader.push(`- **${author}:** ${body}`);
    }
  }
  sections.push(mainHeader.join('\n'));

  // Related Tickets Section
  const relatedParts: string[] = ['## Related Tickets & Dependencies'];
  let hasRelated = false;

  // Parent
  if (parentIssueDetails || issue.parentIssue) {
    hasRelated = true;
    const pKey = parentIssueDetails?.key || issue.parentIssue?.key;
    const pSummary = parentIssueDetails?.summary || issue.parentIssue?.summary || '';
    const pStatus = parentIssueDetails?.status ? ` [${parentIssueDetails.status}]` : '';
    relatedParts.push(`### Parent Issue: ${pKey} — ${pSummary}${pStatus}`);
    if (parentIssueDetails?.description?.trim()) {
      const pDesc = parentIssueDetails.description.trim();
      const truncated = pDesc.length > relatedDescLimit ? `${pDesc.slice(0, relatedDescLimit)}…` : pDesc;
      relatedParts.push(`**Goal / Overview:**\n${truncated}`);
    }
    // Sibling tasks from parent
    if (parentIssueDetails?.subTasks && parentIssueDetails.subTasks.length > 0) {
      const siblings = parentIssueDetails.subTasks.filter(st => st.key !== issue.key);
      if (siblings.length > 0) {
        relatedParts.push('**Sibling Tasks under Parent (Boundaries):**');
        for (const sib of siblings) {
          relatedParts.push(`- ${sib.key}: ${sib.summary} [${sib.status}]${sib.assignee ? ` (${sib.assignee})` : ''}`);
        }
      }
    }
  }

  // Dependencies (dependsOn)
  if (dependencyDetails.length > 0) {
    hasRelated = true;
    relatedParts.push('### Dependencies (must be respected/verified)');
    for (const dep of dependencyDetails) {
      relatedParts.push(`- **${dep.key} — ${dep.summary}** [${dep.status}]`);
      if (dep.description?.trim()) {
        const dDesc = dep.description.trim();
        const truncated = dDesc.length > 800 ? `${dDesc.slice(0, 800)}…` : dDesc;
        relatedParts.push(`  *Contract / Requirements:* ${truncated}`);
      }
    }
  } else if (issue.dependsOn && issue.dependsOn.length > 0) {
    hasRelated = true;
    relatedParts.push(`### Dependencies: ${issue.dependsOn.join(', ')}`);
  }

  // Linked issues
  if (linkedDetails.length > 0) {
    hasRelated = true;
    relatedParts.push('### Linked Issues');
    for (const link of linkedDetails) {
      const statusPart = link.issue.status ? ` [${link.issue.status}]` : '';
      relatedParts.push(`- ${link.relationship} **${link.issue.key}** — ${link.issue.summary}${statusPart}`);
      if (link.issue.description?.trim() && (link.relationship.toLowerCase().includes('block') || link.relationship.toLowerCase().includes('depend'))) {
        const truncated = link.issue.description.slice(0, 500).trim();
        relatedParts.push(`  *Details:* ${truncated}`);
      }
    }
  }

  // Sub-tasks on the active ticket
  if (issue.subTasks && issue.subTasks.length > 0) {
    hasRelated = true;
    relatedParts.push('### Sub-Tasks of this Ticket');
    for (const st of issue.subTasks) {
      relatedParts.push(`- ${st.key}: ${st.summary} [${st.status}]${st.assignee ? ` (${st.assignee})` : ''}`);
    }
  }

  if (hasRelated) {
    sections.push(relatedParts.join('\n'));
  }

  // Available Transitions
  if (availableTransitions && availableTransitions.length > 0) {
    const transitionLines = [
      '## Available Ticket Transitions',
      `Current ticket status: **${issue.status}**`,
      'Available transitions you can trigger via `tracker_transition_ticket`:'
    ];
    for (const t of availableTransitions) {
      transitionLines.push(`- **${t.name}** (id: \`${t.id}\`${t.toStatus ? `, moves to: "${t.toStatus}"` : ''})`);
    }
    sections.push(transitionLines.join('\n'));
  }

  // Directives
  if (toolMode !== 'read-only') {
    sections.push(`## Ticket Lifecycle & Progress Reporting Directives
1. **Analyze Dependencies**: Carefully review the active ticket requirements and all related issues above. Ensure your implementation honors existing contracts and does not duplicate work assigned to sibling tasks.
2. **Kickoff**: Before modifying files, transition this ticket to "In Progress" using \`tracker_transition_ticket\` (using the appropriate transition id or status name from the available transitions above), and post your initial plan using \`tracker_add_comment\`.
3. **Stage Progression**: As you progress through major phases (such as completing implementation before beginning automated tests, or if an architectural blocker is found), post a concise progress comment using \`tracker_add_comment\`.
4. **Completion**: When all requirements and the Definition of Done are satisfied and verified (tests pass, code compiles), post a clear completion summary comment using \`tracker_add_comment\` detailing:
   - Files modified or created
   - Test and verification results
   - Any follow-up items
   Then transition the ticket to "In Review" or "Done" using \`tracker_transition_ticket\`.`);
  } else {
    sections.push(`## Ticket Context Directives (Read-Only Mode)
- This session is read-only: do not transition tickets or post comments to the tracker.
- Use the active ticket and related issues above to guide your analysis, findings, and conversation.`);
  }

  return sections.join('\n\n');
}
