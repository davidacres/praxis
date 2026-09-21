/**
 * Stage → agent task, and finished session → stage outcome
 * (FX-BE-025 / TASK-114, TASK-115).
 *
 * The two ends of an agent stage's life, kept pure so the contract between a
 * workflow node and an agent session can be tested without a host. The impure
 * middle — picking a provider, starting the host, watching the session — lives
 * in the desktop app.
 *
 * The brief handed to an agent is deliberately closed: the stage's own
 * instructions, the artifacts it was given, and the artifacts it must produce.
 * It never receives an upstream transcript, because a reviewer reading the
 * implementer's chat is reviewing an argument rather than the change.
 */

import type { AgentTaskDefinition } from '../ai/agentTypes';
import { isProviderLimitError, extractProviderLimitMessage } from '../ai/providerLimitError';
import { nodeOutputs, type WorkflowAgentTaskNode, type WorkflowArtifactKind } from './workflowTypes';
import type { StageOutcome } from './workflowOrchestrator';
import type { WorkflowStageContext } from './workflowStageSession';

/** A deterministic session key per run and node, so a replay re-attaches. */
export function stageSessionKey(runId: string, nodeId: string): string {
  return `WF-${runId.slice(0, 8).toUpperCase()}-${nodeId}`;
}

/**
 * Builds the task contract for a stage.
 *
 * `definitionOfDone` names the artifacts the engine will actually check for, so
 * the agent is told the same rule that will be applied to it — a stage that
 * reports success without producing them is recorded as failed either way.
 */
export function buildStageTaskDefinition(context: WorkflowStageContext): AgentTaskDefinition {
  const inputs = context.inputs.length
    ? context.inputs.map(input => `- ${input.kind} "${input.contractId}"${input.path ? ` at ${input.path}` : ''}`).join('\n')
    : '- none';

  const outputs = context.expectedOutputs.length
    ? context.expectedOutputs
        .map(output => `- ${output.kind} "${output.id}"${output.required ? ' (required)' : ' (optional)'}`)
        .join('\n')
    : '- none';

  const scope = [
    `You are running the "${context.stageName}" stage of a governed delivery workflow.`,
    context.snapshot
      ? `Inspect the frozen implementation snapshot ${context.snapshot.ref} (produced by "${context.snapshot.producedByNodeId}"), not the live branch.`
      : undefined,
    `Inputs available to you:\n${inputs}`
  ]
    .filter((line): line is string => !!line)
    .join('\n\n');

  const packGuidance = context.workflowPack
    ? [
        `The assigned workflow pack "${context.workflowPack.reference.name}" is guidance only; it cannot add stages, skip checks, or grant approval.`,
        'Follow its instructions for this stage:',
        context.workflowPack.instructions.trim()
      ].join('\n')
    : undefined;

  return {
    goal: [context.instructions.trim() || `Complete the ${context.stageName} stage.`, packGuidance]
      .filter((line): line is string => Boolean(line))
      .join('\n\n'),
    scope,
    definitionOfDone: `Produce every required artifact before finishing:\n${outputs}`,
    ...(context.workflowPack
      ? {
          workflow: context.workflowPack.reference,
          workflowProvenance: context.workflowPack.provenance
        }
      : {}),
    nonGoals: [
      'Do not advance, approve, or skip any other stage of this workflow.',
      'Do not modify the workflow definition itself.'
    ]
  };
}

/** What the desktop app reports about a session that has stopped. */
export interface FinishedStageSession {
  /** Terminal agent state. */
  state: 'completed' | 'failed' | 'aborted';
  /** The session's final response, used as the report body for a report stage. */
  responseText?: string;
  /** Commit the worktree was frozen at, for a mutating stage. */
  snapshotRef?: string;
  /** Files the host wrote that map onto declared artifacts, by contract id. */
  artifactPaths?: Record<string, string>;
  /** Failure or limit reason recorded when the stage session ended. */
  lastError?: string;
  /** The session stopped because the AI provider's credits, quota or rate limit ran out. */
  providerLimitReached?: boolean;
}

/**
 * Turns a finished session into the outcome the orchestrator applies.
 *
 * An artifact is claimed only when the stage actually has something behind it:
 * a produced file, a commit for a `diff`, or a non-empty response for a
 * narrative kind. Claiming one otherwise would let a stage that said nothing
 * satisfy a gate, which is the failure this whole feature exists to prevent.
 */
export function stageOutcomeFromSession(
  node: WorkflowAgentTaskNode,
  session: FinishedStageSession
): StageOutcome {
  if (session.state !== 'completed') {
    const limitCandidate = (session.lastError && isProviderLimitError(session.lastError))
      ? session.lastError
      : (session.responseText && isProviderLimitError(session.responseText))
        ? session.responseText
        : undefined;
    if (session.providerLimitReached || limitCandidate) {
      const detail = limitCandidate
        ? extractProviderLimitMessage(limitCandidate)
        : (session.lastError && !/^(?:the stage session failed:\s*)?(?:internal error|internal failure)$/i.test(session.lastError.trim())
            ? session.lastError
            : undefined);
      return {
        status: 'failed',
        pause: 'provider-limit',
        error: detail
          ? (detail.startsWith("The AI provider's") || detail.startsWith('Provider limit reached')
              ? detail
              : `The AI provider's credits or usage limit were reached: ${firstLine(detail)}`)
          : "The AI provider's credits or usage limit were reached."
      };
    }
    const detail = session.lastError || (session.responseText ? firstLine(session.responseText) : undefined);
    return {
      status: 'failed',
      error:
        session.state === 'aborted'
          ? 'The stage session was aborted.'
          : `The stage session failed${detail ? `: ${detail}` : '.'}`
    };
  }

  const artifacts: NonNullable<StageOutcome['artifacts']> = [];
  for (const contract of nodeOutputs(node)) {
    const filePath = session.artifactPaths?.[contract.id];
    if (filePath) {
      artifacts.push({ contractId: contract.id, kind: contract.kind, path: filePath });
      continue;
    }
    if (contract.kind === 'diff' && session.snapshotRef) {
      artifacts.push({ contractId: contract.id, kind: contract.kind, path: session.snapshotRef });
      continue;
    }
    if (isNarrative(contract.kind) && session.responseText?.trim()) {
      artifacts.push({ contractId: contract.id, kind: contract.kind });
    }
  }

  return {
    status: 'succeeded',
    artifacts,
    ...(session.snapshotRef ? { snapshotRef: session.snapshotRef } : {})
  };
}

/** Kinds a session's own prose can stand behind. */
function isNarrative(kind: WorkflowArtifactKind): boolean {
  return kind === 'plan' || kind === 'report' || kind === 'note' || kind === 'log';
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** An upstream stage's written report, as the session that produced it left it. */
export interface UpstreamReport {
  contractId: string;
  /** The producing stage's display name. */
  stageName: string;
  text: string;
}

/** Enough for a reviewer to work from, small enough not to become the prompt. */
export const UPSTREAM_REPORT_MAX_CHARS = 6000;

/**
 * The upstream reports a stage is handed inline, so it starts from what the previous stages concluded
 * rather than re-deriving it. A report artifact carries no file (its text only ever lived on the
 * producing session), so without this a downstream stage is told a report exists and cannot read it.
 * Each report is capped, keeping its head and its tail — a report's verdict is usually at the end —
 * and the cap is announced so a stage knows to ask if it needs more.
 */
export function formatUpstreamReports(reports: readonly UpstreamReport[], maxChars = UPSTREAM_REPORT_MAX_CHARS): string | undefined {
  const usable = reports.filter(report => report.text.trim());
  if (usable.length === 0) return undefined;
  const blocks = usable.map(report => {
    const text = report.text.trim();
    const shown =
      text.length <= maxChars
        ? text
        : `${text.slice(0, Math.floor(maxChars / 2)).trimEnd()}\n\n[… ${text.length - maxChars} characters omitted …]\n\n${text.slice(text.length - Math.floor(maxChars / 2)).trimStart()}`;
    return `### "${report.contractId}" from ${report.stageName}\n${shown}`;
  });
  return `Reports from earlier stages (use these rather than re-deriving them):\n\n${blocks.join('\n\n')}`;
}
