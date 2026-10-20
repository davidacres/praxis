/**
 * Readiness for a scheduled run: what would stop it, or make it risky, if it
 * started now (FX-BF-047 / FX-BE-147 / TASK-383).
 *
 * Readiness is **derived, never stored**. A ticket can be deleted, moved off
 * the board, or lose its workflow between saving and starting, so the answer is
 * recomputed against the live board each time a schedule is opened. The caller
 * supplies a probe for the board side; this module stays pure.
 *
 * A *blocker* means the run cannot start as it stands. A *warning* means it can,
 * but the user should know first — the editor shows both and lets a warning
 * through.
 */

import type { ScheduledRun, ScheduledTicketRef } from './scheduledRun';

export type ReadinessSeverity = 'blocker' | 'warning';

export type ScheduledReadinessCode =
  | 'no-tickets'
  | 'start-in-past'
  | 'no-provider'
  | 'ticket-missing'
  | 'ticket-moved'
  | 'ticket-closed'
  | 'no-folder'
  | 'no-workflow'
  | 'no-acceptance-criteria'
  | 'in-other-schedule';

export interface ScheduledReadinessIssue {
  code: ScheduledReadinessCode;
  severity: ReadinessSeverity;
  /** Present when the issue belongs to one queue entry. */
  entryId?: string;
  message: string;
}

export interface ScheduledRunReadiness {
  /** False when any blocker is present. Warnings do not make a run not ready. */
  ready: boolean;
  issues: ScheduledReadinessIssue[];
}

/** What the board can say about one queued ticket right now. */
export interface ScheduledTicketProbe {
  /** `missing` = no longer exists; `moved` = exists but is no longer on this board. */
  state: 'found' | 'missing' | 'moved';
  /** The ticket is already in a finished status. */
  closed?: boolean;
  hasFolder?: boolean;
  hasWorkflow?: boolean;
  hasAcceptanceCriteria?: boolean;
  /** Name of another armed schedule that already queues this ticket. */
  inOtherSchedule?: string;
}

export interface ScheduledReadinessContext {
  now: string;
  probe: (ticket: ScheduledTicketRef) => ScheduledTicketProbe;
  /** Enabled AI providers that are set up. */
  usableProviderCount: number;
}

export function assessScheduledRunReadiness(run: ScheduledRun, context: ScheduledReadinessContext): ScheduledRunReadiness {
  const issues: ScheduledReadinessIssue[] = [];
  if (run.entries.length === 0) {
    issues.push({ code: 'no-tickets', severity: 'blocker', message: 'Add at least one ticket.' });
  }
  // Only a draft can have a start that is too late to arm. A scheduled run whose time has come is just due.
  if (run.status === 'draft' && Date.parse(run.scheduledStartAt) <= Date.parse(context.now)) {
    issues.push({ code: 'start-in-past', severity: 'blocker', message: 'The start time has already passed.' });
  }
  if (context.usableProviderCount <= 0) {
    issues.push({ code: 'no-provider', severity: 'blocker', message: 'No AI provider is enabled and set up to run the tickets.' });
  }

  for (const entry of run.entries) {
    const key = entry.ticket.issueKey;
    const probe = context.probe(entry.ticket);
    if (probe.state === 'missing') {
      issues.push({ code: 'ticket-missing', severity: 'blocker', entryId: entry.id, message: `${key} no longer exists.` });
      continue;
    }
    if (probe.state === 'moved') {
      issues.push({ code: 'ticket-moved', severity: 'blocker', entryId: entry.id, message: `${key} is no longer on this board.` });
      continue;
    }
    if (probe.closed) {
      issues.push({ code: 'ticket-closed', severity: 'blocker', entryId: entry.id, message: `${key} is already finished.` });
    }
    if (probe.hasFolder === false) {
      issues.push({ code: 'no-folder', severity: 'blocker', entryId: entry.id, message: `${key} has no working folder to run in.` });
    }
    if (probe.hasWorkflow === false) {
      issues.push({ code: 'no-workflow', severity: 'blocker', entryId: entry.id, message: `${key} has no workflow assigned.` });
    }
    if (probe.hasAcceptanceCriteria === false) {
      issues.push({
        code: 'no-acceptance-criteria',
        severity: 'warning',
        entryId: entry.id,
        message: `${key} has no acceptance criteria, so the agent may stop to ask.`
      });
    }
    if (probe.inOtherSchedule) {
      issues.push({
        code: 'in-other-schedule',
        severity: 'warning',
        entryId: entry.id,
        message: `${key} is also queued in "${probe.inOtherSchedule}".`
      });
    }
  }

  return { ready: !issues.some(issue => issue.severity === 'blocker'), issues };
}
