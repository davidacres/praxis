/**
 * Master-plan artifact builders for the Task Designer — host-agnostic.
 *
 * Ported verbatim from the VS Code extension's `taskDesignerPanelManager.ts`
 * (buildMasterPlanMarkdown / buildGeneratedFeatureArtifacts and friends). The
 * host (extension workspace folder or desktop working directory) only owns the
 * file writes; the markdown itself is generated here exactly once.
 */

import {
  computeTaskDesignerTopologicalOrder,
  type TaskDesignerDirectedConnector,
  type TaskDesignerTicketNode
} from './taskDesignerState';

export const MASTER_PLAN_DIRECTORY_NAME = 'plans';
export const MASTER_PLAN_FILE_NAME = 'master-plan.md';
export const GENERATED_FEATURES_ROOT_SEGMENT = 'features';
export const GENERATED_FEATURES_DIRECTORY_NAME = 'generated-from-designer';
export const GENERATED_STORIES_PER_FEATURE = 3;

export interface TaskDesignerGeneratedStoryArtifact {
  readonly node: TaskDesignerTicketNode;
  readonly order: number;
  readonly featureNumber: number;
  readonly storyNumber: number;
  readonly ref: string;
  readonly slug: string;
  readonly dependencies: readonly string[];
}

export interface TaskDesignerGeneratedFeatureArtifact {
  readonly featureNumber: number;
  readonly ref: string;
  readonly slug: string;
  readonly title: string;
  readonly stories: readonly TaskDesignerGeneratedStoryArtifact[];
  readonly dependencies: readonly string[];
}

export interface TaskDesignerMasterPlanArtifacts {
  readonly masterPlanMarkdown: string;
  readonly features: readonly TaskDesignerGeneratedFeatureArtifact[];
  readonly storyCount: number;
}

const DEFAULT_ARTIFACT_PRIORITY = 'P2';
const DEFAULT_ARTIFACT_COMPLEXITY = 'Low';
const DEFAULT_ARTIFACT_RISK = 'Low';
const DEFAULT_ARTIFACT_CONFIDENCE = 'High';

function toSingleLineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function toTwoDigitNumber(value: number): string {
  return value.toString().padStart(2, '0');
}

function toSlug(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
    .replace(/-$/g, '');
  return normalized || fallback;
}

function toExecutionPriority(priority?: string): string {
  const normalized = toSingleLineText(priority ?? '').toUpperCase();
  if (/^P[0-4]$/.test(normalized)) {
    return normalized;
  }
  return DEFAULT_ARTIFACT_PRIORITY;
}

function compareNodeIds(
  leftNodeId: string,
  rightNodeId: string,
  nodeOrder: ReadonlyMap<string, number>
): number {
  const leftOrder = nodeOrder.get(leftNodeId) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = nodeOrder.get(rightNodeId) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return leftNodeId.localeCompare(rightNodeId);
}

export function buildTaskDesignerMasterPlanMarkdown(
  nodes: readonly TaskDesignerTicketNode[],
  connectors: readonly TaskDesignerDirectedConnector[]
): string {
  const orderedNodeIds = computeTaskDesignerTopologicalOrder(nodes, connectors);
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const orderedNodes = (orderedNodeIds ?? nodes.map(node => node.id))
    .map(nodeId => nodeById.get(nodeId))
    .filter((node): node is TaskDesignerTicketNode => Boolean(node));
  const nodeOrder = new Map(orderedNodes.map((node, index) => [node.id, index]));
  const dependencyRows = connectors
    .filter(connector => nodeById.has(connector.sourceNodeId) && nodeById.has(connector.targetNodeId))
    .slice()
    .sort((left, right) => {
      const bySource = compareNodeIds(left.sourceNodeId, right.sourceNodeId, nodeOrder);
      if (bySource !== 0) {
        return bySource;
      }
      const byTarget = compareNodeIds(left.targetNodeId, right.targetNodeId, nodeOrder);
      if (byTarget !== 0) {
        return byTarget;
      }
      return left.id.localeCompare(right.id);
    });

  const description = `Generated from the Task Designer graph with ${orderedNodes.length} ticket node${orderedNodes.length === 1 ? '' : 's'} and ${dependencyRows.length} dependency link${dependencyRows.length === 1 ? '' : 's'}.`;
  const goals = [
    'Execute planned tickets in deterministic topological order.',
    'Keep graph dependencies explicit and reviewable in markdown.',
    'Persist a local master plan artifact under plans/.'
  ];
  const nonGoals = [
    'Does not execute or mutate tickets automatically.',
    'Does not infer extra dependencies beyond directed links.',
    'Does not modify manually-authored plan files outside generated artifacts.'
  ];

  const lines: string[] = [
    '# Task Designer Master Plan',
    '',
    '**Status:** Proposed',
    '**Type:** Master Plan',
    `**Priority:** ${DEFAULT_ARTIFACT_PRIORITY}`,
    `**Dependencies:** ${dependencyRows.length > 0 ? `${dependencyRows.length} directed graph link${dependencyRows.length === 1 ? '' : 's'}` : 'None'}`,
    `**Complexity:** ${DEFAULT_ARTIFACT_COMPLEXITY}`,
    `**Risk:** ${DEFAULT_ARTIFACT_RISK}`,
    `**Confidence:** ${DEFAULT_ARTIFACT_CONFIDENCE}`,
    '',
    '## Description',
    description,
    '',
    '## Goals',
    ...goals.map((goal, index) => `${index + 1}. ${goal}`),
    '',
    '## Non-Goals',
    ...nonGoals.map((nonGoal, index) => `${index + 1}. ${nonGoal}`),
    '',
    '## Phase Overview'
  ];

  if (orderedNodes.length === 0) {
    lines.push('1. No ticket nodes are currently defined.');
  } else {
    for (const [index, node] of orderedNodes.entries()) {
      lines.push(`${index + 1}. **Phase ${index + 1} — ${node.issueKey}:** ${toSingleLineText(node.summary) || '(no summary)'}`);
    }
  }

  lines.push('', '## Dependencies');
  if (dependencyRows.length === 0) {
    lines.push('1. No explicit directed dependencies are currently defined.');
  } else {
    for (const [index, connector] of dependencyRows.entries()) {
      const source = nodeById.get(connector.sourceNodeId);
      const target = nodeById.get(connector.targetNodeId);
      if (!source || !target) {
        continue;
      }
      lines.push(`${index + 1}. ${source.issueKey} → ${target.issueKey}`);
    }
  }

  lines.push(
    '',
    '## Verification',
    '1. Generate the master plan artifact from Task Designer and confirm the metadata block includes status, type, priority, dependencies, complexity, risk, and confidence.',
    '2. Verify each dependency row maps to an explicit connector in the graph.',
    '3. Re-generate without changing the graph and confirm the file content is unchanged.',
    '4. Run `npm run check-types`.'
  );

  return `${lines.join('\n')}\n`;
}

function selectFeaturePriority(stories: readonly TaskDesignerGeneratedStoryArtifact[]): string {
  const rank = new Map([
    ['P0', 0],
    ['P1', 1],
    ['P2', 2],
    ['P3', 3],
    ['P4', 4]
  ]);
  const priorities = stories.map(story => toExecutionPriority(story.node.priority));
  priorities.sort((left, right) => (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER));
  return priorities[0] ?? DEFAULT_ARTIFACT_PRIORITY;
}

export function buildTaskDesignerGeneratedFeatureArtifacts(
  nodes: readonly TaskDesignerTicketNode[],
  connectors: readonly TaskDesignerDirectedConnector[]
): TaskDesignerGeneratedFeatureArtifact[] {
  const orderedNodeIds = computeTaskDesignerTopologicalOrder(nodes, connectors);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const orderedNodes = (orderedNodeIds ?? nodes.map(node => node.id))
    .map(nodeId => byId.get(nodeId))
    .filter((node): node is TaskDesignerTicketNode => Boolean(node));
  const nodeOrder = new Map(orderedNodes.map((node, index) => [node.id, index]));
  const incomingDependencyByTarget = new Map<string, string[]>();
  for (const connector of connectors) {
    if (!byId.has(connector.sourceNodeId) || !byId.has(connector.targetNodeId)) {
      continue;
    }
    const refs = incomingDependencyByTarget.get(connector.targetNodeId);
    if (refs) {
      refs.push(connector.sourceNodeId);
    } else {
      incomingDependencyByTarget.set(connector.targetNodeId, [connector.sourceNodeId]);
    }
  }

  const storyArtifacts: TaskDesignerGeneratedStoryArtifact[] = orderedNodes.map((node, index) => {
    const featureNumber = Math.floor(index / GENERATED_STORIES_PER_FEATURE) + 1;
    const storyNumber = (index % GENERATED_STORIES_PER_FEATURE) + 1;
    const ref = `${toTwoDigitNumber(featureNumber)}.${storyNumber}`;
    const dependencyIds = [...(incomingDependencyByTarget.get(node.id) ?? [])].sort((left, right) =>
      compareNodeIds(left, right, nodeOrder)
    );
    const dependencies = dependencyIds.map(sourceNodeId => {
      const sourceOrder = nodeOrder.get(sourceNodeId) ?? 0;
      const sourceFeature = Math.floor(sourceOrder / GENERATED_STORIES_PER_FEATURE) + 1;
      const sourceStory = (sourceOrder % GENERATED_STORIES_PER_FEATURE) + 1;
      return `${toTwoDigitNumber(sourceFeature)}.${sourceStory}`;
    });
    return {
      node,
      order: index + 1,
      featureNumber,
      storyNumber,
      ref,
      slug: toSlug(node.summary, `story-${toTwoDigitNumber(featureNumber)}-${storyNumber}`),
      dependencies
    };
  });

  const featureByNumber = new Map<number, TaskDesignerGeneratedStoryArtifact[]>();
  for (const story of storyArtifacts) {
    const group = featureByNumber.get(story.featureNumber);
    if (group) {
      group.push(story);
    } else {
      featureByNumber.set(story.featureNumber, [story]);
    }
  }

  const featureArtifacts: TaskDesignerGeneratedFeatureArtifact[] = [...featureByNumber.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([featureNumber, stories]) => {
      const dependencies = new Set<string>();
      for (const story of stories) {
        for (const dependency of story.dependencies) {
          const dependencyFeatureRef = dependency.split('.')[0];
          if (dependencyFeatureRef !== toTwoDigitNumber(featureNumber)) {
            dependencies.add(`Feature ${dependencyFeatureRef}`);
          }
        }
      }

      const firstStory = stories[0];
      const title = `Execution Slice ${toTwoDigitNumber(featureNumber)} — ${toSingleLineText(firstStory.node.summary) || firstStory.node.issueKey}`;
      return {
        featureNumber,
        ref: toTwoDigitNumber(featureNumber),
        slug: toSlug(title, `feature-${toTwoDigitNumber(featureNumber)}`),
        title,
        stories,
        dependencies: [...dependencies].sort((left, right) => left.localeCompare(right))
      };
    });

  return featureArtifacts;
}

export function buildTaskDesignerGeneratedFeatureMarkdown(feature: TaskDesignerGeneratedFeatureArtifact): string {
  const priority = selectFeaturePriority(feature.stories);
  const lines: string[] = [
    `# Feature ${feature.ref}: ${feature.title}`,
    '',
    '**Status:** Proposed',
    '**Type:** Feature',
    `**Priority:** ${priority}`,
    `**Dependencies:** ${feature.dependencies.length > 0 ? feature.dependencies.join(', ') : 'None'}`,
    `**Complexity:** ${DEFAULT_ARTIFACT_COMPLEXITY}`,
    `**Risk:** ${DEFAULT_ARTIFACT_RISK}`,
    `**Confidence:** ${DEFAULT_ARTIFACT_CONFIDENCE}`,
    '',
    '## Description',
    `Generated from Task Designer graph order for story slice group ${feature.ref}.`,
    '',
    '## Items',
    '',
    '| Ref | Type | Name | Ticket | Status |',
    '| --- | --- | --- | --- | --- |'
  ];

  for (const story of feature.stories) {
    lines.push(`| ${story.ref} | Story | ${toSingleLineText(story.node.summary) || '(no summary)'} | ${story.node.issueKey} | ${story.node.status} |`);
  }

  lines.push('', '## Dependencies');
  if (feature.dependencies.length === 0) {
    lines.push('1. No cross-feature dependencies.');
  } else {
    for (const [index, dependency] of feature.dependencies.entries()) {
      lines.push(`${index + 1}. Depends on ${dependency}.`);
    }
  }

  lines.push(
    '',
    '## Verification',
    '1. Confirm the metadata block includes status, type, priority, dependencies, complexity, risk, and confidence.',
    '2. Execute stories in listed order and verify cross-feature dependencies are satisfied first.',
    '3. Run `npm run check-types`.'
  );
  return `${lines.join('\n')}\n`;
}

export function buildTaskDesignerGeneratedStoryMarkdown(story: TaskDesignerGeneratedStoryArtifact): string {
  const priority = toExecutionPriority(story.node.priority);
  const lines: string[] = [
    `# Story ${story.ref}: ${toSingleLineText(story.node.summary) || story.node.issueKey}`,
    '',
    '**Status:** Proposed',
    '**Type:** Story',
    `**Priority:** ${priority}`,
    `**Dependencies:** ${story.dependencies.length > 0 ? story.dependencies.join(', ') : 'None'}`,
    `**Complexity:** ${DEFAULT_ARTIFACT_COMPLEXITY}`,
    `**Risk:** ${DEFAULT_ARTIFACT_RISK}`,
    `**Confidence:** ${DEFAULT_ARTIFACT_CONFIDENCE}`,
    `**Source Ticket:** ${story.node.issueKey}`,
    '',
    '## Description',
    `Implement execution phase ${story.order} from the Task Designer graph using ticket ${story.node.issueKey}.`,
    '',
    '## Implementation Activities',
    `1. Deliver the scope represented by ticket ${story.node.issueKey}.`,
    '2. Keep implementation aligned with upstream dependency ordering.',
    '3. Ensure the slice remains independently reviewable.',
    '',
    '## Acceptance Criteria',
    '1. The ticket scope is implemented as a functional, compilable slice.',
    '2. Graph dependencies are respected by execution order.',
    '3. `npm run check-types` passes.',
    '',
    '## References',
    `1. Ticket: ${story.node.issueKey}`,
    `2. Graph order: ${story.order}`
  ];

  if (story.dependencies.length > 0) {
    lines.push(`3. Upstream story refs: ${story.dependencies.join(', ')}`);
  }

  lines.push(
    '',
    '## Verification',
    `1. Validate behavior for ticket ${story.node.issueKey} in isolation.`,
    `2. Confirm prerequisite story refs are completed first: ${story.dependencies.length > 0 ? story.dependencies.join(', ') : 'None'}.`,
    '3. Run `npm run check-types`.'
  );
  return `${lines.join('\n')}\n`;
}

/** Convenience: build everything the host writes to disk in one call. */
export function buildTaskDesignerMasterPlanArtifacts(
  nodes: readonly TaskDesignerTicketNode[],
  connectors: readonly TaskDesignerDirectedConnector[]
): TaskDesignerMasterPlanArtifacts {
  const features = buildTaskDesignerGeneratedFeatureArtifacts(nodes, connectors);
  return {
    masterPlanMarkdown: buildTaskDesignerMasterPlanMarkdown(nodes, connectors),
    features,
    storyCount: features.reduce((count, feature) => count + feature.stories.length, 0)
  };
}
