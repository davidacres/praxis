import {
  TICKET_REVIEW_APPLY_FIELDS,
  reviewedIssueKey,
  type AgentSessionRecord
} from '@praxis/core';
import { getAiSessionManager } from './aiInstance';
import { getServiceForConnection } from './serviceRegistry';

/**
 * The description and summary the review last read or wrote, per review
 * session. The agent rewrote the description from a snapshot; applying that over
 * a description someone edited in the meantime would silently discard their
 * edit. Comparing against this baseline before writing turns that into a
 * refusal the user can act on.
 *
 * It is the fields an apply overwrites, not the tracker's `updated` marker: a
 * comment (including the one "Post as comment" adds) bumps `updated` without
 * touching anything an apply would clobber.
 *
 * In memory on purpose: after a restart there is no baseline, and the check is
 * skipped rather than blocking every apply on a session that outlived the app.
 */
interface TicketBaseline {
  summary?: string;
  description?: string;
}

const baselines = new Map<string, TicketBaseline>();

const normalized = (value: string | undefined): string => (value ?? '').trim();

export function recordTicketReviewBaseline(sessionId: string, ticket: TicketBaseline): void {
  baselines.set(sessionId, { summary: ticket.summary, description: ticket.description });
}

export function forgetTicketReviewBaseline(sessionId: string): void {
  baselines.delete(sessionId);
}

function findSession(sessionId: string): AgentSessionRecord | undefined {
  return [...getAiSessionManager().getAllAgentSessions().values()].find(session => session.sessionId === sessionId);
}

function text(fields: Record<string, string | number | boolean>, name: (typeof TICKET_REVIEW_APPLY_FIELDS)[number]): string {
  const value = fields[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Writes an approved ticket review to the tracker.
 *
 * This is the one place a ticket-review gadget reaches a service that mutates
 * state, and it does so through the same `IssueTrackerService` every other
 * ticket edit uses. It refuses anything that is not a ticket-review session, so
 * a gadget from an ordinary chat cannot borrow the gate to edit tickets.
 */
export async function applyTicketReview(
  sessionId: string,
  fields: Record<string, string | number | boolean>
): Promise<{ outcome: unknown; message: string }> {
  const record = findSession(sessionId);
  const issueKey = reviewedIssueKey(record?.issueKey);
  if (!record || !issueKey) {
    throw new Error('Ticket changes can only be applied from a ticket review.');
  }

  const summary = text(fields, 'summary');
  const description = text(fields, 'description');
  const comment = text(fields, 'comment');
  if (!summary && !description && !comment) {
    throw new Error('There is nothing to apply — fill in at least one field.');
  }

  const service = await getServiceForConnection(record.connectionId);
  const changesTicket = Boolean(summary || description);

  const baseline = baselines.get(sessionId);
  if (changesTicket && baseline) {
    const current = await service.getIssue(issueKey);
    const edited =
      (description && normalized(current.description) !== normalized(baseline.description)) ||
      (summary && normalized(current.summary) !== normalized(baseline.summary));
    if (edited) {
      throw new Error(
        `${issueKey} was edited after this review started, so applying now would overwrite that edit. Run the review again to work from the current ticket.`
      );
    }
  }

  const applied: string[] = [];
  if (changesTicket) {
    const updated = await service.updateIssue(issueKey, {
      ...(summary ? { summary } : {}),
      ...(description ? { description } : {})
    });
    recordTicketReviewBaseline(sessionId, updated);
    applied.push(`updated the ${[summary && 'summary', description && 'description'].filter(Boolean).join(' and ')}`);
  }
  if (comment) {
    await service.addComment(issueKey, comment);
    applied.push('posted a comment');
  }

  return {
    outcome: { issueKey, summary: Boolean(summary), description: Boolean(description), comment: Boolean(comment) },
    message: `Applied to ${issueKey}: ${applied.join(' and ')}.`
  };
}
