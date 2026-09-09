import {
  createDiagnosisSession as createDiagnosisSessionCore,
  PROVIDER_DESCRIPTORS,
  readEvidenceBundle,
  readEvidenceContent,
  type AgentTaskDefinition,
  type AgentToolMode,
  type CreateDiagnosisSessionResult,
  type DiagnosisSessionPort,
  type IssueDetails,
  type WorkflowCheckNode,
  type WorkflowEvidenceBundleKey
} from '@praxis/core';
import {
  getAcpAgentHost,
  getCopilotAgentHost,
  getVercelAgentService,
  resolveAcpStartOptions,
  resolveConnectionOptions,
  resolveCopilotStartOptions
} from './aiInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { evidenceStorageRoot } from './workflowEvidenceStorage';

/**
 * Diagnosis sessions from retained evidence (FX-BE-052 / TASK-135).
 *
 * A diagnosis session is not a ticket, so — exactly like `workflowAgentStage.ts`
 * does for workflow stages — it is attributed to a synthetic issue keyed by
 * run/node/attempt rather than forced through the real per-project issue list.
 * `diagnosisSessionKey` is that key; the Diagnose action in the run monitor
 * (TASK-137) opens a session by this key the same way `WorkflowRunMonitor`
 * already opens a stage's session by `stageSessionKey`.
 */
export function diagnosisSessionKey(key: WorkflowEvidenceBundleKey): string {
  return `diagnosis-${key.runId}-${key.nodeId}-${key.attempt}`;
}

const DEFAULT_DEFINITION_OF_DONE = 'The command named in the brief exits with one of its declared success codes when run again.';

/**
 * Exported so a diagnosis flow whose "done" criterion isn't a repro
 * command — e.g. `previewVerificationSession.ts`'s "the check's assertions
 * all pass when run again" — can reuse the real provider-dispatch logic
 * below rather than duplicating the three-way CLI-agent/Copilot/gateway
 * branching.
 */
export class ElectronDiagnosisSessionPort implements DiagnosisSessionPort {
  public constructor(
    private readonly issueKey: string,
    private readonly definitionOfDone: string = DEFAULT_DEFINITION_OF_DONE
  ) {}

  public async start(prompt: string, workingDirectory: string): Promise<string> {
    const settings = getSettingsBackend().read();
    const provider = settings.ai.activeProvider;
    const descriptor = PROVIDER_DESCRIPTORS[provider];

    // A synthetic issue, same convention as workflowAgentStage.ts: the
    // session store is issue-keyed, and a diagnosis attempt is not a ticket.
    const issue = {
      key: this.issueKey,
      summary: 'Diagnose failure',
      issueType: 'Task',
      status: 'In progress',
      projectKey: 'DIAGNOSIS'
    } as IssueDetails;

    const taskDefinition: AgentTaskDefinition = {
      kind: 'general',
      goal: prompt,
      scope: 'The working tree at the given working directory only.',
      definitionOfDone: this.definitionOfDone
    };

    if (descriptor.kind === 'cli-agent' && descriptor.hostKind === 'copilot-sdk') {
      const { runtimePath, model } = resolveCopilotStartOptions(provider);
      return getCopilotAgentHost().startTask(issue, taskDefinition, provider, {
        runtimePath,
        model,
        workingDirectory,
        toolMode: 'full'
      });
    }
    if (descriptor.kind === 'cli-agent') {
      const { command, args } = resolveAcpStartOptions(provider);
      return getAcpAgentHost().startTask(issue, taskDefinition, provider, {
        command,
        args,
        workingDirectory,
        toolMode: 'full'
      });
    }
    const gateway = await resolveConnectionOptions(provider);
    if (!gateway.apiKey) throw new Error(`No ${descriptor.label} API key configured for diagnosis sessions.`);
    return getVercelAgentService().startTask(issue, taskDefinition, {
      apiKey: gateway.apiKey,
      gatewayUrl: gateway.gatewayUrl,
      workingDirectory,
      model: gateway.model,
      provider,
      toolMode: 'full'
    });
  }
}

export interface StartDiagnosisSessionInput {
  key: WorkflowEvidenceBundleKey;
  node: WorkflowCheckNode;
  workingDirectory: string | undefined;
  toolMode: AgentToolMode;
}

/**
 * Reads the retained bundle for this attempt back off disk, then hands it to
 * `createDiagnosisSession` (core) with the real Electron-backed port. A
 * missing bundle or a failed preflight never reaches `ElectronDiagnosisSessionPort` —
 * no session opens just to discover it has nothing to work from.
 */
export async function startDiagnosisSessionFromEvidence(
  input: StartDiagnosisSessionInput
): Promise<CreateDiagnosisSessionResult> {
  const { bundle } = await readEvidenceBundle(evidenceStorageRoot(), input.key);
  if (!bundle) {
    return {
      ok: false,
      reason: 'no-evidence',
      message: 'No retained evidence exists for this attempt; there is nothing to diagnose from.'
    };
  }

  const evidenceContent: Record<string, string> = {};
  for (const entry of bundle.entries) {
    if (entry.presence !== 'present') continue;
    try {
      evidenceContent[entry.label] = await readEvidenceContent(evidenceStorageRoot(), input.key, entry);
    } catch {
      // Content unreadable (e.g. removed out of band): renderDiagnosisPrompt
      // shows "(unavailable)" for this entry rather than failing the whole brief.
    }
  }

  const port = new ElectronDiagnosisSessionPort(diagnosisSessionKey(input.key));
  return createDiagnosisSessionCore(port, {
    bundle,
    node: input.node,
    workingDirectory: input.workingDirectory,
    toolMode: input.toolMode,
    evidenceContent,
    environment: { platform: process.platform, arch: process.arch, node: process.version }
  });
}
