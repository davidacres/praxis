/**
 * Stage preflight and Agent Hub binding (FX-BE-020 / TASK-098).
 *
 * A workflow definition names an agent profile and runtime host independently;
 * legacy agentId values are used as both ids during migration.
 * Preflight is where that name is resolved against what is actually discovered,
 * trusted, and loadable *right now* — which is the whole reason definitions
 * store ids rather than manifests. Revoking trust or breaking a manifest takes
 * effect at the next stage start, not at the next save.
 *
 * Everything here fails closed, and every failure carries a remediation: a
 * stage refusing to start is only useful if it says what to fix.
 *
 * Pure, and takes a catalog snapshot rather than the runtime manager, so the
 * rules are testable without discovering anything from disk. `AgentRuntimeSnapshot`
 * satisfies `AgentCatalogSnapshot` structurally.
 */

import type { AgentToolMode } from '../ai/agentTypes';
import type { AgentCapabilities } from '../ai/agentRuntime/hostLoader';
import type { DiscoveredAgent } from '../ai/agentRuntime/manifest';
import type { DiscoveredSkill } from '../ai/agentRuntime/skillRegistry';
import type { DiscoveredAgentProfile } from '../ai/agentRuntime/profileRegistry';
import {
  isAgentTaskNode,
  nodeMutatesWorktree,
  type WorkflowAgentRef,
  type WorkflowCapabilityRequirement,
  type WorkflowNode,
  type WorkflowPolicyProfile
} from './workflowTypes';

/** The subset of a runtime snapshot preflight needs. */
export interface AgentCatalogSnapshot {
  /** Legacy name for runtime hosts. */
  agents: DiscoveredAgent[];
  runtimeHosts?: DiscoveredAgent[];
  profiles?: DiscoveredAgentProfile[];
  skills: DiscoveredSkill[];
  /** Keyed by agent id; present only for agents whose host has been loaded. */
  capabilities: Record<string, AgentCapabilities>;
}

export type PreflightFailureKind =
  | 'agent-not-found'
  | 'profile-not-found'
  | 'profile-invalid'
  | 'profile-untrusted'
  | 'agent-invalid'
  | 'agent-untrusted'
  | 'agent-unavailable'
  | 'capability-unsupported'
  | 'skill-not-found'
  | 'skill-invalid'
  | 'skill-untrusted'
  | 'skill-drifted'
  | 'tool-mode-refused';

export interface PreflightFailure {
  kind: PreflightFailureKind;
  /** What is wrong. */
  message: string;
  /** What the user must do about it. */
  remediation: string;
}

/** Everything the orchestrator needs to actually start the stage. */
export interface StageAgentBinding {
  nodeId: string;
  /** Legacy host attribution. */
  agentId: string;
  profileId: string;
  profileInstructions: string;
  profileFingerprint?: string;
  hostId: string;
  providerId?: string;
  agentRootPath: string;
  skills: Array<{ name: string; skillPath: string; instructionsPath: string; fingerprint: string }>;
  toolMode: AgentToolMode;
  /** Undefined when the host has not been loaded and the stage required nothing. */
  capabilities?: AgentCapabilities;
  mutatesWorktree: boolean;
}

export interface StagePreflightResult {
  ok: boolean;
  failures: PreflightFailure[];
  /** Present only when `ok`. */
  binding?: StageAgentBinding;
}

/**
 * Checks one stage against the live catalog.
 *
 * `policy` is optional but should be the *composed* profile from
 * `WorkflowPolicyStore.effectiveForProject`, never a raw stored one — a project
 * profile alone can be weaker than the org's.
 */
export function preflightStage(
  node: WorkflowNode,
  catalog: AgentCatalogSnapshot,
  policy?: WorkflowPolicyProfile
): StagePreflightResult {
  // Only agent stages bind to the Agent Hub; checks, approvals, and joins have
  // nothing to resolve.
  if (!isAgentTaskNode(node)) return { ok: true, failures: [] };

  const failures: PreflightFailure[] = [];
  const ref = node.agent;
  const requireTrust = policy?.requireTrustedAgents ?? true;
  const hostId = ref.hostId || hostId;
  const profileId = ref.profileId || hostId;
  const runtimeHosts = catalog.runtimeHosts ?? catalog.agents;
  const agent = runtimeHosts.find(candidate => candidate.manifest.id === hostId);
  const profile = catalog.profiles?.find(candidate => candidate.profile.id === profileId);
  if (!agent) {
    return {
      ok: false,
      failures: [
        {
          kind: 'agent-not-found',
          message: `Agent "${hostId}" is not in the ${ref.scope} catalog.`,
          remediation: `Install or import an agent with id "${hostId}", or point this stage at one that exists.`
        }
      ]
    };
  }

  if ((ref.profileId || (catalog.profiles && catalog.profiles.length > 0)) && !profile) {
    failures.push({
      kind: 'profile-not-found',
      message: `Agent profile "${profileId}" is not in the ${ref.scope} catalog.`,
      remediation: `Create or import an AGENT.md profile with id "${profileId}", or select an existing profile.`
    });
  }
  if (profile?.error) {
    failures.push({
      kind: 'profile-invalid',
      message: `Agent profile "${profileId}" is invalid: ${profile.error}`,
      remediation: `Fix ${profile.profilePath}.`
    });
  }
  if (profile && requireTrust && !profile.trusted) {
    failures.push({
      kind: 'profile-untrusted',
      message: `Agent profile "${profileId}" is not trusted.`,
      remediation: 'Move the profile under the trusted profiles folder, or relax requireTrustedAgents.'
    });
  }

  if (agent.errors.length > 0) {
    failures.push({
      kind: 'agent-invalid',
      message: `Agent "${hostId}" has a malformed manifest: ${agent.errors
        .map(error => `${error.path}: ${error.message}`)
        .join('; ')}`,
      remediation: `Fix ${agent.manifestPath}.`
    });
  }

  // `DiscoveredAgent.trusted` conflates "found under the trusted user root" with
  // "manifest parsed cleanly" — that is how discovery reports it today. Both are
  // reasons to refuse, so the conflation is safe here even though a future
  // FX-BF-009 catalog may separate them.
  if (requireTrust && !agent.trusted) {
    failures.push({
      kind: 'agent-untrusted',
      message: `Agent "${hostId}" is not trusted.`,
      remediation:
        'Move the agent under the trusted agents folder, or relax requireTrustedAgents in the workflow policy.'
    });
  }

  const capabilities = catalog.capabilities[hostId];
  const required = ref.requiredCapabilities;
  if (required && Object.keys(required).length > 0) {
    if (!capabilities) {
      failures.push({
        kind: 'agent-unavailable',
        message: `Agent "${hostId}" declares capability requirements but its host is not running.`,
        remediation: 'Start the agent from the Agent Hub so its capabilities can be read.'
      });
    } else {
      for (const unmet of unmetCapabilities(required, capabilities)) {
        failures.push({
          kind: 'capability-unsupported',
          message: `Agent "${hostId}" does not support ${unmet}, which this stage requires.`,
          remediation: `Choose an agent that supports ${unmet}, or drop the requirement from the stage.`
        });
      }
    }
  }

  failures.push(...preflightSkills(ref, catalog, requireTrust));

  // Validation catches this at authoring time; it is re-checked here because a
  // definition can arrive from a project folder that never passed through the
  // designer.
  if (!nodeMutatesWorktree(node) && ref.toolMode === 'full') {
    failures.push({
      kind: 'tool-mode-refused',
      message: `Stage "${node.id}" is non-mutating but requests full tool mode.`,
      remediation: 'Set the stage to read-only or project-only, or mark it as mutating.'
    });
  }

  if (failures.length > 0) return { ok: false, failures };

  return {
    ok: true,
    failures: [],
    binding: {
      nodeId: node.id,
      agentId: hostId,
      profileId,
      profileInstructions: profile?.profile.instructions ?? '',
      ...(profile ? { profileFingerprint: profile.fingerprint } : {}),
      hostId,
      ...(ref.providerId ? { providerId: ref.providerId } : {}),
      agentRootPath: agent.rootPath,
      skills: (ref.skillNames ?? []).map(name => {
        const skill = catalog.skills.find(candidate => candidate.metadata.name === name) as DiscoveredSkill;
        return {
          name,
          skillPath: skill.skillPath,
          instructionsPath: skill.instructionsPath,
          fingerprint: skill.fingerprint
        };
      }),
      toolMode: ref.toolMode,
      ...(capabilities ? { capabilities } : {}),
      mutatesWorktree: nodeMutatesWorktree(node)
    }
  };
}

function preflightSkills(
  ref: WorkflowAgentRef,
  catalog: AgentCatalogSnapshot,
  requireTrust: boolean
): PreflightFailure[] {
  const failures: PreflightFailure[] = [];

  for (const name of ref.skillNames ?? []) {
    const skill = catalog.skills.find(candidate => candidate.metadata.name === name);
    if (!skill) {
      failures.push({
        kind: 'skill-not-found',
        message: `Skill "${name}" is not discovered.`,
        remediation: `Install the "${name}" skill, or remove it from this stage.`
      });
      continue;
    }
    if (skill.error) {
      failures.push({
        kind: 'skill-invalid',
        message: `Skill "${name}" is invalid: ${skill.error}`,
        remediation: `Fix ${skill.instructionsPath}.`
      });
      continue;
    }
    if (requireTrust && !skill.trusted) {
      failures.push({
        kind: 'skill-untrusted',
        message: `Skill "${name}" is not trusted.`,
        remediation: 'Move the skill under a trusted skills root, or relax requireTrustedAgents.'
      });
      continue;
    }

    // A pinned fingerprint that no longer matches means the skill's
    // instructions changed under a workflow that was reviewed against the old
    // ones. That is a decision for a person, not a silent upgrade.
    const pinned = ref.skillFingerprints?.[name];
    if (pinned && pinned !== skill.fingerprint) {
      failures.push({
        kind: 'skill-drifted',
        message: `Skill "${name}" has changed since this workflow pinned it.`,
        remediation: `Review ${skill.instructionsPath} and re-pin the fingerprint, or restore the previous version.`
      });
    }
  }

  return failures;
}

function unmetCapabilities(
  required: WorkflowCapabilityRequirement,
  actual: AgentCapabilities
): string[] {
  const unmet: string[] = [];
  for (const [key, value] of Object.entries(required)) {
    // Only a positive requirement is enforced; an unset or false entry means
    // "don't care", never "must not support".
    if (value !== true) continue;
    if (!actual[key as keyof AgentCapabilities]) unmet.push(key);
  }
  return unmet.sort();
}

/** Runs preflight across every agent stage, for a pre-run readiness report. */
export function preflightWorkflow(
  nodes: WorkflowNode[],
  catalog: AgentCatalogSnapshot,
  policy?: WorkflowPolicyProfile
): { ok: boolean; byNode: Record<string, StagePreflightResult> } {
  const byNode: Record<string, StagePreflightResult> = {};
  let ok = true;
  for (const node of nodes) {
    const result = preflightStage(node, catalog, policy);
    byNode[node.id] = result;
    if (!result.ok) ok = false;
  }
  return { ok, byNode };
}
