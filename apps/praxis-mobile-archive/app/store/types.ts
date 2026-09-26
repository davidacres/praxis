import type {
  AnyGadgetEnvelope,
  GadgetActionDescriptor,
  GadgetActionValue,
  MobileDeviceAccess,
  MobileFileDiff,
  MobileHostInfo,
  MobileModelCatalog,
  MobileProviderCatalog,
  MobileRunSnapshot,
  MobileSessionChanges,
  MobileSessionMode,
  MobileSessionSnapshot,
} from '@praxis/core';
import type { MobileShellState } from '../../renderer/mobileShellState';
import type { MobileDetailTab, MobilePrimaryRoute } from '../../renderer/mobileNavigation';
import type { MobileFollowUp } from '../../renderer/mobileFollowUp';
import type { MobileAttentionItem } from '../../renderer/mobileAttention';
import type { MobileUsageView } from '../../renderer/mobileUsage';
import type { MobileSessionSelection } from '../../renderer/mobileSessionOptions';
import type { MobileConnectionIssue } from '../../renderer/mobilePairingInvitation';
import type { MobileHostConfiguration } from '../mobileConnection';
import type { TranscriptMessage } from '../Transcript';

export interface MobileHostSummary { hostId: string; hostName: string; online: boolean }
export interface MobileProjectSummary { projectId: string; name: string; workflow?: string }
export interface MobileWorkflowChoice { workflowId: string; name: string; trigger: string }
export interface MobileRunSummary {
  runId: string;
  workflowName: string;
  status: string;
  explanation: string;
  stages: Array<{
    nodeId: string;
    name: string;
    outcome: string;
    lane: string;
    artifacts: Array<{ contractId: string; kind: string; path?: string }>;
  }>;
}
export interface MobileWorkItem {
  workId: string;
  title: string;
  status: string;
  sessionId: string;
  runId?: string;
  provider?: string;
  model?: string;
  mode: MobileSessionMode;
  /** Not yet created on the desktop; `selection` is what the first message will launch. */
  draft?: boolean;
  selection?: MobileSessionSelection;
}
export type MobileTranscriptMessage = TranscriptMessage;
export interface MobileActivityEntry { id: string; at: string; workId: string; title: string; text: string }

/** A host-backed value that may still be loading, or not offered by an older desktop. */
export interface Remote<T> { status: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error'; value?: T; message?: string }

export interface Store {
  shell: MobileShellState;
  /** False after an intentional disconnect, so the connect screen does not immediately bootstrap the saved host. */
  autoConnectEnabled: boolean;
  host: MobileHostSummary;
  hostInfo: MobileHostInfo | undefined;
  hostConfig: MobileHostConfiguration | undefined;
  project: MobileProjectSummary;
  work: MobileWorkItem[];
  attention: MobileAttentionItem[];
  followUps: MobileFollowUp[];
  workflows: MobileWorkflowChoice[];
  runs: Record<string, MobileRunSummary>;
  /** The project's workflow runs, newest first — live from `run.snapshot` events. */
  workflowRuns: MobileRunSnapshot[];
  /** False against a desktop too old to list runs. */
  runsSupported: boolean;
  openWorkId: string | undefined;
  openRunId: string | undefined;
  connectionIssue: MobileConnectionIssue | undefined;
  pairing: { message: string; deviceLabel?: string } | undefined;
  providers: Remote<MobileProviderCatalog>;
  models: Record<string, Remote<MobileModelCatalog>>;
  access: Remote<MobileDeviceAccess>;
  activity: MobileActivityEntry[];

  connect(config: MobileHostConfiguration): Promise<void>;
  retryConnection(): void;
  cancelConnect(): void;
  disconnect(options?: { forget?: boolean }): void;
  setRoute(primary: MobilePrimaryRoute): void;
  setDetail(detail: MobileDetailTab): void;
  openWork(workId: string | undefined): void;
  openRun(runId: string | undefined): void;
  /** A stage's session record, for its AI and model — read from the desktop if the phone has not seen it. */
  sessionFor(sessionId: string): MobileSessionSnapshot | undefined;
  loadSession(sessionId: string): Promise<void>;
  retryStage(runId: string, nodeId: string): Promise<void>;
  startNewChat(): void;
  transcriptFor(sessionId: string): MobileTranscriptMessage[];
  usageFor(item: MobileWorkItem): MobileUsageView;
  refreshUsage(sessionId: string): Promise<void>;
  refreshProviders(): Promise<void>;
  loadModels(provider: string, refresh?: boolean): Promise<void>;
  updateDraftSelection(workId: string, patch: Partial<MobileSessionSelection>): void;
  /** Between-turn provider handover / model change / mode switch of an existing session. */
  configureSession(item: MobileWorkItem, change: { provider?: string; model?: string; mode?: MobileSessionMode }): Promise<void>;
  sendFollowUp(work: MobileWorkItem, text: string): Promise<void>;
  retryFollowUp(messageId: string): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  /** Allowing asks the person to prove it is them first; resolves false when they cancel. */
  respondToPermission(requestId: string, decision: 'allow' | 'deny'): Promise<boolean>;
  startWorkflow(workflowId: string, task: string): Promise<void>;
  /** Asks the person to prove it is them first; resolves false when they cancel. */
  approve(runId: string): Promise<boolean>;
  /** Fails the run's approval with the reason recorded; asks the person to prove it is them first. */
  reject(runId: string, reason: string): Promise<boolean>;
  /** Whether this desktop accepts `operation` from the phone now. */
  canCommand(operation: 'workflowGates.approve' | 'workflowGates.reject' | 'workflowRuns.retryStage' | 'gadgets.submit'): boolean;
  loadRun(runId: string): Promise<void>;
  /** Answers a gadget in a session; approving or changing answers ask the person to prove it is them first. */
  answerGadget(sessionId: string, gadget: AnyGadgetEnvelope, action: GadgetActionDescriptor, value: GadgetActionValue): Promise<void>;
  /** Whether this desktop can show a session's working-tree changes. */
  changesSupported: boolean;
  sessionChanges(sessionId: string): Promise<MobileSessionChanges>;
  fileDiff(sessionId: string, path: string): Promise<MobileFileDiff>;
}
