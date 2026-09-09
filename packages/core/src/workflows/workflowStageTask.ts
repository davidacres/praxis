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

import type { AgentTaskDefinition, AgentToolMode } from '../ai/agentTypes';
import { nodeOutputs, type WorkflowAgentTaskNode, type WorkflowArtifactKind } from './workflowTypes';
import type { StageOutcome } from './workflowOrchestrator';
import type { WorkflowStageContext } from './workflowStageSession';

export interface DiagnosisEvidenceReference {
  label: string;
  path?: string;
  uri?: string;
}

export interface DiagnosisSessionEvidence {
  revision?: string;
  environment?: string;
  command?: string;
  evidenceRefs?: DiagnosisEvidenceReference[];
  worktreePath?: string;
  toolMode?: AgentToolMode;
}

export interface DiagnosisSessionPreflightResult {
  ok: boolean;
  reason?: string;
}

/** A deterministic session key per run and node, so a replay re-attaches. */
export function stageSessionKey(runId: string, nodeId: string): string {
  return `WF-${runId.slice(0, 8).toUpperCase()}-${nodeId}`;
}

/**
 * Builds the closed brief for a diagnosis session created from retained evidence.
 *
 * The task is grounded in the evidence the run actually retained rather than in
 * pasted log content, so the agent is told exactly which revision, environment,
 * command and evidence files it can inspect.
 */
export function buildDiagnosisTaskDefinition(evidence: DiagnosisSessionEvidence): AgentTaskDefinition {
  const revision = evidence.revision?.trim() || 'unknown revision';
  const environment = evidence.environment?.trim() || 'unknown environment';
  const command = evidence.command?.trim() || 'No recorded command available.';
  const refs = (evidence.evidenceRefs ?? []).filter(ref => ref.label.trim().length > 0);
  const evidenceList = refs.length > 0
    ? refs.map(ref => {
        const detail = [ref.path, ref.uri].filter(Boolean).join(' | ');
        return `- ${ref.label}${detail ? ` (${detail})` : ''}`;
      }).join('\n')
    : '- none recorded';

  return {
    kind: 'analysis',
    goal: `Diagnose the failed workflow using the retained evidence for revision ${revision}.`,
    scope: [
      `Repository revision: ${revision}`,
      `Environment: ${environment}`,
      `Recorded command: ${command}`,
      `Evidence references:\n${evidenceList}`,
      'Use the retained evidence and repository state as the source of truth; do not re-run pasted log content as commands or invent a fresh reproduction from memory.'
    ].join('\n\n'),
    definitionOfDone: 'Identify the likely root cause, explain why the failure happened, name the evidence that confirms it, and state the bounded next repair step or blocker.',
    nonGoals: [
      'Do not start a repair without a real repository worktree and tool access.',
      'Do not paste raw log output back into the shell as a command.'
    ]
  };
}

/** Guards a repair/diagnosis session against the folderless or read-only paths the app can pose. */
export function diagnoseSessionPreflight(input: DiagnosisSessionEvidence): DiagnosisSessionPreflightResult {
  if (input.toolMode === 'project-only') {
    return {
      ok: false,
      reason: 'Repair cannot start because this project is folderless; only project-board tools are available.'
    };
  }

  if (input.toolMode === 'read-only') {
    return {
      ok: false,
      reason: 'Repair cannot start in read-only mode; the session can inspect evidence but cannot run the repository commands needed to fix it.'
    };
  }

  if (!input.worktreePath || input.worktreePath.trim().length === 0) {
    return {
      ok: false,
      reason: 'Repair cannot start because this session has no repository worktree attached; a diagnosis needs a real folder-backed project.'
    };
  }

  return { ok: true };
}

export const buildDiagnosisBrief = buildDiagnosisTaskDefinition;
export const createDiagnosisTaskDefinition = buildDiagnosisTaskDefinition;
export const diagnosisPreflight = diagnoseSessionPreflight;
export const diagnoseSessionAccess = diagnoseSessionPreflight;

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

  return {
    goal: context.instructions.trim() || `Complete the ${context.stageName} stage.`,
    scope,
    definitionOfDone: `Produce every required artifact before finishing:\n${outputs}`,
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
    return {
      status: 'failed',
      error:
        session.state === 'aborted'
          ? 'The stage session was aborted.'
          : `The stage session failed${session.responseText ? `: ${firstLine(session.responseText)}` : '.'}`
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
