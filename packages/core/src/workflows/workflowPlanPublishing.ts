/**
 * A stage's plan, published to the project board (`WorkflowArtifactContract.publishTo: 'board'`).
 *
 * The agent never writes plan files itself: it runs read-only, in a throwaway worktree, and does
 * not know the board's id scheme. It ends its response with one `praxis-plan` block; the app parses
 * it here and creates a feature plus one work item per entry through the project's own board
 * service — so a folder-backed project gets real plan markdown with ids the board allocates, and
 * any other board gets the same items in its own storage.
 */

import type { CreateIssueInput } from '../types';

export type PlanPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type PlanItemType = 'Story' | 'Task' | 'Bug';

export type PlanSeverity = 'Critical' | 'High' | 'Medium' | 'Low';

export interface PublishablePlanItem {
  type: PlanItemType;
  title: string;
  priority: PlanPriority;
  /** Markdown. */
  description: string;
  /** The worst severity among the findings the item resolves. */
  severity?: PlanSeverity;
  /** A Bug's reproduction, as its board template asks for: how it is exploited, what should happen, what does. */
  steps?: string;
  expected?: string;
  actual?: string;
}

export interface PublishablePlan {
  feature: { title: string; description: string };
  items: PublishablePlanItem[];
}

const PRIORITIES: readonly PlanPriority[] = ['P0', 'P1', 'P2', 'P3'];
const SEVERITIES: readonly PlanSeverity[] = ['Critical', 'High', 'Medium', 'Low'];
/** How a plan priority reads in a board's own `Priority` field. */
const BOARD_PRIORITY: Record<PlanPriority, string> = { P0: 'Highest', P1: 'High', P2: 'Medium', P3: 'Low' };
const TYPES: readonly PlanItemType[] = ['Story', 'Task', 'Bug'];
const MAX_ITEMS = 60;
const MAX_TITLE = 120;

/** What a publishing stage is told, so the contract it is held to is the one it was given. */
export const PUBLISHABLE_PLAN_INSTRUCTIONS = [
  'This plan is created on the project board for you. End your response with exactly one fenced block tagged `praxis-plan` containing JSON of this shape (and no other `praxis-plan` block):',
  '```praxis-plan',
  '{',
  '  "feature": { "title": "Short plan title", "description": "Markdown: goal, scope, how the items were prioritised" },',
  '  "items": [',
  '    { "type": "Story" | "Task" | "Bug", "priority": "P0" | "P1" | "P2" | "P3", "severity": "Critical" | "High" | "Medium" | "Low", "title": "Short imperative title", "description": "Markdown: what to change and where, how to verify it, effort, dependencies",',
  '      "steps": "Bug only — markdown steps that show the problem", "expected": "Bug only — the correct behaviour", "actual": "Bug only — what happens today" }',
  '  ]',
  '}',
  '```',
  `Titles are at most ${MAX_TITLE} characters and do not repeat the priority. Between 1 and ${MAX_ITEMS} items. Do not create files or tickets yourself.`
].join('\n');

/**
 * Reads the last `praxis-plan` block from a stage's response. Throws with a message that says what
 * is wrong, because it becomes the stage's failure reason and the next attempt's guidance.
 */
export function parsePublishablePlan(responseText: string | undefined): PublishablePlan {
  const blocks = [...(responseText ?? '').matchAll(/```praxis-plan[^\n]*\n([\s\S]*?)```/g)];
  const block = blocks[blocks.length - 1]?.[1];
  if (!block) throw new Error('The stage finished without a `praxis-plan` block, so there was no plan to create on the board.');

  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch (error) {
    throw new Error(`The \`praxis-plan\` block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(raw) || !isObject(raw.feature) || !Array.isArray(raw.items)) {
    throw new Error('The `praxis-plan` block needs a "feature" object and an "items" array.');
  }

  const featureTitle = text(raw.feature.title);
  if (!featureTitle) throw new Error('The plan\'s "feature.title" is empty.');
  if (raw.items.length === 0) throw new Error('The plan has no items.');
  if (raw.items.length > MAX_ITEMS) throw new Error(`The plan has ${raw.items.length} items; at most ${MAX_ITEMS} can be created.`);

  const items = raw.items.map((entry, index): PublishablePlanItem => {
    if (!isObject(entry)) throw new Error(`Plan item ${index + 1} is not an object.`);
    const title = text(entry.title);
    if (!title) throw new Error(`Plan item ${index + 1} has no title.`);
    const priority = text(entry.priority).toUpperCase() as PlanPriority;
    const type = TYPES.find(candidate => candidate.toLowerCase() === text(entry.type).toLowerCase()) ?? 'Task';
    const severity = SEVERITIES.find(candidate => candidate.toLowerCase() === text(entry.severity).toLowerCase());
    return {
      type,
      title: clip(title.replace(/^\[?P[0-3]\]?[\s:·-]*/i, ''), MAX_TITLE),
      priority: PRIORITIES.includes(priority) ? priority : 'P2',
      description: text(entry.description),
      ...(severity ? { severity } : {}),
      ...(type === 'Bug' && text(entry.steps) ? { steps: text(entry.steps) } : {}),
      ...(type === 'Bug' && text(entry.expected) ? { expected: text(entry.expected) } : {}),
      ...(type === 'Bug' && text(entry.actual) ? { actual: text(entry.actual) } : {})
    };
  });

  return { feature: { title: clip(featureTitle, MAX_TITLE), description: text(raw.feature.description) }, items };
}

/** The feature, then its items in priority order (stable within a priority), as board inputs. */
export function planIssueInputs(
  plan: PublishablePlan,
  projectKey: string
): { feature: CreateIssueInput; items: (featureKey: string) => CreateIssueInput[] } {
  const ordered = plan.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => PRIORITIES.indexOf(a.item.priority) - PRIORITIES.indexOf(b.item.priority) || a.index - b.index)
    .map(entry => entry.item);
  return {
    feature: {
      projectKey,
      issueType: 'Feature',
      summary: plan.feature.title,
      description: plan.feature.description,
      // A plan is as urgent as its most urgent item.
      priority: BOARD_PRIORITY[ordered[0]?.priority ?? 'P2']
    },
    items: featureKey =>
      ordered.map(item => ({
        projectKey,
        issueType: item.type,
        summary: `[${item.priority}] ${item.title}`,
        // Boards without a parent/child model still show which plan an item belongs to.
        description: `**Priority:** ${item.priority} · Part of plan ${featureKey}: ${plan.feature.title}\n\n${item.description}`.trim(),
        parentKey: featureKey,
        // Folder boards write these into the item's own header and template sections; other
        // boards ignore them, and the description above already carries the priority.
        priority: BOARD_PRIORITY[item.priority],
        ...(item.severity ? { severity: item.severity } : {}),
        ...(item.type === 'Bug' && (item.steps || item.expected || item.actual)
          ? {
              sections: {
                ...(item.steps ? { 'Steps to Reproduce': item.steps } : {}),
                ...(item.expected ? { 'Expected Behavior': item.expected } : {}),
                ...(item.actual ? { 'Actual Behavior': item.actual } : {})
              }
            }
          : {})
      }))
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
