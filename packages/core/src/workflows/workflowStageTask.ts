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
import { nodeOutputs, type CheckFindings, type WorkflowAgentTaskNode, type WorkflowArtifactKind } from './workflowTypes';
import { parseReviewFindings } from '../ai/aiReviewService';
import { PUBLISHABLE_PLAN_INSTRUCTIONS } from './workflowPlanPublishing';
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
    definitionOfDone: [
      `Produce every required artifact before finishing:\n${outputs}`,
      context.expectedOutputs.some(output => output.kind === 'findings') ? FINDINGS_BLOCK_INSTRUCTIONS : undefined,
      context.expectedOutputs.some(output => output.publishTo === 'board') ? PUBLISHABLE_PLAN_INSTRUCTIONS : undefined
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n\n'),
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

/** How a stage delivers a `findings` output: the block `parseReviewFindings` reads. */
export const FINDINGS_BLOCK_INSTRUCTIONS = [
  'A findings output is delivered as the last fenced ```json block of your response, in this shape:',
  '```json',
  '{ "summary": "One-paragraph assessment", "findings": [ { "file": "path/from/repo/root", "line": 42, "severity": "critical" | "high" | "medium" | "low" | "info", "category": "e.g. security", "message": "What is wrong and why it matters", "suggestion": "The concrete fix" } ] }',
  '```',
  'Use an empty "findings" array when there are none. Prose alone does not count.'
].join('\n');

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

  // A findings output is the structured JSON findings block at the end of the stage's response.
  // Without one the stage has not delivered what it declared, and the engine fails it as such.
  let findings: CheckFindings | undefined;
  const findingsContracts = nodeOutputs(node).filter(contract => contract.kind === 'findings');
  if (findingsContracts.length > 0 && session.responseText?.trim()) {
    try {
      findings = parseReviewFindings(session.responseText).findings;
      for (const contract of findingsContracts) {
        if (!artifacts.some(artifact => artifact.contractId === contract.id)) {
          artifacts.push({ contractId: contract.id, kind: contract.kind });
        }
      }
    } catch {
      findings = undefined;
    }
  }

  return {
    status: 'succeeded',
    artifacts,
    ...(findings ? { findings } : {}),
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
  /**
   * Where the whole report can be read, relative to the stage's working directory, when it is
   * too long to inline. Without one, a long report reaches the stage with its middle cut out.
   */
  fullTextPath?: string;
}

/**
 * Enough for a whole review report to arrive intact, small enough not to become the prompt. A
 * report longer than this keeps its head (the summary) and its tail (the register and verdict).
 */
export const UPSTREAM_REPORT_MAX_CHARS = 24000;

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
        : `${text.slice(0, Math.floor(maxChars / 2)).trimEnd()}\n\n[… ${text.length - maxChars} characters omitted${
            report.fullTextPath ? ` — read the whole report from \`${report.fullTextPath}\` before relying on any part of it` : ''
          } …]\n\n${text.slice(text.length - Math.floor(maxChars / 2)).trimStart()}`;
    return `### "${report.contractId}" from ${report.stageName}${report.fullTextPath && text.length > maxChars ? ` (full text: \`${report.fullTextPath}\`)` : ''}\n${shown}`;
  });
  return `Reports from earlier stages (use these rather than re-deriving them):\n\n${blocks.join('\n\n')}`;
}

/** An upstream check's captured output, read from its evidence file. */
export interface UpstreamLog {
  contractId: string;
  stageName: string;
  text: string;
}

/** Per log: scanner output is dense, and its tail holds the tool's own summary and exit line. */
export const UPSTREAM_LOG_MAX_CHARS = 12000;

/**
 * The upstream check logs a stage is handed inline. A log is a file in the app's evidence store,
 * outside the run's worktree, where an agent's file tools cannot reach — so a stage told only the
 * path could never read what the checks found. Capped the same way as reports.
 */
export function formatUpstreamLogs(logs: readonly UpstreamLog[], maxChars = UPSTREAM_LOG_MAX_CHARS): string | undefined {
  const usable = logs.filter(log => log.text.trim());
  if (usable.length === 0) return undefined;
  const blocks = usable.map(log => {
    const text = log.text.trim();
    const shown =
      text.length <= maxChars
        ? text
        : `${text.slice(0, Math.floor(maxChars / 2)).trimEnd()}\n\n[… ${text.length - maxChars} characters omitted …]\n\n${text.slice(text.length - Math.floor(maxChars / 2)).trimStart()}`;
    return `### "${log.contractId}" from ${log.stageName}\n\`\`\`text\n${shown}\n\`\`\``;
  });
  return `Output of earlier check stages (already captured — do not try to open their files):\n\n${blocks.join('\n\n')}`;
}
