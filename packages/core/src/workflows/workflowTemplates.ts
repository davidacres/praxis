/**
 * Workflow template library (FX-BE-021 / TASK-101).
 *
 * A template is just a `WorkflowDefinition` a user starts from. The library
 * offers three tiers — the app's built-ins, the user's saved globals, and a
 * project's committed definitions — and turning one into a project's own
 * workflow is a copy of the *definition*, never of an agent manifest. The copy
 * keeps the agent ids; whether those ids resolve is answered separately, before
 * the workflow can run.
 *
 * The built-in `governed-delivery` template is defined here rather than in
 * FX-BE-022 because the designer needs something to open on day one. FX-BE-022
 * registers it as the delivery default and adds the run-monitor around it.
 */

import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from './workflowTypes';
import { validateWorkflow } from './workflowValidation';
import type { AgentCatalogSnapshot } from './workflowPreflight';
import { preflightWorkflow } from './workflowPreflight';
import type { WorkflowSource } from './workflowStore';

export interface WorkflowTemplate {
  definition: WorkflowDefinition;
  source: WorkflowSource;
  /** Absolute path, for project-sourced templates. */
  path?: string;
  /** True for the app's own templates, which cannot be edited in place. */
  builtIn: boolean;
}

/** Per-template readiness, so a bad Agent Hub reference is visible before a run. */
export interface TemplateReadiness {
  templateId: string;
  /** Structurally valid — cycles, dangling refs, gates all check out. */
  structureOk: boolean;
  /** Every agent stage resolves against the live catalog. */
  agentsOk: boolean;
  /** Node id → the first blocking reason, for the ones that failed. */
  blockingByNode: Record<string, string>;
}

// ── Built-in templates ───────────────────────────────────────────────────

const NOW = '2026-09-02T00:00:00.000Z';

/**
 * Plan → Implement → (Review ∥ QA ∥ Security) → Gates → Approve.
 *
 * The agent ids (`praxis-planner`, `praxis-implementer`, `praxis-reviewer`) are
 * conventional: a project points them at real Agent Hub agents, or the designer
 * flags them as unresolved. QA and security are deterministic checks precisely
 * so their gates cannot be waved through by an agent.
 */
export function governedDeliveryTemplate(): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'governed-delivery',
    name: 'Governed delivery',
    description: 'Plan, implement, then converge review, QA, and security before a human approves.',
    scope: 'global',
    version: 1,
    entryNodeId: 'plan',
    builtIn: true,
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [
      {
        type: 'agent-task',
        id: 'plan',
        name: 'Plan',
        x: 0,
        y: 160,
        inputs: [],
        agent: { agentId: 'praxis-planner', scope: 'global', toolMode: 'read-only' },
        instructions: 'Produce an implementation plan for the assigned task.',
        outputs: [{ id: 'plan-doc', kind: 'plan', required: true, description: 'The implementation plan.' }],
        mutatesWorktree: false
      },
      {
        type: 'agent-task',
        id: 'implement',
        name: 'Implement',
        x: 240,
        y: 160,
        inputs: ['plan-doc'],
        agent: { agentId: 'praxis-implementer', scope: 'global', toolMode: 'full' },
        instructions: 'Implement the plan. Commit the change and report the ref.',
        outputs: [{ id: 'change-diff', kind: 'diff', required: true, description: 'The implemented change.' }],
        mutatesWorktree: true,
        maxAttempts: 2
      },
      {
        type: 'agent-task',
        id: 'review',
        name: 'Review',
        x: 480,
        y: 0,
        inputs: ['change-diff'],
        agent: { agentId: 'praxis-reviewer', scope: 'global', toolMode: 'read-only' },
        instructions: 'Review the implementation snapshot for correctness and quality.',
        outputs: [{ id: 'review-report', kind: 'report', required: true }],
        mutatesWorktree: false,
        satisfiesGate: 'review'
      },
      {
        type: 'check',
        id: 'qa',
        name: 'QA',
        x: 480,
        y: 160,
        inputs: ['change-diff'],
        command: 'npm',
        args: ['test'],
        successExitCodes: [0],
        outputs: [{ id: 'qa-results', kind: 'test-results', required: true }],
        satisfiesGate: 'qa'
      },
      {
        type: 'check',
        id: 'security',
        name: 'Security scan',
        x: 480,
        y: 320,
        inputs: ['change-diff'],
        command: 'npm',
        args: ['audit', '--audit-level=high'],
        successExitCodes: [0],
        outputs: [{ id: 'security-report', kind: 'report', required: true }],
        satisfiesGate: 'security'
      },
      { type: 'join', id: 'gates', name: 'Gates', x: 720, y: 160, inputs: [], mode: 'all' },
      {
        type: 'approval',
        id: 'approve',
        name: 'Approve',
        x: 960,
        y: 160,
        inputs: ['review-report', 'qa-results', 'security-report'],
        prompt: 'Review, QA, and security have passed. Approve this change for delivery?',
        requiredGates: ['review', 'qa', 'security'],
        allowBypass: false
      }
    ],
    edges: [
      { id: 'e-plan-impl', from: 'plan', to: 'implement', on: 'success', required: true },
      { id: 'e-impl-review', from: 'implement', to: 'review', on: 'success', required: true },
      { id: 'e-impl-qa', from: 'implement', to: 'qa', on: 'success', required: true },
      { id: 'e-impl-sec', from: 'implement', to: 'security', on: 'success', required: true },
      { id: 'e-review-gates', from: 'review', to: 'gates', on: 'success', required: true },
      { id: 'e-qa-gates', from: 'qa', to: 'gates', on: 'success', required: true },
      { id: 'e-sec-gates', from: 'security', to: 'gates', on: 'success', required: true },
      { id: 'e-gates-approve', from: 'gates', to: 'approve', on: 'success', required: true }
    ]
  };
}

/** A minimal starting point: implement then approve, no gates. */
export function quickChangeTemplate(): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'quick-change',
    name: 'Quick change',
    description: 'One implementation stage and a human sign-off. No automated gates.',
    scope: 'global',
    version: 1,
    entryNodeId: 'implement',
    builtIn: true,
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [
      {
        type: 'agent-task',
        id: 'implement',
        name: 'Implement',
        x: 0,
        y: 0,
        inputs: [],
        agent: { agentId: 'praxis-implementer', scope: 'global', toolMode: 'full' },
        instructions: 'Implement the assigned change.',
        outputs: [{ id: 'change-diff', kind: 'diff', required: true }],
        mutatesWorktree: true
      },
      {
        type: 'approval',
        id: 'approve',
        name: 'Approve',
        x: 240,
        y: 0,
        inputs: ['change-diff'],
        prompt: 'Approve this change?',
        requiredGates: [],
        allowBypass: false
      }
    ],
    edges: [{ id: 'e-impl-approve', from: 'implement', to: 'approve', on: 'success', required: true }]
  };
}

export function builtInWorkflowTemplates(): WorkflowDefinition[] {
  return [governedDeliveryTemplate(), quickChangeTemplate()];
}

// ── Library assembly ─────────────────────────────────────────────────────

export interface AssembleTemplateLibraryInput {
  /** Defaults to `builtInWorkflowTemplates()`. */
  builtIn?: WorkflowDefinition[];
  global?: WorkflowDefinition[];
  project?: Array<{ definition: WorkflowDefinition; path?: string }>;
}

/**
 * The templates offered to a project, in tier order: built-in, then global,
 * then project. Unlike the run catalog this does not collapse by id — a user
 * choosing a starting point should see every option, including a project
 * template that happens to share a built-in's id.
 */
export function assembleTemplateLibrary(input: AssembleTemplateLibraryInput = {}): WorkflowTemplate[] {
  const builtIn = (input.builtIn ?? builtInWorkflowTemplates()).map(
    (definition): WorkflowTemplate => ({ definition, source: 'built-in', builtIn: true })
  );
  const global = (input.global ?? []).map(
    (definition): WorkflowTemplate => ({ definition, source: 'global', builtIn: false })
  );
  const project = (input.project ?? []).map(
    (entry): WorkflowTemplate => ({
      definition: entry.definition,
      source: 'project',
      builtIn: false,
      ...(entry.path ? { path: entry.path } : {})
    })
  );
  return [...builtIn, ...global, ...project];
}

// ── Instantiation ────────────────────────────────────────────────────────

export interface InstantiateTemplateInput {
  template: WorkflowDefinition;
  projectId: string;
  /** New id for the project copy. Defaults to `<template.id>-<projectId>`. */
  newId?: string;
  /** New display name. Defaults to the template's name. */
  newName?: string;
  at: string;
}

/**
 * Copies a template into a project-scoped definition.
 *
 * The copy is deep, re-scoped to the project, reset to version 1, and stripped
 * of `builtIn`. Agent ids are carried across verbatim — the point of storing
 * ids rather than manifests is that the copy references the same catalog agents
 * without duplicating anything.
 */
export function instantiateTemplateForProject(input: InstantiateTemplateInput): WorkflowDefinition {
  const clone = JSON.parse(JSON.stringify(input.template)) as WorkflowDefinition;
  const { builtIn: _builtIn, ...rest } = clone;

  return {
    ...rest,
    id: input.newId ?? `${input.template.id}-${input.projectId}`,
    name: input.newName ?? input.template.name,
    scope: 'project',
    projectId: input.projectId,
    version: 1,
    createdAt: input.at,
    updatedAt: input.at
  };
}

/** Duplicates a definition in place (same scope), for "Save as a copy". */
export function duplicateWorkflowDefinition(
  definition: WorkflowDefinition,
  input: { newId: string; newName?: string; at: string }
): WorkflowDefinition {
  const clone = JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
  const { builtIn: _builtIn, ...rest } = clone;
  return {
    ...rest,
    id: input.newId,
    name: input.newName ?? `${definition.name} copy`,
    version: 1,
    createdAt: input.at,
    updatedAt: input.at
  };
}

// ── Readiness ────────────────────────────────────────────────────────────

/**
 * Assesses whether a template could actually run against the live catalog.
 *
 * Surfaced in the library so a user does not pick a template, wire it to a
 * project, and only discover at run time that `praxis-reviewer` was never
 * installed.
 */
export function assessTemplateReadiness(
  template: WorkflowDefinition,
  catalog: AgentCatalogSnapshot
): TemplateReadiness {
  const structure = validateWorkflow(template);
  const preflight = preflightWorkflow(template.nodes, catalog);

  const blockingByNode: Record<string, string> = {};
  for (const [nodeId, result] of Object.entries(preflight.byNode)) {
    if (result.ok || result.failures.length === 0) continue;
    blockingByNode[nodeId] = result.failures[0].message;
  }

  return {
    templateId: template.id,
    structureOk: structure.valid,
    agentsOk: preflight.ok,
    blockingByNode
  };
}
