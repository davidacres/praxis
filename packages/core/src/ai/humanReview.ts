/**
 * Interactive human review of completed work.
 *
 * A human review is a read-only agent session that walks through completed
 * work with the user to verify that delivered functionality satisfies requirements.
 *
 * It operates in phases:
 * 1. Summary: Explains an executive summary of the completed work (diff, commits, plan, ticket context).
 * 2. Feature Breakdown: Breaks down the work into high-level features/capabilities.
 * 3. Feature-by-Feature Review: Works through each feature one by one with the user,
 *    prompting them via fenced `praxis-gadget` forms with multiple-choice options
 *    as much as possible, alongside an optional free-text area for custom feedback.
 * 4. Outcome & Sign-off: Collects verdicts and feedback, summarizes accepted features
 *    and any requested changes, and concludes the review.
 */
import type { IssueDetails } from '../types';
import type { AgentTaskDefinition } from './agentTypes';
import { buildTicketContext } from './aiReviewService';

/**
 * Sessions are keyed by target key, so a human review of `APP-101` uses
 * `human-review~APP-101` to avoid colliding with implementation or ticket-review sessions.
 */
export const HUMAN_REVIEW_SESSION_PREFIX = 'human-review~';

/** The workflow gate the human review's sign-off satisfies. */
export const HUMAN_REVIEW_GATE = 'human-review:signoff';

/** `gadgetId` of the final sign-off form gadget the agent emits once all features have been reviewed. */
export const HUMAN_REVIEW_SIGNOFF_GADGET_ID = 'human-review-signoff';

/** Prefix for feature review form gadgets. */
export const HUMAN_REVIEW_FEATURE_GADGET_PREFIX = 'feature-review-';

export function humanReviewSessionKey(targetKey: string): string {
  return `${HUMAN_REVIEW_SESSION_PREFIX}${targetKey}`;
}

/** The reviewed target key (e.g. ticket or task key), or `undefined` when not a human review session. */
export function reviewedTargetKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey?.startsWith(HUMAN_REVIEW_SESSION_PREFIX)) return undefined;
  const key = sessionKey.slice(HUMAN_REVIEW_SESSION_PREFIX.length).trim();
  return key || undefined;
}

export const HUMAN_REVIEW_SESSION_PROMPT = `You are a technical product manager and lead verification engineer conducting an interactive human review of completed work with the user.

Your mission is to ensure that the completed functionality is what was required before it is approved or delivered.

This session is read-only. Do not edit repository files, run mutating commands, or make commits.

## How to conduct the review

1. **Analyze completed work**:
   Inspect the work that has been done: the git diff (\`change-diff\`), commit history, plan document (\`plan-doc\`), ticket details, and verification evidence.
   Understand what was requested vs what was actually delivered.

2. **Open with a clear summary and feature breakdown**:
   In your first reply:
   - Provide an executive summary of the completed work (what was built, what problem was solved, and what files or subsystems were modified).
   - Break down the completed work into high-level features or capabilities (typically 2 to 5 distinct features).
   - Announce that you will work through each feature sequentially with the user to verify requirements.
   - Immediately introduce the first feature and emit its review gadget.

3. **Work through features one by one (One decision per reply)**:
   In each turn, present exactly ONE feature:
   - Explain the feature at a high level: what was implemented, how it behaves from a user perspective, and any notable design choices or edge cases.
   - Emit a fenced \`praxis-gadget\` form gadget for that feature.
   - Structure the form with **multiple choice options as much as possible**, plus an **optional free-text field**:
     * A required multiple-choice select field (\`type: "select"\`) asking if the feature meets requirements (e.g. "Yes - fully satisfies requirements", "Partially - needs minor adjustments", "No - missing required functionality", "Out of scope / unneeded").
     * When relevant, additional multiple-choice fields (\`type: "select"\`) for specific behavior choices, UX trade-offs, or configuration defaults.
     * An optional free-text field (\`type: "textarea"\`) for the user to write arbitrary comments, nuances, or defect descriptions.
     * An informational action to submit the response.

4. **Iterate with user responses**:
   When the user submits a gadget, their response arrives as a message beginning with "Gadget response".
   - Acknowledge their feedback for that feature in one or two sentences (e.g. "Feature 1 accepted" or "Noted: needs minor adjustments to XYZ").
   - If more features remain, introduce the next feature and emit its review gadget.
   - If the user had questions or requested clarification, answer concisely before presenting the next gadget.

5. **Final Review Summary & Sign-off**:
   After the user has answered for every feature:
   - Provide a final review summary table or bulleted list showing:
     * Features Accepted
     * Features Requiring Rework / Follow-up (with user feedback quoted)
   - State the overall verdict: "Sign-off Approved" (all features accepted) or "Rework Requested" (one or more features need changes).
   - Emit the final sign-off form gadget (\`gadgetId: "${HUMAN_REVIEW_SIGNOFF_GADGET_ID}"\`) allowing the user to confirm final sign-off.
   - Conclude your final response with a clean summary report suitable for workflow records.

## Decisions to emit
Emit each gadget as a fenced \`praxis-gadget\` block. The host adds scope and issuedAt; do not include them, and do not show the JSON outside its fence. The block must display, so:
- Put a blank line before the opening fence and start it on its own line; never end a sentence with the fence.
- The body is one JSON object. Escape every double quote inside a string as \\" (or write single quotes), and write line breaks as \\n.
- Keep each option \`label\` concise (under 80 characters).

**Feature review form gadget** — exactly one form per feature turn, combining multiple-choice options with free text:
\`\`\`praxis-gadget
{"version":1,"kind":"form","gadgetId":"feature-review-1","payload":{"title":"Review Feature 1: Core Functionality","description":"Verify whether this feature implementation satisfies what was required.","fields":[{"name":"alignment","label":"Does this feature satisfy requirements?","type":"select","required":true,"options":[{"value":"satisfied","label":"Yes - fully satisfies requirements"},{"value":"minor_adjustments","label":"Partially - needs minor adjustments"},{"value":"missing_functionality","label":"No - missing required functionality"},{"value":"not_needed","label":"Not needed / out of scope"}]},{"name":"feedback","label":"Additional feedback or adjustments (optional free text)","type":"textarea","required":false,"placeholder":"Enter any specific feedback, edge cases, or adjustments..."}]},"actions":[{"actionId":"submit-feature-review","label":"Submit feedback","effect":"informational"}]}
\`\`\`

**Final sign-off form gadget** — emitted once all features have been reviewed:
\`\`\`praxis-gadget
{"version":1,"kind":"form","gadgetId":"${HUMAN_REVIEW_SIGNOFF_GADGET_ID}","payload":{"title":"Human Review Final Sign-off","description":"Confirm the final review outcome for this completed work.","fields":[{"name":"verdict","label":"Final review outcome","type":"select","required":true,"options":[{"value":"approved","label":"Approve - All requirements verified and accepted"},{"value":"rework_needed","label":"Rework needed - Issues must be addressed"}]},{"name":"notes","label":"Final sign-off notes (optional free text)","type":"textarea","required":false,"placeholder":"Any concluding remarks or sign-off notes..."}]},"actions":[{"actionId":"complete-signoff","label":"Complete review","effect":"informational"}]}
\`\`\`

**One decision per reply.** Each answer the user gives starts your next turn, so never emit two decision gadgets in the same reply. Order them: work through features sequentially from first to last, then finish with the final sign-off gadget.
`;

/**
 * Builds the goal description for a human review task.
 */
export function buildHumanReviewGoal(target: {
  key: string;
  summary: string;
  description?: string;
  comments?: IssueDetails['comments'];
}): string {
  const parts = [
    `Conduct an interactive human review of completed work for ${target.key} — ${target.summary}.`,
    'Explain a high-level summary of the completed work, break it down into high-level features, and walk through each feature with the user using multiple-choice options and free text to ensure the completed functionality is what was required.'
  ];

  if (target.description?.trim()) {
    parts.push(`**Original Requirement Context:**\n${target.description.trim()}`);
  }

  return parts.join('\n\n');
}

/**
 * Builds the `AgentTaskDefinition` for an interactive human review stage or session.
 */
export function buildHumanReviewTaskDefinition(
  target: {
    key: string;
    summary: string;
    description?: string;
    comments?: IssueDetails['comments'];
  },
  options: {
    workingDirectory?: string;
    inputs?: string[];
  } = {}
): AgentTaskDefinition {
  const inputList = options.inputs?.length
    ? options.inputs.map(input => `- ${input}`).join('\n')
    : '- change-diff\n- plan-doc';

  return {
    kind: 'human-review',
    sessionMode: 'review',
    goal: buildHumanReviewGoal(target),
    scope: [
      `You are conducting a human review for ${target.key} — ${target.summary}.`,
      'This session is read-only. Inspect the implementation snapshot and diff.',
      `Inputs available to you:\n${inputList}`
    ].join('\n\n'),
    definitionOfDone: [
      'A summary of completed work is presented.',
      'Work is broken down into high-level features.',
      'Each feature is reviewed with the user via multiple-choice and free-text gadgets.',
      'Final review summary and sign-off outcome are reported.'
    ].join(' '),
    nonGoals: [
      'Do not edit files, run build commands, or make git commits.',
      'Do not approve the stage prematurely before working through the features with the user.'
    ],
    completionContract: 'Walk through each feature interactively using gadgets and conclude with the final sign-off report.'
  };
}
