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
 * What an apply actually did to the ticket fields, versus what the form merely
 * sent. A description field is required, so a round with nothing new to say
 * about it still resubmits the current text verbatim — writing that back is
 * harmless, but the summary shown to the user must say what changed, not what
 * was merely present in the form, or "updated the description" appears next to
 * a description that reads identically before and after.
 *
 * Pure and exported so the wording is pinned by a unit test without needing
 * the tracker singletons `applyTicketReview` itself depends on.
 */
export function describeAppliedChanges(
  before: { summary?: string; description?: string },
  fields: { summary: string; description: string }
): { changedSummary: boolean; changedDescription: boolean; label: string | undefined } {
  const changedSummary = Boolean(fields.summary) && normalized(fields.summary) !== normalized(before.summary);
  const changedDescription = Boolean(fields.description) && normalized(fields.description) !== normalized(before.description);
  const changed = [changedSummary && 'summary', changedDescription && 'description'].filter(
    (field): field is string => Boolean(field)
  );
  return {
    changedSummary,
    changedDescription,
    label: changed.length > 0 ? `updated the ${changed.join(' and ')}` : undefined
  };
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

  // Fetched once, whenever a field might touch the ticket: the conflict check
  // (against the baseline, when one is known) and the "what actually changed"
  // wording below both read off the ticket's state immediately before this
  // write, not off what the form happened to be pre-filled with. A form field
  // is required and so often resubmits the unchanged current text — writing
  // that back is harmless, but claiming it as a change is not: the apply
  // form's own "Got it — description left as-is" reply and the result banner
  // must agree.
  const before = changesTicket ? await service.getIssue(issueKey) : undefined;
  const baseline = baselines.get(sessionId);
  if (before && baseline) {
    const edited =
      (description && normalized(before.description) !== normalized(baseline.description)) ||
      (summary && normalized(before.summary) !== normalized(baseline.summary));
    if (edited) {
      throw new Error(
        `${issueKey} was edited after this review started, so applying now would overwrite that edit. Run the review again to work from the current ticket.`
      );
    }
  }

  const applied: string[] = [];
  if (changesTicket && before) {
    const { label } = describeAppliedChanges(before, { summary, description });
    const updated = await service.updateIssue(issueKey, {
      ...(summary ? { summary } : {}),
      ...(description ? { description } : {})
    });
    recordTicketReviewBaseline(sessionId, updated);
    if (label) {
      applied.push(label);
    } else if (!comment) {
      // Every field it sent matched what was already there — the review had
      // nothing left to apply this round, and the user should see that plainly
      // rather than a claimed update that changed nothing.
      applied.push('nothing changed — the ticket already matched');
    }
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
